import pg from 'pg'

/**
 * A long-lived LISTEN subscription, and the connection it needs.
 *
 * This module exists in @ev/db rather than in apps/web for a hard reason and a
 * soft one. The hard one: `pg` is a dependency of this package alone and does
 * not resolve from apps/web under pnpm's isolated linker, so the import would
 * fail the build. The soft one: apps/web is driver-free even at the type level
 * (queries.ts declares a structural `Queryable` rather than importing pg), and
 * the five PG* variables are read in exactly one place — a fact the web
 * Deployment's env comment asserts.
 *
 * What lives here is connection mechanics only. Backoff policy, payload
 * parsing and what to do with a notification all live in the consumer.
 */

/** The subset of pg.Client this module uses, so tests can supply their own. */
export interface ListenerClient {
  connect(): Promise<void>
  query(sql: string): Promise<unknown>
  end(): Promise<void>
  /** 'error' | 'end' | 'notification' */
  on(event: string, fn: (arg?: any) => void): void
}

export interface ChangeListenerHandlers {
  /** The raw NOTIFY payload for this channel. Parse it in the consumer. */
  onPayload(raw: string): void
  /**
   * Connected, and LISTEN issued. Fired on the FIRST connect and on every
   * reconnect, because the consumer must resynchronise: notifications that
   * arrived while disconnected are gone and Postgres does not replay them.
   */
  onConnected(): void
  onError(err: unknown): void
}

export interface ChangeListenerOptions {
  createClient?: () => ListenerClient
  /** Delay before attempt N (0-based). Default: capped exponential, 0.5s→30s. */
  backoffMs?: (attempt: number) => number
  schedule?: (fn: () => void, ms: number) => void
}

export interface ChangeListener {
  start(): void
  stop(): Promise<void>
}

function defaultBackoff(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** attempt)
}

/**
 * Build the dedicated client.
 *
 * keepAlive is ON, and that is not incidental. Every recovery path in this
 * module is triggered by an 'error' or 'end' event, so a connection that dies
 * silently — the database's node hard-failing, a path partition, anything that
 * never delivers a FIN or RST — would deliver neither, and this listener would
 * sit healthy-looking and deaf for the lifetime of the process. `pg` defaults
 * keepAlive to false. With it on, the socket eventually fails ETIMEDOUT and the
 * ordinary reconnect path runs.
 */
function defaultClient(): ListenerClient {
  return new pg.Client({
    host: required('PGHOST'),
    port: Number(process.env['PGPORT'] ?? 5432),
    user: required('PGUSER'),
    password: required('PGPASSWORD'),
    database: required('PGDATABASE'),
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  }) as unknown as ListenerClient
}

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`missing required environment variable ${name}`)
  return v
}

export function createChangeListener(
  channel: string,
  handlers: ChangeListenerHandlers,
  opts: ChangeListenerOptions = {},
): ChangeListener {
  const create = opts.createClient ?? defaultClient
  const backoff = opts.backoffMs ?? defaultBackoff
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms).unref?.())

  let client: ListenerClient | null = null
  /**
   * Which connection attempt owns the current client.
   *
   * Load-bearing, not bookkeeping. One dropped pg connection emits 'error'
   * TWICE and then 'end' — the socket error path emits once, and the 'end'
   * handler emits again because the first path does not set the flag it checks.
   * Scheduling a reconnect per event would start three overlapping reconnect
   * loops for one drop, each building clients. Every handler carries the
   * generation it was attached for and does nothing if it is not current.
   */
  let generation = 0
  let attempt = 0
  let stopped = false

  const connect = (): void => {
    if (stopped) return
    const mine = ++generation
    // A used pg.Client throws "Client has already been connected. You cannot
    // reuse a client." on a second connect(), so recovery means a NEW client
    // every time, never a reconnect of the old one.
    const next = create()

    // BEFORE connect(), always: an 'error' emitted with no handler attached
    // throws out of the EventEmitter and takes the process down.
    next.on('error', (err?: unknown) => fail(mine, err))
    next.on('end', () => fail(mine, new Error('listener connection ended')))
    next.on('notification', (msg?: { channel?: string; payload?: string }) => {
      if (mine !== generation || !msg || msg.channel !== channel) return
      handlers.onPayload(msg.payload ?? '')
    })

    client = next
    next
      .connect()
      // The one place a value is interpolated into SQL, and it is both safe and
      // unavoidable: LISTEN takes an identifier, which cannot be a bound
      // parameter. The only caller passes the module constant
      // VEHICLE_CHANGED_CHANNEL.
      .then(() => next.query(`LISTEN ${channel}`))
      .then(() => {
        if (mine !== generation || stopped) return
        attempt = 0
        handlers.onConnected()
      })
      .catch((err: unknown) => fail(mine, err))
  }

  const fail = (mine: number, err: unknown): void => {
    if (stopped || mine !== generation) return
    // Bump immediately: every further event from this client is now stale and
    // the guard above will drop it, including the second 'error' and the 'end'.
    generation++
    handlers.onError(err)
    const wait = backoff(attempt++)
    schedule(connect, wait)
  }

  return {
    start(): void {
      if (client || stopped) return
      connect()
    },
    async stop(): Promise<void> {
      stopped = true
      generation++
      const current = client
      client = null
      await current?.end().catch(() => undefined)
    },
  }
}
