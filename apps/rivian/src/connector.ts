import { createHash } from 'node:crypto'
import type { RivianConnectorState, RivianStatusRow } from '@ev/db'
import {
  CredentialUnreadable,
  RIVIAN_PROPERTIES,
  RivianApiError,
  SUBSCRIPTIONS_URL,
  connectionInitPayload,
  findVehicle,
  toRivianApiError,
  unsealCredential,
  type AppSession,
  type RivianHttp,
  type RivianStream,
} from '@ev/rivian'
import { Backoff } from './backoff.js'
import type { ConnectorConfig } from './config.js'
import type { ConnectorMetrics } from './metrics.js'
import type { Publisher } from './publisher.js'
import { frameFor, type PublishQueue } from './queue.js'
import { SocketOpenError, type CloseReason, type SocketLike, type openSocket } from './socket.js'
import type { ConnectorStore } from './store.js'
import { SubscriptionPlan, type PlannedSubscription } from './subscriptions.js'

/**
 * THE CONNECTOR: ONE RIVIAN SESSION, HELD OPEN, EVERYTHING IT SAYS PUBLISHED
 * (design §5.2 to §5.7).
 *
 * `socket.ts` is the wire, `subscriptions.ts` is the bookkeeping of what is
 * subscribed, `backoff.ts` is the schedule, `queue.ts` and `publisher.ts` are
 * the road to the broker. This file is the one that decides: which of the nine
 * states the connector is in, what each event means in that state, and when to
 * try again. It owns every timer, and it takes the clock, the socket, the HTTP
 * client, the store and the metrics as arguments, so a test drives all of it
 * without a network, a database or a real minute passing.
 *
 * FOUR RULES SHAPE IT, EACH ONE LEARNED FROM A FAILURE SOMEONE ELSE HAD.
 *
 * 1. POSTGRES IS NEVER ON THE SOCKET'S CRITICAL PATH. Nothing the socket does
 *    waits on a database call, and nothing a database call does closes the
 *    socket. A credential poll that throws is counted and changes nothing; a
 *    status write that throws is logged and never awaited by anything that
 *    handles a frame. The only database answer that closes the socket is a
 *    SUCCESSFUL query that finds no credential row, because that is the user
 *    signing out, and the connector hangs up on purpose.
 *
 * 2. NOTHING RECONNECTS FASTER THAN THE BACKOFF. Every failure path ends in
 *    `#backOff`, whatever it was (a close, a rejected open, an HTTP call that
 *    failed before there was a socket), and the one clock they share,
 *    `#reconnectAt`, is consulted before any new session is begun. A new
 *    credential in the middle of a backoff therefore still waits it out, which
 *    is design §5.2's "only shutdown cuts a backoff short". The one failure
 *    that is not retried at all is a dead session, which waits for a new
 *    credential instead: retrying a dead session is how accounts get flagged.
 *
 * 3. A STALE ANSWER NEVER ACTS. Every await in a lifecycle can be overtaken (a
 *    new credential restarts it, a sign-out ends it, SIGTERM stops it), and the
 *    continuation that finally runs belongs to a lifecycle that no longer
 *    exists. Each one carries the `#epoch` it started in and checks it before
 *    touching anything, and every socket carries a connection number checked
 *    the same way, so a late `next` from a socket that was replaced is not
 *    published and a late close from one is not a reason to back off.
 *
 * 4. NO SECRET IS EVER TEXT. The only things that reach a log line, a metric
 *    label or `rivian_status.last_error` are a fixed string, a `RivianApiError`'s
 *    `redacted()` form, or a `SocketOpenError`/close detail (which `socket.ts`
 *    builds only from fixed strings). An error of any other kind is reduced to
 *    its class name: its message is anyone's guess, and the connector holds a
 *    session token, a private key and a database password.
 */

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(h: unknown): void
}

/** The real clock. Tests pass one they advance by hand. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
}

export interface ConnectorDeps {
  config: ConnectorConfig
  store: ConnectorStore
  http: Pick<
    RivianHttp,
    'createCsrf' | 'userInfo' | 'vehicle' | 'chargingSummaries' | 'introspectVehicleState'
  >
  openSocket: typeof openSocket
  queue: PublishQueue
  publisher: Publisher
  clock: Clock
  /** The backoff's jitter source. `Math.random` unless a test says otherwise. */
  random?: () => number
  metrics: ConnectorMetrics
  /** One line, already free of secrets. The entrypoint prints it. */
  log: (line: string) => void
}

/** How often the credential's stamp is read (design §5.2). */
const POLL_INTERVAL_MS = 15_000

/**
 * How long a database call may take before it counts as failed. Without a bound
 * a Postgres that accepts the connection and then never answers would leave the
 * poll waiting for ever, and a poll that is waiting is a poll that never
 * notices a sign-out or a new sign-in. A call that outlives this is a failure
 * like any other: counted, logged, and the next poll tries again.
 */
const STORE_TIMEOUT_MS = 10_000

/** How long `openSocket` waits for `connection_ack` (design §5.2). */
const ACK_TIMEOUT_MS = 15_000

/** Nothing for this long on an acknowledged socket means resubscribe (design §5.2). */
const SILENCE_MS = 60_000

/** Before a rejected half, an ended subscription or an errored one is subscribed again (design §5.2, §5.4). */
const RESUBSCRIBE_DELAY_MS = 30_000

/**
 * The least time between two renewals of everything. A renewal re-sends a
 * snapshot, and a snapshot is exactly what overflows a queue that is already
 * struggling: renewing on every overflow is a resubscribe storm against Rivian
 * that would ask for the next overflow itself.
 */
const MIN_RENEW_INTERVAL_MS = 60_000

/** `last_frame_at` is written at most this often (design §5.7). */
const FRAME_WRITE_INTERVAL_MS = 60_000

/** How long shutdown waits for the queue to reach the broker (design §5.2). */
const DRAIN_MS = 5_000

/** The VIN is absent from the account: look again this often (design §5.2). */
const VIN_RETRY_MS = 60 * 60 * 1000

/**
 * How often the plan is asked whether a dropped property or an unavailable
 * subscription is due for its daily retry. The plan holds the 24 h; this only
 * bounds how late the retry can be. An hour late on a day is not worth a
 * timer per property.
 */
const REPROBE_CHECK_MS = 60 * 60 * 1000

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** The user's account and vehicles: every 6 h once the car is found (design §5.6). */
const USER_INFO_EVERY_MS = 6 * HOUR_MS
const VEHICLE_EVERY_MS = DAY_MS
const CHARGING_SUMMARIES_EVERY_MS = 6 * HOUR_MS
const SCHEMA_EVERY_MS = DAY_MS

/** The starting selection of `vehicleState`: the catalogue, widened by discovery. */
const CATALOGUE: readonly string[] = RIVIAN_PROPERTIES.map((p) => p.name)
const CATALOGUE_SET: ReadonlySet<string> = new Set(CATALOGUE)

/**
 * An HTTP call was refused as unauthenticated, a new app session was made, and
 * the retry was refused too: the user session is dead (design §5.2).
 */
class SessionDead extends Error {
  constructor() {
    super('Rivian rejected the session')
    this.name = 'SessionDead'
  }
}

/** The lifecycle that made a call was replaced while it ran. The caller's `alive` check says so first. */
class Superseded extends Error {
  constructor() {
    super('superseded')
    this.name = 'Superseded'
  }
}

/**
 * What may be said about a failure. A Rivian error's redacted form is safe by
 * construction (design §4.4); anything else is reduced to a class name that
 * looks like one, because an unexpected error's message is the one place a
 * token could still be lurking.
 */
function describeError(e: unknown): string {
  if (e instanceof RivianApiError) return e.redacted()
  if (e instanceof SessionDead) return e.message
  const name = e instanceof Error && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : 'error'
  return `unexpected ${name}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Each name once, in the order first seen. */
function unique(names: readonly string[]): string[] {
  return [...new Set(names)]
}

/**
 * The fields of the `VehicleState` type out of an introspection answer, each
 * with the name of its type (looked for under a `NON_NULL` wrapper too). Null
 * when the answer is not that shape, which is how a refused introspection
 * reaches here: `{ __type: null }`.
 */
function schemaFields(data: unknown): { name: string; typeName: string | null }[] | null {
  if (!isRecord(data) || !isRecord(data['__type'])) return null
  const fields = data['__type']['fields']
  if (!Array.isArray(fields)) return null
  const out: { name: string; typeName: string | null }[] = []
  for (const field of fields) {
    if (!isRecord(field) || typeof field['name'] !== 'string') continue
    const type = field['type']
    let typeName: string | null = null
    if (isRecord(type)) {
      if (typeof type['name'] === 'string') typeName = type['name']
      else if (isRecord(type['ofType']) && typeof type['ofType']['name'] === 'string') {
        typeName = type['ofType']['name']
      }
    }
    out.push({ name: field['name'], typeName })
  }
  return out
}

/** The errors of a subscription's `error` message, which is a list (and, from a stricter server, `{ errors }`). */
function errorListOf(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload
  return isRecord(payload) ? payload['errors'] : undefined
}

export class Connector {
  readonly #deps: ConnectorDeps
  readonly #backoff: Backoff

  #state: RivianConnectorState = 'signed_out'
  #started = false
  #stopped = false
  #stopping: Promise<void> | null = null

  /**
   * Identifies the lifecycle that is running. Bumped by everything that ends
   * one (a restart, a sign-out, a give-up, a stop), so a continuation that
   * outlived its lifecycle can tell (rule 3, above).
   */
  #epoch = 0

  /**
   * The credential's stamp as of the last poll that acted on it: a number for
   * a row, null for "signed out", undefined for "decide again at the next
   * successful poll". Undefined is how a lifecycle that could not even read the
   * credential gets itself restarted, with no timer of its own to do it.
   */
  #credentialMs: number | null | undefined = undefined
  #pollTimer: unknown = null
  #pollFailing = false

  /** Timers that live as long as the session: slow HTTP, the hourly look for the VIN, the backoff. */
  readonly #sessionTimers = new Set<unknown>()
  /** Timers that live as long as one socket: silence, probes, resubscribes, reprobes. */
  readonly #connTimers = new Set<unknown>()

  #token: string | null = null
  #app: AppSession | null = null
  #vehicleId: string | null = null
  #plan: SubscriptionPlan | null = null
  /** `TimeStamped*` properties discovery has found, kept so a rebuilt plan still has them. */
  readonly #discovered: string[] = []

  /** The earliest the next Rivian call of any kind may be made. Never moves back. */
  #reconnectAt = 0

  #socket: SocketLike | null = null
  /** Identifies the socket whose handlers are current; bumped whenever one ends. */
  #connId = 0
  /** Every id subscribed on the current socket, so shutdown can `complete` each one. */
  readonly #live = new Set<string>()
  /** A `next` has arrived since the connect: the backoff has been reset for it. */
  #flowing = false
  #silenceTimer: unknown = null
  #lastActivity = 0
  #renewPending = false
  #renewTimer: unknown = null
  #lastRenewAt = Number.NEGATIVE_INFINITY
  /** The publisher has reported the queue empty since the last frame was queued. */
  #queueEmpty = true

  /** SHA-256 of the last `meta` data published, per kind, for the change-only rule. */
  readonly #metaHashes = new Map<string, string>()

  // The status row (design §5.7): kept as fields and turned into a row at write time.
  #lastError: string | null = null
  #backoffUntil: number | null = null
  #lastFrameAt: Date | null = null
  #lastFrameWrite = Number.NEGATIVE_INFINITY
  /** The saved status has been read successfully at least once. */
  #loaded = false
  /** The dropped list to start a plan from, and to write while there is no plan. */
  #dropped: string[] = []
  /**
   * Saved dropped names the live plan was NOT started with, because the read
   * that would have told us failed when the plan was built and succeeded
   * afterwards. They are written back with the plan's own, so that a blip at
   * startup cannot cost the saved list. See `#droppedForRow`.
   */
  #carried: string[] = []
  #statusDirty = false
  #statusBusy = false

  constructor(deps: ConnectorDeps) {
    this.#deps = deps
    this.#backoff = new Backoff(deps.random)
    // Registered once, for the life of the connector: the publisher has no way
    // to remove a listener. What it does when the queue empties is decided by
    // the state at that moment (see `#queueDrained`).
    deps.publisher.onEmpty(() => this.#guarded(() => this.#queueDrained()))
  }

  get state(): RivianConnectorState {
    return this.#state
  }

  /** Begin the credential poll, and with it the lifecycle. The first poll is at once. */
  start(): void {
    if (this.#started || this.#stopped) return
    this.#started = true
    this.#guarded(() => this.#poll())
  }

  /**
   * The SIGTERM sequence (design §5.2). Safe to call more than once: later
   * calls get the first call's answer.
   *
   * 1. Stop timers, and stop reading the socket: from here a frame that
   *    arrives is not queued, and nothing new is begun.
   * 2. Drain the publish queue for up to 5 s. Frames still owed after that are
   *    counted as dropped, because they are.
   * 3. `complete` every subscription, then 4. close the socket, and
   * 5. end MQTT. The caller exits the process afterwards: a graceful MQTT end
   *    may leave the stream open, and the process must not wait on it.
   */
  stop(): Promise<void> {
    this.#stopping ??= this.#stop()
    return this.#stopping
  }

  async #stop(): Promise<void> {
    this.#stopped = true
    this.#epoch += 1
    if (this.#pollTimer !== null) this.#deps.clock.clearTimeout(this.#pollTimer)
    this.#pollTimer = null
    this.#clearTimers(this.#sessionTimers)
    this.#clearTimers(this.#connTimers)

    // Kept to complete and close below. The connection number moves on at once,
    // so that nothing the socket still says is read as news.
    const socket = this.#socket
    const ids = [...this.#live]
    this.#connId += 1
    this.#socket = null

    const left = await this.#deps.publisher.drain(DRAIN_MS)
    if (left > 0) {
      this.#deps.metrics.dropped(left)
      this.#log(`shutdown: ${left} queued frames were not published and are dropped`)
    }
    if (socket !== null) {
      for (const id of ids) this.#attempt(() => socket.complete(id))
      this.#attempt(() => socket.close())
    }
    await this.#deps.publisher.end()
  }

  // -------------------------------------------------------------------------
  // The credential poll
  // -------------------------------------------------------------------------

  /**
   * Read the credential's stamp and act on what it says. The next poll is
   * scheduled when this one ends, not on a fixed beat, so a slow query can
   * never have two polls in flight.
   */
  async #poll(): Promise<void> {
    try {
      let stamp: Date | null
      try {
        stamp = await this.#withinTimeout(this.#deps.store.credentialStamp())
      } catch {
        // Counted, and changes nothing: the socket stays up (rule 1). The error
        // itself is not logged, because a Postgres error can name the host and
        // the user. Only the first failure of a run is logged: one line per 15 s
        // for the length of an outage says nothing the counter does not.
        this.#deps.metrics.pollFailure()
        if (!this.#pollFailing) this.#log('credential poll failed; the connection is unaffected')
        this.#pollFailing = true
        return
      }
      if (this.#pollFailing) this.#log('credential poll succeeded again')
      this.#pollFailing = false
      if (this.#stopped) return
      this.#onStamp(stamp)
    } finally {
      if (!this.#stopped) {
        this.#pollTimer = this.#deps.clock.setTimeout(() => {
          this.#pollTimer = null
          this.#guarded(() => this.#poll())
        }, POLL_INTERVAL_MS)
      }
    }
  }

  /**
   * `null` is a SUCCESSFUL query that found no row: the user signed out, and
   * everything is closed. A stamp that differs from the one acted on restarts
   * from `starting`, whatever state the connector was in, which is also how
   * `unauthenticated` and `credential_invalid` are ever left.
   */
  #onStamp(stamp: Date | null): void {
    if (stamp === null) {
      if (this.#credentialMs === null) return
      this.#credentialMs = null
      this.#halt()
      this.#enter('signed_out')
      return
    }
    const ms = stamp.getTime()
    if (ms === this.#credentialMs) return
    this.#credentialMs = ms
    this.#begin()
  }

  // -------------------------------------------------------------------------
  // The lifecycle: starting, finding the vehicle, connecting
  // -------------------------------------------------------------------------

  /** Everything that belongs to a session is torn down, and a new lifecycle begins. */
  #begin(): void {
    this.#halt()
    const epoch = this.#epoch
    this.#enter('starting')
    this.#guarded(() => this.#starting(epoch))
  }

  /**
   * Read the saved status, open the credential, and go to the network.
   *
   * A failure to READ the credential (a Postgres blip) is not a verdict on it:
   * the lifecycle stays where it is, and `#credentialMs` is cleared so that the
   * next successful poll starts it again. A credential that will not OPEN is a
   * verdict, and `credential_invalid` waits for a new row rather than looping
   * on one that cannot ever work (design §4.2).
   */
  async #starting(epoch: number): Promise<void> {
    await this.#loadSaved()
    if (!this.#alive(epoch)) return

    let row: { sealed: string } | null
    try {
      row = await this.#withinTimeout(this.#deps.store.credential())
    } catch {
      this.#log('reading the credential failed; will try again at the next poll')
      this.#credentialMs = undefined
      return
    }
    if (!this.#alive(epoch)) return
    if (row === null) {
      this.#credentialMs = null
      this.#halt()
      this.#enter('signed_out')
      return
    }

    try {
      this.#token = (await unsealCredential(this.#deps.config.privateJwk, row.sealed)).userSessionToken
    } catch (e) {
      if (!this.#alive(epoch)) return
      // `CredentialUnreadable` is a row that will not open (wrong key, rotated
      // secret, corrupt value). Anything else is the KEY failing to import,
      // which a new row cannot fix either: this process's key is fixed for its
      // life, so the same wait is the right one, with a message that says which.
      this.#enter('credential_invalid', {
        error:
          e instanceof CredentialUnreadable
            ? 'the stored credential cannot be read'
            : 'the credential key cannot be used',
      })
      return
    }
    if (!this.#alive(epoch)) return
    await this.#acquire(epoch)
  }

  /**
   * An app session, then the vehicle. This is the first thing that calls
   * Rivian, so it is where a backoff still running from before a restart is
   * waited out (rule 2).
   *
   * `waited` is true for a call made by a timer that has just done the waiting
   * (a backoff's own, or the wait below). It skips the check, because the check
   * is for a lifecycle that STARTS inside a backoff, and a timer that fires a
   * millisecond early would otherwise find a millisecond still to wait and go
   * round again, flapping `backing_off` for nothing.
   */
  async #acquire(epoch: number, waited = false): Promise<void> {
    const wait = this.#reconnectAt - this.#deps.clock.now()
    if (!waited && wait > 0) {
      this.#enter('backing_off', {
        error: 'waiting out an earlier backoff',
        backoffUntil: this.#reconnectAt,
      })
      this.#schedule(this.#sessionTimers, wait, () => {
        if (this.#alive(epoch)) return this.#acquire(epoch, true)
      })
      return
    }
    if (this.#state !== 'starting') this.#enter('starting')

    try {
      this.#app = await this.#deps.http.createCsrf()
    } catch (e) {
      if (!this.#alive(epoch)) return
      this.#failed(epoch, 'createCsrf', 'http', e, () => this.#acquire(epoch, true))
      return
    }
    if (!this.#alive(epoch)) return
    await this.#findVehicle(epoch)
  }

  /**
   * `getUserInfo`, taped as `meta`, and the car looked for by VIN. A car that is
   * not listed is `waiting_for_vehicle`, and is looked for again hourly without
   * leaving that state (design §5.2): an undelivered R2 may well not be on the
   * account yet.
   */
  async #findVehicle(epoch: number): Promise<void> {
    if (this.#state !== 'waiting_for_vehicle') this.#enter('finding_vehicle')

    let info: unknown
    try {
      info = await this.#authed(epoch, (app, token) => this.#deps.http.userInfo(app, token))
    } catch (e) {
      if (!this.#alive(epoch)) return
      if (e instanceof SessionDead) {
        this.#unauthenticated(e.message)
        return
      }
      this.#failed(epoch, 'getUserInfo', 'http', e, () => this.#acquire(epoch, true))
      return
    }
    if (!this.#alive(epoch)) return
    this.#publishMeta('userInfo', info)

    const found = findVehicle(info, this.#deps.config.vin)
    if (found === null) {
      if (this.#state !== 'waiting_for_vehicle') this.#enter('waiting_for_vehicle')
      this.#schedule(this.#sessionTimers, VIN_RETRY_MS, () => {
        if (this.#alive(epoch)) return this.#findVehicle(epoch)
      })
      return
    }

    this.#vehicleId = found.id
    const plan = (this.#plan ??= this.#newPlan(found.id))
    this.#startSlowTasks(epoch, found.id)
    await this.#connect(epoch, plan)
  }

  /**
   * Open the socket, and subscribe to everything on its acknowledgement.
   *
   * The connection number is taken before the open and checked after it, as the
   * epoch is: an open that is overtaken (a restart, a stop) must close the
   * socket it finally gets, and a socket that closed before this function saw
   * it (the handlers can run before the awaiting code does) must not be
   * treated as live.
   */
  async #connect(epoch: number, plan: SubscriptionPlan): Promise<void> {
    this.#enter('connecting')
    this.#connId += 1
    const connId = this.#connId

    let socket: SocketLike
    try {
      socket = await this.#deps.openSocket({
        url: SUBSCRIPTIONS_URL,
        initPayload: connectionInitPayload(this.#token ?? ''),
        ackTimeoutMs: ACK_TIMEOUT_MS,
        handlers: {
          onNext: (id, payload) => this.#guarded(() => this.#onNext(connId, id, payload)),
          onError: (id, payload) => this.#guarded(() => this.#onError(connId, id, payload)),
          onComplete: (id) => this.#guarded(() => this.#onComplete(connId, id)),
          onClose: (reason, detail) =>
            this.#guarded(() => {
              if (connId !== this.#connId || !this.#alive(epoch)) return
              this.#socketEnded(epoch, plan, reason, detail)
            }),
        },
      })
    } catch (e) {
      if (connId !== this.#connId || !this.#alive(epoch)) return
      // `SocketOpenError` carries a `CloseReason` and a detail built from fixed
      // strings. Anything else is not one of ours and gets neither.
      if (e instanceof SocketOpenError) this.#socketEnded(epoch, plan, e.reason, e.message)
      else this.#socketEnded(epoch, plan, 'error', 'websocket error')
      return
    }
    if (connId !== this.#connId || !this.#alive(epoch)) {
      this.#attempt(() => socket.close())
      return
    }

    this.#socket = socket
    this.#flowing = false
    this.#lastActivity = this.#deps.clock.now()
    // `initial()` starts the plan over, which is right for a replaced socket
    // and is why every timer that belonged to the last socket is already gone
    // (`#dropConnection`): a held probe would be numbered by the old plan.
    this.#live.clear()
    for (const { id, sub } of plan.initial()) {
      this.#live.add(id)
      socket.subscribe(id, sub.doc)
    }
    this.#enter('subscribed')
    this.#armSilence()
    this.#armReprobe()
    // The reconnect may have come a day or more after a rejection; if a probe is
    // due it is handed out now, while the socket is acknowledged.
    this.#reprobe()
  }

  /**
   * The socket is over. A dead session is final until the credential changes;
   * every other ending is a backoff, from the same schedule whatever it was
   * (rule 2).
   */
  #socketEnded(epoch: number, plan: SubscriptionPlan, reason: CloseReason, detail: string): void {
    this.#dropConnection()
    if (reason === 'unauthenticated') {
      this.#unauthenticated(detail)
      return
    }
    this.#deps.metrics.reconnect(reason)
    this.#backOff(epoch, detail, () => this.#connect(epoch, plan))
  }

  /** A Rivian HTTP call failed: say so redacted, and back off before trying the session again. */
  #failed(epoch: number, what: string, reason: string, e: unknown, resume: () => Promise<void>): void {
    const detail = describeError(e)
    this.#log(`${what} failed: ${detail}`)
    this.#deps.metrics.reconnect(reason)
    this.#backOff(epoch, detail, resume)
  }

  /**
   * Wait out the next step of the backoff, then `resume`. Everything that
   * retries Rivian goes through here: the HTTP failures before there is a
   * socket and the closes after one alike.
   */
  #backOff(epoch: number, detail: string, resume: () => Promise<void>): void {
    const wait = this.#backoff.next()
    const until = this.#deps.clock.now() + wait
    this.#reconnectAt = Math.max(this.#reconnectAt, until)
    this.#enter('backing_off', { error: detail, backoffUntil: until })
    this.#schedule(this.#sessionTimers, wait, () => {
      if (this.#alive(epoch)) return resume()
    })
  }

  /**
   * The session is dead (HTTP `UNAUTHENTICATED` twice, or a websocket closed
   * with "Unauthenticated"). Everything stops, the poll excepted, and only a
   * changed credential starts it again: retrying a dead session is how
   * accounts get flagged (design §5.2).
   */
  #unauthenticated(detail: string): void {
    this.#halt()
    this.#enter('unauthenticated', { error: detail })
  }

  /**
   * An HTTP call with the one retry design §5.2 allows. A refusal as
   * unauthenticated may only mean the app session has lapsed (whether it can
   * is unknown, §2.2), so a fresh one is made and the call repeated. A second
   * refusal means the user session is the problem and is `SessionDead`.
   */
  async #authed<T>(
    epoch: number,
    call: (app: AppSession, token: string) => Promise<T>,
  ): Promise<T> {
    const token = this.#token
    if (token === null || this.#app === null) throw new Superseded()
    try {
      return await call(this.#app, token)
    } catch (e) {
      if (!(e instanceof RivianApiError && e.unauthenticated)) throw e
    }
    const fresh = await this.#deps.http.createCsrf()
    if (!this.#alive(epoch)) throw new Superseded()
    this.#app = fresh
    try {
      return await call(fresh, token)
    } catch (e) {
      if (e instanceof RivianApiError && e.unauthenticated) throw new SessionDead()
      throw e
    }
  }

  // -------------------------------------------------------------------------
  // Frames, errors, silence
  // -------------------------------------------------------------------------

  /**
   * A frame: stamped with the clock NOW (the one honest answer to when we
   * learned it, design §3), queued, and the pump nudged. Nothing here waits on
   * the broker or the database.
   *
   * The id decides whether the frame is ours: one the plan does not hold is a
   * late frame for a subscription that was renewed, rejected or ended, and is
   * dropped without a trace, since it is neither data for the new subscription
   * nor a sign that the connection is alive.
   */
  #onNext(connId: number, id: string, payload: unknown): void {
    if (connId !== this.#connId || this.#stopped) return
    const stream = this.#plan?.streamOf(id) ?? null
    if (stream === null) return

    // The first frame after a connect is what proves the connection works: an
    // ack on its own is not, since a server that acknowledges and closes in the
    // same breath has not recovered (see `Backoff.reset`).
    if (!this.#flowing) {
      this.#flowing = true
      this.#backoff.reset()
    }
    const now = this.#deps.clock.now()
    this.#lastActivity = now
    this.#deps.metrics.frame(stream)
    this.#deps.metrics.lastFrame(now)
    this.#lastFrameAt = new Date(now)
    if (now - this.#lastFrameWrite >= FRAME_WRITE_INTERVAL_MS) {
      this.#lastFrameWrite = now
      this.#persist()
    }
    this.#enqueue(stream, new Date(now), payload)
  }

  /**
   * Queue a frame and pump. A drop is counted, and sets `renewPending` BEFORE the
   * pump runs: the pump can empty the queue synchronously, and a flag set after
   * that would miss the only moment `#queueDrained` looks at it.
   *
   * Dropping is not answered with a renewal on the spot. The renewal is a
   * snapshot, a snapshot is what overflows a full queue, and a renewal per
   * overflow is a resubscribe storm. `#queueDrained` renews once, when the
   * queue is empty, and `#maybeRenew` holds that to once a minute.
   *
   * With no socket up there is nothing to renew and nothing to ask for: a drop
   * while the connector is backing off (the `connection` frames of a long
   * outage can fill a small queue) is made good by the subscribe on the next
   * connection, which is a snapshot too. Remembering it would have that
   * reconnect renew everything again for a gap it has just filled.
   */
  #enqueue(stream: RivianStream, at: Date, body: unknown): void {
    if (this.#stopped) return
    const dropped = this.#deps.queue.push(frameFor(this.#deps.config.vin, stream, at, body))
    this.#queueEmpty = false
    if (dropped > 0) {
      this.#deps.metrics.dropped(dropped)
      if (this.#socket !== null) this.#renewPending = true
    }
    this.#deps.publisher.pump()
  }

  #queueDrained(): void {
    this.#queueEmpty = true
    this.#maybeRenew()
  }

  /**
   * Renew everything if a drop has asked for it, the queue has emptied (the
   * snapshot's frames will not meet a full queue), a socket is there to renew
   * on, and the last renewal was over a minute ago. Too soon, it tries again
   * when the minute is up.
   */
  #maybeRenew(): void {
    if (!this.#renewPending || this.#socket === null || !this.#queueEmpty || this.#stopped) return
    const wait = this.#lastRenewAt + MIN_RENEW_INTERVAL_MS - this.#deps.clock.now()
    if (wait > 0) {
      if (this.#renewTimer === null) {
        this.#renewTimer = this.#schedule(this.#connTimers, wait, () => {
          this.#renewTimer = null
          this.#maybeRenew()
        })
      }
      return
    }
    this.#renewAll()
  }

  /**
   * `complete` every live subscription and `subscribe` it again under a fresh
   * id (`graphql-transport-ws` forbids reusing a live one). On the same socket:
   * silence and overflow are not reasons to reconnect (design §5.2, §5.5).
   */
  #renewAll(): void {
    const socket = this.#socket
    const plan = this.#plan
    if (socket === null || plan === null) return
    for (const { oldId, id, sub } of plan.renewAll()) {
      socket.complete(oldId)
      this.#live.delete(oldId)
      this.#live.add(id)
      socket.subscribe(id, sub.doc)
    }
    const now = this.#deps.clock.now()
    this.#lastRenewAt = now
    // The snapshot is on its way, which is what the pending renewal was for.
    this.#lastActivity = now
    this.#renewPending = false
  }

  /**
   * Nothing for 60 s on an acknowledged socket: resubscribe everything, and
   * wait another 60 s. It is one timer that looks at when the last frame
   * arrived and goes back to sleep for the difference if it was recent, rather
   * than a timer cancelled and made again for every frame; Parallax can send
   * many a second.
   */
  #armSilence(afterMs: number = SILENCE_MS): void {
    this.#silenceTimer = this.#schedule(this.#connTimers, afterMs, () => {
      this.#silenceTimer = null
      const idle = this.#deps.clock.now() - this.#lastActivity
      if (idle >= SILENCE_MS) {
        this.#renewAll()
        this.#armSilence()
      } else {
        this.#armSilence(SILENCE_MS - idle)
      }
    })
  }

  /**
   * A subscription the server rejected. A validation failure goes to the plan
   * to bisect (design §5.4); anything else is an ordinary end and comes back
   * after 30 s. The errors are read only for their codes (design §4.4).
   */
  #onError(connId: number, id: string, payload: unknown): void {
    const plan = this.#plan
    if (connId !== this.#connId || this.#stopped || plan === null) return
    const error = toRivianApiError(null, { errors: errorListOf(payload) }, 'subscription')
    this.#live.delete(id)

    if (!error.validationFailed) {
      const sub = plan.ended(id)
      if (sub === null) return
      this.#log(`subscription ${sub.key} was refused: ${error.redacted()}; trying again in 30 s`)
      this.#resubscribeLater(sub)
      return
    }

    const { probes, newlyDropped, unavailable } = plan.rejected(id, this.#deps.clock.now())
    for (const probe of probes) this.#resubscribeLater(probe)
    if (unavailable !== null) {
      this.#log(`subscription ${unavailable} is rejected and has nothing to bisect; trying again in a day`)
    }
    if (newlyDropped.length > 0) {
      this.#log(`rivian rejects ${newlyDropped.join(', ')}; no longer subscribed`)
      this.#droppedChanged()
    }
  }

  /** The server completed a subscription: it comes back after 30 s under a fresh id. */
  #onComplete(connId: number, id: string): void {
    if (connId !== this.#connId || this.#stopped) return
    this.#live.delete(id)
    const sub = this.#plan?.ended(id) ?? null
    if (sub === null) return
    this.#log(`subscription ${sub.key} was ended by the server; trying again in 30 s`)
    this.#resubscribeLater(sub)
  }

  #resubscribeLater(sub: PlannedSubscription): void {
    this.#schedule(this.#connTimers, RESUBSCRIBE_DELAY_MS, () => this.#activate(sub))
  }

  /** Subscribe something the plan handed back, under the fresh id `activate` gives it. */
  #activate(sub: PlannedSubscription): void {
    const plan = this.#plan
    const socket = this.#socket
    if (plan === null || socket === null) return
    const id = plan.activate(sub)
    this.#live.add(id)
    socket.subscribe(id, sub.doc)
  }

  /**
   * Hand out whatever is due for its daily retry (design §5.4), each at once
   * (a probe not subscribed is forgotten for a day, or for ever), and write the
   * list again, because handing a property out takes it off the list.
   */
  #reprobe(): void {
    const plan = this.#plan
    if (plan === null || this.#socket === null) return
    const probes = plan.dueForReprobe(this.#deps.clock.now())
    if (probes.length === 0) return
    for (const probe of probes) this.#activate(probe)
    this.#droppedChanged()
  }

  #armReprobe(): void {
    this.#schedule(this.#connTimers, REPROBE_CHECK_MS, () => {
      this.#reprobe()
      this.#armReprobe()
    })
  }

  // -------------------------------------------------------------------------
  // Slow HTTP, all published as `meta` (design §5.6)
  // -------------------------------------------------------------------------

  /**
   * The calls that are made rarely: the vehicle and the charging summaries and
   * the schema once found and then on their cadence, `userInfo` again after its
   * 6 h (it has just been made). They are independent of the socket and of one
   * another, and none of them can change the state: a refusal is logged and the
   * next one is a cadence away. A dead session is the websocket's to report, and
   * an endpoint that answers `UNAUTHENTICATED` for its own reasons (the charging
   * one is unverified, §2.4) must not take a healthy stream down with it.
   */
  #startSlowTasks(epoch: number, vehicleId: string): void {
    this.#every(epoch, 'getUserInfo', USER_INFO_EVERY_MS, USER_INFO_EVERY_MS, async () => {
      const data = await this.#authed(epoch, (app, token) => this.#deps.http.userInfo(app, token))
      if (this.#alive(epoch)) this.#publishMeta('userInfo', data)
    })
    this.#every(epoch, 'getVehicle', VEHICLE_EVERY_MS, 0, async () => {
      const data = await this.#authed(epoch, (app, token) =>
        this.#deps.http.vehicle(app, token, vehicleId),
      )
      if (this.#alive(epoch)) this.#publishMeta('vehicle', data)
    })
    this.#every(epoch, 'getCompletedSessionSummaries', CHARGING_SUMMARIES_EVERY_MS, 0, async () => {
      const data = await this.#authed(epoch, (app, token) =>
        this.#deps.http.chargingSummaries(app, token, vehicleId),
      )
      if (this.#alive(epoch)) this.#publishMeta('chargingSummaries', data)
    })
    this.#every(epoch, 'introspection', SCHEMA_EVERY_MS, 0, async () => {
      const data = await this.#authed(epoch, (app, token) =>
        this.#deps.http.introspectVehicleState(app, token),
      )
      if (this.#alive(epoch)) this.#applySchema(data)
    })
  }

  /**
   * Run `task` after `firstInMs`, and again every `periodMs` after it ends,
   * for as long as this lifecycle lives. The next run is scheduled whether this
   * one succeeded or not: a refused introspection is tried again in 24 h and
   * nothing else changes (design §5.6), and the same is true of the others.
   */
  #every(
    epoch: number,
    name: string,
    periodMs: number,
    firstInMs: number,
    task: () => Promise<void>,
  ): void {
    const run = async (): Promise<void> => {
      try {
        await task()
      } catch (e) {
        if (!this.#alive(epoch)) return
        this.#log(`${name} failed: ${describeError(e)}`)
      }
      if (this.#alive(epoch)) this.#schedule(this.#sessionTimers, periodMs, run)
    }
    if (firstInMs === 0) this.#guarded(run)
    else this.#schedule(this.#sessionTimers, firstInMs, run)
  }

  /**
   * Discovery (design §5.6): a `VehicleState` field the catalogue has never
   * heard of whose type is `TimeStamped*` is added to the selection with the
   * plain `{ timeStamp value }` template. Any other unknown field is listed in
   * the record and NOT selected, because its shape is unknown, and a guess at a
   * shape is a validation error that silences a whole group.
   */
  #applySchema(data: unknown): void {
    const fields = schemaFields(data)
    if (fields === null) {
      this.#log('introspection answered, but not with the fields of VehicleState')
      return
    }
    const discovered: string[] = []
    const unselected: string[] = []
    for (const { name, typeName } of fields) {
      if (CATALOGUE_SET.has(name)) continue
      if (typeName !== null && typeName.startsWith('TimeStamped')) discovered.push(name)
      else unselected.push(name)
    }

    for (const name of discovered) if (!this.#discovered.includes(name)) this.#discovered.push(name)
    // The plan refuses names it already holds and names that are not GraphQL
    // names; what it hands back is the groups that are new, subscribed now if
    // there is a socket, and otherwise held in the plan for the next `initial()`.
    for (const group of this.#plan?.addProperties(discovered) ?? []) this.#activate(group)

    this.#publishMeta('schema', { introspection: data, discovered, unselected })
  }

  // -------------------------------------------------------------------------
  // Meta frames
  // -------------------------------------------------------------------------

  /**
   * Publish `{ kind, data }` on the `meta` stream. Change-only by SHA-256 of
   * the JSON, so that an hourly `userInfo` that has not changed leaves nothing
   * on the tape; `connection` is the exception and is always published, since
   * it is the record of what the connector did and when.
   */
  #publishMeta(kind: string, data: unknown): void {
    if (kind !== 'connection') {
      const hash = createHash('sha256').update(JSON.stringify(data)).digest('hex')
      if (this.#metaHashes.get(kind) === hash) return
      this.#metaHashes.set(kind, hash)
    }
    this.#enqueue('meta', new Date(this.#deps.clock.now()), { kind, data })
  }

  /** The dropped list changed: count it, tape it, and write it. */
  #droppedChanged(): void {
    const properties = this.#droppedForRow()
    this.#deps.metrics.droppedProperties(properties.length)
    this.#publishMeta('droppedProperties', { properties })
    this.#persist()
  }

  // -------------------------------------------------------------------------
  // State and status
  // -------------------------------------------------------------------------

  /**
   * Move to a state: the gauge, a `connection` meta frame, a log line and a
   * status write, all of which are best-effort and none of which waits.
   *
   * `error` is the redacted reason, kept until a state that means all is well
   * (`signed_out`, `starting`, `subscribed`) clears it. `backoffUntil` is only
   * ever kept for `backing_off`: a stale one on a connector that is streaming
   * would have the page report it as backing off (see `writeRivianStatus`).
   */
  #enter(
    state: RivianConnectorState,
    opts: { error?: string; backoffUntil?: number } = {},
  ): void {
    this.#state = state
    if (state === 'signed_out' || state === 'starting' || state === 'subscribed') {
      this.#lastError = null
    }
    if (opts.error !== undefined) this.#lastError = opts.error
    this.#backoffUntil = state === 'backing_off' ? (opts.backoffUntil ?? null) : null

    this.#deps.metrics.setState(state)
    this.#log(this.#lastError === null ? `state: ${state}` : `state: ${state} (${this.#lastError})`)
    this.#publishMeta('connection', { state, reason: this.#lastError })
    this.#persist()
  }

  /**
   * Request a status write. Never awaited by anything that handles a frame
   * (rule 1): it only marks the row dirty and starts the writer if it is idle.
   */
  #persist(): void {
    if (this.#stopped) return
    this.#statusDirty = true
    if (!this.#statusBusy) this.#guarded(() => this.#writeStatus())
  }

  /**
   * One write at a time, each of the LATEST row. Writes that overlapped could
   * finish out of order and leave an older state in the table; a writer that
   * loops until nothing is dirty collapses a burst of changes into the row as
   * it stands. A failed write is logged and not retried until something else
   * changes (design §5.7): the next state change or frame will write it again.
   *
   * The row replaces the whole of the stored one, and so carries
   * `dropped_properties`. A write made before the saved list has ever been
   * read would replace it with an empty one, so the first thing a write does is
   * make sure the list has been read; if that cannot be done (the same blip
   * that is likely to have failed the write too) the write is skipped rather
   * than sent with a list that is only a guess.
   */
  async #writeStatus(): Promise<void> {
    this.#statusBusy = true
    try {
      while (this.#statusDirty && !this.#stopped) {
        this.#statusDirty = false
        try {
          await this.#loadSaved()
          if (!this.#loaded) {
            this.#log('status not written: the saved status could not be read')
            continue
          }
          await this.#withinTimeout(this.#deps.store.writeStatus(this.#row()))
        } catch {
          this.#log('status write failed; it is retried with the next change')
        }
      }
    } finally {
      this.#statusBusy = false
    }
  }

  #row(): Omit<RivianStatusRow, 'updatedAt'> {
    return {
      state: this.#state,
      vin: this.#deps.config.vin,
      rivianVehicleId: this.#vehicleId,
      lastFrameAt: this.#lastFrameAt,
      lastError: this.#lastError,
      backoffUntil: this.#backoffUntil === null ? null : new Date(this.#backoffUntil),
      droppedProperties: this.#droppedForRow(),
    }
  }

  /**
   * Read the saved status once, for the dropped list and the last frame time.
   * A failure is not remembered as "none": nothing is concluded from it, and it
   * is tried again by whatever needs it next.
   *
   * If a plan is already running it was started without the list, so the saved
   * names are carried alongside the plan's own (see `#carried`) instead of
   * being lost to the next write.
   */
  async #loadSaved(): Promise<void> {
    if (this.#loaded) return
    let row: RivianStatusRow | null
    try {
      row = await this.#withinTimeout(this.#deps.store.status())
    } catch {
      this.#log('reading the saved status failed')
      return
    }
    if (this.#loaded) return
    this.#loaded = true
    const saved = row?.droppedProperties ?? []
    // Merged, never replaced, in both branches. With no plan the connector's
    // own list can already hold names: a plan that ran before a sign-out
    // handed its dropped list over in `#halt`, and the read that failed was
    // made while that list was the only copy of what Rivian had rejected. The
    // saved names go in front, as they do in `#droppedForRow`.
    if (this.#plan === null) this.#dropped = unique([...saved, ...this.#dropped])
    else this.#carried = unique(saved)
    this.#lastFrameAt ??= row?.lastFrameAt ?? null
    this.#deps.metrics.droppedProperties(this.#droppedForRow().length)
  }

  /**
   * The dropped list as it stands: the plan's, plus any saved names the plan
   * does not know. A list carried this way can only grow until the next
   * restart, which reads the list properly; the alternative was an empty list
   * written over the one thing that stops a restart repeating the search.
   */
  #droppedForRow(): string[] {
    return unique([...this.#carried, ...(this.#plan?.dropped ?? this.#dropped)])
  }

  /** A plan for the vehicle, started from the catalogue, discovery so far, and the dropped list. */
  #newPlan(vehicleId: string): SubscriptionPlan {
    const plan = new SubscriptionPlan(vehicleId, {
      properties: [...CATALOGUE, ...this.#discovered],
      dropped: this.#dropped,
      parallaxRvms: this.#deps.config.parallaxRvms,
      now: this.#deps.clock.now(),
    })
    this.#carried = []
    this.#deps.metrics.droppedProperties(plan.dropped.length)
    return plan
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  #alive(epoch: number): boolean {
    return epoch === this.#epoch && !this.#stopped
  }

  /**
   * End whatever lifecycle is running: nothing from it acts again, the socket
   * is closed, and the session is forgotten. The dropped list is kept for the
   * next plan to start from. Backoff and `#reconnectAt` are deliberately kept
   * too (rule 2).
   */
  #halt(): void {
    this.#epoch += 1
    if (this.#plan !== null) {
      this.#dropped = this.#droppedForRow()
      this.#carried = []
      this.#plan = null
    }
    this.#dropConnection()
    this.#clearTimers(this.#sessionTimers)
    this.#token = null
    this.#app = null
    this.#vehicleId = null
  }

  /** Forget the socket: close it, and cancel everything that belonged to it. */
  #dropConnection(): void {
    this.#connId += 1
    const socket = this.#socket
    this.#socket = null
    if (socket !== null) this.#attempt(() => socket.close())
    this.#clearTimers(this.#connTimers)
    this.#silenceTimer = null
    this.#renewTimer = null
    this.#live.clear()
    this.#flowing = false
    this.#renewPending = false
  }

  #clearTimers(set: Set<unknown>): void {
    for (const handle of set) this.#deps.clock.clearTimeout(handle)
    set.clear()
  }

  #schedule(set: Set<unknown>, ms: number, fn: () => void | Promise<void>): unknown {
    const handle: unknown = this.#deps.clock.setTimeout(() => {
      set.delete(handle)
      this.#guarded(fn)
    }, ms)
    set.add(handle)
    return handle
  }

  /**
   * A database call that gives up after `STORE_TIMEOUT_MS`. The call itself is
   * not cancelled (there is nothing to cancel it with); its late answer is read
   * and thrown away.
   */
  #withinTimeout<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = this.#deps.clock.setTimeout(
        () => reject(new Error('timed out')),
        STORE_TIMEOUT_MS,
      )
      work.then(
        (value) => {
          this.#deps.clock.clearTimeout(timer)
          resolve(value)
        },
        (err: unknown) => {
          this.#deps.clock.clearTimeout(timer)
          reject(err instanceof Error ? err : new Error('failed'))
        },
      )
    })
  }

  /**
   * Run a callback from a timer, a handler or a promise chain that nothing is
   * waiting on, and report what it throws as a log line. An exception out of a
   * timer, or a rejection nobody handles, ends the process, and a connector
   * that restarts is a session that is torn down and rebuilt for nothing.
   * Everything expected is handled where it happens; this is for the rest, and
   * it names the class and nothing else (rule 4).
   */
  #guarded(fn: () => void | Promise<void>): void {
    try {
      const result = fn()
      if (result instanceof Promise) result.catch((e: unknown) => this.#unexpected(e))
    } catch (e) {
      this.#unexpected(e)
    }
  }

  /** Do something that may throw and does not matter if it does (closing a socket that is already gone). */
  #attempt(fn: () => void): void {
    try {
      fn()
    } catch {
      // See above.
    }
  }

  #unexpected(e: unknown): void {
    this.#log(`internal error: ${describeError(e)}`)
  }

  #log(line: string): void {
    // The sink is the caller's. A sink that throws must not take a lifecycle down.
    this.#attempt(() => this.#deps.log(line))
  }
}
