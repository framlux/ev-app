# Real-time updates — design

**Date:** 2026-09-05
**Status:** Approved for planning
**Scope:** Push current vehicle state to open browser pages as ingest commits it. Tesla only, same as everything else in the app today.
**Parent spec:** `docs/superpowers/specs/2026-09-04-ev-app-design.md`

---

## 1. Purpose

Every page in the web app is server-rendered once and never updated. `+page.server.ts` queries Postgres during the request; there is no `EventSource`, WebSocket, `setInterval`, or `invalidate()` anywhere in `apps/web`. A dashboard left open shows the state it had at page load until someone reloads it, and the app's most-viewed screen — the vehicle overview, watched while the car is actually driving or charging — is precisely the one where that is most wrong.

This spec adds a push path from the ingest worker to open pages, parallel to the existing request path, without changing the fact that Postgres is the only source of truth.

### Goals

- The vehicle overview reflects a new sample within roughly a second of ingest committing it.
- The activity pill is live on every page that shows one — the vehicle layout header and the garage cards.
- A viewer can always tell whether what they are looking at is live or stale.
- No new infrastructure. No broker, no Redis, no second process.

### Non-goals

- **Live charts and session lists.** The 7-day sample chart and the recent-sessions list stay load-time. They are historical views; a point appearing on a chart in real time is a different feature with its own cost, and this spec does not buy it.
- **Sub-sample latency.** The ingest pipeline debounces field bursts (`QUIET_PERIOD_MS` = 2s, `MAX_SAMPLE_INTERVAL_MS` = 30s), so a sample is the finest granularity that exists. Streaming raw MQTT into the web tier to beat that is explicitly rejected in §3.
- **Multi-replica fan-out.** `deployment-web.yaml` sets `replicas: 1` and the deployment serves fewer than ten people. The design does not break if scaled out (see §7), but nothing here is built for it.
- **Writes of any kind.** The stream is read-only, like the rest of the web tier.

---

## 2. Decisions and rationale

| Decision | Choice | Why |
|---|---|---|
| Transport | Server-Sent Events | One-directional, which is exactly the traffic. Runs over the existing HTTPS ingress with no protocol upgrade for Traefik to route, and carries the session cookie automatically. A WebSocket would add a second protocol for no capability we need. Note what is **not** a reason: `EventSource`'s built-in retry is not sufficient here — see §3.5. |
| Wake-up signal | Postgres `LISTEN`/`NOTIFY` | The database is already the point both processes share, and the notify can ride the transaction that writes the sample — so a rolled-back message notifies nothing, for free. Any other channel (a broker topic, an HTTP callback from ingest to web) would be a second delivery path that can disagree with the database. |
| Notify payload | Identifiers only | The worker publishes `{vehicleId, ts, kind}` and nothing else. See §3.2. |
| Notify call site | The ingest **runner**, not the `Store` | `reprocess.ts` builds its own runner, so a replay of the tape notifies nothing — for free, with no flag to remember to set. The runner also sees the `PipelineResult`, so it can notify once per transaction that actually produced something, rather than on every field message. See §3.4. |
| Endpoint shape | One account-wide stream | `GET /api/v1/stream`, not one endpoint per vehicle. See §3.3. |
| Listener connection | A dedicated `pg.Client`, not the pool | A `LISTEN` occupies its connection for as long as it holds the subscription. Taking that from the shared pool permanently removes a slot and risks the pool recycling the connection out from under the subscription — silently, with the symptom being "updates stopped" hours later. |
| Where that client lives | `packages/db`, not `apps/web` | `pg` is a dependency of `packages/db` alone. Under pnpm's isolated linker it does not resolve from `apps/web` at all (there is no `node_modules/pg`, no `apps/web/node_modules/pg`, and no `@types/pg`), so the import would fail `vite build` and `svelte-check`. It is also the existing convention: `queries.ts` defines a structural `Queryable` rather than importing a `pg` type, and the five `PG*` variables are read in exactly one place — a fact `deployment-web.yaml`'s env comment asserts. |
| Auth | The existing gate, unchanged | `EventSource` sends cookies, so `hooks.server.ts` verifies the session exactly as it does for every other route. `/api/v1/stream` is deliberately NOT added to `PUBLIC_PATHS`. |

---

## 3. Architecture

### 3.1 Data flow

```
ev-ingest (one transaction)
  insert raw → insert sample → session rows → advance cursor → pg_notify('vehicle_changed', {vehicleId, ts, kind})
  │                                                             COMMIT delivers the notification
  ▼
Postgres
  │ LISTEN vehicle_changed  (one dedicated connection, ev-web)
  ▼
ev-web  notify listener singleton
  │ on notification: query getVehicle(vehicleId) once
  ▼
  broadcast to every open SSE response
  │ text/event-stream over the existing Traefik ingress
  ▼
browser  EventSource → live store → overview tiles, map, activity pills
```

### 3.2 Why the notification carries identifiers only

The alternative — putting the rendered state in the `NOTIFY` payload — removes the query on the push path, and that is its whole benefit. Against it: the ingest worker would have to construct a UI-shaped payload, which means a second definition of "current vehicle state" living on the write side, drifting against `mapState`/`mapVehicleWithState` in `queries.ts` with nothing to catch the divergence. It would also put that structure inside `NOTIFY`'s 8 kB payload limit, which is ample today and is exactly the kind of ceiling nobody remembers when adding a field.

Identifiers only means the web tier reads the state through the same functions the REST endpoints and page loads use. What the stream sends and what a reload shows are then the same object produced by the same code, and cannot disagree.

The cost is one `getVehicle` query per notification, which is per *sample* — not per viewer, because the listener queries once and fans the result out to all open connections. At the pipeline's ceiling that is one indexed query every two seconds.

The third option — a bare ping that makes each client call `invalidate()` — is rejected because SvelteKit would re-run the whole page `load` for every sample: the 7-day sample series and the sessions page query included, per open tab, every two seconds. It is the least code and by a distance the worst behaviour.

### 3.3 Why one stream, not one per vehicle

The garage page lists every vehicle. Per-vehicle endpoints would open N `EventSource` connections there, each with its own listener registration and heartbeat, to deliver what one connection can. The app is single-tenant by design (one `ALLOWED_SUBJECT`, no user table, no tenancy — parent spec §1), so "every vehicle" and "every vehicle this viewer may see" are the same set, and the endpoint needs no filtering. Clients subscribe to the one stream and ignore events for vehicles they are not showing.

### 3.4 Components

**`packages/db` — notify emission.** A `notifyVehicleChanged(client, payload)` repo function issuing `SELECT pg_notify($1, $2)`. It belongs next to the other repo functions because it is a statement against a `DbClient`, and putting it there is what lets it join the pipeline's transaction rather than run beside it.

**`apps/ingest/src/store.ts` — the call site, which is the runner and not the `Store`.** `pgRunner` already wraps `withTransaction`. It awaits the wrapped function, inspects the `PipelineResult` that comes back, and — still inside the transaction, so still subject to the same rollback as everything else — issues one `notifyVehicleChanged` if and only if that unit of work actually produced something: `samples > 0`, `sessionsOpened > 0` or `sessionsClosed > 0`. `kind` is `'session'` when a session opened or closed and `'sample'` otherwise, because a session boundary is what moves the activity pill and an ordinary sample is not.

**Notifying on the result, not on every transaction, is the point.** fleet-telemetry publishes ONE FIELD PER MESSAGE (`pipeline.ts`'s `TeslaEnvelope`), and the accumulator debounces a burst of them into a single sample. A transaction is therefore roughly ten times more frequent than a sample, and most transactions add a field to the accumulator and write nothing observable at all. Notifying per transaction would fire an order of magnitude more often than there is anything new to show, each one costing a `getVehicle` on the web tier for an unchanged answer. Keying off the result collapses that back to one notification per sample — which is the real rate at which the state a viewer can see changes.

The runner also needs the vehicle id, which `PipelineResult` does not carry; `pgRunner` takes it from the same `config.vehicle` it is already constructed beside, alongside `cursorSource`.

The obvious alternative placement — a `notifyChanged` method on `Store`, called from `Pipeline.applySample` — is wrong, and `reprocess.ts` is why. That script builds its own runner over the *same* `storeOn` (`apps/ingest/src/reprocess.ts:57-60`) and replays the entire window through the same `Pipeline` inside **one** transaction that has also just deleted the derived tables. A `Store`-level notify would therefore make a segmenter-change rebuild — the documented reason `raw_message` exists at all — queue one `pg_notify` per replayed sample, potentially hundreds of thousands, all delivered in a single burst at COMMIT, driving the web tier to hammer `getVehicle` for as long as it takes to drain, for nothing anyone can see. Putting the call on `pgRunner` means `reprocess` notifies nothing, for free — with no flag anyone has to remember to set.

**`packages/db/src/listen.ts` — the connection.** `createChangeListener(channel, handlers)`, built from the same private `required()`-driven `PG*` config as `getPool()`, and **re-exported from `packages/db/src/index.ts`** — the barrel's own comment records that an unexported module does not exist as far as consumers are concerned, and that this was previously caught only in CI. It owns the `pg` dependency and nothing else; policy lives one layer up.

Its connection handling is dictated by how `pg@8` actually behaves, and the naive reading of "reconnect the client" does not work:

- A `Client` that has connected once cannot connect again — `client.js` throws *"Client has already been connected. You cannot reuse a client."* So the listener holds a **replaceable** client: every attempt constructs a **new** `pg.Client`, attaches `'error'` and `'end'` handlers **before** `connect()`, and re-issues `LISTEN` on success.
- A single drop emits `'error'` **twice** and then `'end'`. A reconnect scheduled per event would start three overlapping loops, so attempts are guarded by a generation counter: one drop, one attempt.
- An `'error'` with no listener attached throws out of the EventEmitter and takes the process down. Hence handlers before `connect()`, not after.
- The client is constructed with `keepAlive: true, keepAliveInitialDelayMillis: 10_000`. `pg` defaults `keepAlive` to false, and every recovery path here is triggered by `'error'` or `'end'` — so a silent drop (the CNPG primary's node hard-failing, a path partition) would deliver neither, and live updates would stay dead for the lifetime of the process with nothing in the logs. With keepalive the socket eventually fails `ETIMEDOUT` and the ordinary reconnect path runs.

**`apps/web/src/lib/server/notify-listener.ts` — the policy.** Registers with `createChangeListener`, parses each payload defensively (an unparseable one is counted and dropped, never thrown), invokes subscribers, applies capped exponential backoff between reconnect attempts, and on a successful reconnect tells subscribers to **resynchronise** — notifications that arrived while disconnected are gone, and Postgres does not replay them.

**`apps/web/src/lib/server/live.ts` — the fan-out.** Owns the set of connected clients and the notification→query→broadcast step. Deduplicates: notifications arriving faster than the query completes collapse into one query. Keeps the listener free of any knowledge of HTTP, and keeps the route free of any knowledge of Postgres.

**`apps/web/src/routes/api/v1/stream/+server.ts` — the endpoint.** Returns a `ReadableStream` with `content-type: text/event-stream`, `cache-control: no-store`, `x-accel-buffering: no` (harmless under Traefik, correct if anything else is ever put in front). Rejects with 401 when `locals.user` is absent, matching the other API routes. Sends a `state` event per vehicle immediately on connect, then events as they come, then a heartbeat comment every 20s. Unregisters from the fan-out on `cancel`.

**`apps/web/src/lib/live.svelte.ts` — the client.** A single `EventSource` shared by the whole app, exposing a rune-based store keyed by vehicle id, plus a connection status. Components read from it; nothing else constructs an `EventSource`. It is constructed in the browser only — never during SSR — and owns its own reconnect, for the reason in §3.5.

**UI.** `vehicles/[id]/+page.svelte`, `vehicles/[id]/+layout.svelte` (the pill) and the garage page prefer the live value for a vehicle when one has arrived, falling back to the `data` the load function returned. A `LiveIndicator` component near the pill shows live / stale, driven by the connection status and the age of the newest sample.

### 3.5 The client must own its reconnect — `EventSource` will not

`EventSource`'s automatic retry covers one case: the connection dropping mid-stream. It does **not** cover a retry that gets a response. Per the WHATWG processing model, a reconnect attempt that receives a non-200 status, or a 200 with the wrong `Content-Type`, *fails the connection*: `readyState` goes to `CLOSED`, one `error` event fires, and nothing tries again. (This is the specified algorithm; it is a browser behaviour and is not verifiable from anything installed in this repo.)

This design produces exactly those responses on exactly that endpoint:

- The gate returns a `text/plain` 401 for anything under `/api/` without a session (`gate.ts:41` via `hooks.server.ts`), so a session expiring behind an open tab kills the stream permanently.
- §4 specifies a 503 when Postgres is unavailable.
- With `replicas: 1`, every deploy, crash, OOM or eviction leaves a window in which Traefik itself answers `text/plain` 503 — and `EventSource`'s default 3-second retry lands squarely in it.

In all three cases the tab stops updating forever and looks fine, which is the precise failure this feature exists to remove. So the client store owns reconnection: on `error` with `readyState === EventSource.CLOSED`, it tears the source down and constructs a new one under capped exponential backoff. The server also emits a `retry:` field in its opening payload, because the 3-second default is what makes a restart window fatal in the first place.

The signed-out case cannot be detected from the error itself — the event is a bare `Event` carrying no status. After N consecutive failures the client probes an authenticated endpoint with `fetch`; a 401 there means the session is gone, and it navigates to `/auth/login` rather than retrying forever against a gate that will keep refusing it.

### 3.6 Staleness, which is the honesty requirement

Two independent things can be wrong, and the indicator must not conflate them:

- **The stream is down.** `EventSource` is reconnecting, or the listener lost Postgres. The client knows because neither an event nor a heartbeat has arrived within ~45s (two missed 20s heartbeats plus slack).
- **The car is quiet.** The stream is perfectly healthy and the vehicle simply is not reporting — parked in a garage, asleep, or the ingest worker is wedged. The client knows from the age of the newest sample timestamp.

The indicator reads `live` only when the stream is connected *and* a sample has arrived recently; otherwise it says which of the two is the case. A UI that claims "live" while showing an hour-old number is worse than one that never claimed anything.

On reconnect the server sends a full state snapshot before any incremental event, so a client can never sit on a value it silently missed an update to.

---

## 4. Failure handling

| Failure | Behaviour |
|---|---|
| Postgres drops the listener connection | A **new** `pg.Client` is constructed and connected under capped backoff (the old one is unusable — §3.4), re-`LISTEN`s, and pushes a fresh snapshot to every connected client. One drop emits `error`, `error`, `end`; the generation guard turns that into exactly one reconnect. Missed notifications are not recoverable and the snapshot is what makes that harmless. |
| Postgres or the network dies silently | No `error` and no `end` ever arrive, so nothing above triggers. TCP keepalive (`keepAlive: true`, 10s initial delay — `pg` defaults it off) is what eventually turns this into an `ETIMEDOUT` and hands it to the row above. Until it does, clients show *stale* rather than a false *live*, because the staleness rule is (stream connected) AND (recent sample) — §3.6. |
| Postgres is down at page load | Unchanged from today: the page load fails and renders the error page. The stream endpoint returns 503 rather than an open connection that will never carry anything — and because a 503 permanently closes an `EventSource`, the client's own reconnect (§3.5) is what recovers it. |
| The web pod restarts, or the session expires behind an open tab | The retry gets a 503 or a `text/plain` 401, which closes `EventSource` for good. The client-owned reconnect in §3.5 handles the first; the `fetch` probe after N failures detects the second and navigates to `/auth/login`. |
| The `getVehicle` query fails on a notification | Log, count, drop that notification. The next sample produces another one within seconds, and the heartbeat keeps clients from declaring the stream dead over a single failed query. |
| A client disconnects | The `cancel` callback unregisters it. Nothing else references it. |
| The ingest worker is down | No notifications, so the client's sample age grows and the indicator goes stale. This is the correct and visible outcome, and it matches what the existing `ev_ingest_last_sample_timestamp_seconds` alert reports. |
| The notify payload is malformed or from a newer version | Counted and dropped, never thrown — the same defensive posture `readEnvelope` takes for the tape. |
| Many clients | Fewer than ten viewers, one query per notification regardless of viewer count, one heartbeat timer per connection. No back-pressure design is warranted and none is built. |

---

## 5. Testing

- **`packages/db`**: `notifyVehicleChanged` issues the expected statement against a fake client; the integration test asserts a `LISTEN`ing connection actually receives it, and receives it only after commit. `createChangeListener` is tested against a fake client factory: an `'error'` schedules exactly **one** reconnect that builds a **fresh** client, and the real `error`+`error`+`end` triple still schedules exactly one.
- **`apps/ingest`**: the existing fake-store tests gain three assertions — a committed message-transaction notifies once; a transaction that throws does not notify at all; and **a `reprocess` run notifies nothing**, which is the property §3.4 chose the runner placement for and the one most likely to be broken by a later refactor.
- **`apps/web`**: the fan-out is tested against a fake listener and fake subscribers — one notification produces one query and N writes; a query failure drops the notification without disturbing the clients; a burst collapses. The route is tested for 401 without a session, for the initial snapshot, for the `retry:` field, and for unregistration on cancel. The client store is tested for reconnect after a non-200 (with backoff), for reconnect resynchronisation, and for the two staleness conditions independently.
- **Boundaries**: `test/boundaries.test.ts` gains a check that `/api/v1/stream` is not in `PUBLIC_PATHS`, and that `EventSource` is constructed in exactly one module.

---

## 6. What changes outside this repo

`stack/clusters/prod/apps/ev/base/` needs one change and two confirmations. Traefik streams responses without buffering, `replicas: 1` is already set, and no NetworkPolicy selects `ev-web`, so nothing about routing or admission changes.

**The change: shutdown timing.** `@sveltejs/adapter-node` calls `httpServer.close()` on SIGTERM and only forces connections shut after `SHUTDOWN_TIMEOUT` (default 30s). An open SSE response is an in-flight request that never ends, so every pod will sit out the full 30s and then race Kubernetes' default 30s `terminationGracePeriodSeconds` (unset in `deployment-web.yaml`) into a SIGKILL — on every deploy. `maxSurge: 1 / maxUnavailable: 0` means no user-visible downtime either way, so this is untidy rather than dangerous: set `SHUTDOWN_TIMEOUT` to ~5, and/or raise the grace period.

Two items to confirm during implementation rather than assume:

- Traefik's `respondingTimeouts.writeTimeout` on the `websecure` entrypoint. It defaults to no timeout, but if this cluster sets one, a long-lived SSE response is cut at that interval. The heartbeat makes the cut recoverable and invisible; it is still worth knowing.
- The web pod holds one additional Postgres connection for the lifetime of the process. CNPG's `max_connections` has ample headroom for one, but the number is now one higher than the pool's `PGPOOL_MAX` suggests.

---

## 7. If this is ever scaled past one replica

Nothing here breaks: `NOTIFY` broadcasts to every listening connection, so each replica gets every notification, queries independently, and serves its own clients. No sticky sessions, no shared state. The only cost is one listener connection and one query per notification per replica. Recorded so the constraint is understood as a cost, not a correctness boundary.
