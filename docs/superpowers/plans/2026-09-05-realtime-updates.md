# Real-time updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push current vehicle state to open browser pages within about a second of the ingest worker committing a sample, so the overview tiles and the activity pill stop being frozen at page-load time.

**Architecture:** The ingest runner issues `pg_notify` inside the transaction that wrote the sample. A dedicated Postgres connection in the web pod `LISTEN`s, and on each notification queries the vehicle once through the *same* query functions the REST routes use, then fans the result out to every open Server-Sent Events response. The browser holds one `EventSource` for the whole app, owns its own reconnection, and shows a live/stale indicator that distinguishes "the stream is down" from "the car is quiet".

**Tech Stack:** TypeScript, pnpm workspaces, node-postgres (`pg@8`), SvelteKit 2 + Svelte 5 runes, `@sveltejs/adapter-node`, Vitest, Postgres 17 (CNPG), Kubernetes + ArgoCD.

**Spec:** `docs/superpowers/specs/2026-09-05-realtime-updates-design.md` — read it before starting. Every task below argues from it.

## Global Constraints

- **`pg` may only be imported from `packages/db`.** It is not resolvable from `apps/web` or `apps/ingest` under pnpm's isolated linker. `apps/web` uses the structural `Queryable` type in `queries.ts`, never a `pg` type.
- **Anything added to `packages/db/src/` must be re-exported from `packages/db/src/index.ts`.** A module missing from that barrel does not exist to consumers, and the failure appears only in CI.
- **Svelte 5 runes only.** `$props()` not `export let`; never import from `svelte/store`. `test/ui-boundaries.test.ts` enforces both.
- **`apps/web` must never import `@ev/core/engine` or reference an engine symbol** (`summariseSession`, `deriveIdles`, `estimateCapacity`, `initialState`, `DEFAULT_SEGMENTER_OPTIONS`). `test/boundaries.test.ts` enforces this.
- **Indentation:** tabs in `apps/web`, two spaces in `packages/*` and `apps/ingest`. Match the file you are editing.
- **Import specifiers end in `.js`** even though the files are `.ts`.
- **Comments explain WHY, not what.** This codebase's comments carry the reasoning behind non-obvious decisions; match that density in new files.
- **Never construct `EventSource` outside `apps/web/src/lib/live.svelte.ts`.** Task 8 adds a boundary test pinning this.
- **Channel name:** `vehicle_changed`. **Notify payload:** `{vehicleId, ts, kind}` where `kind` is `'sample' | 'session'`.
- **Run tests from the repo root** with `pnpm test` (vitest workspace covers `packages/*` and `apps/*`), or scope with `pnpm vitest run --project @ev/db` / `--project @ev/ingest` / `--project web`.
- The database tests in `packages/db/test/repo.test.ts` skip unless `PGHOST` is set. To run them locally: `docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=ev --name ev-pg postgres:17` then `export PGHOST=localhost PGPORT=5432 PGUSER=postgres PGPASSWORD=pw PGDATABASE=ev`.

---

## File Structure

**Created:**
- `packages/db/src/repo/notify.ts` — the `pg_notify` statement and the payload type. One responsibility: emit a change notification on a `DbClient`.
- `packages/db/src/listen.ts` — `createChangeListener`: owns the dedicated `pg.Client`, its replacement on failure, the generation guard, and TCP keepalive. Knows nothing about vehicles or HTTP.
- `packages/db/test/notify.test.ts` — statement shape against a fake client; real-Postgres delivery-only-after-commit.
- `packages/db/test/listen.test.ts` — reconnect behaviour against an injected fake client factory.
- `apps/web/src/lib/server/live.ts` — the fan-out hub: subscribers, per-vehicle coalescing, query, broadcast. No `pg`, no HTTP.
- `apps/web/src/lib/server/notify-listener.ts` — the singleton wiring `createChangeListener` to the hub, with backoff and resync policy.
- `apps/web/src/routes/api/v1/stream/+server.ts` — the SSE endpoint.
- `apps/web/src/lib/live.svelte.ts` — the browser store: one `EventSource`, client-owned reconnect, staleness.
- `apps/web/src/lib/components/LiveIndicator.svelte` — live / reconnecting / last-seen.
- `apps/web/test/live-hub.test.ts`, `apps/web/test/stream-route.test.ts`, `apps/web/test/live-store.test.ts` — one per unit above.

**Modified:**
- `packages/db/src/index.ts` — export the two new modules.
- `apps/ingest/src/store.ts` — `pgRunner` gains the vehicle id and issues the notify.
- `apps/ingest/src/main.ts`, `apps/ingest/src/reprocess.ts` — `pgRunner` call sites.
- `apps/ingest/test/pipeline.test.ts` (or a new `apps/ingest/test/notify.test.ts`) — the three notify assertions.
- `apps/web/src/routes/vehicles/[id]/+page.svelte`, `apps/web/src/routes/vehicles/[id]/+layout.svelte`, `apps/web/src/routes/+page.svelte` — prefer live state over load-time data.
- `apps/web/test/boundaries.test.ts`, `apps/web/test/ui-boundaries.test.ts` — two new pins.
- `stack/clusters/prod/apps/ev/base/deployment-web.yaml`, `.../kustomization.yaml` (separate repo) — `SHUTDOWN_TIMEOUT` and the image tag.

---

## Task 1: Notify emission in `packages/db`

**Files:**
- Create: `packages/db/src/repo/notify.ts`
- Create: `packages/db/test/notify.test.ts`
- Modify: `packages/db/src/index.ts`

**Interfaces:**
- Consumes: `DbClient` from `./types.js`.
- Produces: `VEHICLE_CHANGED_CHANNEL: 'vehicle_changed'`, `interface VehicleChange { vehicleId: string; ts: string; kind: 'sample' | 'session' }`, `notifyVehicleChanged(c: DbClient, change: VehicleChange): Promise<void>`, `parseVehicleChange(raw: string): VehicleChange | null`.

- [ ] **Step 1: Write the failing test**

Create `packages/db/test/notify.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  notifyVehicleChanged,
  parseVehicleChange,
  VEHICLE_CHANGED_CHANNEL,
  type VehicleChange,
} from '../src/repo/notify.js'
import type { DbClient } from '../src/repo/types.js'

const CHANGE: VehicleChange = {
  vehicleId: 'v1',
  ts: '2026-09-05T10:00:00.000Z',
  kind: 'sample',
}

function fakeClient(): DbClient & { calls: Array<{ sql: string; values: unknown[] }> } {
  const calls: Array<{ sql: string; values: unknown[] }> = []
  return {
    calls,
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values })
      return { rows: [] }
    },
  } as unknown as DbClient & { calls: Array<{ sql: string; values: unknown[] }> }
}

describe('notifyVehicleChanged', () => {
  it('uses parameterised pg_notify, never string-built NOTIFY', async () => {
    const c = fakeClient()
    await notifyVehicleChanged(c, CHANGE)
    expect(c.calls).toHaveLength(1)
    expect(c.calls[0]!.sql).toMatch(/pg_notify/)
    // NOTIFY takes an identifier, not a parameter, so a literal NOTIFY would
    // have to be built by string concatenation. pg_notify is what keeps the
    // payload a bound parameter.
    expect(c.calls[0]!.sql).not.toMatch(/\bNOTIFY\s+\w/i)
    expect(c.calls[0]!.values).toEqual([VEHICLE_CHANGED_CHANNEL, JSON.stringify(CHANGE)])
  })
})

describe('parseVehicleChange', () => {
  it('reads back what notifyVehicleChanged writes', () => {
    expect(parseVehicleChange(JSON.stringify(CHANGE))).toEqual(CHANGE)
  })

  it('returns null rather than throwing on anything unexpected', () => {
    for (const bad of ['', 'not json', '[]', '{}', '{"vehicleId":1}', 'null']) {
      expect(parseVehicleChange(bad)).toBeNull()
    }
  })

  it('rejects an unknown kind, so a newer worker cannot inject a state we do not handle', () => {
    expect(parseVehicleChange('{"vehicleId":"v1","ts":"t","kind":"telepathy"}')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project @ev/db test/notify.test.ts`
Expected: FAIL — `Failed to resolve import "../src/repo/notify.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/db/src/repo/notify.ts`:

```ts
import type { DbClient } from './types.js'

/**
 * The one channel this system notifies on.
 *
 * A single channel rather than one per vehicle: `LISTEN` takes an identifier,
 * not a parameter, so per-vehicle channels would mean issuing DDL-shaped SQL
 * built by concatenation every time a vehicle appears — and the listener would
 * have to know the vehicle set before it could subscribe to it. One channel
 * with the id in the payload has neither problem.
 */
export const VEHICLE_CHANGED_CHANNEL = 'vehicle_changed'

/**
 * What a notification carries: identifiers, never rendered state.
 *
 * The reader queries the state back through the same functions the HTTP routes
 * use, so what the stream sends and what a page reload shows are produced by
 * one piece of code and cannot drift. See spec §3.2.
 *
 * `ts` is an ISO string rather than a Date because this round-trips through
 * JSON in the NOTIFY payload; typing it as Date would be a lie on the way out.
 */
export interface VehicleChange {
  vehicleId: string
  ts: string
  /** 'session' when a drive/charge opened or closed — that is what moves the
   *  activity pill. 'sample' for an ordinary state update. */
  kind: 'sample' | 'session'
}

/**
 * Emit a change notification on the current transaction.
 *
 * `pg_notify(channel, payload)` rather than `NOTIFY channel, 'payload'`:
 * NOTIFY's arguments are literals, so the payload would have to be built by
 * string concatenation into SQL. The function form takes bound parameters.
 *
 * Delivery is tied to COMMIT by Postgres itself, which is the property the
 * whole design rests on: a transaction that rolls back notifies nothing, with
 * no compensating logic anywhere.
 */
export async function notifyVehicleChanged(c: DbClient, change: VehicleChange): Promise<void> {
  await c.query('SELECT pg_notify($1, $2)', [VEHICLE_CHANGED_CHANNEL, JSON.stringify(change)])
}

/**
 * Read a payload back, defensively.
 *
 * Never throws. The payload crosses a process boundary from a worker that may
 * be a different version than the reader — the same reason `readEnvelope` in
 * the ingest pipeline is written this way. An unreadable notification is a
 * dropped update, which the next sample repairs; an exception here would take
 * out the listener that would have delivered it.
 */
export function parseVehicleChange(raw: string): VehicleChange | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const o = parsed as Record<string, unknown>
  const { vehicleId, ts, kind } = o
  if (typeof vehicleId !== 'string' || vehicleId === '') return null
  if (typeof ts !== 'string' || ts === '') return null
  if (kind !== 'sample' && kind !== 'session') return null
  return { vehicleId, ts, kind }
}
```

- [ ] **Step 4: Export from the barrel**

In `packages/db/src/index.ts`, add below `export * from './repo/cursor.js'`:

```ts
export * from './repo/notify.js'
```

- [ ] **Step 4b: Build `packages/db`**

```bash
pnpm --filter @ev/db build
```

`packages/db/package.json` has no `exports` map — it declares `"main": "./dist/index.js"` — and nothing aliases the package to `src`. Consumers therefore resolve through `dist/`, so a new module is invisible to `apps/ingest` and `apps/web` until this runs. CI only survives because `test.yml` builds first.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run --project @ev/db test/notify.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Add the real-Postgres test that delivery waits for COMMIT**

Append to `packages/db/test/repo.test.ts`, inside the existing `describe` that has a live pool (follow the file's existing `hasDb` guard style — copy the guard expression used by the neighbouring tests):

```ts
  it('delivers a notification only after the transaction commits', async () => {
    const pool = getPool()
    const listener = await pool.connect()
    const received: string[] = []
    listener.on('notification', (msg) => received.push(msg.payload ?? ''))
    await listener.query(`LISTEN ${VEHICLE_CHANGED_CHANNEL}`)

    const change = { vehicleId: VEHICLE, ts: TS.toISOString(), kind: 'sample' as const }

    // A transaction that rolls back must deliver nothing.
    await withTransaction(pool, async (c) => {
      await notifyVehicleChanged(c, change)
      throw new Error('rollback')
    }).catch(() => undefined)
    await new Promise((r) => setTimeout(r, 200))
    expect(received).toEqual([])

    // A transaction that commits must deliver exactly once.
    await withTransaction(pool, (c) => notifyVehicleChanged(c, change))
    await new Promise((r) => setTimeout(r, 200))
    expect(received).toEqual([JSON.stringify(change)])

    // UNLISTEN before the connection goes back to the pool: a subscription
    // that followed it back would deliver into a later test's client.
    await listener.query('UNLISTEN *')
    listener.release()
  })
```

Add to that file's imports: `import { notifyVehicleChanged, VEHICLE_CHANGED_CHANNEL } from '../src/repo/notify.js'`.

- [ ] **Step 7: Run the database tests**

Run (with `PGHOST` etc. exported per Global Constraints): `pnpm vitest run --project @ev/db`
Expected: PASS. Without `PGHOST` the new test skips with the others — that is expected locally, but CI runs it.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/repo/notify.ts packages/db/src/index.ts packages/db/test/notify.test.ts packages/db/test/repo.test.ts
git commit -m "feat(db): emit vehicle change notifications inside the writing transaction"
```

---

## Task 2: The listening connection in `packages/db`

**Files:**
- Create: `packages/db/src/listen.ts`
- Create: `packages/db/test/listen.test.ts`
- Modify: `packages/db/src/index.ts`

**Interfaces:**
- Consumes: nothing from Task 1 at runtime (the channel name is passed in by the caller).
- Produces: `createChangeListener(channel: string, handlers: ChangeListenerHandlers, opts?: ChangeListenerOptions): ChangeListener`, with `interface ChangeListenerHandlers { onPayload(raw: string): void; onConnected(): void; onError(err: unknown): void }`, `interface ChangeListener { start(): void; stop(): Promise<void> }`, `interface ListenerClient { connect(): Promise<void>; query(sql: string): Promise<unknown>; end(): Promise<void>; on(event: 'error' | 'end', fn: (err?: unknown) => void): void }`, `interface ChangeListenerOptions { createClient?: () => ListenerClient; backoffMs?: (attempt: number) => number; schedule?: (fn: () => void, ms: number) => void }`.

**Read the spec's §3.4 bullet list before writing this file.** Three of the four rules below exist because `pg` behaves in a way the obvious implementation gets wrong.

- [ ] **Step 1: Write the failing test**

Create `packages/db/test/listen.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createChangeListener, type ListenerClient } from '../src/listen.js'

/**
 * A stand-in for pg.Client that reproduces the two behaviours this module
 * exists to survive: a client cannot be reconnected once used, and one dropped
 * connection emits 'error' twice and then 'end'.
 */
class FakeClient implements ListenerClient {
  static made: FakeClient[] = []
  connects = 0
  queries: string[] = []
  ended = false
  private handlers = new Map<string, Array<(err?: unknown) => void>>()

  constructor() {
    FakeClient.made.push(this)
  }

  async connect(): Promise<void> {
    this.connects++
    if (this.connects > 1) throw new Error('Client has already been connected. You cannot reuse a client.')
  }

  async query(sql: string): Promise<unknown> {
    this.queries.push(sql)
    return { rows: [] }
  }

  async end(): Promise<void> {
    this.ended = true
  }

  on(event: 'error' | 'end', fn: (err?: unknown) => void): void {
    const list = this.handlers.get(event) ?? []
    list.push(fn)
    this.handlers.set(event, list)
  }

  /** What one real dropped connection emits, in order. */
  drop(): void {
    this.emit('error', new Error('connection terminated unexpectedly'))
    this.emit('error', new Error('connection terminated unexpectedly'))
    this.emit('end')
  }

  emit(event: string, err?: unknown): void {
    for (const fn of this.handlers.get(event) ?? []) fn(err)
  }

  hasHandler(event: string): boolean {
    return (this.handlers.get(event) ?? []).length > 0
  }
}

function harness() {
  FakeClient.made = []
  const scheduled: Array<() => void> = []
  const connected: number[] = []
  const payloads: string[] = []
  const errors: unknown[] = []
  const listener = createChangeListener(
    'vehicle_changed',
    {
      onPayload: (raw) => payloads.push(raw),
      onConnected: () => connected.push(1),
      onError: (err) => errors.push(err),
    },
    {
      createClient: () => new FakeClient(),
      backoffMs: () => 1000,
      schedule: (fn) => scheduled.push(fn),
    }
  )
  return { listener, scheduled, connected, payloads, errors }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('createChangeListener', () => {
  it('LISTENs on the channel once connected and reports it', async () => {
    const h = harness()
    h.listener.start()
    await settle()
    expect(FakeClient.made).toHaveLength(1)
    expect(FakeClient.made[0]!.queries).toEqual(['LISTEN vehicle_changed'])
    expect(h.connected).toEqual([1])
  })

  it('attaches error and end handlers BEFORE connecting', async () => {
    // An 'error' with no listener throws out of the EventEmitter and takes the
    // process down, so the window between construction and connect() must not
    // exist.
    const h = harness()
    h.listener.start()
    await settle()
    expect(FakeClient.made[0]!.hasHandler('error')).toBe(true)
    expect(FakeClient.made[0]!.hasHandler('end')).toBe(true)
  })

  it('builds a NEW client on reconnect, because a used one cannot be reconnected', async () => {
    const h = harness()
    h.listener.start()
    await settle()
    FakeClient.made[0]!.drop()
    await settle()
    h.scheduled.forEach((fn) => fn())
    await settle()
    expect(FakeClient.made).toHaveLength(2)
    expect(FakeClient.made[1]!.queries).toEqual(['LISTEN vehicle_changed'])
    expect(h.connected).toEqual([1, 1])
  })

  it('schedules exactly one reconnect for one drop, despite error+error+end', async () => {
    const h = harness()
    h.listener.start()
    await settle()
    FakeClient.made[0]!.drop()
    await settle()
    expect(h.scheduled).toHaveLength(1)
  })

  it('ignores events from a superseded client', async () => {
    const h = harness()
    h.listener.start()
    await settle()
    const first = FakeClient.made[0]!
    first.drop()
    await settle()
    h.scheduled.forEach((fn) => fn())
    await settle()
    // The dead client emits again — a real socket does this — and it must not
    // schedule a second reconnect loop on top of the live client.
    const before = h.scheduled.length
    first.drop()
    await settle()
    expect(h.scheduled).toHaveLength(before)
  })

  it('forwards notification payloads for this channel only', async () => {
    const h = harness()
    h.listener.start()
    await settle()
    FakeClient.made[0]!.emit('notification', { channel: 'vehicle_changed', payload: 'a' })
    FakeClient.made[0]!.emit('notification', { channel: 'something_else', payload: 'b' })
    expect(h.payloads).toEqual(['a'])
  })

  it('stops cleanly and does not reconnect after stop', async () => {
    const h = harness()
    h.listener.start()
    await settle()
    await h.listener.stop()
    expect(FakeClient.made[0]!.ended).toBe(true)
    FakeClient.made[0]!.drop()
    await settle()
    expect(h.scheduled).toHaveLength(0)
  })
})
```

Note the test emits `'notification'` through `FakeClient.emit`, so the fake's `on` must accept that event name too — widen `ListenerClient['on']` to `(event: string, fn: (arg?: any) => void) => void` if TypeScript objects, and keep the narrow union in the doc comment.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project @ev/db test/listen.test.ts`
Expected: FAIL — cannot resolve `../src/listen.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/db/src/listen.ts`:

```ts
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
```

`LISTEN ${channel}` is the one place a value is interpolated into SQL. It is safe and unavoidable — `LISTEN` takes an identifier, which cannot be a bound parameter — and the only caller passes the module constant `VEHICLE_CHANGED_CHANNEL`. Add that as a comment above the line.

- [ ] **Step 4: Export from the barrel**

In `packages/db/src/index.ts`, add:

```ts
export * from './listen.js'
```

- [ ] **Step 4b: Build `packages/db`**

```bash
pnpm --filter @ev/db build
```

Same reason as Task 1 Step 4b: `@ev/db` resolves through `dist/`, so consumers cannot see `src/`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run --project @ev/db test/listen.test.ts`
Expected: PASS (7 tests). If the "stops cleanly" test fails because `stop()` raced a pending connect, check that `stopped` is consulted in `connect` as well as `fail`.

- [ ] **Step 6: Typecheck**

Run: `pnpm -r typecheck`
Expected: clean. `apps/web` does not import this module yet.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/listen.ts packages/db/src/index.ts packages/db/test/listen.test.ts
git commit -m "feat(db): dedicated LISTEN connection with generation-guarded reconnect"
```

---

## Task 3: Notify from the ingest runner

**Files:**
- Modify: `apps/ingest/src/store.ts`
- Modify: `apps/ingest/src/main.ts:63` (the `new Pipeline(pgRunner(...))` call)
- Modify: `apps/ingest/test/startup.test.ts:66` — a third `pgRunner` call site the compiler will flag
- Create: `apps/ingest/test/notify.test.ts`
- Verify unchanged: `apps/ingest/src/reprocess.ts` — it builds its own runner and must keep doing so.

**Interfaces:**
- Consumes: `notifyVehicleChanged`, `VehicleChange` from `@ev/db` (Task 1).
- Produces: `pgRunner(pool: DbPool, cursorSource: string, vehicleId: string): StoreRunner` — **note the new third parameter** — and `vehicleChangeFrom(result: unknown, vehicleId: string): VehicleChange | null`.

**Why the runner and not the `Store`:** read spec §3.4. Two independent reasons: `reprocess.ts` builds its own runner over the same `storeOn`, so a `Store`-level notify would fire once per replayed sample for an entire tape replay; and the runner is the only place that sees the `PipelineResult`, which is what makes "notify once per sample" possible instead of "once per field message".

- [ ] **Step 1: Write the failing test**

Create `apps/ingest/test/notify.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { vehicleChangeFrom } from '../src/store.js'

const TS = new Date('2026-09-05T10:00:00.000Z')

const result = (over: Record<string, unknown> = {}) => ({
  samples: 0, sessionsOpened: 0, sessionsClosed: 0,
  fieldsApplied: 0, unmapped: 0, lastSampleTs: null,
  ...over,
})

describe('vehicleChangeFrom', () => {
  it('notifies for a transaction that wrote a sample', () => {
    expect(vehicleChangeFrom(result({ samples: 1, lastSampleTs: TS }), 'v1')).toEqual({
      vehicleId: 'v1', ts: TS.toISOString(), kind: 'sample',
    })
  })

  it('reports kind "session" when a session opened or closed', () => {
    expect(vehicleChangeFrom(result({ samples: 1, sessionsOpened: 1, lastSampleTs: TS }), 'v1')?.kind)
      .toBe('session')
    expect(vehicleChangeFrom(result({ samples: 1, sessionsClosed: 1, lastSampleTs: TS }), 'v1')?.kind)
      .toBe('session')
  })

  /**
   * The reason the notify is keyed off the result rather than issued once per
   * transaction. fleet-telemetry publishes ONE FIELD PER MESSAGE and the
   * accumulator debounces a burst into one sample, so transactions outnumber
   * samples by roughly ten to one and most of them write nothing anyone can
   * see. Notifying per transaction would make the web tier re-query for an
   * unchanged answer nine times out of ten.
   */
  it('does NOT notify for a message that only fed the accumulator', () => {
    expect(vehicleChangeFrom(result({ fieldsApplied: 1 }), 'v1')).toBeNull()
  })

  it('does NOT notify for an unmapped message', () => {
    expect(vehicleChangeFrom(result({ unmapped: 1 }), 'v1')).toBeNull()
  })

  it('returns null for anything that is not a PipelineResult', () => {
    for (const bad of [null, undefined, 'x', 42, {}, []]) {
      expect(vehicleChangeFrom(bad, 'v1')).toBeNull()
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project @ev/ingest test/notify.test.ts`
Expected: FAIL — `vehicleChangeFrom` is not exported from `../src/store.js`.

- [ ] **Step 3: Implement `vehicleChangeFrom` and wire it into `pgRunner`**

In `apps/ingest/src/store.ts`, add `notifyVehicleChanged` and `type VehicleChange` to the existing `@ev/db` import, then replace `pgRunner` with:

```ts
/**
 * Does this unit of work contain anything a viewer could see?
 *
 * Keyed off the RESULT rather than the transaction, and that distinction is the
 * whole design. fleet-telemetry publishes one field per message, and the
 * accumulator debounces a burst of them into a single sample, so transactions
 * are about ten times more frequent than samples and most of them do nothing
 * but add a value to the accumulator. Notifying per transaction would wake the
 * web tier — and cost it a query — for an answer that has not changed.
 *
 * Typed as `unknown` because StoreRunner.run is generic: `reprocess` and the
 * tests hand it callbacks returning other things. A shape that is not a
 * PipelineResult simply does not notify.
 */
export function vehicleChangeFrom(result: unknown, vehicleId: string): VehicleChange | null {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null
  const r = result as Record<string, unknown>
  const num = (k: string): number => (typeof r[k] === 'number' ? (r[k] as number) : 0)
  const opened = num('sessionsOpened')
  const closed = num('sessionsClosed')
  if (num('samples') === 0 && opened === 0 && closed === 0) return null
  // Stamped with the observation's time, not the wall clock, so a replayed or
  // late message describes when the car was in this state rather than when we
  // heard about it. Nothing observable landed without one, so its absence means
  // there is nothing to announce.
  const ts = r['lastSampleTs']
  if (!(ts instanceof Date)) return null
  return {
    vehicleId,
    ts: ts.toISOString(),
    kind: opened > 0 || closed > 0 ? 'session' : 'sample',
  }
}

/**
 * One `run()` is one transaction. Everything a single MQTT message produces —
 * the raw row, its samples, the session rows, the watermark — commits together
 * or not at all, which is what lets the caller ack only after a commit.
 *
 * The change notification is issued HERE, inside that transaction, rather than
 * from a Store method, for two reasons that both matter:
 *
 *  - `reprocess.ts` builds its own runner over the same `storeOn`, and replays
 *    an entire window inside ONE transaction. A Store-level notify would queue
 *    one pg_notify per replayed sample — potentially hundreds of thousands,
 *    delivered in a single burst at COMMIT — and set the web tier querying for
 *    as long as it took to drain, for nothing anyone asked to see. Placing it
 *    here means a replay notifies nothing, with no flag to remember to set.
 *  - Only the runner sees the PipelineResult, which is what makes "notify once
 *    per sample" possible rather than once per field message.
 *
 * Inside the transaction, so a rollback un-notifies exactly as it un-writes.
 */
export function pgRunner(pool: DbPool, cursorSource: string, vehicleId: string): StoreRunner {
  return {
    run: (fn) =>
      withTransaction(pool, async (client) => {
        const out = await fn(storeOn(client, cursorSource))
        const change = vehicleChangeFrom(out, vehicleId)
        if (change) await notifyVehicleChanged(client, change)
        return out
      }),
  }
}
```

- [ ] **Step 4: Update the call site in `main.ts`**

In `apps/ingest/src/main.ts`, change:

```ts
  const pipeline = new Pipeline(pgRunner(pool, config.cursorSource), {
```

to:

```ts
  const pipeline = new Pipeline(pgRunner(pool, config.cursorSource, config.vehicle.id), {
```

- [ ] **Step 4b: Update the other call site**

`apps/ingest/test/startup.test.ts:66` also calls `pgRunner`, and the compiler will flag it. Change:

```ts
    const pipeline = new Pipeline(pgRunner(getPool(), 'startup-test'), {
```

to pass that file's vehicle constant as the third argument (read the file for its name — it is the id used by the surrounding assertions):

```ts
    const pipeline = new Pipeline(pgRunner(getPool(), 'startup-test', VEHICLE), {
```

Leaving it two-argument would compile under a default and then emit `vehicleId: undefined` in a notification the moment that test ever produced a sample.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run --project @ev/ingest`
Expected: PASS, including the existing pipeline/mqtt/startup suites. `reprocess.ts` needs no change — confirm by reading `apps/ingest/src/reprocess.ts:57-60`: it constructs `{ run: (fn) => fn(storeOn(client, config.cursorSource)) }` inline and never calls `pgRunner`.

- [ ] **Step 6: Add the rollback assertion**

Append to `apps/ingest/test/notify.test.ts`:

```ts
import { withTransaction } from '@ev/db'
```

…and a test that exercises `pgRunner` against a fake pool, asserting the notify statement is issued for a sample-producing result, is absent for an accumulator-only result, and is absent when the callback throws:

```ts
describe('pgRunner', () => {
  function fakePool(): { pool: any; sql: string[] } {
    const sql: string[] = []
    const client = {
      query: async (text: string) => { sql.push(text); return { rows: [] } },
      release: () => undefined,
    }
    return { pool: { connect: async () => client } as any, sql }
  }

  it('notifies inside the transaction when a sample was written', async () => {
    const { pool, sql } = fakePool()
    const { pgRunner } = await import('../src/store.js')
    await pgRunner(pool, 'test', 'v1').run(async () => ({
      samples: 1, sessionsOpened: 0, sessionsClosed: 0,
      fieldsApplied: 0, unmapped: 0, lastSampleTs: TS,
    }))
    const notifyAt = sql.findIndex((s) => s.includes('pg_notify'))
    expect(notifyAt).toBeGreaterThan(-1)
    expect(sql[0]).toBe('BEGIN')
    expect(sql[sql.length - 1]).toBe('COMMIT')
    expect(notifyAt).toBeLessThan(sql.length - 1)
  })

  it('does not notify when the transaction rolls back', async () => {
    const { pool, sql } = fakePool()
    const { pgRunner } = await import('../src/store.js')
    await pgRunner(pool, 'test', 'v1')
      .run(async () => { throw new Error('boom') })
      .catch(() => undefined)
    expect(sql.some((s) => s.includes('pg_notify'))).toBe(false)
    expect(sql).toContain('ROLLBACK')
  })

  it('does not notify for a message that only fed the accumulator', async () => {
    const { pool, sql } = fakePool()
    const { pgRunner } = await import('../src/store.js')
    await pgRunner(pool, 'test', 'v1').run(async () => ({
      samples: 0, sessionsOpened: 0, sessionsClosed: 0,
      fieldsApplied: 1, unmapped: 0, lastSampleTs: null,
    }))
    expect(sql.some((s) => s.includes('pg_notify'))).toBe(false)
  })
})
```

- [ ] **Step 7: Add the regression pin that reprocess never notifies**

Append to the same file:

```ts
/**
 * The property the runner placement exists for, pinned so a later refactor
 * that "tidies" the notify onto the Store fails here instead of in production
 * during a tape replay.
 */
describe('reprocess', () => {
  it('constructs its own runner and therefore cannot notify', () => {
    const src = readFileSync(new URL('../src/reprocess.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/pgRunner/)
    expect(src).toMatch(/run:\s*\(fn\)\s*=>\s*fn\(storeOn\(/)
  })

  it('keeps the notify out of the Store interface', () => {
    const src = readFileSync(new URL('../src/pipeline.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/notify/i)
  })
})
```

Add `import { readFileSync } from 'node:fs'` to the top of the file.

- [ ] **Step 8: Run the full suite and typecheck**

Run: `pnpm test && pnpm -r typecheck`
Expected: PASS, clean.

- [ ] **Step 9: Commit**

```bash
git add apps/ingest/src/store.ts apps/ingest/src/main.ts apps/ingest/test/notify.test.ts
git commit -m "feat(ingest): notify once per sample from the runner, never from a replay"
```

---

## Task 4: The fan-out hub in `apps/web`

**Files:**
- Create: `apps/web/src/lib/server/live.ts`
- Create: `apps/web/test/live-hub.test.ts`

**Interfaces:**
- Consumes: `VehicleChange` from `@ev/db` (Task 1); `getVehicle`, `listVehicles` from `$lib/server/queries.js`; `VehicleWithState` from `$lib/api-types.js`.
- Produces: `createHub(deps: HubDeps): Hub`, where `interface HubDeps { getVehicle(id: string): Promise<VehicleWithState>; listVehicles(): Promise<VehicleWithState[]>; onError?(err: unknown): void }`, `interface LiveSubscriber { send(event: string, data: unknown): void }`, `interface Hub { add(sub: LiveSubscriber): () => void; size(): number; handle(change: VehicleChange): void; resync(): void; snapshot(sub: LiveSubscriber): Promise<void> }`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/live-hub.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createHub } from '../src/lib/server/live.js'
import type { VehicleWithState } from '../src/lib/api-types.js'

const entry = (id: string, soc = 50): VehicleWithState =>
	({
		vehicle: { id, displayName: id } as never,
		state: { vehicleId: id, ts: '2026-09-05T10:00:00.000Z', socPct: soc } as never,
		activity: 'parked',
		openSessionId: null
	}) as VehicleWithState

function sub() {
	const sent: Array<{ event: string; data: unknown }> = []
	return { sent, send: (event: string, data: unknown) => sent.push({ event, data }) }
}

const change = (vehicleId = 'v1') =>
	({ vehicleId, ts: '2026-09-05T10:00:00.000Z', kind: 'sample' }) as const

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('createHub', () => {
	it('queries once per notification and sends to every subscriber', async () => {
		const getVehicle = vi.fn(async (id: string) => entry(id))
		const hub = createHub({ getVehicle, listVehicles: async () => [entry('v1')] })
		const a = sub()
		const b = sub()
		hub.add(a)
		hub.add(b)

		hub.handle(change())
		await settle()

		// One query, N writes — the reason the payload is fetched server-side
		// rather than by each client.
		expect(getVehicle).toHaveBeenCalledTimes(1)
		expect(a.sent).toEqual([{ event: 'vehicle', data: entry('v1') }])
		expect(b.sent).toEqual([{ event: 'vehicle', data: entry('v1') }])
	})

	it('collapses a burst of notifications for one vehicle into one trailing query', async () => {
		let resolve!: (v: VehicleWithState) => void
		const getVehicle = vi.fn(
			() => new Promise<VehicleWithState>((r) => { resolve = r })
		)
		const hub = createHub({ getVehicle, listVehicles: async () => [] })
		hub.add(sub())

		hub.handle(change())
		hub.handle(change())
		hub.handle(change())
		expect(getVehicle).toHaveBeenCalledTimes(1)

		resolve(entry('v1'))
		await settle()
		// One re-query for everything that arrived while the first was in flight,
		// not one per notification.
		expect(getVehicle).toHaveBeenCalledTimes(2)
	})

	it('keeps vehicles independent', async () => {
		const getVehicle = vi.fn(async (id: string) => entry(id))
		const hub = createHub({ getVehicle, listVehicles: async () => [] })
		hub.add(sub())
		hub.handle(change('v1'))
		hub.handle(change('v2'))
		await settle()
		expect(getVehicle).toHaveBeenCalledTimes(2)
	})

	it('drops a notification whose query fails, without disturbing subscribers', async () => {
		const errors: unknown[] = []
		const hub = createHub({
			getVehicle: async () => { throw new Error('db down') },
			listVehicles: async () => [],
			onError: (e) => errors.push(e)
		})
		const s = sub()
		hub.add(s)
		hub.handle(change())
		await settle()
		expect(s.sent).toEqual([])
		expect(errors).toHaveLength(1)
		expect(hub.size()).toBe(1)
		// Counted, so a hub dropping everything is distinguishable from a quiet
		// fleet without reading the logs.
		expect(hub.stats().dropped).toBe(1)
	})

	it('unsubscribes exactly one subscriber', async () => {
		const hub = createHub({ getVehicle: async (id) => entry(id), listVehicles: async () => [] })
		const a = sub()
		const b = sub()
		const off = hub.add(a)
		hub.add(b)
		off()
		expect(hub.size()).toBe(1)
		hub.handle(change())
		await settle()
		expect(a.sent).toEqual([])
		expect(b.sent).toHaveLength(1)
	})

	it('resync sends every vehicle to every subscriber', async () => {
		const hub = createHub({
			getVehicle: async (id) => entry(id),
			listVehicles: async () => [entry('v1'), entry('v2')]
		})
		const s = sub()
		hub.add(s)
		hub.resync()
		await settle()
		expect(s.sent.map((m) => m.event)).toEqual(['vehicle', 'vehicle'])
	})

	it('snapshot sends the current fleet to one subscriber only', async () => {
		const hub = createHub({
			getVehicle: async (id) => entry(id),
			listVehicles: async () => [entry('v1'), entry('v2')]
		})
		const a = sub()
		const b = sub()
		hub.add(a)
		hub.add(b)
		await hub.snapshot(a)
		expect(a.sent).toHaveLength(2)
		expect(b.sent).toHaveLength(0)
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project web test/live-hub.test.ts`
Expected: FAIL — cannot resolve `../src/lib/server/live.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/lib/server/live.ts`:

```ts
import type { VehicleChange } from '@ev/db'
import type { VehicleWithState } from '$lib/api-types.js'

/**
 * The fan-out: notifications in, rendered vehicle state out to open streams.
 *
 * Deliberately knows nothing about Postgres and nothing about HTTP. Its
 * dependencies are two query functions and its subscribers are anything with a
 * `send`, which is what lets the whole of it be tested without a database or a
 * server — and what keeps the SSE route down to plumbing.
 */

export interface LiveSubscriber {
	send(event: string, data: unknown): void
}

export interface HubDeps {
	getVehicle(id: string): Promise<VehicleWithState>
	listVehicles(): Promise<VehicleWithState[]>
	onError?(err: unknown): void
}

export interface HubStats {
	/** Notifications whose query failed, so the update was dropped. */
	dropped: number
	/** Vehicle updates written to at least one subscriber. */
	sent: number
}

export interface Hub {
	/** Register a stream. Returns the unsubscribe. */
	add(sub: LiveSubscriber): () => void
	size(): number
	/** Counted, not just logged: a listener that is quietly dropping every
	 *  update looks identical to a quiet car in the logs. */
	stats(): HubStats
	/** A change landed: query once, send to everyone. */
	handle(change: VehicleChange): void
	/** Push the whole fleet to everyone. Used after a listener reconnect. */
	resync(): void
	/** Push the whole fleet to one subscriber. Used when a stream opens. */
	snapshot(sub: LiveSubscriber): Promise<void>
}

/** The one event name a vehicle update is sent under. */
export const VEHICLE_EVENT = 'vehicle'

export function createHub(deps: HubDeps): Hub {
	const subscribers = new Set<LiveSubscriber>()
	/**
	 * Vehicles with a query in flight, and whether another change arrived while
	 * it was running.
	 *
	 * Without this, a car reporting faster than the query returns would queue an
	 * unbounded number of identical queries, each answering the same question.
	 * Collapsing them to "one in flight, one pending" means the extra
	 * notifications cost nothing and the last one is still honoured — the state
	 * sent is always at least as fresh as the newest notification seen.
	 */
	const inFlight = new Map<string, { pending: boolean }>()

	const stats = { dropped: 0, sent: 0 }

	const fail = (err: unknown): void => {
		// A failed query is a dropped update, not a broken stream: the next
		// sample produces another notification within seconds, and the heartbeat
		// keeps clients from concluding the connection is dead meanwhile.
		stats.dropped++
		deps.onError?.(err)
	}

	const broadcast = (entry: VehicleWithState): void => {
		if (subscribers.size > 0) stats.sent++
		for (const sub of subscribers) {
			try {
				sub.send(VEHICLE_EVENT, entry)
			} catch (err) {
				// One wedged stream must not stop the others being served.
				fail(err)
			}
		}
	}

	const pump = (vehicleId: string): void => {
		const state = inFlight.get(vehicleId)
		if (state) {
			state.pending = true
			return
		}
		inFlight.set(vehicleId, { pending: false })
		void deps
			.getVehicle(vehicleId)
			.then(broadcast, fail)
			.finally(() => {
				const again = inFlight.get(vehicleId)?.pending ?? false
				inFlight.delete(vehicleId)
				if (again) pump(vehicleId)
			})
	}

	return {
		add(sub: LiveSubscriber): () => void {
			subscribers.add(sub)
			return () => subscribers.delete(sub)
		},
		size: () => subscribers.size,
		stats: () => ({ ...stats }),
		handle(change: VehicleChange): void {
			if (subscribers.size === 0) return
			pump(change.vehicleId)
		},
		resync(): void {
			if (subscribers.size === 0) return
			void deps.listVehicles().then((all) => all.forEach(broadcast), fail)
		},
		async snapshot(sub: LiveSubscriber): Promise<void> {
			// Awaited, unlike resync: the caller is opening a stream and wants the
			// current state on it before anything incremental arrives.
			try {
				for (const entry of await deps.listVehicles()) sub.send(VEHICLE_EVENT, entry)
			} catch (err) {
				fail(err)
			}
		}
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run --project web test/live-hub.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/server/live.ts apps/web/test/live-hub.test.ts
git commit -m "feat(web): fan-out hub that queries once per change and coalesces bursts"
```

---

## Task 5: Wire the listener singleton

**Files:**
- Create: `apps/web/src/lib/server/notify-listener.ts`

**Interfaces:**
- Consumes: `createChangeListener`, `parseVehicleChange`, `VEHICLE_CHANGED_CHANNEL` from `@ev/db` (Tasks 1–2); `createHub`, `Hub` from `./live.js` (Task 4); `getVehicle`, `listVehicles` from `./queries.js`.
- Produces: `getLiveHub(): Hub` — lazily starts the listener on first call and returns the process-wide hub.

- [ ] **Step 1: Write the implementation** (no separate unit test: this module is dependency wiring, and both halves it wires are tested in Tasks 2 and 4; Task 6's route test exercises it end-to-end through `getLiveHub`)

Create `apps/web/src/lib/server/notify-listener.ts`:

```ts
import {
	createChangeListener,
	parseVehicleChange,
	VEHICLE_CHANGED_CHANNEL,
	type ChangeListener
} from '@ev/db'
import { createHub, type Hub } from './live.js'
import { getVehicle, listVehicles } from './queries.js'

/**
 * The process-wide bridge from Postgres notifications to open streams.
 *
 * Started lazily, on the first stream to open, rather than at module load. A
 * pod that nobody is watching should not hold a database connection open, and
 * more practically: module load happens during `vite build`'s SSR analysis and
 * in unit tests, neither of which has a database to connect to.
 *
 * There is deliberately no `stop()`. The listener lives as long as the process,
 * and the process is killed by Kubernetes; adding a teardown path would create
 * a second state ("stopped but a stream is open") that nothing needs.
 */
let hub: Hub | undefined
let listener: ChangeListener | undefined

export function getLiveHub(): Hub {
	if (hub) return hub

	hub = createHub({
		getVehicle: (id) => getVehicle(id),
		listVehicles: async () => (await listVehicles()).vehicles,
		onError: (err) => console.error('live hub', err)
	})

	listener = createChangeListener(VEHICLE_CHANGED_CHANNEL, {
		onPayload: (raw) => {
			const change = parseVehicleChange(raw)
			// A payload we cannot read is dropped, never thrown: it crosses a
			// process boundary from a worker that may be a different version, and
			// the next sample repairs the miss.
			if (change) hub!.handle(change)
			else console.warn('live: unparseable notification payload')
		},
		// Fires on the first connect and on every reconnect. Resyncing on the
		// first is harmless; resyncing on the rest is essential, because
		// notifications that arrived while disconnected are gone and Postgres
		// does not replay them.
		onConnected: () => hub!.resync(),
		onError: (err) => console.error('live listener', err)
	})
	listener.start()

	return hub
}
```

- [ ] **Step 2: Build the workspace, then typecheck**

```bash
pnpm -r build && pnpm -r typecheck
```

Expected: clean. The build is not optional here: `@ev/db` resolves through `dist/`, so a `notifyVehicleChanged` that exists only in `src/` typechecks against a stale `dist/index.d.ts` and fails at runtime with "does not provide an export named". If exports are still missing, confirm Task 1 Step 4 and Task 2 Step 4 both landed in the barrel.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/server/notify-listener.ts
git commit -m "feat(web): wire the change listener to the fan-out hub"
```

---

## Task 6: The SSE endpoint

**Files:**
- Create: `apps/web/src/routes/api/v1/stream/+server.ts`
- Create: `apps/web/test/stream-route.test.ts`

**Interfaces:**
- Consumes: `getLiveHub` from `$lib/server/notify-listener.js` (Task 5); `VEHICLE_EVENT` from `$lib/server/live.js` (Task 4).
- Produces: `GET /api/v1/stream`, and the exported constants `HEARTBEAT_MS = 20_000`, `RETRY_MS = 2_000`, plus `formatEvent(event: string, data: unknown): string` and `openStream(hub, opts)` for testing.

**Two things here are easy to get wrong:**

1. **The heartbeat must be a named event, not an SSE comment.** A comment line (`: hb`) keeps proxies from timing the connection out, but `EventSource` never surfaces it — so the client could not use it to detect a connection that is open but dead. It is sent as `event: heartbeat` for that reason.
2. **`retry:` is sent in the opening bytes.** The browser's 3-second default is what makes a pod restart window fatal (see spec §3.5).

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/stream-route.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { formatEvent, GET, openStream, HEARTBEAT_MS, RETRY_MS } from '../src/routes/api/v1/stream/+server.js'
import type { Hub, LiveSubscriber } from '../src/lib/server/live.js'

function fakeHub(): Hub & { subs: LiveSubscriber[]; unsubscribed: number } {
	const subs: LiveSubscriber[] = []
	const hub = {
		subs,
		unsubscribed: 0,
		add(sub: LiveSubscriber) {
			subs.push(sub)
			return () => { hub.unsubscribed++ }
		},
		size: () => subs.length,
		stats: () => ({ dropped: 0, sent: 0 }),
		handle: () => undefined,
		resync: () => undefined,
		snapshot: async (sub: LiveSubscriber) => {
			sub.send('vehicle', { vehicle: { id: 'v1' } })
		}
	}
	return hub as Hub & { subs: LiveSubscriber[]; unsubscribed: number }
}

async function read(stream: ReadableStream<Uint8Array>, chunks: number): Promise<string> {
	const reader = stream.getReader()
	const decoder = new TextDecoder()
	let out = ''
	for (let i = 0; i < chunks; i++) {
		const { value, done } = await reader.read()
		if (done) break
		out += decoder.decode(value)
	}
	reader.releaseLock()
	return out
}

describe('formatEvent', () => {
	it('emits a well-formed SSE frame', () => {
		expect(formatEvent('vehicle', { a: 1 })).toBe('event: vehicle\ndata: {"a":1}\n\n')
	})

	it('never emits a bare newline inside data, which would split the frame', () => {
		const frame = formatEvent('vehicle', { note: 'line1\nline2' })
		expect(frame.split('\n').filter((l) => l.startsWith('data: '))).toHaveLength(1)
	})
})

describe('openStream', () => {
	it('opens with a retry hint, because the 3s browser default is too short for a restart', async () => {
		const hub = fakeHub()
		const { stream } = openStream(hub, { setInterval: () => 0 as never, clearInterval: () => undefined })
		expect(await read(stream, 1)).toBe(`retry: ${RETRY_MS}\n\n`)
	})

	it('sends the current fleet before anything incremental', async () => {
		const hub = fakeHub()
		const { stream } = openStream(hub, { setInterval: () => 0 as never, clearInterval: () => undefined })
		const text = await read(stream, 2)
		expect(text).toContain('event: vehicle')
		expect(text).toContain('"id":"v1"')
	})

	it('heartbeats as a NAMED EVENT so the client can see it', async () => {
		const hub = fakeHub()
		let beat: (() => void) | undefined
		const { stream } = openStream(hub, {
			setInterval: (fn: () => void) => { beat = fn; return 1 as never },
			clearInterval: () => undefined
		})
		await read(stream, 2)
		beat!()
		// A comment frame (': hb') is invisible to EventSource, so a dead-but-open
		// connection would be undetectable by the client.
		expect(await read(stream, 1)).toContain('event: heartbeat')
	})

	it('unregisters from the hub and stops the heartbeat when the client goes away', async () => {
		const hub = fakeHub()
		const cleared: number[] = []
		const { stream } = openStream(hub, {
			setInterval: () => 7 as never,
			clearInterval: (id: number) => cleared.push(id)
		})
		await read(stream, 1)
		await stream.cancel()
		expect(hub.unsubscribed).toBe(1)
		expect(cleared).toEqual([7])
	})

	it('heartbeats well inside a proxy idle timeout', () => {
		expect(HEARTBEAT_MS).toBeLessThanOrEqual(30_000)
	})
})

describe('GET', () => {
	/**
	 * The handler's own refusal, not just the gate's. hooks.server.ts already
	 * turns an unauthenticated /api/ request away, but this route is the one
	 * place a stream could be opened, and a future change to the gate must not
	 * silently make it public.
	 */
	it('refuses a request with no session', async () => {
		await expect(GET({ locals: {} } as never)).rejects.toMatchObject({ status: 401 })
	})

	it('returns 503 rather than an open stream when the database is unreachable', async () => {
		vi.doMock('$lib/server/db.js', () => ({
			getPool: () => ({ query: async () => { throw new Error('down') } })
		}))
		const { GET: freshGet } = await import('../src/routes/api/v1/stream/+server.js?503')
		await expect(freshGet({ locals: { user: { sub: 'u' } } } as never)).rejects.toMatchObject({
			status: 503
		})
		vi.doUnmock('$lib/server/db.js')
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project web test/stream-route.test.ts`
Expected: FAIL — cannot resolve the route module.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/routes/api/v1/stream/+server.ts`:

```ts
import { error } from '@sveltejs/kit'
import type { RequestHandler } from './$types.js'
import { getLiveHub } from '$lib/server/notify-listener.js'
import { getPool } from '$lib/server/db.js'
import type { Hub, LiveSubscriber } from '$lib/server/live.js'

/**
 * The live stream: one connection per browser tab, every vehicle on it.
 *
 * One account-wide endpoint rather than one per vehicle because the garage
 * page shows every car — per-vehicle endpoints would open N connections there
 * to deliver what one can. The app is single-tenant (one ALLOWED_SUBJECT, no
 * tenancy), so "every vehicle" and "every vehicle this viewer may see" are the
 * same set and nothing has to be filtered.
 */

/**
 * Under a proxy's idle timeout, and under the client's own dead-connection
 * threshold, with room for one to be missed.
 */
export const HEARTBEAT_MS = 20_000

/**
 * What the browser waits before retrying a dropped stream.
 *
 * The default is 3s, and a single-replica deployment's restart window is
 * comfortably longer than that — every retry landing inside it gets Traefik's
 * 503, which closes an EventSource permanently. The client owns its own
 * reconnect for that reason (see lib/live.svelte.ts); this only tightens the
 * built-in retry for the ordinary case of a clean drop.
 */
export const RETRY_MS = 2_000

/** One SSE frame. `data` is JSON, so it can never contain a raw newline. */
export function formatEvent(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

interface Timers {
	setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval>
	clearInterval(id: ReturnType<typeof setInterval>): void
}

/**
 * Build the response body. Separated from the handler so the framing, the
 * heartbeat and the teardown can be tested without a SvelteKit runtime.
 */
export function openStream(
	hub: Hub,
	timers: Timers = { setInterval, clearInterval }
): { stream: ReadableStream<Uint8Array> } {
	const encoder = new TextEncoder()
	let unsubscribe: (() => void) | undefined
	let beat: ReturnType<typeof setInterval> | undefined

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const write = (chunk: string): void => {
				try {
					controller.enqueue(encoder.encode(chunk))
				} catch {
					// The client vanished between the check and the write. Nothing to
					// do: cancel() has run or is about to.
				}
			}

			write(`retry: ${RETRY_MS}\n\n`)

			const subscriber: LiveSubscriber = {
				send: (event, data) => write(formatEvent(event, data))
			}
			unsubscribe = hub.add(subscriber)

			// The current fleet before anything incremental, so a client that
			// reconnects after missing updates cannot sit on a stale value: what it
			// missed is exactly what this replaces.
			void hub.snapshot(subscriber)

			// A NAMED event, not an SSE comment. A comment keeps proxies from
			// timing the connection out but is invisible to EventSource, so the
			// client could not distinguish "quiet" from "dead" — which is half of
			// what the live/stale indicator has to answer.
			beat = timers.setInterval(() => write(formatEvent('heartbeat', { t: Date.now() })), HEARTBEAT_MS)
		},
		cancel() {
			unsubscribe?.()
			if (beat !== undefined) timers.clearInterval(beat)
		}
	})

	return { stream }
}

export const GET: RequestHandler = async ({ locals }) => {
	// Same refusal as every other /api/v1 route. Note this is checked once, at
	// open: an authenticated stream stays open until it drops, and the session
	// expiring is caught on the client's next reconnect (lib/live.svelte.ts).
	if (!locals.user) throw error(401, 'unauthorized')

	// Refuse rather than hand back a stream that cannot carry anything. One
	// cheap query at open — not per event — and it is what makes the client's
	// reconnect loop meaningful: a 503 is a definite answer it can back off
	// against, where an open-but-silent stream is indistinguishable from a
	// parked car.
	try {
		await getPool().query('SELECT 1')
	} catch {
		throw error(503, 'database unavailable')
	}

	const { stream } = openStream(getLiveHub())

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			// No store, no transform: an intermediary that buffered this would
			// defeat the whole point, and one that "helpfully" compressed it would
			// hold frames until its window filled.
			'cache-control': 'no-store',
			connection: 'keep-alive',
			// Harmless under Traefik, which does not buffer; correct if anything
			// nginx-shaped is ever put in front.
			'x-accel-buffering': 'no'
		}
	})
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run --project web test/stream-route.test.ts`
Expected: PASS (9 tests). If the 503 test's module mocking proves awkward under this vitest version, assert the same thing by extracting the check into an exported `assertDatabaseReachable()` and testing that directly — the requirement is that a 503 is returned, not how the test reaches it. If the import of `./$types.js` fails under vitest, run `pnpm --filter @ev/web exec svelte-kit sync` first.

- [ ] **Step 5: Verify the route is gated, not public**

Run: `pnpm vitest run --project web test/auth.test.ts`
Expected: PASS. `/api/v1/stream` is not in `PUBLIC_PATHS`, so `hooks.server.ts` refuses it by default — Task 8 pins that.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/api/v1/stream/+server.ts apps/web/test/stream-route.test.ts
git commit -m "feat(web): SSE endpoint with snapshot-on-connect and visible heartbeats"
```

---

## Task 7: The browser store

**Files:**
- Create: `apps/web/src/lib/live.svelte.ts`
- Create: `apps/web/test/live-store.test.ts`

**Interfaces:**
- Consumes: `VehicleWithState` from `$lib/api-types.js`.
- Produces: `createLiveStore(opts?: LiveStoreOptions): LiveStore` with `interface LiveStore { readonly vehicles: Record<string, VehicleWithState>; readonly connection: 'connecting' | 'open' | 'reconnecting'; readonly lastEventAt: number | null; start(): void; stop(): void; get(id: string): VehicleWithState | undefined }`, the singleton `live`, and the constants `STREAM_DEAD_MS = 45_000`, `PROBE_AFTER_FAILURES = 3`.

**The central fact this file exists for:** `EventSource` only retries a connection that *drops*. A retry that receives a non-200 — the `text/plain` 401 when the session expires, the 503 when Postgres is down, Traefik's own 503 during a pod restart — closes it permanently, with `readyState === CLOSED` and no further attempts. That is silent, permanent death of the feature, so the store owns reconnection itself.

- [ ] **Step 0: Teach vitest to compile `.svelte.ts` — MANDATORY, do this first**

`apps/web/vitest.config.ts`'s hand-rolled plugin transforms `.svelte` only. A `.svelte.ts` module goes through esbuild, which leaves `$state` as an undefined global — and `live.svelte.ts` calls `createLiveStore()` at module scope, so the ReferenceError fires at import, before any test runs. There is no `.svelte.ts` in the repo today, so this path has never been exercised. It also breaks Task 8: `components.test.ts` renders the pages that will import this module, and those 36 tests pass today.

`compileModule` alone is not enough — it has no TypeScript parser and throws `js_parse_error` on an `interface`. Strip types first. In `apps/web/vitest.config.ts`, change the import to `import { compile, compileModule } from 'svelte/compiler'`, add `import { transformWithEsbuild } from 'vite'`, and replace the plugin's `transform` with:

```ts
		/**
		 * A .svelte.ts module carries runes too, and esbuild leaves `$state` as an
		 * undefined global — a ReferenceError at import, before a single test
		 * runs. compileModule is what handles runes outside a component, and it
		 * has no TypeScript parser, so the types come off first.
		 */
		async transform(_code, id) {
			if (id.endsWith('.svelte.ts')) {
				const stripped = await transformWithEsbuild(readFileSync(id, 'utf8'), id, { loader: 'ts' })
				const { js } = compileModule(stripped.code, { filename: id, generate: 'server' })
				return { code: js.code, map: js.map }
			}
			if (!id.endsWith('.svelte')) return null
			const source = readFileSync(id, 'utf8')
			const { js } = compile(source, {
				filename: id,
				generate: 'server',
				css: 'injected'
			})
			return { code: js.code, map: js.map }
		}
```

Verify before continuing: `pnpm vitest run --project web` must still be green (the whole suite, unchanged).

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/live-store.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createLiveStore, STREAM_DEAD_MS, PROBE_AFTER_FAILURES } from '../src/lib/live.svelte.js'

class FakeSource {
	static made: FakeSource[] = []
	static readonly CLOSED = 2
	static readonly OPEN = 1
	readyState = 1
	closed = false
	listeners = new Map<string, Array<(e: unknown) => void>>()

	constructor(public url: string) {
		FakeSource.made.push(this)
	}

	addEventListener(type: string, fn: (e: unknown) => void): void {
		const l = this.listeners.get(type) ?? []
		l.push(fn)
		this.listeners.set(type, l)
	}

	close(): void {
		this.closed = true
		this.readyState = 2
	}

	emit(type: string, data?: unknown): void {
		for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) })
	}

	fail(): void {
		this.readyState = 2
		for (const fn of this.listeners.get('error') ?? []) fn({})
	}
}

const entry = (id: string, soc: number) =>
	({ vehicle: { id }, state: { vehicleId: id, socPct: soc }, activity: 'driving', openSessionId: 's1' })

function harness(over: Record<string, unknown> = {}) {
	FakeSource.made = []
	const scheduled: Array<{ fn: () => void; ms: number }> = []
	const store = createLiveStore({
		// The web project runs in vitest's `node` environment, so `window` is
		// undefined and the real browser guard would make start() a no-op.
		browser: true,
		createSource: (url: string) => new FakeSource(url) as never,
		schedule: (fn: () => void, ms: number) => { scheduled.push({ fn, ms }); return 0 as never },
		// Separate from `schedule` so `scheduled` holds reconnect attempts only —
		// the watchdog arms itself on every connect and would otherwise be the
		// first entry in the array these tests index into.
		scheduleWatchdog: () => 0 as never,
		unschedule: () => undefined,
		now: () => 1_000_000,
		probe: async () => 200,
		...over
	})
	return { store, scheduled }
}

describe('createLiveStore', () => {
	it('records vehicles by id from the vehicle event', () => {
		const h = harness()
		h.store.start()
		FakeSource.made[0]!.emit('vehicle', entry('v1', 61))
		expect(h.store.get('v1')?.state?.socPct).toBe(61)
		expect(h.store.connection).toBe('open')
	})

	it('reconnects with a NEW EventSource after a failure, because a closed one never retries', () => {
		const h = harness()
		h.store.start()
		FakeSource.made[0]!.fail()
		expect(h.store.connection).toBe('reconnecting')
		expect(h.scheduled).toHaveLength(1)
		h.scheduled[0]!.fn()
		expect(FakeSource.made).toHaveLength(2)
	})

	it('backs off between attempts rather than hammering a pod that is restarting', () => {
		const h = harness()
		h.store.start()
		FakeSource.made[0]!.fail()
		h.scheduled[0]!.fn()
		FakeSource.made[1]!.fail()
		expect(h.scheduled[1]!.ms).toBeGreaterThan(h.scheduled[0]!.ms)
	})

	it('resets the backoff once a connection succeeds', () => {
		const h = harness()
		h.store.start()
		FakeSource.made[0]!.fail()
		h.scheduled[0]!.fn()
		FakeSource.made[1]!.emit('vehicle', entry('v1', 50))
		FakeSource.made[1]!.fail()
		expect(h.scheduled[1]!.ms).toBe(h.scheduled[0]!.ms)
	})

	it('closes the old source before opening a new one, so they cannot both run', () => {
		const h = harness()
		h.store.start()
		FakeSource.made[0]!.fail()
		h.scheduled[0]!.fn()
		expect(FakeSource.made[0]!.closed).toBe(true)
		// And the replacement is live, not closed — otherwise this passes on a
		// store that simply gave up.
		expect(FakeSource.made[1]!.closed).toBe(false)
	})

	it('treats a heartbeat as liveness without touching vehicle state', () => {
		const h = harness()
		h.store.start()
		FakeSource.made[0]!.emit('vehicle', entry('v1', 50))
		const before = h.store.lastEventAt
		FakeSource.made[0]!.emit('heartbeat', { t: 1 })
		expect(h.store.lastEventAt).toBe(before)
		expect(h.store.get('v1')?.state?.socPct).toBe(50)
	})

	it('probes for a lost session after repeated failures and redirects on 401', async () => {
		const redirects: string[] = []
		const h = harness({
			probe: async () => 401,
			redirect: (to: string) => redirects.push(to)
		})
		h.store.start()
		for (let i = 0; i < PROBE_AFTER_FAILURES; i++) {
			FakeSource.made[FakeSource.made.length - 1]!.fail()
			h.scheduled[h.scheduled.length - 1]!.fn()
		}
		await new Promise((r) => setTimeout(r, 0))
		expect(redirects).toEqual(['/auth/login'])
	})

	it('stops cleanly', () => {
		const h = harness()
		h.store.start()
		h.store.stop()
		expect(FakeSource.made[0]!.closed).toBe(true)
		FakeSource.made[0]!.fail()
		expect(FakeSource.made).toHaveLength(1)
	})

	it('declares a silent connection dead well inside two heartbeats', () => {
		expect(STREAM_DEAD_MS).toBeGreaterThan(40_000)
		expect(STREAM_DEAD_MS).toBeLessThan(60_000)
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project web test/live-store.test.ts`
Expected: FAIL — cannot resolve `../src/lib/live.svelte.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/lib/live.svelte.ts`:

```ts
import type { VehicleWithState } from '$lib/api-types.js'

/**
 * The browser's end of the live stream. One EventSource for the whole app.
 *
 * WHY THIS OWNS ITS RECONNECT, when EventSource has one built in: the built-in
 * retry covers a connection that DROPS. A retry that gets a response back does
 * not retry again — per the HTML spec, a non-200 status or the wrong
 * content-type fails the connection permanently: readyState goes to CLOSED and
 * that is the end of it. This app produces exactly those responses on exactly
 * this endpoint: a text/plain 401 when the session expires behind an open tab,
 * a 503 when the database is down, and — on a single-replica deployment —
 * Traefik's own 503 for the seconds a pod takes to restart, which the 3-second
 * default retry lands squarely inside. Left to the browser, one deploy would
 * silently kill live updates in every open tab until someone reloaded, which is
 * the exact failure this feature exists to remove.
 */

/** No heartbeat and no event for this long means the connection is dead. */
export const STREAM_DEAD_MS = 45_000

/** Consecutive failures before we suspect the session rather than the pod. */
export const PROBE_AFTER_FAILURES = 3

const STREAM_URL = '/api/v1/stream'
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000]

export type ConnectionState = 'connecting' | 'open' | 'reconnecting'

export interface LiveStoreOptions {
	/** Defaults to `typeof window !== 'undefined'`. Tests drive the store directly. */
	browser?: boolean
	createSource?: (url: string) => EventSource
	schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
	/** The watchdog's timer, separate so a test can inspect the reconnect queue alone. */
	scheduleWatchdog?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
	unschedule?: (id: ReturnType<typeof setTimeout>) => void
	now?: () => number
	/** Returns the status code of an authenticated probe request. */
	probe?: () => Promise<number>
	redirect?: (to: string) => void
}

export interface LiveStore {
	readonly vehicles: Record<string, VehicleWithState>
	readonly connection: ConnectionState
	/** When the last VEHICLE update landed. Heartbeats do not move this: they
	 *  prove the stream is alive, not that the car said anything. */
	readonly lastEventAt: number | null
	start(): void
	stop(): void
	get(id: string): VehicleWithState | undefined
}

export function createLiveStore(opts: LiveStoreOptions = {}): LiveStore {
	const createSource = opts.createSource ?? ((url: string) => new EventSource(url))
	const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms))
	const scheduleWatchdog = opts.scheduleWatchdog ?? schedule
	const unschedule = opts.unschedule ?? ((id) => clearTimeout(id))
	const browser = opts.browser ?? typeof window !== 'undefined'
	const now = opts.now ?? (() => Date.now())
	const probe = opts.probe ?? (async () => (await fetch('/api/v1/vehicles')).status)
	const redirect = opts.redirect ?? ((to: string) => { window.location.href = to })

	let vehicles = $state<Record<string, VehicleWithState>>({})
	let connection = $state<ConnectionState>('connecting')
	let lastEventAt = $state<number | null>(null)

	let source: EventSource | null = null
	let failures = 0
	let stopped = false
	let watchdog: ReturnType<typeof setTimeout> | undefined
	let lastAnyAt = 0

	const armWatchdog = (): void => {
		if (watchdog !== undefined) unschedule(watchdog)
		watchdog = scheduleWatchdog(() => {
			// Open but silent for longer than two heartbeats: the socket is up as
			// far as the browser knows and nothing is coming through it. Treat it
			// as a failure so the ordinary reconnect path runs.
			if (!stopped && now() - lastAnyAt >= STREAM_DEAD_MS) onFailure()
			else armWatchdog()
		}, STREAM_DEAD_MS)
	}

	const alive = (): void => {
		lastAnyAt = now()
		failures = 0
		connection = 'open'
	}

	const connect = (): void => {
		if (stopped) return
		// A used EventSource is never reused: close it, build a new one. Leaving
		// the old one attached would double every event if it ever recovered.
		source?.close()
		const next = createSource(STREAM_URL)
		source = next

		next.addEventListener('open', () => alive())
		next.addEventListener('heartbeat', () => alive())
		next.addEventListener('vehicle', (e) => {
			alive()
			try {
				const entry = JSON.parse((e as MessageEvent).data) as VehicleWithState
				const id = entry?.vehicle?.id
				if (!id) return
				// Reassigned rather than mutated: $state tracks the assignment, and a
				// deep mutation of a value that arrived as JSON would not notify.
				vehicles = { ...vehicles, [id]: entry }
				lastEventAt = now()
			} catch {
				// A frame we cannot read is a dropped update, not a broken stream.
			}
		})
		next.addEventListener('error', () => onFailure())

		lastAnyAt = now()
		armWatchdog()
	}

	const onFailure = (): void => {
		if (stopped) return
		connection = 'reconnecting'
		source?.close()
		source = null
		const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]!
		failures++
		if (failures >= PROBE_AFTER_FAILURES) void checkSession()
		schedule(connect, wait)
	}

	/**
	 * Is the stream failing because we are signed out?
	 *
	 * It cannot be read off the error event — that is a bare Event with no
	 * status — so after enough consecutive failures we ask an endpoint that
	 * answers plainly. Retrying forever against a gate that will keep refusing
	 * is the alternative, and it looks identical to an outage.
	 */
	const checkSession = async (): Promise<void> => {
		try {
			if ((await probe()) === 401) redirect('/auth/login')
		} catch {
			// The probe failing is itself uninformative — the network is down, which
			// the reconnect loop already handles.
		}
	}

	return {
		get vehicles() { return vehicles },
		get connection() { return connection },
		get lastEventAt() { return lastEventAt },
		start(): void {
			// Browser only. During SSR there is no EventSource, and a page that
			// constructed one while rendering on the server would throw on every
			// request.
			if (!browser || source || stopped) return
			connect()
		},
		stop(): void {
			stopped = true
			source?.close()
			source = null
			if (watchdog !== undefined) unschedule(watchdog)
		},
		get: (id: string) => vehicles[id]
	}
}

/** The app-wide instance. Components read this; nothing else builds one. */
export const live = createLiveStore()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run --project web test/live-store.test.ts`
Expected: PASS (9 tests). If vitest rejects `$state` in a `.svelte.ts` file, confirm `apps/web/vitest.config.ts`'s plugin transforms `.svelte.ts` as well as `.svelte` — if it does not, extend the plugin's `transform` to run `compileModule` from `svelte/compiler` on files ending `.svelte.ts`, matching the existing plugin's style and comment density.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/live.svelte.ts apps/web/test/live-store.test.ts
git commit -m "feat(web): browser live store that owns its own reconnect"
```

---

## Task 8: Wire the UI and pin the boundaries

**Files:**
- Create: `apps/web/src/lib/components/LiveIndicator.svelte`
- Modify: `apps/web/src/routes/vehicles/[id]/+layout.svelte`
- Modify: `apps/web/src/routes/vehicles/[id]/+page.svelte`
- Modify: `apps/web/src/routes/+page.svelte`
- Modify: `apps/web/test/boundaries.test.ts`, `apps/web/test/ui-boundaries.test.ts`
- Modify: `apps/web/test/components.test.ts`

**Interfaces:**
- Consumes: `live` from `$lib/live.svelte.js` (Task 7).
- Produces: `LiveIndicator` taking `{ connection: ConnectionState; lastEventAt: number | null }`.

- [ ] **Step 1: Write the failing component test**

Append to `apps/web/test/components.test.ts` (match the file's existing `render`-from-`svelte/server` style):

```ts
describe('LiveIndicator', () => {
	it('says live when connected and something arrived recently', () => {
		const { body } = render(LiveIndicator, {
			props: { connection: 'open', lastEventAt: Date.now() }
		})
		expect(body).toContain('Live')
	})

	/**
	 * The honesty requirement from spec §3.6: two different things can be wrong
	 * and the indicator must not conflate them. A connected stream over a quiet
	 * car is normal — a parked car reports nothing for hours — while a dropped
	 * stream is a fault. Claiming "Live" over an hour-old number is worse than
	 * saying nothing at all.
	 */
	it('reports a quiet car differently from a broken stream', () => {
		const quiet = render(LiveIndicator, {
			props: { connection: 'open', lastEventAt: Date.now() - 3_600_000 }
		}).body
		const broken = render(LiveIndicator, {
			props: { connection: 'reconnecting', lastEventAt: Date.now() }
		}).body
		expect(quiet).not.toContain('Live')
		expect(broken).not.toContain('Live')
		expect(quiet).not.toBe(broken)
		expect(broken).toContain('Reconnecting')
	})

	it('says nothing misleading before the first event', () => {
		const { body } = render(LiveIndicator, {
			props: { connection: 'connecting', lastEventAt: null }
		})
		expect(body).not.toContain('Live')
	})
})
```

Add `import LiveIndicator from '../src/lib/components/LiveIndicator.svelte'` to the file's imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project web test/components.test.ts`
Expected: FAIL — cannot resolve `LiveIndicator.svelte`.

- [ ] **Step 3: Write the component**

Create `apps/web/src/lib/components/LiveIndicator.svelte`:

```svelte
<script lang="ts">
	import type { ConnectionState } from '$lib/live.svelte.js'
	import { formatRelative } from '$lib/format.js'

	interface Props {
		connection: ConnectionState
		lastEventAt: number | null
	}

	let { connection, lastEventAt }: Props = $props()

	/**
	 * How recently an update must have landed for "Live" to be true.
	 *
	 * Comfortably past the ingest pipeline's own ceiling (a sample is emitted at
	 * least every 30s while a car is reporting at all), so a driving or charging
	 * car reads as live continuously, and a car that has genuinely stopped
	 * reporting stops claiming to be.
	 */
	const FRESH_MS = 90_000

	let fresh = $derived(lastEventAt !== null && Date.now() - lastEventAt < FRESH_MS)
	let state = $derived(
		connection !== 'open' ? 'down' : fresh ? 'live' : 'quiet'
	)
</script>

<span class="indicator" class:live={state === 'live'} class:down={state === 'down'} title={
	state === 'live'
		? 'Receiving updates'
		: state === 'down'
			? 'Not connected to the live stream — showing the last values received'
			: 'Connected, but the vehicle has not reported recently'
}>
	<span class="dot"></span>
	{#if state === 'live'}
		Live
	{:else if state === 'down'}
		Reconnecting…
	{:else if lastEventAt !== null}
		Last update {formatRelative(new Date(lastEventAt).toISOString())}
	{:else}
		Waiting for data
	{/if}
</span>

<style>
	.indicator {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 0.8rem;
		color: var(--muted);
	}

	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--muted);
	}

	.live .dot {
		background: var(--accent);
	}

	.down .dot {
		background: var(--muted);
		opacity: 0.5;
	}
</style>
```

Check `apps/web/src/app.css` for the actual custom-property names before using `--muted` and `--accent`; use whatever that file defines. Confirm `formatRelative`'s signature in `apps/web/src/lib/format.ts` and match it — it is used with an ISO string in `+page.svelte` today.

- [ ] **Step 4: Run the component test**

Run: `pnpm vitest run --project web test/components.test.ts`
Expected: PASS.

- [ ] **Step 5: Start the stream and show the indicator in the vehicle layout**

In `apps/web/src/routes/vehicles/[id]/+layout.svelte`, add to the `<script>`:

```ts
	import { onMount } from 'svelte'
	import LiveIndicator from '$lib/components/LiveIndicator.svelte'
	import { live } from '$lib/live.svelte.js'

	// Browser only, and idempotent: the store is app-wide, so navigating between
	// tabs must not open a second stream.
	onMount(() => live.start())

	// The live entry when one has arrived for this vehicle, the load-time data
	// until then. Never a merge of the two: a half-live object could show a
	// position from now beside an activity from page load.
	let entry = $derived(live.get(data.entry.vehicle.id) ?? data.entry)
```

Then replace the existing `<ActivityPill activity={data.entry.activity} openSessionId={data.entry.openSessionId} />` with:

```svelte
		<div class="status">
			<ActivityPill activity={entry.activity} openSessionId={entry.openSessionId} />
			<LiveIndicator connection={live.connection} lastEventAt={live.lastEventAt} />
		</div>
```

…and add a `.status { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }` rule to that file's `<style>`.

- [ ] **Step 6: Prefer live state on the overview page**

In `apps/web/src/routes/vehicles/[id]/+page.svelte`, add to the `<script>`:

```ts
	import { live } from '$lib/live.svelte.js'
```

and change:

```ts
	let entry = $derived(data.entry)
```

to:

```ts
	// Same rule as the layout: the live entry wholesale, or the load-time one.
	// The chart and the session list keep reading `data` — they are historical
	// views and this spec deliberately does not stream them.
	let entry = $derived(live.get(data.entry.vehicle.id) ?? data.entry)
```

Everything downstream (`s`, `charging`, `located`, the tiles, the map) already derives from `entry` and needs no change. Verify that by reading the file before editing.

- [ ] **Step 7: Prefer live state on the garage**

In `apps/web/src/routes/+page.svelte`, add `onMount(() => live.start())` and replace the array the `{#each}` iterates with:

```ts
	// Each card independently: a vehicle with no live update yet keeps its
	// load-time card rather than the whole list waiting for the first event.
	let vehicles = $derived(data.vehicles.map((v) => live.get(v.vehicle.id) ?? v))
```

Add `import { onMount } from 'svelte'` explicitly — that file imports only types and two components today — along with `import LiveIndicator from '$lib/components/LiveIndicator.svelte'` and `import { live } from '$lib/live.svelte.js'`. Read the file first and match the existing prop names in the `{#each}` block.

Then put the indicator in the garage's own header, beside the page heading:

```svelte
	<LiveIndicator connection={live.connection} lastEventAt={live.lastEventAt} />
```

Without it the garage shows live data with no way to tell it is live — the same honesty requirement §3.6 states for the vehicle page, and the goal says the pill is live "on every page that shows one".

- [ ] **Step 8: Pin the boundaries**

Append to `apps/web/test/boundaries.test.ts`:

```ts
describe('the live stream is gated like every other API route', () => {
	it('is not in the public allowlist', () => {
		const src = readFileSync(
			new URL('../src/lib/server/public-paths.ts', import.meta.url).pathname,
			'utf8'
		)
		// The ALLOWLIST, not the file: the file's comments contain the word
		// "upstream", so a bare /stream/ over the whole source is red before
		// anything has gone wrong.
		const allowlist = src.match(/PUBLIC_PATHS\s*=\s*\[([\s\S]*?)\]/)
		expect(allowlist).not.toBeNull()
		expect(allowlist![1]).not.toMatch(/stream/)
	})
})
```

Append to `apps/web/test/ui-boundaries.test.ts`:

```ts
describe('EventSource is constructed in exactly one place', () => {
	/**
	 * Reconnect, backoff and the signed-out probe all live in the live store. A
	 * second EventSource built anywhere else would be a second connection with
	 * none of that behaviour — and it would look like it worked, right up until
	 * the first pod restart.
	 */
	it('appears only in lib/live.svelte.ts', () => {
		const offenders = sourceFiles.filter(
			(f) => /new EventSource\(/.test(readFileSync(f, 'utf8')) && !f.endsWith('live.svelte.ts')
		)
		expect(offenders).toEqual([])
	})
})
```

- [ ] **Step 9: Run everything**

Run: `pnpm test && pnpm -r typecheck && pnpm --filter @ev/web build`
Expected: all pass, and the build succeeds — the build is what would catch an SSR-time `EventSource` or an unresolvable `pg` import.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/lib/components/LiveIndicator.svelte apps/web/src/routes apps/web/test
git commit -m "feat(web): live vehicle state and a live/stale indicator in the UI"
```

---

## Task 9: Manual verification against a real database

**Files:** none — this task produces evidence, not code.

- [ ] **Step 1: Start Postgres and migrate**

```bash
docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=ev --name ev-pg postgres:17
export PGHOST=localhost PGPORT=5432 PGUSER=postgres PGPASSWORD=pw PGDATABASE=ev
pnpm -r build && pnpm --filter @ev/db migrate
```

- [ ] **Step 2: Insert a vehicle and start the web app**

```bash
psql -c "INSERT INTO vehicle (id, vendor, vendor_vehicle_id, display_name) VALUES ('v1','tesla','VIN1','Test car') ON CONFLICT DO NOTHING"
pnpm --filter @ev/web dev
```

- [ ] **Step 3: Watch the stream**

```bash
curl -N -H "Cookie: <a session cookie from the browser>" http://localhost:5173/api/v1/stream
```

Expected: `retry: 2000`, then a `vehicle` event per vehicle, then a `heartbeat` event every 20 seconds.

- [ ] **Step 4: Prove a notification lands**

In `psql`, with the curl still running:

```sql
SELECT pg_notify('vehicle_changed', '{"vehicleId":"v1","ts":"2026-09-05T10:00:00.000Z","kind":"sample"}');
```

Expected: a `vehicle` event appears on the curl output within a second.

- [ ] **Step 5: Prove the reconnect works**

Restart Postgres (`docker restart ev-pg`), wait, then repeat Step 4. Expected: after the listener reconnects, the notification is delivered again, and a full set of `vehicle` events appeared at reconnect time (the resync).

- [ ] **Step 6: Prove the client survives a server restart**

With a browser on `/vehicles/v1`, stop and restart `pnpm dev`. Expected: the indicator goes to "Reconnecting…", then back to Live, with no page reload. This is the case the built-in `EventSource` retry does not handle.

- [ ] **Step 6b: Confirm the two items spec §6 flagged rather than assumed**

Traefik's write timeout on the `websecure` entrypoint — if one is set, a long-lived SSE response is cut at that interval (recoverable via the heartbeat and the client's reconnect, but worth knowing):

```bash
kubectl -n kube-system get deploy traefik -o yaml | grep -i -A2 'respondingTimeouts\|writeTimeout' || echo "no writeTimeout configured (Traefik default: none)"
```

And the connection budget — the web pod now holds one connection above `PGPOOL_MAX`:

```bash
kubectl -n ev exec -it ev-pg-1 -- psql -U postgres -c "SHOW max_connections; SELECT count(*) FROM pg_stat_activity;"
```

Record both. If `kubectl` is unavailable from this machine, say so rather than reporting a result you did not observe.

- [ ] **Step 7: Record the results in the PR/commit message**

Note anything that did not behave as described above, and fix it before proceeding.

---

## Task 10: Ship it

**Files (this repo):** none beyond the tag.
**Files (in the separate GitOps repo):** `clusters/prod/apps/ev/base/deployment-web.yaml`, `clusters/prod/apps/ev/base/kustomization.yaml`.

- [ ] **Step 1: Confirm the tree is green and push**

```bash
pnpm test && pnpm -r typecheck
git push origin main
```

- [ ] **Step 2: Tag the release**

The images workflow publishes only for `v*` tags (`.github/workflows/images.yml`), so the tag is what produces deployable images.

```bash
git tag -a v0.3.0 -m "Real-time updates over SSE"
git push origin v0.3.0
```

- [ ] **Step 3: Wait for the images**

```bash
gh run watch $(gh run list --workflow=images --limit 1 --json databaseId --jq '.[0].databaseId')
```

Expected: `ev-web`, `ev-ingest` and `ev-migrator` all published at `v0.3.0`.

- [ ] **Step 4: Add `SHUTDOWN_TIMEOUT` to the web Deployment**

In `stack/clusters/prod/apps/ev/base/deployment-web.yaml`, add to the web container's `env:` list:

```yaml
            # An open SSE response is an in-flight request that never ends, and
            # adapter-node waits SHUTDOWN_TIMEOUT (default 30s) before forcing
            # connections shut. Left at the default, every pod would sit out the
            # full 30s on SIGTERM and then race Kubernetes' 30s grace period
            # into a SIGKILL on every deploy. maxUnavailable: 0 means no user
            # sees downtime either way; this just stops the rollout dawdling.
            - name: SHUTDOWN_TIMEOUT
              value: "5"
```

- [ ] **Step 5: Bump the image tags**

In `stack/clusters/prod/apps/ev/base/kustomization.yaml`, change all three `newTag: v0.2.0` to `newTag: v0.3.0`.

- [ ] **Step 6: Commit and push the stack change**

```bash
cd ../stack
git add clusters/prod/apps/ev/base/deployment-web.yaml clusters/prod/apps/ev/base/kustomization.yaml
git commit -m "feat(ev): deploy v0.3.0 — real-time updates"
git push
```

- [ ] **Step 7: Verify the rollout**

ArgoCD syncs from the stack repo. Confirm with whatever access is available (`kubectl -n ev get pods`, or the ArgoCD UI), then load `https://ev.example.com/vehicles/<id>` and confirm the indicator reads Live while the car is reporting.

If `kubectl` is not available from this machine, say so rather than claiming the rollout succeeded — the tag and the stack commit are the deliverables that can be verified, and the sync is ArgoCD's to do.
