import type { RivianConnectorState, RivianStatusRow } from '@ev/db'
import {
  generateCredentialKeys,
  sealCredential,
  type RivianEnvelope,
  type RivianStream,
  type SubscriptionDocument,
} from '@ev/rivian'
import type { ConnectorConfig } from '../../src/config.js'
import { Connector, type Clock } from '../../src/connector.js'
import type { ConnectorMetrics } from '../../src/metrics.js'
import { Publisher, type MqttLike } from '../../src/publisher.js'
import { PublishQueue } from '../../src/queue.js'
import type { openSocket, SocketHandlers, SocketLike, SocketOpenError } from '../../src/socket.js'
import type { ConnectorStore } from '../../src/store.js'
import { FakeGateway } from './fake-gateway.js'

/**
 * Everything `connector.test.ts` needs to run a real `Connector` with nothing
 * real behind it: a clock the test advances, a store that can be made to fail,
 * a socket the test speaks for, an MQTT client that answers when told to, and
 * metrics that record. The queue, the publisher and the connector are the real
 * ones. The Rivian side of the wire is `FakeGateway`.
 */

/** Real jose work (a keypair, a seal, an unseal) is slow enough to be worth doing once. */
let keys: ReturnType<typeof generateCredentialKeys> | undefined

/** A VIN, and a session token no honest log line or status row could contain. */
export const VIN = '7PD2EAAB2VN016249'
export const TOKEN = 'tok-SECRET-userSession-0123456789'

/** One real macrotask turn, so everything that is only waiting on promises has run. */
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

export async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await turn()
}

/**
 * A clock that moves when the test says. `tick` runs every timer that falls
 * due, in order, with time set to each timer's own moment, and lets the
 * promise chains behind each one finish before the next fires.
 */
export class FakeClock implements Clock {
  #now: number
  #timers: { id: number; at: number; fn: () => void }[] = []
  #nextId = 1

  constructor(start: number) {
    this.#now = start
  }

  now(): number {
    return this.#now
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.#nextId++
    this.#timers.push({ id, at: this.#now + Math.max(0, ms), fn })
    return id
  }

  clearTimeout(h: unknown): void {
    this.#timers = this.#timers.filter((t) => t.id !== h)
  }

  async tick(ms: number): Promise<void> {
    const target = this.#now + ms
    await settle()
    for (;;) {
      const due = this.#timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (due === undefined) break
      this.#timers = this.#timers.filter((t) => t !== due)
      this.#now = Math.max(this.#now, due.at)
      due.fn()
      await settle()
    }
    this.#now = target
    await settle()
  }
}

export class FakeStore implements ConnectorStore {
  stamp: Date | null = null
  sealed = ''
  /** What `status()` answers. */
  statusRow: RivianStatusRow | null = null

  /** The next this-many `credentialStamp` calls throw. */
  stampFailures = 0
  /** `credentialStamp` returns a promise that never settles. */
  stampHangs = false
  statusReadFails = false
  credentialReadFails = false
  writeFails = false

  readonly writes: Omit<RivianStatusRow, 'updatedAt'>[] = []
  readonly calls = { stamp: 0, status: 0, credential: 0, write: 0 }

  async credentialStamp(): Promise<Date | null> {
    this.calls.stamp += 1
    if (this.stampHangs) return new Promise(() => {})
    if (this.stampFailures > 0) {
      this.stampFailures -= 1
      // What a real driver error can say: an address and a password.
      throw new Error('connect ECONNREFUSED postgres://ev:db-password-xyz@10.0.0.9:5432')
    }
    return this.stamp
  }

  async status(): Promise<RivianStatusRow | null> {
    this.calls.status += 1
    if (this.statusReadFails) throw new Error('status read failed: db-password-xyz')
    return this.statusRow
  }

  async credential(): Promise<{ sealed: string } | null> {
    this.calls.credential += 1
    if (this.credentialReadFails) throw new Error('credential read failed: db-password-xyz')
    return this.stamp === null ? null : { sealed: this.sealed }
  }

  async writeStatus(s: Omit<RivianStatusRow, 'updatedAt'>): Promise<void> {
    this.calls.write += 1
    if (this.writeFails) throw new Error('status write failed: db-password-xyz')
    this.writes.push(structuredClone(s))
  }
}

/** A socket the test speaks for: it records what the connector sends, and exposes the handlers. */
export class FakeSocket implements SocketLike {
  readonly subscribes: { id: string; doc: SubscriptionDocument }[] = []
  readonly completes: string[] = []
  /** Ids the SERVER ended (rejected, errored or completed), which the connector never completes itself. */
  readonly ended = new Set<string>()
  closed = false

  constructor(readonly handlers: SocketHandlers) {}

  subscribe(id: string, doc: SubscriptionDocument): void {
    this.subscribes.push({ id, doc })
  }

  complete(id: string): void {
    this.completes.push(id)
  }

  close(): void {
    this.closed = true
  }

  /** The subscription ids in force: subscribed, and neither completed by the connector nor ended by the server. */
  get liveIds(): string[] {
    return this.subscribes
      .map((s) => s.id)
      .filter((id) => !this.completes.includes(id) && !this.ended.has(id))
  }

  /** The server rejects `id` with `GRAPHQL_VALIDATION_FAILED`, which names no field. */
  reject(id: string): void {
    this.ended.add(id)
    this.handlers.onError(id, [{ extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }])
  }

  /** The server errors `id` for some other reason. */
  fail(id: string, code = 'INTERNAL_SERVER_ERROR'): void {
    this.ended.add(id)
    this.handlers.onError(id, [{ extensions: { code } }])
  }

  /** The server completes `id`. */
  end(id: string): void {
    this.ended.add(id)
    this.handlers.onComplete(id)
  }

  /** The live id for a plan key (`state:0`, `parallax`, ...). */
  idFor(key: string): string {
    const id = this.liveIds.filter((i) => i.startsWith(`${key}#`)).at(-1)
    if (id === undefined) throw new Error(`no live subscription for ${key}`)
    return id
  }

  /** The newest subscribe whose query selects this `vehicleState` property. */
  subscribeFor(property: string): { id: string; doc: SubscriptionDocument } | undefined {
    const pattern = new RegExp(`\\b${property}\\b`)
    return this.subscribes.filter((s) => pattern.test(s.doc.query)).at(-1)
  }
}

export interface FakeSockets {
  open: typeof openSocket
  sockets: FakeSocket[]
  opens: { url: string; initPayload: Record<string, string> }[]
  /** What the next opens do: `'ack'` (the default), or the error to reject with. */
  outcomes: ('ack' | SocketOpenError)[]
  /** While true, an open does not answer until `releaseOpens`. */
  hold: boolean
  releaseOpens(): void
}

export function fakeOpenSocket(): FakeSockets {
  const waiting: (() => void)[] = []
  const fake: FakeSockets = {
    sockets: [],
    opens: [],
    outcomes: [],
    hold: false,
    releaseOpens() {
      fake.hold = false
      for (const release of waiting.splice(0)) release()
    },
    open: async (opts) => {
      fake.opens.push({ url: opts.url, initPayload: opts.initPayload })
      if (fake.hold) await new Promise<void>((resolve) => waiting.push(resolve))
      const outcome = fake.outcomes.shift() ?? 'ack'
      if (outcome !== 'ack') throw outcome
      const socket = new FakeSocket(opts.handlers)
      fake.sockets.push(socket)
      return socket
    },
  }
  return fake
}

/** An MQTT client that acknowledges at once, or only when released. */
export class FakeMqtt implements MqttLike {
  readonly published: { topic: string; body: string; cb: (err?: Error) => void; acked: boolean }[] = []
  readonly ends: (boolean | undefined)[] = []
  /** While true, a publish waits for `release`. */
  held = false

  publish(
    topic: string,
    body: string,
    _opts: { qos: 1; retain: false },
    cb: (err?: Error) => void,
  ): void {
    const entry = { topic, body, cb, acked: false }
    this.published.push(entry)
    if (!this.held) {
      queueMicrotask(() => {
        entry.acked = true
        cb()
      })
    }
  }

  end(force?: boolean, cb?: () => void): void {
    this.ends.push(force)
    cb?.()
  }

  /** Acknowledge everything outstanding and stop holding. */
  release(): void {
    this.held = false
    for (const entry of [...this.published]) {
      if (!entry.acked) {
        entry.acked = true
        entry.cb()
      }
    }
  }

  /** What was published, parsed. */
  get envelopes(): (RivianEnvelope & { topic: string })[] {
    return this.published.map((p) => ({ topic: p.topic, ...(JSON.parse(p.body) as RivianEnvelope) }))
  }
}

export class RecordingMetrics implements ConnectorMetrics {
  readonly states: RivianConnectorState[] = []
  readonly frames: Record<string, number> = {}
  droppedTotal = 0
  publishFailures = 0
  readonly reconnects: string[] = []
  readonly droppedProps: number[] = []
  pollFailures = 0
  readonly lastFrames: number[] = []

  setState(s: RivianConnectorState): void {
    this.states.push(s)
  }
  frame(stream: RivianStream): void {
    this.frames[stream] = (this.frames[stream] ?? 0) + 1
  }
  dropped(n: number): void {
    this.droppedTotal += n
  }
  publishFailure(): void {
    this.publishFailures += 1
  }
  reconnect(reason: string): void {
    this.reconnects.push(reason)
  }
  droppedProperties(n: number): void {
    this.droppedProps.push(n)
  }
  pollFailure(): void {
    this.pollFailures += 1
  }
  lastFrame(atMs: number): void {
    this.lastFrames.push(atMs)
  }
}

export interface HarnessOptions {
  /** The publish queue's cap in bytes; the real 32 MiB by default. */
  capBytes?: number
  /** The jitter source for the backoff. Zero by default, so a wait is exactly its floor. */
  random?: () => number
  parallaxRvms?: string[] | null
}

export interface Harness {
  connector: Connector
  clock: FakeClock
  store: FakeStore
  gateway: FakeGateway
  mqtt: FakeMqtt
  queue: PublishQueue
  publisher: Publisher
  metrics: RecordingMetrics
  fake: FakeSockets
  logs: string[]
  /** The newest socket the connector opened. */
  socket: FakeSocket
  /** Seal a credential into the store under a fresh stamp. Does not poll. */
  signIn(token?: string): Promise<void>
  /** Store a credential that will not open, under a fresh stamp. */
  signInWithGarbage(): void
  /** Start the connector with a credential present, and wait for `subscribed`. */
  connect(): Promise<void>
  /** Wait, in real time, for a condition that depends on real asynchronous work. */
  until(predicate: () => boolean, what?: string): Promise<void>
  /** A `next` on the live subscription for this plan key, on the newest socket. */
  next(key: string, payload?: unknown): Promise<void>
  /** Frames published to a stream. */
  frames(stream: RivianStream): (RivianEnvelope & { topic: string })[]
  /** The `data` of every published `meta` frame of this kind. */
  meta(kind: string): unknown[]
}

export const START = Date.UTC(2026, 9, 19, 12)

export async function makeHarness(opts: HarnessOptions = {}): Promise<Harness> {
  keys ??= generateCredentialKeys()
  const { privateJwk, publicJwk } = await keys

  const clock = new FakeClock(START)
  const store = new FakeStore()
  const gateway = new FakeGateway(VIN)
  const mqtt = new FakeMqtt()
  const queue = new PublishQueue(opts.capBytes)
  const metrics = new RecordingMetrics()
  const fake = fakeOpenSocket()
  const logs: string[] = []

  const publisher = new Publisher(mqtt, queue, {
    onPublished: () => {},
    onFailure: () => metrics.publishFailure(),
  })
  const config: ConnectorConfig = {
    vin: VIN,
    privateJwk,
    mqtt: { url: 'tcp://broker.invalid:1883', username: 'rivian', password: 'mqtt-pw', clientId: 'ev-rivian' },
    parallaxRvms: opts.parallaxRvms ?? null,
    metricsPort: 0,
  }
  const connector = new Connector({
    config,
    store,
    http: gateway,
    openSocket: fake.open,
    queue,
    publisher,
    clock,
    random: opts.random ?? (() => 0),
    metrics,
    log: (line) => logs.push(line),
  })

  let stamps = 0
  const until: Harness['until'] = async (predicate, what = 'a condition') => {
    const deadline = Date.now() + 3_000
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }

  const h: Harness = {
    connector,
    clock,
    store,
    gateway,
    mqtt,
    queue,
    publisher,
    metrics,
    fake,
    logs,
    get socket() {
      const socket = fake.sockets.at(-1)
      if (socket === undefined) throw new Error('the connector has opened no socket')
      return socket
    },
    async signIn(token = TOKEN) {
      store.sealed = await sealCredential(publicJwk, { userSessionToken: token })
      stamps += 1
      store.stamp = new Date(START + stamps * 1_000)
    },
    signInWithGarbage() {
      store.sealed = 'not-a-jwe'
      stamps += 1
      store.stamp = new Date(START + stamps * 1_000)
    },
    async connect() {
      await h.signIn()
      connector.start()
      await until(() => connector.state === 'subscribed', 'state subscribed')
      await settle()
    },
    until,
    async next(key, payload = { data: {} }) {
      const socket = h.socket
      socket.handlers.onNext(socket.idFor(key), payload)
      await settle()
    },
    frames: (stream) => mqtt.envelopes.filter((e) => e.stream === stream),
    meta: (kind) =>
      mqtt.envelopes
        .filter((e) => e.stream === 'meta')
        .map((e) => e.body as { kind: string; data: unknown })
        .filter((b) => b.kind === kind)
        .map((b) => b.data),
  }
  return h
}
