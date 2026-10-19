# Rivian Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record everything Rivian streams about the R2 (VIN `7PD2EAAB2VN016249`) through a new always-on connector, the existing broker and a vendor-generalised ingest worker, with a web sign-in page. All of it is buildable and testable before the car is delivered.

**Architecture:** `apps/rivian` (new) holds one Rivian websocket, stamps and publishes every frame verbatim to MQTT under `rivian/<VIN>/<stream>`. The existing `ev-ingest` image, run with `EV_VENDOR=rivian`, tapes and normalises those frames through a `VendorProfile` that replaces today's Tesla-hard-coded accumulator. `packages/rivian` (new) holds every Rivian fact: catalogue, normaliser, HTTP client, credential sealing and a protobuf wire decoder. `ev-web` gains `/settings/rivian`. The credential is sealed to the connector's key, so the web pod can write it but never read it.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node 22, pnpm workspaces, vitest 2, Postgres 17 with node-pg-migrate, `mqtt` 5, `prom-client` 15, `jose` 5, `ws` 8, SvelteKit 2 / Svelte 5.

**Spec:** `docs/superpowers/specs/2026-10-19-rivian-ingestion-design.md`. Read it before any task. Section numbers below (§n) refer to it.

## Global Constraints

- Read-only toward Rivian. No commands, no phone-key enrolment, no BLE.
- **No code, `.proto` or schema file may be copied from `bretterer/rivian-python-client`, which is unlicensed.** Facts (endpoint URLs, field names, units, protocol message types) are fine. Write every file from scratch.
- Absent never becomes zero: a value the decoder cannot vouch for decodes to nothing, never 0.
- No token, password, OTP, request body or response body in any log line, thrown message, DB row (other than the sealed JWE) or HTTP response (§4.4).
- `EV_VENDOR` is required (`tesla` | `rivian`), with no default.
- Rivian MQTT topics are `rivian/<VIN>/<stream>`. Streams: `state`, `parallax`, `charging`, `cloud`, `ota`, `geofence`, `departure`, `meta`.
- The envelope is `{ v: 1, stream, vin, receivedAt (ISO, connector clock), body }`.
- Client ids: connector `ev-rivian`; Rivian ingest `ev-ingest-rivian`; Tesla ingest `ev-ingest`; receiver `ev-fleet-telemetry`. Each worker refuses the others' ids.
- Backoff: 30 s × 2ⁿ plus uniform 0–30 s jitter, capped at 900 s. No failure path reconnects faster than this.
- Silence: 60 s with no frame on an acknowledged socket means resubscribe every subscription under fresh ids. Never reconnect on silence.
- `vehicleState` groups hold at most 16 properties.
- The publish queue is capped at 32 MiB of serialised envelopes. Drop oldest, then resubscribe everything.
- Strings are cleaned before taping: remove `\u0000`, replace unpaired surrogates with U+FFFD. Both the connector and ingest do this.
- Credential JWE: `ECDH-ES+A256KW` / `A256GCM`, P-256 keys as JWK. The payload holds only `{userSessionToken}`.
- Match the codebase's comment style. Comments explain *why*, the way the existing files do (long, specific, citing the failure they prevent). Don't write terse or no-comment code in files that are heavily commented.
- Imports use `.js` specifiers. Packages build to `dist/`, and apps import workspace packages from their built `dist/`. **Run `pnpm -r build` before testing a consumer of a changed package.**
- Commit messages follow the repo's style: `feat(scope): …`, `fix(scope): …`, `refactor(scope): …`, `docs: …`, `test(scope): …`, lowercase, imperative, describing the behaviour. No attribution lines.
- Never `git revert`. Roll forward.

**How to run tests:**
- **Throwaway Postgres:** `podman run --rm -d -p 55432:5432 -e POSTGRES_USER=ev -e POSTGRES_PASSWORD=ev -e POSTGRES_DB=ev --name ev-pg postgres:17-alpine`, if `podman ps` doesn't already show `ev-pg`.
- **Full gate:** `pnpm -r build && pnpm typecheck && PGHOST=localhost PGPORT=55432 PGUSER=ev PGPASSWORD=ev PGDATABASE=ev pnpm test`. The baseline is 51 files, 1792 tests, all passing.
- **One project:** `PG…=… pnpm vitest run --project @ev/ingest test/pipeline.test.ts`. Project names: `@ev/core`, `@ev/db`, `@ev/tesla`, `@ev/ingest`, `web`, and the new `@ev/rivian` and `@ev/rivian-connector`.

## Review Focus

1. **A subscribe snapshot re-sends hours-old values.** A parked car's old speed or `charging_active` must not open or hold a session. The test lives in Task 6 (end-to-end).
2. **A Rivian worker misconfigured with the Tesla client id or topic.** It must refuse to start rather than steal and ack the Tesla backlog. Tested in Task 4.
3. **Postgres blips under the connector.** A failed credential poll or status write must not drop the socket. Tested in Task 11.
4. **A user-entered string containing `\u0000`** (driver name, vehicle name). It must tape cleanly and never wedge ingest. Tested in Tasks 3 and 4.
5. **An error from Rivian that echoes tokens or the request body.** It must be redacted everywhere it surfaces. Tested in Tasks 7 and 12.

---

## File Structure

**New package `packages/rivian` (`@ev/rivian`)**, every Rivian fact, no I/O except the HTTP client:

| File | Holds |
|---|---|
| `src/envelope.ts` | envelope type, stream names, topic builder, `readRivianEnvelope`, `cleanStrings` |
| `src/catalogue.ts` | `vehicleState` property list, shape templates, selection builder, grouping, subscription documents |
| `src/gear.ts` | Rivian gear words → canonical `Gear` |
| `src/normalise.ts` | `RivianFieldState`, `decodeRivian`, `rivianStateToSample`, slot lists |
| `src/protobuf.ts` | schema-less wire decoder |
| `src/errors.ts` | `RivianApiError` (redacted) and `toRivianApiError` |
| `src/http.ts` | `RivianHttp`: CSRF, login, OTP, userInfo, vehicle, chargingSummaries, introspection |
| `src/credential.ts` | `sealCredential`, `unsealCredential`, `generateCredentialKeys` |
| `src/index.ts` | barrel |
| `test/*.test.ts`, `test/fixtures/*.ts` | tests and synthetic fixtures (labelled) |

**New app `apps/rivian` (`@ev/rivian-connector`)**, the connector:

| File | Holds |
|---|---|
| `src/config.ts` | env → `ConnectorConfig` |
| `src/socket.ts` | `graphql-transport-ws` client over `ws` |
| `src/subscriptions.ts` | `SubscriptionPlan`: groups, fresh ids, bisection, dropped list |
| `src/queue.ts` | `PublishQueue`, byte-bounded |
| `src/publisher.ts` | MQTT publisher |
| `src/backoff.ts` | the backoff schedule |
| `src/store.ts` | the connector's Postgres seam (credential stamp, read, status write) |
| `src/connector.ts` | lifecycle orchestrator |
| `src/metrics.ts`, `src/main.ts` | metrics and entrypoint |
| `Dockerfile`, `test/*` | image and tests |

**`apps/ingest` changes:**

| File | Change |
|---|---|
| `src/timing.ts` (new) | the four timing constants |
| `src/profile.ts` (new) | `Decoded`, `VendorProfile` |
| `src/profiles/tesla.ts` (new) | Tesla profile, built from the constants that leave `pipeline.ts` |
| `src/profiles/rivian.ts` (new) | Rivian profile |
| `src/deps.ts` | becomes `profileFor(vendor)` |
| `src/pipeline.ts` | profile-driven accumulator, `observedAt`, lock, `untimed` |
| `src/config.ts` | `vendor` and vendor-derived defaults and refusals |
| `src/mqtt.ts` | Rivian topic parser and handler alongside the Tesla one |
| `src/store.ts` | `registerVehicle` takes the vendor |
| `src/main.ts` | profile, vendor labels, skew-corrected flush |
| `src/metrics.ts` | per-vendor record kinds, `envelope` failure, untimed counter |
| `src/reprocess.ts` | vehicle filter, profile |
| `src/parallax-dump.ts` (new) | Parallax tape reader |
| `Dockerfile` | builds `@ev/rivian` |

**Changes in `packages/core`, `packages/tesla` and `packages/db`:**
- **`packages/core`:** the `Gear` type, the segmenter, `signals.ts`, `model.ts`; `adapter.ts` is deleted.
- **`packages/tesla`:** the canonical gear decode.
- **`packages/db`:** migrations `008_canonical_gear.sql` and `009_rivian.sql`, and `src/repo/rivian.ts`.

**`apps/web` changes:**
- `src/lib/server/rivian-pending.ts` and `src/lib/server/rivian-auth.ts`
- the routes `api/v1/rivian/{login,otp,logout}` and `settings/rivian`
- the vehicle layout's Settings tab
- `package.json` and `Dockerfile`

**Other:** `scripts/rivian-keygen.mjs`, `.github/workflows/images.yml`, `README.md`.

---

### Task 1: Canonical gear

**Files:**
- Modify: `packages/core/src/signals.ts` (the `TsType` union, `TS_TYPES_FOR_SQL`, the `gear` entry and its comment)
- Modify: `packages/core/src/model.ts` (export `type Gear`, add `Gear: Gear` to `TsTypeMap`)
- Modify: `packages/core/src/engine/segmenter.ts:200` and `:211-216`
- Modify: `packages/tesla/src/normalise.ts` (the `Gear` override at about lines 223-229)
- Create: `packages/db/migrations/008_canonical_gear.sql`
- Test: `packages/core/test/segmenter.test.ts`, `packages/core/test/signals.test.ts`, `packages/tesla/test/normalise.test.ts`, `apps/ingest/test/pipeline.test.ts` (gear strings only), new `packages/db/test/migration-008.test.ts`

**Interfaces:**
- Produces: `export type Gear = 'P' | 'R' | 'N' | 'D'` from `@ev/core`, and `VehicleSample.gear: Gear | null`.

- [ ] **Step 1: Write the failing tests**

In `packages/tesla/test/normalise.test.ts`, replace the existing `describe('decodeTeslaField: Gear', …)` body with:

```ts
describe('decodeTeslaField: Gear', () => {
  it('decodes the four positions to the canonical letter the engine reads', () => {
    expect(decodeTeslaField('Gear', 'ShiftStateP')).toEqual({ gear: 'P' })
    expect(decodeTeslaField('Gear', 'ShiftStateR')).toEqual({ gear: 'R' })
    expect(decodeTeslaField('Gear', 'ShiftStateN')).toEqual({ gear: 'N' })
    expect(decodeTeslaField('Gear', 'ShiftStateD')).toEqual({ gear: 'D' })
  })

  it('reads a null gear as Park, since that is what a switched-off car is in', () => {
    // 2026-09-15 19:40:04: D or R straight to null, ten times, stopped every time.
    expect(decodeTeslaField('Gear', null)).toEqual({ gear: 'P' })
  })

  it('writes an explicit null for a position it cannot name, so an earlier D is not carried', () => {
    // Today ShiftStateSNA OVERWRITES a carried D (it is not in the driving set).
    // Returning nothing instead would carry the D and hold the drive open - the
    // bug 71aa244 fixed - so an unnamed position is an explicit null.
    expect(decodeTeslaField('Gear', 'ShiftStateSNA')).toEqual({ gear: null })
    expect(decodeTeslaField('Gear', 'ShiftStateInvalid')).toEqual({ gear: null })
  })

  it('still decodes a wrong-typed payload to nothing', () => {
    expect(decodeTeslaField('Gear', 42)).toBeNull()
  })
})
```

In `packages/core/test/segmenter.test.ts`, replace every `'ShiftStateP'`, `'ShiftStateD'`, `'ShiftStateR'` and `'ShiftStateN'` with `'P'`, `'D'`, `'R'` and `'N'`. In `apps/ingest/test/pipeline.test.ts`, change only the **expected sample values** that assert a decoded gear to the letters. Leave the raw `field(at, 'Gear', 'ShiftStateD')` payloads alone: the car still sends those strings.

Also change `packages/tesla/test/normalise.test.ts:105` (`expect(decoded('Gear','ShiftStateD')).toEqual({ gear: 'ShiftStateD' })`, outside the describe above) to expect `{ gear: 'D' }`. `apps/ingest/test/pipeline.test.ts` has no decoded-gear assertions; grep it for `ShiftState` and change only assertions on emitted samples, if any.

Create `packages/db/test/migration-008.test.ts`. **Do not model it on `migration-004.test.ts`** (a text-only drift test), and **do not migrate the shared `ev` database down**: other test files run concurrently against it.
- Use the skip guard from `packages/db/test/migrate.test.ts:34-44` (`hasDb`, plus throw-in-CI).
- In `beforeAll`, connect a `pg.Client` to `ev`, `CREATE DATABASE ev_mig008_<random hex>`, and connect a second client to it.
- Call node-pg-migrate's runner directly against that client, with the same `dir`/`migrationsTable` options `packages/db/src/migrate.ts` uses: `direction: 'up', count: 7` (to 007), seed, then `count: 1` up (008), then `direction: 'down', count: 1`.
- In `afterAll`, close the clients and `DROP DATABASE`.

It must assert:

```ts
// seed after migrating to 007, as a tesla vehicle 'v-t' and a rivian vehicle 'v-r'
// (create the month partition first if 002_partitions.sql requires it):
//   (v-t, t1, 'ShiftStateD'), (v-t, t2, 'ShiftStateSNA'), (v-t, t3, 'ShiftStateP'), (v-r, t4, 'D')
// migrate up to 008:
//   gear at t1 = 'D', t2 = NULL, t3 = 'P', t4 = 'D'
// migrate down one:
//   v-t rows: t1 = 'ShiftStateD', t2 = NULL, t3 = 'ShiftStateP'; v-r row t4 still 'D'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ev/core build && pnpm vitest run --project @ev/tesla test/normalise.test.ts`
Expected: FAIL. `{ gear: 'ShiftStateP' }` is returned instead of `{ gear: 'P' }`.

- [ ] **Step 3: Implement**

In `packages/core/src/signals.ts`:
- Add `| 'Gear'` to `TsType`.
- Change `'TEXT': ['string', 'PowerState', 'ChargeState']` to `'TEXT': ['string', 'PowerState', 'ChargeState', 'Gear']`.
- Change the gear entry to `{ column: 'gear', key: 'gear', sql: 'TEXT', ts: 'Gear' }`.
- Replace its comment (`// ShiftState, as the vendor names it`) with: `// Canonical P/R/N/D, not the vendor's word: the segmenter reasons about it, so each normaliser maps its own vocabulary onto these four (the tape keeps the original).`

In `packages/core/src/model.ts`, add:

```ts
/**
 * The selector position, canonical across vendors. The segmenter reasons about
 * it - only Park ends a drive - so, like PowerState and ChargeState, each
 * normaliser maps its vendor's own vocabulary onto these four letters and the
 * raw tape keeps the original word.
 */
export type Gear = 'P' | 'R' | 'N' | 'D'
```

Then add `Gear: Gear` to `interface TsTypeMap`.

In `segmenter.ts`:
- Line 200 becomes `if (sample.gear === 'P') return 'stationary'`. Update the comment above it: canonical, mapped by every normaliser.
- `DRIVING_GEARS` becomes `new Set<string>(['D', 'R', 'N'])`, with a doc comment saying it's canonical.

In `packages/tesla/src/normalise.ts`, replace the `Gear` override with:

```ts
  // Canonical letters, because the segmenter reasons about gear and must not
  // know any vendor's words (spec §7.5). A null gear is the drive system
  // powering down, and a Tesla that is off is in Park (71aa244). A position we
  // cannot name - ShiftStateSNA, ShiftStateInvalid - is an EXPLICIT null: it
  // used to overwrite a carried D, and `one()` returning nothing would carry it
  // instead, holding the drive open. A non-string is still nothing.
  Gear: (v) => {
    if (v === null) return { gear: 'P' }
    if (typeof v !== 'string') return null
    return { gear: TESLA_GEARS[v] ?? null }
  },
```

Add near it:

```ts
const TESLA_GEARS: Readonly<Record<string, Gear>> = {
  ShiftStateP: 'P', ShiftStateR: 'R', ShiftStateN: 'N', ShiftStateD: 'D',
}
```

Import `type Gear` from `@ev/core`. If the existing "every catalogued field decodes" table test asserts something about Gear's string domain, keep its `SHAPED` entry as `Gear: { good: 'ShiftStateD', wrong: 42 }`, which still holds.

Create `packages/db/migrations/008_canonical_gear.sql`, matching the `-- Up Migration` / `-- Down Migration` format of `007_energy_rate.sql`:

```sql
-- Up Migration

-- Spec §7.5. `gear` becomes canonical (P/R/N/D) because the segmenter reasons
-- about it and must not know a vendor's words. New samples already arrive
-- canonical; this rewrites history so it agrees with what a reprocess of the
-- tape would now produce. Unmatched values (ShiftStateSNA, ShiftStateInvalid)
-- become NULL, which is exactly what the decoder now writes for them.
--
-- ROLLOUT: the previous ingest image writes ShiftState* strings. Stop it before
-- this runs (the broker queues the backlog) - see the spec §11.
UPDATE sample SET gear = CASE gear
    WHEN 'ShiftStateP' THEN 'P'
    WHEN 'ShiftStateR' THEN 'R'
    WHEN 'ShiftStateN' THEN 'N'
    WHEN 'ShiftStateD' THEN 'D'
  END
WHERE gear LIKE 'ShiftState%';

-- Down Migration

-- Lossy for ShiftStateSNA/Invalid, which became NULL and stay NULL. Tesla rows
-- only: a Rivian sample's 'D' was never a ShiftState string.
UPDATE sample s SET gear = 'ShiftState' || s.gear
FROM vehicle v
WHERE v.id = s.vehicle_id AND v.vendor = 'tesla' AND s.gear IN ('P', 'R', 'N', 'D');
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: the full gate (Global Constraints).
Expected: all pass, 1792 or more tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core packages/tesla packages/db apps/ingest/test
git commit -m "feat(core): read gear as a canonical letter, not Tesla's word"
```

---

### Task 2: Vendor profile and a behaviour-neutral pipeline refactor

**Files:**
- Create: `apps/ingest/src/timing.ts`, `apps/ingest/src/profile.ts`, `apps/ingest/src/profiles/tesla.ts`
- Modify: `apps/ingest/src/pipeline.ts`, `apps/ingest/src/deps.ts`, `apps/ingest/src/main.ts`, `apps/ingest/src/reprocess.ts`, `apps/ingest/src/store.ts` (only if it imports moved names)
- Delete: `packages/core/src/adapter.ts`, plus its export line in `packages/core/src/index.ts`
- Test: `apps/ingest/test/pipeline.test.ts` (mechanical edits only), new `apps/ingest/test/profile-tesla.test.ts`, new `apps/ingest/test/boundaries.test.ts`

**Interfaces:**
- Produces, in `apps/ingest/src/timing.ts`: `QUIET_PERIOD_MS`, `MAX_SAMPLE_INTERVAL_MS`, `VOLATILE_STALE_MS`, `STALE_VALUE_MS` (same values and comments, moved). `pipeline.ts` re-exports them.
- Produces, in `apps/ingest/src/profile.ts`:

```ts
import type { RawMessage, Vendor, VehicleSample } from '@ev/core'
export interface Decoded {
  /** Slot -> value. An explicit null is stored ("the car says unknown"); an absent key changes nothing. */
  slots: Record<string, unknown>
  /** Slot -> when the vehicle observed it, epoch ms. Absent: the message's receivedAt. */
  observedAt?: Record<string, number>
  /** Properties whose own timestamp was missing or unparseable (spec §6.4), for the metric. */
  untimed?: number
}
export interface VendorProfile {
  readonly vendor: Vendor
  decode(raw: RawMessage): Decoded | null
  toSample(vehicleId: string, ts: Date, state: Record<string, unknown>): VehicleSample
  staleWindowFor(slot: string): number
  readonly chargeStateSlots: readonly string[]
  readonly chargingPowerSlots: readonly string[]
  readonly chargingEnergySlots: readonly string[]
}
```

- Produces, in `apps/ingest/src/profiles/tesla.ts`: `export const teslaProfile: VendorProfile`, `export const VOLATILE_FIELDS: ReadonlySet<string>`, and `export function staleWindowFor(field: string): number`, moved verbatim from `pipeline.ts` with their comments.
- Produces, in `apps/ingest/src/deps.ts`: `export function profileFor(vendor: Vendor): VendorProfile`, which throws `Error('no profile for vendor rivian yet')` for `rivian` until Task 6. It keeps `export * from '@ev/core'`.
- Changes: `new Pipeline(profile: VendorProfile, runner: StoreRunner, opts: MetricsOptions, home: HomeLocation | null = null)`, `new FieldAccumulator(profile: VendorProfile)`, `FieldAccumulator.apply(decoded: Decoded, at: Date)`, and `take(): { state: Record<string, unknown>; ts: Date } | null`.
- Adds `untimed: number` to `PipelineResult` (and to `EMPTY` and `merge`).

- [ ] **Step 1: Write the failing tests**

`apps/ingest/test/profile-tesla.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { TESLA_FIELDS, slotsOf } from '@ev/tesla'
import { STALE_VALUE_MS, VOLATILE_STALE_MS } from '../src/timing.js'
import { VOLATILE_FIELDS, staleWindowFor, teslaProfile } from '../src/profiles/tesla.js'

describe('the Tesla profile is exactly what pipeline.ts hard-coded', () => {
  it('derives the volatile set from the drive tier, minus Location and Gear, plus the rails and speed', () => {
    const expected = new Set<string>([
      'speedKph', 'acPowerKw', 'dcPowerKw',
      ...TESLA_FIELDS.filter((e) => e.tier === 'drive' && e.field !== 'Location' && e.field !== 'Gear')
        .flatMap(slotsOf),
    ])
    expect(VOLATILE_FIELDS).toEqual(expected)
    expect(staleWindowFor('speedKph')).toBe(VOLATILE_STALE_MS)
    expect(staleWindowFor('socPct')).toBe(STALE_VALUE_MS)
    expect(teslaProfile.staleWindowFor).toBe(staleWindowFor)
  })

  it('keeps the charge refresh slots', () => {
    expect(teslaProfile.chargeStateSlots).toEqual(['chargeStateDetailed', 'chargeStateBasic', 'activeRail'])
    expect(teslaProfile.chargingPowerSlots).toEqual(['acPowerKw', 'dcPowerKw'])
    expect(teslaProfile.chargingEnergySlots).toEqual(['acEnergyKwh', 'dcEnergyKwh'])
  })

  it('decodes a metrics envelope to slots with no observedAt, so arrival time stamps it as before', () => {
    const d = teslaProfile.decode({
      vehicleId: 'v', vendor: 'tesla', receivedAt: new Date(0), source: 'telemetry',
      payload: { kind: 'metrics', vin: 'X', field: 'Soc', value: 55 },
    })
    expect(d).toEqual({ slots: { socPct: 55 } })
  })

  it('refuses another vendor\'s message', () => {
    expect(teslaProfile.decode({
      vehicleId: 'v', vendor: 'rivian', receivedAt: new Date(0), source: 'graphql_ws',
      payload: { kind: 'metrics', vin: 'X', field: 'Soc', value: 55 },
    })).toBeNull()
  })
})
```

Before writing the third test, check the actual slot `decodeTeslaField('Soc', 55)` produces by reading `packages/tesla/src/catalogue.ts`, and use it.

`apps/ingest/test/boundaries.test.ts`, the import boundary from spec §6.1:

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = new URL('../src', import.meta.url).pathname
const ALLOWED = new Set(['deps.ts', 'profiles/tesla.ts', 'profiles/rivian.ts', 'parallax-dump.ts'])

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const full = join(dir, e)
    return statSync(full).isDirectory() ? files(full) : full.endsWith('.ts') ? [full] : []
  })
}

describe('vendor packages are imported only at the seam', () => {
  it('finds sources', () => expect(files(SRC).length).toBeGreaterThan(5))
  it('no other module imports @ev/tesla or @ev/rivian', () => {
    const offenders = files(SRC)
      .filter((f) => !ALLOWED.has(relative(SRC, f)))
      .filter((f) => /from\s+['"]@ev\/(tesla|rivian)(\/[^'"]*)?['"]/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f))
    expect(offenders).toEqual([])
  })
})
```

`parallax-dump.ts` is allowed because Task 6 makes it import the protobuf decoder from `@ev/rivian`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run --project @ev/ingest test/profile-tesla.test.ts test/boundaries.test.ts`
Expected: FAIL. `profiles/tesla.js` doesn't exist, and `pipeline.ts` imports `@ev/tesla`.

- [ ] **Step 3: Implement**

1. **`timing.ts`:** move the four constants and their full doc comments out of `pipeline.ts`. In `pipeline.ts` add `export { QUIET_PERIOD_MS, MAX_SAMPLE_INTERVAL_MS, VOLATILE_STALE_MS, STALE_VALUE_MS } from './timing.js'` and import them for internal use.
2. **`profile.ts`:** exactly the interface above, with doc comments. Explain why it replaced `VehicleAdapter`: a message is a fragment, and the vendor knowledge is the accumulator's policy. Explain that `observedAt` exists for spec §6.4.
3. **`profiles/tesla.ts`:** move `CARRIED_DRIVE_FIELDS`, `ALWAYS_VOLATILE`, `VOLATILE_FIELDS`, `CHARGE_STATE_SLOTS`, `CHARGING_POWER_SLOTS`, `CHARGING_ENERGY_SLOTS` and `staleWindowFor`, with **every comment and `satisfies keyof TeslaFieldState` intact**. Then:

```ts
export const teslaProfile: VendorProfile = {
  vendor: 'tesla',
  decode(raw) {
    if (raw.vendor !== 'tesla') return null
    const update = decodeTeslaMessage(raw)
    return update === null ? null : { slots: update as Record<string, unknown> }
  },
  toSample: (vehicleId, ts, state) => teslaStateToSample(vehicleId, ts, state as TeslaFieldUpdate),
  staleWindowFor,
  chargeStateSlots: CHARGE_STATE_SLOTS,
  chargingPowerSlots: CHARGING_POWER_SLOTS,
  chargingEnergySlots: CHARGING_ENERGY_SLOTS,
}
```

   `decodeTeslaMessage` is the body of today's `decodeIfKnown` Tesla branch, moved here, along with `readEnvelope` and the `TeslaEnvelope`/`RecordKind` types (re-export them from `pipeline.ts` so `mqtt.ts` imports keep compiling).
4. **`deps.ts`:**

```ts
export * from '@ev/core'
import type { Vendor } from '@ev/core'
import type { VendorProfile } from './profile.js'
import { teslaProfile } from './profiles/tesla.js'

/**
 * The one place the worker chooses a vendor. EV_VENDOR picks the profile at
 * startup (config.ts), and every vendor-specific decision - decode, staleness,
 * the charge refresh, sample construction - lives behind it.
 */
export function profileFor(vendor: Vendor): VendorProfile {
  switch (vendor) {
    case 'tesla': return teslaProfile
    case 'rivian': throw new Error('no profile for vendor rivian yet')
  }
}
```

   Delete `decodeIfKnown`.
5. **`pipeline.ts`:**
   - Remove the `@ev/tesla` import and the `decode` function.
   - `FieldAccumulator` gets `constructor(private readonly profile: VendorProfile)`.
   - `apply(decoded: Decoded, at: Date)`:

```ts
  apply(decoded: Decoded, at: Date): void {
    const ms = at.getTime()
    const charging = this.showsCharging(decoded.slots)
    for (const [key, value] of Object.entries(decoded.slots)) {
      if (value === undefined) continue
      // The vehicle's own observation time where the vendor gives one (spec
      // §6.4), never later than the frame that carried it; arrival otherwise.
      const observed = decoded.observedAt?.[key]
      const at = observed === undefined ? ms : Math.min(observed, ms)
      // A re-sent snapshot can carry an OLDER observation than the one we hold
      // (a resubscribe replays the car's last-known values); it must not
      // overwrite a newer one. Only values with an observation time compete
      // this way - Tesla never sets one, so its behaviour is unchanged.
      const held = this.slots.get(key)
      if (observed !== undefined && held?.observed !== undefined && at < held.observed) continue
      this.slots.set(key, { value, at, observed: observed === undefined ? undefined : at })
    }
    if (charging) {
      for (const key of this.profile.chargeStateSlots) {
        const entry = this.slots.get(key)
        if (entry) this.slots.set(key, { value: entry.value, at: ms })
      }
    }
    this.newestAt = ms
    this.pendingSince ??= ms
  }
```

   - `showsCharging` iterates `this.profile.chargingPowerSlots` and `chargingEnergySlots`.
   - `take()` uses `this.profile.staleWindowFor(key)`.
   - `clone()` constructs with the same profile.
   - `Pipeline` constructor: `(private profile: VendorProfile, private runner: StoreRunner, private opts: MetricsOptions, private home: HomeLocation | null = null)`.
   - `accumulatorFor` builds `new FieldAccumulator(this.profile)`. `emit` calls `this.profile.toSample(...)`. `handle` calls `this.profile.decode(raw)`, adding `result.untimed = decoded.untimed ?? 0`.
   - Add `untimed: 0` to `EMPTY`, and `untimed: a.untimed + b.untimed` to `merge`. Document `untimed` on `PipelineResult`.
   - **Serialise work.** Split today's `transactionally` into two private methods, and route every public entry point through the lock exactly once:

```ts
  private chain: Promise<unknown> = Promise.resolve()

  /**
   * One unit of work at a time. The flush timer used to be able to run in the
   * middle of a handle(): each snapshots the in-memory state, and a rollback in
   * one restored its snapshot over the other's committed progress - and flush
   * read `this.accumulators` before a queued handle had run. A promise chain,
   * not a mutex library: the queue is never deeper than one flush and the
   * message mqtt.js is already waiting on.
   *
   * NEVER call `locked` or `transactionally` from inside a `locked` callback:
   * the inner call would wait on the outer one forever.
   */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => undefined)
    return next
  }

  /** Snapshot, run one transaction, restore on failure. No lock: callers hold it. */
  private async attempt<T>(fn: (store: Store) => Promise<T>): Promise<T> {
    const snapshot = this.snapshot()
    try {
      return await this.runner.run(fn)
    } catch (err) {
      this.restore(snapshot)
      throw err
    }
  }

  private transactionally<T>(fn: (store: Store) => Promise<T>): Promise<T> {
    return this.locked(() => this.attempt(fn))
  }

  // flush takes the lock ONCE for its whole loop and uses attempt() inside,
  // re-reading each accumulator from the map (an earlier rollback replaces it):
  async flush(now: Date = new Date(), force = false): Promise<PipelineResult> {
    return this.locked(async () => {
      let result = { ...EMPTY }
      for (const vehicleId of [...this.accumulators.keys()]) {
        const acc = this.accumulators.get(vehicleId)
        if (!acc || !(force ? acc.pending : acc.due(now))) continue
        result = merge(result, await this.attempt((s) => this.emit(s, vehicleId, this.accumulators.get(vehicleId)!)))
      }
      return result
    })
  }
```

     The other entry points:
     - `handle` and `handleSample` call `transactionally` once each.
     - `resume` swaps `this.runner` and calls `handle`/`flush`, each locking per call. `reconcile` runs afterwards via `transactionally`.
     - `emit`, `applySample` and `finish` never call `transactionally` or `locked`.
6. **Callers:**
   - `main.ts` passes `profileFor('tesla')` for now (Task 4 wires the vendor).
   - `reprocess.ts` builds `new Pipeline(profileFor('tesla'), …)` for now.
   - Every `new Pipeline(` and `new FieldAccumulator(` in `apps/ingest/test/*.ts` gains `teslaProfile` as the first argument (about 75 sites; a mechanical edit). Import `VOLATILE_FIELDS` and `staleWindowFor` from `../src/profiles/tesla.js`.
   - Tests that call `acc.apply(update, at)` with a bare update object now pass `{ slots: update }`.
7. **Delete `packages/core/src/adapter.ts`** and its export from `packages/core/src/index.ts`. `grep -rn VehicleAdapter packages apps --include='*.ts'` must return nothing outside `dist/`.
8. **Add a concurrency test** to `pipeline.test.ts`:

```ts
it('runs a flush started during a handle after it, not interleaved with it', async () => {
  const db = new FakeDb()               // FakeDb IS the StoreRunner: it has run(fn), no .runner
  const order: string[] = []
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const runner = { run: async <T,>(fn: (s: Store) => Promise<T>) => {
    order.push('start'); const out = await db.run(fn); await gate; order.push('end'); return out } }
  const p = new Pipeline(teslaProfile, runner, OPTS)
  const h = p.handle(field('2026-09-01T00:00:00Z', 'Soc', 50))
  // A minute later the burst is due, so the flush has real work - once the handle has run.
  const f = p.flush(new Date('2026-09-01T00:01:00Z'))
  await new Promise((r) => setTimeout(r, 0)); release()
  await Promise.all([h, f])
  expect(order).toEqual(['start', 'end', 'start', 'end'])
  expect(db.state.samples).toHaveLength(1)
})
```

   Confirm `FakeDb`'s property names (`run`, `state.samples`) in `test/support/fake-db.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the full gate.
Expected: all pass. **No assertion in any existing test may change**, other than the mechanical edits listed in step 6. If one would have to change, stop and report it: the refactor isn't behaviour-neutral.

- [ ] **Step 5: Commit**

```bash
git add apps/ingest packages/core
git commit -m "refactor(ingest): move vendor policy behind a profile, and serialise handle and flush"
```

---

### Task 3: `@ev/rivian` foundations: envelope, catalogue, gear, protobuf

**Files:**
- Create: `packages/rivian/package.json`, `packages/rivian/tsconfig.json` (copy `packages/tesla/tsconfig.json`), `packages/rivian/vitest.config.ts` (copy `packages/tesla/vitest.config.ts` and rename the project to `@ev/rivian`), `packages/rivian/src/{envelope,catalogue,gear,protobuf,index}.ts`
- Test: `packages/rivian/test/{envelope,catalogue,gear,protobuf}.test.ts`
- Modify: `pnpm-lock.yaml` (via `pnpm install`)

**Interfaces:**
- Produces, in `envelope.ts`:

```ts
export const ENVELOPE_VERSION = 1
export const RIVIAN_STREAMS = ['state', 'parallax', 'charging', 'cloud', 'ota', 'geofence', 'departure', 'meta'] as const
export type RivianStream = (typeof RIVIAN_STREAMS)[number]
export interface RivianEnvelope { v: 1; stream: RivianStream; vin: string; receivedAt: string; body: unknown }
export const RIVIAN_TOPIC_ROOT = 'rivian'
export function rivianTopic(vin: string, stream: RivianStream): string           // `rivian/${vin}/${stream}`
export function readRivianEnvelope(payload: unknown): RivianEnvelope | null       // null unless exactly v1-shaped
export function cleanStrings<T>(value: T): T   // deep: strings AND object keys; removes \u0000, lone surrogates -> �
```

- Produces, in `catalogue.ts`:

```ts
export type PropertyShape = 'value' | 'location' | 'cloudConnection' | 'locationError'
export interface RivianProperty { readonly name: string; readonly shape: PropertyShape }
export const RIVIAN_PROPERTIES: readonly RivianProperty[]
export const SHAPE_SELECTIONS: Readonly<Record<PropertyShape, string>>
export const MAX_GROUP_SIZE = 16
export function shapeOf(name: string): PropertyShape     // catalogue shape, else 'value'
export function groupProperties(names: readonly string[], size?: number): string[][]
export interface SubscriptionDocument { operationName: string; query: string; variables: Record<string, unknown> }
export function vehicleStateDocument(vehicleId: string, names: readonly string[]): SubscriptionDocument
export function parallaxDocument(vehicleId: string, rvms: readonly string[] | null): SubscriptionDocument
export function chargingSessionDocument(vehicleId: string): SubscriptionDocument
export function cloudConnectionDocument(vehicleId: string): SubscriptionDocument
export function otaInstallStateDocument(vehicleId: string): SubscriptionDocument
export function otaInstallSchedulesDocument(vehicleId: string): SubscriptionDocument
export function geofencesDocument(vehicleId: string): SubscriptionDocument
export function departureSchedulesDocument(vehicleId: string): SubscriptionDocument
```

- Produces, in `gear.ts`: `export function rivianGear(raw: unknown): Gear | null | undefined`. `undefined` means not a string (decode nothing); `null` means a string it can't name (explicit null).
- Produces, in `protobuf.ts`:

```ts
export type WireNode =
  | { field: number; wire: 'varint'; value: string }          // decimal string: a varint can exceed 2^53
  | { field: number; wire: 'i64'; value: string }             // hex, little-endian as on the wire
  | { field: number; wire: 'i32'; value: string }
  | { field: number; wire: 'len'; value: WireNode[] | { utf8: string } | { hex: string } }
export function decodeWire(bytes: Uint8Array, depth?: number): WireNode[] | null   // null if bytes are not a complete message
```

- [ ] **Step 1: Scaffold the package**

`packages/rivian/package.json`:

```json
{
  "name": "@ev/rivian",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": { "build": "tsc -p tsconfig.json", "typecheck": "tsc -p tsconfig.json --noEmit" },
  "dependencies": { "@ev/core": "workspace:*", "jose": "^5.9.0" },
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } }
}
```

Run `pnpm install`. Confirm `vitest.workspace.ts` (`['packages/*', 'apps/*']`) picks the package up.

- [ ] **Step 2: Write the failing tests**

`test/envelope.test.ts` must cover:
- `rivianTopic('VIN1','state') === 'rivian/VIN1/state'`.
- `readRivianEnvelope` accepts a valid v1 envelope. It returns null for:
  - `v: 2`
  - a missing `receivedAt`
  - an unknown stream
  - a non-object
  - a `vin` that isn't a string
- `cleanStrings({ 'a\u0000b': ['x\u0000', '\uD800y', 'ok 😀'] })` deep-equals `{ ab: ['x', '�y', 'ok 😀'] }`. A valid surrogate pair is kept.
- Non-string leaves (numbers, booleans, null) pass through unchanged.
- The input object isn't mutated.

`test/catalogue.test.ts` must cover:
- **Names:** every name in `RIVIAN_PROPERTIES` is unique and camelCase.
- **Shapes:** the three structured shapes are exactly `gnssLocation` (location), `cloudConnection` (cloudConnection) and `gnssError` (locationError).
- **`SHAPE_SELECTIONS`:**
  - `value` → `'{ timeStamp value }'`
  - `location` → `'{ latitude longitude timeStamp isAuthorized }'`
  - `cloudConnection` → `'{ lastSync isOnline }'`
  - `locationError` → `'{ timeStamp positionVertical positionHorizontal speed bearing }'`
- **`groupProperties`:** for 40 names it gives groups of 16, 16 and 8, in order. With `[]` it gives `[]`.
- **`vehicleStateDocument('veh', ['batteryLevel','gnssLocation'])`:** `operationName` is `'VehicleState'`, `variables` is `{ vehicleID: 'veh' }`, and `query` equals exactly `'subscription VehicleState($vehicleID: String!) { vehicleState(id: $vehicleID) { batteryLevel { timeStamp value } gnssLocation { latitude longitude timeStamp isAuthorized } } }'`.
- **`parallaxDocument('veh', null)`:** variables are `{ vehicleId: 'veh', rvms: null }`, and the query selects `parallaxMessages(vehicleId: $vehicleId, rvms: $rvms) { payload timestamp rvm }`.
- **`chargingSessionDocument`:** selects every field listed in spec §2.3 under `liveData` and `chartData`.

`test/gear.test.ts`:
- `park`, `PARK`, `drive`, `reverse` and `neutral` map to `P`, `P`, `D`, `R` and `N`.
- `'sport'` maps to `null`, and `42` to `undefined`.

`test/protobuf.test.ts`, with hand-encoded bytes:
- `[0x08, 0x96, 0x01]` gives `[{field:1, wire:'varint', value:'150'}]`.
- `[0x12, 0x02, 0x6f, 0x6b]` gives field 2 len `{utf8:'ok'}`. (`0x6f` is wire type 7, so it can't parse as a nested message. Don't use `'hi'`: `0x68 0x69` IS a valid one-field message, and the message rule wins.)
- A nested message `[0x1a, 0x03, 0x08, 0x96, 0x01]` gives field 3 len `[ {field:1,varint '150'} ]`.
- A fixed32 `[0x25, 0x00, 0x00, 0x80, 0x3f]` gives field 4 i32 `'0000803f'`.
- A truncated buffer `[0x08]` gives `null`.
- Recursion is bounded. Build 20 levels of nesting, each level a single field-1 len wrapper, with the innermost payload `[0x08,0x96,0x01]`. The top level is depth 0. Levels 0–15 parse as messages, and the len value at depth 15 is `{hex}`. Keep every length byte non-printable (they are: lengths stay under 0x20 at these sizes) so no level falls back to utf8.
- A varint of `2^63` gives `'9223372036854775808'`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run --project @ev/rivian`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement**

**`catalogue.ts`.** `RIVIAN_PROPERTIES` lists exactly these names (API field names: facts, not copied code). All have shape `value` except the three structured ones:

```
cloudConnection geoLocation gnssLocation gnssError alarmSoundStatus batteryCapacity batteryCellType
batteryHvThermalEvent batteryHvThermalEventPropagation batteryLevel batteryLimit batteryNeedsLfpCalibration
brakeFluidLow btmFfHardwareFailureStatus btmIcHardwareFailureStatus btmLfdHardwareFailureStatus
btmOcHardwareFailureStatus btmRfdHardwareFailureStatus btmRfHardwareFailureStatus
cabinClimateDriverTemperature cabinClimateInteriorTemperature cabinPreconditioningStatus
cabinPreconditioningType carWashMode chargerDerateStatus chargerState chargerStatus chargePortState
chargingDisabledAll closureFrunkClosed closureFrunkLocked closureFrunkNextAction closureLiftgateClosed
closureLiftgateLocked closureLiftgateNextAction closureSideBinLeftClosed closureSideBinLeftLocked
closureSideBinLeftNextAction closureSideBinRightClosed closureSideBinRightLocked closureSideBinRightNextAction
closureTailgateClosed closureTailgateLocked closureTailgateNextAction closureTonneauClosed closureTonneauLocked
closureTonneauNextAction defrostDefogStatus distanceToEmpty doorFrontLeftClosed doorFrontLeftLocked
doorFrontRightClosed doorFrontRightLocked doorRearLeftClosed doorRearLeftLocked doorRearRightClosed
doorRearRightLocked driveMode gearGuardLocked gearGuardVideoMode gearGuardVideoStatus
gearGuardVideoTermsAccepted gearStatus gnssAltitude gnssBearing gnssSpeed limitedRegenCold limitedAccelCold
otaAvailableVersion otaAvailableVersionGitHash otaAvailableVersionNumber otaAvailableVersionWeek
otaAvailableVersionYear otaCurrentStatus otaCurrentVersion otaCurrentVersionGitHash otaCurrentVersionNumber
otaCurrentVersionWeek otaCurrentVersionYear otaDownloadProgress otaInstallDuration otaInstallProgress
otaInstallReady otaInstallTime otaInstallType otaStatus petModeStatus petModeTemperatureStatus powerState
rangeThreshold rearHitchStatus remoteChargingAvailable seatFrontLeftHeat seatFrontLeftVent seatFrontRightHeat
seatFrontRightVent seatRearLeftHeat seatRearRightHeat seatThirdRowLeftHeat seatThirdRowRightHeat serviceMode
steeringWheelHeat timeToEndOfCharge tirePressureStatusFrontLeft tirePressureStatusFrontRight
tirePressureStatusRearLeft tirePressureStatusRearRight tirePressureStatusValidFrontLeft
tirePressureStatusValidFrontRight tirePressureStatusValidRearLeft tirePressureStatusValidRearRight
trailerStatus twelveVoltBatteryHealth vehicleMileage windowFrontLeftCalibrated windowFrontLeftClosed
windowFrontRightCalibrated windowFrontRightClosed windowRearLeftCalibrated windowRearLeftClosed
windowRearRightCalibrated windowRearRightClosed windowsNextAction wiperFluidState activeDriverName
chargingDisabledACFaultState chargingTimeEstimationValidity chargingTripTargetSoc
chargingTripTargetMinsRemaining closureChargePortDoorNextAction coldRangeNotification tirePressureFrontLeft
tirePressureFrontRight tirePressureRearLeft tirePressureRearRight
```

The header comment must explain:
- the list is R1-derived;
- discovery widens it at runtime (spec §5.6);
- groups exist because validation errors don't name fields (§5.4);
- it's written from field names, not copied.

**Subscription documents.** The variable names are the API's: `vehicleState` uses `$vehicleID`; the others use `$vehicleId` or `$id`, as in spec §2.3.
- `chargingSessionDocument`: `subscription ChargingSession($vehicleId: String!) { chargingSession(vehicleId: $vehicleId) { liveData { powerKW kilometersChargedPerHour rangeAddedThisSession totalChargedEnergy timeElapsed timeRemaining price currency isFreeSession vehicleChargerState startTime } chartData { soc powerKW startTime endTime timeEstimationValidityStatus vehicleChargerState } } }`
- `cloudConnectionDocument`: `subscription VehicleCloudConnection($id: String!) { vehicleCloudConnection(id: $id) { lastSync isOnline } }`
- `otaInstallStateDocument` / `otaInstallSchedulesDocument` / `geofencesDocument`: select `{ payload timestamp rvm }`.
- `departureSchedulesDocument`: `{ id name isEnabled occurrence { __typename ... on RepeatsWeekly { days startsAtMin skippedOn } } departureSettings { shouldOverrideChargeSchedule comfortSettings { cabinTempCelsius frontDefogDefrost surfaceHeatVentLevels { frontLeftSeat frontRightSeat rearLeftSeat rearRightSeat steeringWheel } } } }`.

**`protobuf.ts`.** A cursor over the bytes:
- Varints are read with BigInt.
- Wire types: 0 varint, 1 i64, 2 len, 5 i32. Types 3 and 4 (groups) or anything else mean the bytes aren't a message, so return null.
- A field number of 0 is invalid, so return null.
- For a `len` payload, try `decodeWire(sub, depth + 1)` if `depth + 1 < 16` and the sub-decode consumes all bytes and returns at least one node. Otherwise, if the bytes are valid UTF-8 with no control characters other than `\n\t\r`, return `{utf8}`. Otherwise return `{hex}`.
- Header comment: written from the public protobuf encoding documentation.

**`index.ts`** re-exports all four modules.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @ev/rivian build && pnpm vitest run --project @ev/rivian`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/rivian pnpm-lock.yaml
git commit -m "feat(rivian): envelope, property catalogue, gear and a schema-less protobuf reader"
```

---

### Task 4: Ingest knows its vendor

**Files:**
- Modify: `apps/ingest/src/config.ts`, `apps/ingest/src/mqtt.ts`, `apps/ingest/src/store.ts` (`registerVehicle`), `apps/ingest/src/main.ts`, `apps/ingest/src/metrics.ts`, `apps/ingest/src/reprocess.ts`, `apps/ingest/package.json` (add `"@ev/rivian": "workspace:*"`), `apps/ingest/Dockerfile` (build `@ev/rivian` before `@ev/ingest`)
- Test: `apps/ingest/test/config.test.ts`, `apps/ingest/test/mqtt.test.ts`, `apps/ingest/test/main.test.ts` / `startup.test.ts` (wherever they construct config), new `apps/ingest/test/mqtt-rivian.test.ts`, `apps/ingest/test/reprocess.test.ts`

**Interfaces:**
- Consumes: `cleanStrings`, `RIVIAN_TOPIC_ROOT`, `RIVIAN_STREAMS` and `readRivianEnvelope` from `@ev/rivian`. Note `mqtt.ts` must not import `@ev/rivian` (boundary test): **put the Rivian-specific parsing in `deps.ts`** and import from there.
- Produces:
  - `Config.vendor: Vendor`
  - `loadConfig` defaults by vendor (spec §6.2 table) and refusals
  - `registerVehicle(pool, vehicle, vendor)`
  - `subscribe(opts & { vendor }, …)` dispatching to `makeMessageHandler` (Tesla, unchanged) or `makeRivianMessageHandler` (new)
  - `ParseFailure` gains `'envelope'`
  - `initialiseSeries(vehicleId, vendor)` uses the vendor's record kinds
  - `untimedValuesTotal` counter `ev_ingest_untimed_values_total`

- [ ] **Step 1: Write the failing tests**

`config.test.ts` additions:

```ts
// NB: config.test.ts already declares a `BASE` at line 5 - reuse it (adding EV_VENDOR where needed) rather than redeclaring.
const V = { MQTT_PASSWORD: 'p', EV_VEHICLE_ID: 'v', EV_USABLE_CAPACITY_KWH: '75' }
it('requires EV_VENDOR', () => {
  expect(() => loadConfig({ ...V })).toThrow(/EV_VENDOR/)
  expect(() => loadConfig({ ...V, EV_VENDOR: 'ford' })).toThrow(/EV_VENDOR/)
})
it('derives the Tesla defaults exactly as before', () => {
  const c = loadConfig({ ...V, EV_VENDOR: 'tesla' })
  expect([c.vendor, c.mqtt.clientId, c.mqtt.topic, c.cursorSource]).toEqual(['tesla', 'ev-ingest', 'ev/#', 'tesla:mqtt'])
})
it('derives the Rivian defaults', () => {
  const c = loadConfig({ ...V, EV_VENDOR: 'rivian' })
  expect([c.vendor, c.mqtt.clientId, c.mqtt.topic, c.cursorSource]).toEqual(['rivian', 'ev-ingest-rivian', 'rivian/#', 'rivian:mqtt'])
})
it.each(['ev-ingest', 'ev-fleet-telemetry', 'ev-rivian'])('refuses a Rivian worker with client id %s', (id) => {
  expect(() => loadConfig({ ...V, EV_VENDOR: 'rivian', MQTT_CLIENT_ID: id })).toThrow(/MQTT_CLIENT_ID/)
})
it.each(['ev-ingest-rivian', 'ev-fleet-telemetry', 'ev-rivian'])('refuses a Tesla worker with client id %s', (id) => {
  expect(() => loadConfig({ ...V, EV_VENDOR: 'tesla', MQTT_CLIENT_ID: id })).toThrow(/MQTT_CLIENT_ID/)
})
it('refuses a topic outside the vendor root', () => {
  expect(() => loadConfig({ ...V, EV_VENDOR: 'rivian', MQTT_TOPIC: 'ev/#' })).toThrow(/MQTT_TOPIC/)
  expect(() => loadConfig({ ...V, EV_VENDOR: 'tesla', MQTT_TOPIC: 'rivian/#' })).toThrow(/MQTT_TOPIC/)
})
```

Update every existing test that calls `loadConfig` to pass `EV_VENDOR: 'tesla'`, including `main.test.ts`'s spawned-process env (about lines 43-53). Otherwise its `ECONNREFUSED` assertion fails on the new startup error. Every client-id refusal message must contain both `MQTT_CLIENT_ID` and `must not be`: the existing test at `config.test.ts:24` matches `/must not be/`.

`mqtt-rivian.test.ts` drives `makeRivianMessageHandler(opts, onMessage, hooks)` with fake packets. Cases:

| Input | Expected |
|---|---|
| `rivian/VIN1/state` with a valid v1 envelope | `onMessage` gets `{vehicleId: 'r2', vendor: 'rivian', source: 'graphql_ws', receivedAt: new Date(envelope.receivedAt), payload: envelope}`; `done()` only after it resolves |
| an envelope with `v: 2` | still taped (`onMessage` called with the parsed body as payload); `onParseFailure('envelope')` called |
| a missing or unparseable `receivedAt` | taped with local arrival time; counted `envelope` |
| a body with `"\u0000"` in a string | the payload passed on has it removed |
| a non-JSON body | `json` failure, acked, not taped |
| an empty body | `empty`, acked |
| `rivian/OTHERVIN/state` | `unknown-vehicle`, acked |
| `rivian/VIN1` (too short) or `ev/VIN1/v/Soc` | `topic`, acked |
| an `onMessage` rejection | `onHandlerError`, and `done(err)` (not acked) |

`reprocess.test.ts`: add a test that `streamRaw` is called with `config.vehicle.id`. Use whatever seam the existing tests use; if none exists, extract `replayWindow(client, config, window)` from `main()` and test that.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm install` (for the new `@ev/rivian` dependency), then `pnpm vitest run --project @ev/ingest test/config.test.ts test/mqtt-rivian.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

**`config.ts`:**
- `vendor` comes from `EV_VENDOR`, which must be exactly `tesla` or `rivian`, else throw `EV_VENDOR must be 'tesla' or 'rivian', got …`.
- `const OWN = { tesla: { clientId: 'ev-ingest', topic: 'ev/#', root: 'ev/', cursor: 'tesla:mqtt' }, rivian: { clientId: 'ev-ingest-rivian', topic: 'rivian/#', root: 'rivian/', cursor: 'rivian:mqtt' } }`.
- `RESERVED_CLIENT_IDS = ['ev-fleet-telemetry', 'ev-rivian', 'ev-ingest', 'ev-ingest-rivian']`. A worker's client id may not be any reserved id other than its own default.
- The topic must start with its vendor's `root`.
- The comments carry the "steals the Tesla backlog and acks it as parse failures" reasoning from spec §6.2.

**`deps.ts`** gains `parseRivianTopic(topic, expectedVin)` and `tapeRivianBody(text, arrival)`, which wrap `@ev/rivian`:
- `parseRivianTopic` returns `{vin, stream} | null`. It accepts `rivian/<VIN>/<anything non-empty>`, exactly 3 segments.
- `tapeRivianBody` returns `{payload, receivedAt, envelopeOk} | {error: 'json'}`. It does `JSON.parse`, then `cleanStrings`, then `readRivianEnvelope`:
  - a v1 envelope gives `receivedAt = new Date(env.receivedAt)` (falling back to `arrival` with `envelopeOk = false` if that's NaN);
  - a non-v1 body gives `payload = parsed body`, `receivedAt = arrival`, `envelopeOk = false`.

**`mqtt.ts`** adds `makeRivianMessageHandler` with the same ack discipline as `makeMessageHandler` and the same `attach`/`subscribe` wiring. `subscribe` picks the handler by `opts.vendor`. Update the doc comments: Rivian has no `reliable_ack` chain behind it, but the broker queue is still the only buffer, so ack-after-commit is unchanged.

**`store.ts`:** `registerVehicle(pool, vehicle, vendor: Vendor)` uses `vendor`. Replace the comment about "Rivian gets its own worker" with the true statement.

**`metrics.ts`:**
- Record kinds become per vendor: Tesla `['metrics','alert','error','connectivity']`; Rivian `RIVIAN_STREAMS`, re-exported via `deps.ts`.
- Add `'envelope'` to `PARSE_FAILURE_REASONS`.
- Add `untimedValuesTotal = new Counter({ name: 'ev_ingest_untimed_values_total', help: 'Rivian values whose own timestamp was missing or unparseable, stamped with arrival instead (spec §6.4).', registers: [registry] })`, initialised at 0.

**`main.ts`:**
- `initialiseSeries(config.vehicle.id, config.vendor)` and `registerVehicle(pool, config.vehicle, config.vendor)`.
- `new Pipeline(profileFor(config.vendor), …)`, and vendor labels from config.
- `record()` increments `untimedValuesTotal` by `result.untimed`.
- The `onRecord` hook passes the stream or kind. Widen `MqttHooks.onRecord(record: RecordKind)` to `onRecord(record: string)` in `mqtt.ts`: a Rivian stream isn't a Tesla `RecordKind`.
- **Skew-corrected flush.** Put the logic in a new `apps/ingest/src/flush-clock.ts`: `export function flushClock(now = () => Date.now()) { return { observe(receivedAt: Date): void, now(): Date } }`. `observe` records `skew = now() - receivedAt`, and `now()` returns `new Date(now() - skew)`. Unit-test it in `test/flush-clock.test.ts`: with no observation it gives wall time; after observing a stamp 10 min old it gives wall time minus 10 min; after observing a current stamp it gives wall time. `main.ts` uses it like this:

```ts
  // The connector's clock, not ours, stamps a Rivian message (spec §6.2): during
  // a backlog drain every pending burst would look overdue against our wall
  // clock and be written alone. So the timer asks "is it due?" in the stamp's
  // timeline, offset by how far behind the newest message we are. For Tesla the
  // stamp IS our arrival time and the skew is ~0, so nothing changes.
  let skewMs = 0
  // in the onMessage callback, before pipeline.handle(raw):
  skewMs = Date.now() - raw.receivedAt.getTime()
  // in the interval:
  pipeline.flush(new Date(Date.now() - skewMs)).then(record, …)
```

**`reprocess.ts`:** `streamRaw(client, from, to, undefined /* or the existing page size */, config.vehicle.id)`. Check `streamRaw`'s real signature in `packages/db/src/repo/raw.ts`. Build the pipeline with `profileFor(config.vendor)`, and rewrite the comment at lines 88-92 to match.

**`Dockerfile`:** add `&& pnpm --filter @ev/rivian build` after `@ev/tesla`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the full gate. Then `podman build -f apps/ingest/Dockerfile -t ev-ingest-test .` must succeed.

- [ ] **Step 5: Commit**

```bash
git add apps/ingest pnpm-lock.yaml
git commit -m "feat(ingest): require EV_VENDOR, and tape Rivian envelopes off their own topics"
```

---

### Task 5: Rivian normaliser

**Files:**
- Create: `packages/rivian/src/normalise.ts`, `packages/rivian/test/normalise.test.ts`, `packages/rivian/test/fixtures/state.ts` (the header says SYNTHETIC: hand-written from documented R1 shapes, to be replaced from the tape after delivery)
- Modify: `packages/rivian/src/index.ts`

**Interfaces:**
- Consumes: `SAMPLE_COLUMNS`, `makeSample`, `Gear`, `PowerState`, `ChargeState` and `VehicleSample` from `@ev/core`; `readRivianEnvelope` and `rivianGear`.
- Produces:

```ts
export const LOCK_PROPERTIES: readonly string[]     // doorFrontLeftLocked … closureSideBinRightLocked (10)
export const CLOSED_PROPERTIES: readonly string[]   // the matching *Closed (10)
export interface RivianFieldState {
  socPct: number | null; rangeKm: number | null; odometerKm: number | null
  lat: number | null; lon: number | null; speedKph: number | null; gpsHeading: number | null
  powerStateRaw: string | null; cloudOnline: boolean | null
  chargerState: string | null; chargerStatus: string | null
  insideTempC: number | null
  tpmsFl: number | null; tpmsFr: number | null; tpmsRl: number | null; tpmsRr: number | null
  gear: Gear | null; chargeLimitSoc: number | null; nominalFullPackEnergyKwh: number | null
  timeToFullChargeHours: number | null; version: string | null
  chargePowerKw: number | null; chargeEnergyAddedKwh: number | null
  [lockOrClosed: string]: unknown   // LOCK_PROPERTIES / CLOSED_PROPERTIES keys hold 'locked'|'unlocked'|'open'|'closed'
}
export const RIVIAN_VOLATILE_SLOTS: readonly string[]          // ['speedKph','gpsHeading','chargePowerKw']
export const RIVIAN_CHARGE_STATE_SLOTS: readonly string[]      // ['chargerState','chargerStatus']
export const RIVIAN_CHARGING_POWER_SLOTS: readonly string[]    // ['chargePowerKw']
export const RIVIAN_CHARGING_ENERGY_SLOTS: readonly string[]   // ['chargeEnergyAddedKwh']
export const GPS_SPEED_NOISE_FLOOR_MS = 0.5
export interface RivianDecoded { slots: Record<string, unknown>; observedAt: Record<string, number>; untimed: number }
export function decodeRivian(payload: unknown, receivedAt: Date, staleWindowFor: (slot: string) => number): RivianDecoded | null
export function rivianStateToSample(vehicleId: string, ts: Date, state: Record<string, unknown>): VehicleSample
```

Because of the index signature, write the volatile-slot check as `satisfies readonly (keyof RivianFieldState & string)[]` against an explicit named-keys type (`type NamedSlot = Exclude<keyof RivianFieldState, …>`), or declare the named keys in a separate `interface RivianNamedSlots`. Whichever you choose, a misspelt slot in `RIVIAN_VOLATILE_SLOTS` must fail to compile. Add a `// @ts-expect-error` test line proving it.

- [ ] **Step 1: Write the failing tests**

Build fixtures as v1 envelopes. Put a helper in `test/fixtures/state.ts`:

```ts
/** SYNTHETIC. Hand-written from the R1 shapes documented by the Apache-2.0 Home Assistant
 *  integration (spec §2.5). Replace with real R2 tape excerpts after delivery (spec §8.4). */
export function stateEnvelope(receivedAt: string, props: Record<string, unknown>) {
  return { v: 1, stream: 'state', vin: 'VIN1', receivedAt, body: { data: { vehicleState: props } } }
}
export const tv = (timeStamp: string, value: unknown) => ({ timeStamp, value })
```

`normalise.test.ts` must assert, with `const W = (s: string) => s === 'speedKph' || s === 'gpsHeading' || s === 'chargePowerKw' ? 300_000 : 21_600_000`:

**Units and conversions:**
- `batteryLevel 81.5` gives `socPct 81.5`.
- `vehicleMileage 12345678` gives `odometerKm 12345.678`.
- `gnssSpeed 10` gives `speedKph 36`; `gnssSpeed 0.4` gives `speedKph 0` (the noise floor).
- `timeToEndOfCharge 90` gives `timeToFullChargeHours 1.5`.
- A numeric string `'81.5'` is accepted. `''`, `'abc'`, `NaN` and `Infinity` decode to nothing.

**Location:**
- `gnssLocation { latitude: 47.6, longitude: -122.3, timeStamp }` gives `lat` and `lon`.
- A location with only `latitude` gives neither.

**Nulls and placeholders:**
- `batteryLevel: null` (the property object is null) contributes nothing.
- `tv(ts, null)` contributes nothing.
- `tv(ts, 'signal_not_available')`, `'fault'` and `'undefined'` contribute nothing.

**Clocks (`observedAt`):**
- It's the property's `timeStamp` in ms, clamped to `receivedAt` (a `timeStamp` 10 s after `receivedAt` gives `receivedAt`).
- Too old: `gnssSpeed` stamped 3 h before `receivedAt` contributes nothing (window 5 min). `batteryLevel` stamped 3 h before applies, with `observedAt` 3 h before.
- Untimed: `tv('garbage', 50)` for `batteryLevel` applies, has no `observedAt` key, and adds 1 to `untimed`.

**Gear:**
- `gearStatus 'drive'` gives `{gear: 'D'}`; `'sport'` gives `{gear: null}`.
- `powerState 'sleep'` gives `{powerStateRaw: 'sleep', gear: 'P'}`; `'standby'` also sets gear P; `'go'` doesn't touch gear.

**Other slots:**
- `cloudConnection {isOnline: false, lastSync}` gives `cloudOnline false`. It has no `timeStamp`, so it uses `receivedAt` and isn't counted as untimed.
- **`charging` stream:** `{data: {chargingSession: {liveData: {powerKW: 7.2, totalChargedEnergy: 3.4, vehicleChargerState: 'charging_active', …}}}}` gives `chargePowerKw 7.2`, `chargeEnergyAddedKwh 3.4`, `chargerState 'charging_active'`.
- **`cloud` stream:** `{data: {vehicleCloudConnection: {isOnline: true}}}` gives `cloudOnline true`.
- **Returns `null`:** `parallax` and `meta` streams, `v: 2`, garbage.
- **Unknown properties:** `{ someFutureThing: tv(ts, 1) }` gives `slots {}`, not null.

`rivianStateToSample('r2', ts, state)` must assert:

**Power state:**
- `{cloudOnline: false, powerStateRaw: 'go'}` gives `offline`.
- `{powerStateRaw: 'sleep'}` gives `asleep`.
- `go`, `ready`, `standby` and `vehicle_reset` give `online`.
- An unknown value gives `null`.

**Charge state** (the spec §7.3 table, every row):
- `not_connected` wins over `charging_active`.
- `charging_connecting` with a connected status gives `connected`.
- An unknown state with no status gives `null`.

**Locks and doors:**
- `locked`: every reported lock `locked` gives `true`; one `unlocked` gives `false`; none gives `null`.
- `doorsOpen`: any `open` gives `true`; all `closed` gives `false`; none gives `null`.

**Other columns:**
- `tpms`: `{tpmsFl: 2.9, tpmsRr: 2.8}` gives `{fl: 2.9, rr: 2.8}`; none gives `null`.
- Gear P forces speed: `{gear: 'P', speedKph: 3}` gives `speedKph 0`; `{gear: 'D', speedKph: 3}` gives `3`; `{gear: 'P'}` with no speed gives `null` (not 0).
- `chargePowerKw` and `chargeEnergyAddedKwh` pass through.
- Every column the result fills is a real `SAMPLE_COLUMNS` key: iterate the non-null keys of a fully populated sample.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run --project @ev/rivian test/normalise.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

**Placeholders.** `const PLACEHOLDERS = new Set(['fault', 'signal_not_available', 'undefined'])`.

**Number decoder.** Like Tesla's: accept finite numbers and numeric strings (trimmed, non-empty).

**`decodeRivian`:**
1. `readRivianEnvelope(payload)`, or return null.
2. Switch on `env.stream`:
   - `state`: walk `body.data.vehicleState`.
   - `charging`: `body.data.chargingSession.liveData`.
   - `cloud`: `body.data.vehicleCloudConnection`.
   - anything else: null.
3. Use a per-property table `{ slot(s), decode }` for the spec §7.2 rows. Everything not in the table is skipped.
4. For timestamped properties:
   - parse `timeStamp` with `Date.parse`; if NaN, `untimed++` and no `observedAt`;
   - otherwise `obs = min(parsed, receivedAt)`;
   - if `receivedAt - obs >= staleWindowFor(slot)`, skip the property entirely;
   - otherwise set `observedAt[slot] = obs` for each slot it fills.

**`rivianStateToSample`:**
- Build the direct columns: `socPct`, `rangeKm`, `odometerKm`, `lat`, `lon`, `speedKph`, `gpsHeading`, `insideTempC`, `gear`, `chargeLimitSoc`, `nominalFullPackEnergyKwh`, `timeToFullChargeHours`, `version`, `chargePowerKw`, `chargeEnergyAddedKwh`.
- Then add the combined `powerState`, `chargeState`, `locked`, `doorsOpen` and `tpms`. Apply the Park speed rule last.
- Return `makeSample({ vehicleId, ts, ...cols })`.

**Comments** explain each rule's reason, citing spec sections.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ev/rivian build && pnpm vitest run --project @ev/rivian`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/rivian
git commit -m "feat(rivian): normalise vehicle state and charging onto the canonical sample"
```

---

### Task 6: The Rivian profile, end to end, and `parallax-dump`

**Files:**
- Create: `apps/ingest/src/profiles/rivian.ts`, `apps/ingest/src/parallax-dump.ts`, `apps/ingest/test/pipeline-rivian.test.ts`, `apps/ingest/test/parallax-dump.test.ts`
- Modify: `apps/ingest/src/deps.ts` (return `rivianProfile`), `apps/ingest/package.json` (add the script `"parallax-dump": "node dist/parallax-dump.js"`)

**Interfaces:**
- Consumes: Task 5's exports and `timing.ts`.
- Produces: `export const rivianProfile: VendorProfile`. `parallax-dump` exports `parseDumpArgs(argv): {rvm, from, to, limit}` and `dumpRows(rows: AsyncIterable<RawRow>, opts, write: (line: string) => void): Promise<number>`.

- [ ] **Step 1: Write the failing tests**

`pipeline-rivian.test.ts` uses `FakeDb` and `new Pipeline(rivianProfile, db, { usableCapacityKwh: 80 })` (`FakeDb` is itself the `StoreRunner`), feeding `RawMessage`s built from Task 5's fixture helpers (`vendor: 'rivian'`, `source: 'graphql_ws'`, `receivedAt = new Date(envelope.receivedAt)`). Scenarios:

1. **Drive.**
   - At 10:00:00, a state frame: `gearStatus park`, `gnssSpeed 0`, `batteryLevel 80`, `vehicleMileage 1000000`, `powerState go`.
   - From 10:00:10, every 5 s until 10:10, frames with `gearStatus drive`, `gnssSpeed 20`, mileage rising 100 m per frame, `gnssLocation` moving.
   - At 10:10:05, `gearStatus park`, `gnssSpeed 0`.
   - Then frames every 30 s until 10:17.
   - `flush(new Date('…10:30'), true)`.
   - Expect exactly one closed drive with `distanceKm` about the mileage delta. The SoC delta gives `energyKwh` about `(80 - endSoc)/100 * 80`.
2. **Charge.**
   - `chargerStatus chrgr_sts_connected_charging` and `chargerState charging_connecting`.
   - Then `charging_active` with a `charging` stream frame `powerKW 7.2`, `totalChargedEnergy` rising 0 → 10 over 2 h in frames every 5 min.
   - Then `charging_complete`.
   - Expect one charge, `energyKwh` ≈ 10, `maxChargePowerKw` 7.2.
3. **Snapshot resurrection** (Review Focus 1).
   - A parked car (`gearStatus park`, `gnssSpeed 0` at 09:00).
   - At 09:01 a frame carries `gearStatus drive` stamped 08:59, an OLDER observation than the 09:00 park. Assert the emitted sample's gear is still `P`, because an older observation never overwrites a newer one.
   - At 12:00 a resubscribe snapshot re-sends `gearStatus park` stamped 09:00, and `gnssSpeed` 15 m/s stamped 08:58 (the last moving reading before parking).
   - Expect **no** drive opened, and the emitted 12:00 sample's `speedKph` null or 0.
4. **GPS jitter while charging.**
   - During scenario 2's charge, add state frames with `gnssSpeed 0.4` (below the floor) and `gearStatus park` with `gnssSpeed 0.6`.
   - Expect the charge not split.
5. **Other streams.**
   - `parallax`, `meta` and `ota` envelopes are taped (`db.state.raw` grows), contribute `unmapped: 1`, and open nothing.
6. **Empty frames.** A state frame with only null and unknown properties gives `unmapped: 1` and `fieldsApplied: 0`.
7. **Untimed count.**
   - A frame with `tv('garbage', 50)` returns a result with `untimed: 1`.

`parallax-dump.test.ts`:
- `parseDumpArgs(['--rvm','charging.session.notification','--limit','5'])` gives `{rvm, from: null, to: null, limit: 5}`. A missing `--rvm` throws a usage error.
- `dumpRows` over two fake rows only decodes the matching one. The first is a parallax envelope with `body: {data: {parallaxMessages: {rvm: 'charging.session.notification', payload: base64([0x08,0x96,0x01]), timestamp: '…'}}}`; the second has a different rvm. It writes one JSON line `{"receivedAt":…,"rvm":"charging.session.notification","tree":[{"field":1,"wire":"varint","value":"150"}]}` and returns 1.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run --project @ev/ingest test/pipeline-rivian.test.ts test/parallax-dump.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/ingest/src/profiles/rivian.ts
export function rivianStaleWindowFor(slot: string): number {
  return VOLATILE.has(slot) ? VOLATILE_STALE_MS : STALE_VALUE_MS
}
const VOLATILE: ReadonlySet<string> = new Set(RIVIAN_VOLATILE_SLOTS)
export const rivianProfile: VendorProfile = {
  vendor: 'rivian',
  decode(raw) {
    if (raw.vendor !== 'rivian') return null
    const d = decodeRivian(raw.payload, raw.receivedAt, rivianStaleWindowFor)
    // A frame carrying nothing we place (only unknown or null properties) is
    // unmapped, not an applied field: counting it would schedule an emit of
    // carried-only state on every 60 s resubscribe.
    if (d === null || (Object.keys(d.slots).length === 0 && d.untimed === 0)) return null
    return { slots: d.slots, observedAt: d.observedAt, untimed: d.untimed }
  },
  toSample: rivianStateToSample,
  staleWindowFor: rivianStaleWindowFor,
  chargeStateSlots: RIVIAN_CHARGE_STATE_SLOTS,
  chargingPowerSlots: RIVIAN_CHARGING_POWER_SLOTS,
  chargingEnergySlots: RIVIAN_CHARGING_ENERGY_SLOTS,
}
```

Its header comment covers why there are no Tesla-style carried-drive exceptions (lat, lon and gear are levels here) and spec §6.4. `deps.ts` returns it for `'rivian'`.

**`parallax-dump.ts`:**
- `main()` reads config (vendor must be `rivian`, else exit with a message) and streams raw rows for `config.vehicle.id` in the window (default the whole tape).
- It filters with `readRivianEnvelope(row.payload)?.stream === 'parallax'` and a matching `rvm`, base64-decodes `payload`, and calls `decodeWire`. Each line is `JSON.stringify({receivedAt, rvm, tree})`.
- `--limit` stops early. It's read-only, takes no transaction writes, and uses the `import.meta.url` main guard exactly as `reprocess.ts` does.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the full gate.

- [ ] **Step 5: Commit**

```bash
git add apps/ingest
git commit -m "feat(ingest): the Rivian profile, and a reader for taped Parallax"
```

---

### Task 7: Rivian HTTP client, redacted errors, credential sealing, keygen

**Files:**
- Create: `packages/rivian/src/{errors,http,credential}.ts`, `packages/rivian/test/{http,credential,errors}.test.ts`, `scripts/rivian-keygen.mjs`
- Modify: `packages/rivian/src/index.ts`

**Interfaces:**

```ts
// errors.ts
export interface RivianErrorCode { code: string; reason?: string }
export class RivianApiError extends Error {
  readonly httpStatus: number | null
  readonly codes: readonly RivianErrorCode[]
  constructor(httpStatus: number | null, codes: readonly RivianErrorCode[], what: string)
  /** UNAUTHENTICATED anywhere in codes */
  get unauthenticated(): boolean
  get rateLimited(): boolean          // code RATE_LIMIT, or HTTP 429
  get validationFailed(): boolean     // GRAPHQL_VALIDATION_FAILED
  get badCredentials(): boolean       // BAD_CURRENT_PASSWORD / BAD_USER_INPUT without an OTP reason
  get badOtp(): boolean               // (BAD_USER_INPUT, INVALID_OTP) or (UNAUTHENTICATED, OTP_TOKEN_EXPIRED)
  get locked(): boolean               // SESSION_MANAGER_ERROR
  /** The only form that may be logged, stored or shown (spec §4.4). */
  redacted(): string                  // e.g. "Rivian HTTP 400: UNAUTHENTICATED/expired"
}
export function toRivianApiError(httpStatus: number | null, body: unknown, what: string): RivianApiError

// http.ts
export const GATEWAY_URL = 'https://rivian.com/api/gql/gateway/graphql'
export const CHARGING_URL = 'https://rivian.com/api/gql/chrg/user/graphql'
export const SUBSCRIPTIONS_URL = 'wss://api.rivian.com/gql-consumer-subscriptions/graphql'
export const APOLLO_CLIENT_NAME = 'com.rivian.ios.consumer-apollo-ios'
export const USER_AGENT = 'RivianApp/707 CFNetwork/1237 Darwin/20.4.0'
export const CLIENT_VERSION = '1.13.0-1494'
export interface AppSession { csrfToken: string; appSessionToken: string }
export type LoginResult =
  | { kind: 'session'; userSessionToken: string }
  | { kind: 'otp'; otpToken: string }
export interface RivianHttpOptions { fetch?: typeof fetch; timeoutMs?: number }   // default 15000
export class RivianHttp {
  constructor(opts?: RivianHttpOptions)
  createCsrf(): Promise<AppSession>
  login(app: AppSession, email: string, password: string): Promise<LoginResult>
  loginWithOtp(app: AppSession, email: string, otpCode: string, otpToken: string): Promise<{ userSessionToken: string }>
  userInfo(app: AppSession, userSessionToken: string): Promise<unknown>      // returns data verbatim
  vehicle(app: AppSession, userSessionToken: string, vehicleId: string): Promise<unknown>
  chargingSummaries(app: AppSession, userSessionToken: string, vehicleId: string): Promise<unknown>
  introspectVehicleState(app: AppSession, userSessionToken: string): Promise<unknown>
}
export function findVehicle(userInfo: unknown, vin: string): { id: string; vin: string } | null
export function connectionInitPayload(userSessionToken: string): Record<string, string>   // {client-name, client-version, dc-cid, u-sess}

// credential.ts  (import type { JWK } from 'jose' - JsonWebKey is not declared under this repo's lib: ["ES2023"])
export interface RivianCredential { userSessionToken: string }
export function sealCredential(publicJwk: JWK, c: RivianCredential): Promise<string>
export function unsealCredential(privateJwk: JWK, sealed: string): Promise<RivianCredential>   // throws CredentialUnreadable
export class CredentialUnreadable extends Error {}
export function generateCredentialKeys(): Promise<{ privateJwk: JWK; publicJwk: JWK }>
export function parseJwk(text: string, kind: 'private' | 'public'): JWK   // validates kty EC, crv P-256, d present iff private
```

- [ ] **Step 1: Write the failing tests**

`http.test.ts` uses an injected `fetch` that records requests and returns canned responses.

**`createCsrf`:**
- It POSTs to `GATEWAY_URL` with `Apollographql-Client-Name`, `User-Agent` and a `dc-cid` matching `/^m-ios-[0-9a-f-]{36}$/`.
- The body has `operationName: 'CreateCSRFToken'`.
- It returns the tokens.

**`login`:**
- It sends `Csrf-Token` and `A-Sess`.
- A `MobileLoginResponse` gives `{kind:'session', userSessionToken}`. `accessToken` and `refreshToken` aren't returned.
- A `MobileMFALoginResponse` gives `{kind:'otp', otpToken}`.

**`loginWithOtp`:** variables `{email, otpCode, otpToken}`.

**Authenticated calls:**
- `userInfo` sends `A-Sess` and `U-Sess`, and the query selects `currentUser { id vehicles { id vin name state roles createdAt updatedAt vehicle { id vin modelYear make model expectedBuildDate plannedBuildDate expectedGeneralAssemblyStartDate actualGeneralAssemblyDate } } }`.
- `chargingSummaries` POSTs to `CHARGING_URL` with `getCompletedSessionSummaries`.
- `introspectVehicleState` sends `__type(name: "VehicleState") { fields { name type { name kind ofType { name kind } } } }`.
- `vehicle` sends `getVehicle(id: $id) { id vin mobileConfiguration { … } }`. Select `__typename` plus the documented subfields if known; otherwise select `id vin` and leave `mobileConfiguration` out with a comment.

**Errors:**
- A 400 with `{errors:[{extensions:{code:'UNAUTHENTICATED'}}], data:null}` throws a `RivianApiError` with `unauthenticated` true.
- A timeout throws a `RivianApiError` with `httpStatus` null.

**`findVehicle`:** finds the VIN among several vehicles; null when absent; null for garbage input.

**`connectionInitPayload('S')`:** has the `u-sess` and `client-name` keys.

`errors.test.ts` (Review Focus 5):
- Build a response body containing `accessToken`, `refreshToken`, `userSessionToken`, `otpToken`, `csrfToken`, `appSessionToken` and a `message` echoing `"password=hunter2"`.
- Assert that `String(err)`, `err.message`, `err.redacted()`, `JSON.stringify(err)` and `err.stack` contain none of those values.
- Assert `err.codes` holds only `code` and `reason`.
- Assert the classification getters for each code in the interface.

`credential.test.ts`:
- `generateCredentialKeys`, then `seal` and `unseal`, round-trips `{userSessionToken: 'S'}`.
- Unsealing with a different private key throws `CredentialUnreadable`.
- A corrupt string throws `CredentialUnreadable`.
- The sealed string's protected header has `alg: 'ECDH-ES+A256KW'` and `enc: 'A256GCM'`.
- `parseJwk` rejects a public key passed as private, a private key passed as public, an RSA key, and non-JSON.
- Sealing extra fields is impossible: the payload is exactly `{userSessionToken}` (decode and compare keys).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run --project @ev/rivian test/http.test.ts test/errors.test.ts test/credential.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

**`RivianHttp`:**
- Every call goes through `private async post(url, headers, body, what)`.
- Timeout uses `AbortSignal.timeout(timeoutMs)`.
- A non-JSON response, an `errors` array, a missing `data`, or a non-2xx status becomes `toRivianApiError(status, parsedOrNull, what)`.
- **Never** put the request body, headers or raw response text into an error or log.
- Headers: `Content-Type: application/json`, `Accept: application/json`, `User-Agent`, `Apollographql-Client-Name`, `dc-cid: m-ios-${randomUUID()}`.

**Credential:** use `jose`'s `CompactEncrypt`, `compactDecrypt`, `importJWK`, `generateKeyPair('ECDH-ES+A256KW', { crv: 'P-256', extractable: true })` and `exportJWK`.

**`scripts/rivian-keygen.mjs`:**
- Imports `generateCredentialKeys` from `../packages/rivian/dist/index.js` and prints two lines: `RIVIAN_CREDENTIAL_PRIVATE_KEY=<json>` and `RIVIAN_CREDENTIAL_PUBLIC_KEY=<json>`.
- A header comment says to run `pnpm --filter @ev/rivian build` first, and that the private line goes only into the connector's SealedSecret.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ev/rivian build && pnpm vitest run --project @ev/rivian && node scripts/rivian-keygen.mjs | head -c 80`
Expected: PASS, and the script prints a key line.

- [ ] **Step 5: Commit**

```bash
git add packages/rivian scripts/rivian-keygen.mjs
git commit -m "feat(rivian): an HTTP client whose errors carry no secrets, and credentials sealed to the connector"
```

---

### Task 8: Database: `009_rivian.sql` and its repository

**Files:**
- Create: `packages/db/migrations/009_rivian.sql`, `packages/db/src/repo/rivian.ts`, `packages/db/test/rivian-repo.test.ts`
- Modify: `packages/db/src/index.ts` (export the repo; the barrel comment explains why this matters)

**Interfaces:**

```ts
export interface RivianCredentialRow { sealed: string; account: string; createdAt: Date; updatedAt: Date }
export function readRivianCredential(c: DbClient): Promise<RivianCredentialRow | null>
export function readRivianCredentialStamp(c: DbClient): Promise<Date | null>         // updated_at only
export function upsertRivianCredential(c: DbClient, v: { sealed: string; account: string }): Promise<void>   // sets updated_at = now() explicitly
export function deleteRivianCredential(c: DbClient): Promise<void>
export type RivianConnectorState =
  | 'signed_out' | 'starting' | 'credential_invalid' | 'finding_vehicle' | 'waiting_for_vehicle'
  | 'connecting' | 'subscribed' | 'backing_off' | 'unauthenticated'
export interface RivianStatusRow {
  state: RivianConnectorState; vin: string | null; rivianVehicleId: string | null
  lastFrameAt: Date | null; lastError: string | null; backoffUntil: Date | null
  droppedProperties: string[]; updatedAt: Date
}
export function readRivianStatus(c: DbClient): Promise<RivianStatusRow | null>
export function writeRivianStatus(c: DbClient, s: Omit<RivianStatusRow, 'updatedAt'>): Promise<void>   // upsert id=1, updated_at=now()
```

- [ ] **Step 1: Write the failing test**

`rivian-repo.test.ts`, against real Postgres with the same skip guard as `repo.test.ts`, migrated to latest:
- Add a `beforeEach` that runs `DELETE FROM rivian_credential; DELETE FROM rivian_status` so local reruns are idempotent.
- Credential: null when empty. Upsert then read. A second upsert changes `sealed` and makes `updated_at` strictly greater (sleep 10 ms between). Read the stamp. Delete, then null.
- Status: write then read round-trips every field, including `droppedProperties: ['a','b']` and the default `[]`.
- Inserting a second row with `id = 2` directly fails the CHECK, for both tables.

- [ ] **Step 2: Run the test to verify it fails**

Run: `PG…=… pnpm vitest run --project @ev/db test/rivian-repo.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`009_rivian.sql`:
- Up: the two `CREATE TABLE`s exactly as in spec §4.2 and §5.7, with comments carrying their reasoning (one account, one row; only the connector writes status; `last_error` is redacted). The `state` column carries `CHECK (state IN (…the nine states…))`.
- Down: `DROP TABLE rivian_status; DROP TABLE rivian_credential;`

Repo functions follow `telemetry-status.ts`'s style.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the full gate.

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat(db): a sealed Rivian credential and the connector's status, one row each"
```

---

### Task 9: Connector building blocks: backoff, socket, subscription plan

**Files:**
- Create: `apps/rivian/package.json`, exactly:
  ```json
  {"name":"@ev/rivian-connector","version":"0.0.0","private":true,"type":"module",
   "scripts":{"build":"tsc -p tsconfig.json","typecheck":"tsc -p tsconfig.json --noEmit","start":"node dist/main.js"},
   "dependencies":{"@ev/core":"workspace:*","@ev/db":"workspace:*","@ev/rivian":"workspace:*","mqtt":"^5.10.0","prom-client":"^15.1.0","ws":"^8.18.0"},
   "devDependencies":{"@types/ws":"^8.5.0"}}
  ```
  Also: `apps/rivian/tsconfig.json` (copy `apps/ingest`'s), `apps/rivian/vitest.config.ts` if `apps/ingest` has one (else rely on the workspace and a `test/` dir), `apps/rivian/src/{backoff,socket,subscriptions}.ts`, `apps/rivian/test/{backoff,socket,subscriptions}.test.ts`, `apps/rivian/test/support/fake-rivian-ws.ts`

**Interfaces:**

```ts
// backoff.ts
export const BACKOFF_FLOOR_MS = 30_000, BACKOFF_CAP_MS = 900_000
export class Backoff {
  constructor(random?: () => number)
  next(): number            // floor*2^attempt + random()*floor, capped; increments attempt
  reset(): void
  get attempt(): number
}

// socket.ts: one graphql-transport-ws connection
export type CloseReason = 'rate_limited' | 'unauthenticated' | 'no_ack' | 'closed' | 'error'
export interface SocketHandlers {
  onNext(id: string, payload: unknown): void
  onError(id: string, payload: unknown): void
  onComplete(id: string): void
  onClose(reason: CloseReason, detail: string): void
}
export interface SocketLike {
  subscribe(id: string, doc: SubscriptionDocument): void
  complete(id: string): void
  close(): void
}
export function openSocket(opts: {
  url: string; initPayload: Record<string, string>; ackTimeoutMs: number   // 15000
  handlers: SocketHandlers; WebSocketImpl?: typeof WebSocket   // `ws` default
}): Promise<SocketLike>     // resolves on connection_ack; rejects with {reason:'no_ack'|...}

// subscriptions.ts: pure state, no I/O
export interface PlannedSubscription { key: string; stream: RivianStream; doc: SubscriptionDocument; properties?: string[] }
export class SubscriptionPlan {
  constructor(vehicleId: string, opts: { properties: readonly string[]; dropped: readonly string[]; parallaxRvms: string[] | null; now: number })
  // constructor-supplied `dropped` entries are first reprobed 24 h after `now`
  /** Everything to subscribe now, each with a fresh id. */
  initial(): { id: string; sub: PlannedSubscription }[]
  /** Map an incoming frame id to its stream; null for a stale id. */
  streamOf(id: string): RivianStream | null
  /** Fresh ids for every active subscription (silence or post-drop). Returns [oldId, newId, sub][]. */
  renewAll(): { oldId: string; id: string; sub: PlannedSubscription }[]
  /** A GRAPHQL_VALIDATION_FAILED for this id: returns the probes to subscribe after the 30 s delay, and any newly dropped properties. */
  rejected(id: string, now: number): { probes: PlannedSubscription[]; newlyDropped: string[]; unavailable: string | null }
  /** Subscribe a probe (assigns a fresh id). */
  activate(sub: PlannedSubscription): string
  /** A server complete/error that is not a validation failure: the sub to resubscribe after 30 s. */
  ended(id: string): PlannedSubscription | null
  addProperties(names: readonly string[]): PlannedSubscription[]   // discovery: new groups to subscribe
  dueForReprobe(now: number): PlannedSubscription[]                 // dropped properties and unavailable subs, once per 24 h
  get dropped(): readonly string[]
}
```

Subscription keys: `state:<n>`, `parallax`, `charging`, `cloud`, `ota-state`, `ota-schedules`, `geofence`, `departure`. Ids are `${key}#${counter}`.

- [ ] **Step 1: Write the failing tests**

`backoff.test.ts`, with `random = () => 0` then `() => 1`:
- The sequence is 30 s, 60 s, 120 s, …, capped at 900 s.
- With `random() = 1`, each value is +30 s, still capped at 900 s.
- `reset` returns to 30 s.
- No value is ever below 30 000.

`fake-rivian-ws.ts`: an in-process `ws` `WebSocketServer` on port 0 that:
- requires the subprotocol `graphql-transport-ws`;
- records `connection_init` and replies `connection_ack`, unless told not to;
- records `subscribe` and `complete` messages;
- exposes `sendNext(id, payload)`, `sendError(id, errors)`, `sendComplete(id)` and `closeWith(code, reason)`.

`socket.test.ts`:
- Ack resolves `openSocket`.
- No ack within `ackTimeoutMs` (use 50 ms) rejects with `no_ack` and closes.
- `subscribe` sends `{id, type:'subscribe', payload: doc}`.
- `next`, `error` and `complete` frames route to the handlers.
- Closing with the reason `"Rate limited"` gives `onClose('rate_limited', …)`, and `"Unauthenticated"` gives `'unauthenticated'`. Any other close gives `'closed'`.
- `connection_init` carries exactly the `initPayload` passed in.

`subscriptions.test.ts`:
- `initial()` has `ceil(n/16)` state groups plus the 7 other subscriptions, all ids unique.
- `renewAll()` gives every sub a new id, and `streamOf(oldId)` becomes null.
- **Bisection:** with 16 properties where exactly `'badOne'` is rejected, simulate the server by calling `rejected` on any probe containing `'badOne'` and treating the others as accepted. It reaches `newlyDropped: ['badOne']` within 8 `rejected` calls. Accepted halves stay active. `dropped` contains `'badOne'`.
- Constructing with `dropped: ['badOne']` leaves it out of `initial()`.
- Rejecting `charging` returns `unavailable: 'charging'` with no probes.
- `dueForReprobe(now + 24h)` returns `'badOne'` alone, and `'charging'`. It returns nothing again until another 24 h pass.
- `addProperties(['newThing'])` returns one new group containing it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm install && pnpm vitest run --project @ev/rivian-connector`
Expected: FAIL.

- [ ] **Step 3: Implement**

Use `ws` (`import WebSocket from 'ws'`), with protocol `'graphql-transport-ws'` and headers `{ 'User-Agent': USER_AGENT }`. Bisection splits a rejected group's properties in half, and a single-property probe that's rejected is dropped. Comments cite spec §2.3 and §5.4: errors don't name fields; `graphql-transport-ws` forbids id reuse.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -r build && pnpm vitest run --project @ev/rivian-connector`

- [ ] **Step 5: Commit**

```bash
git add apps/rivian pnpm-lock.yaml
git commit -m "feat(rivian-connector): backoff, a graphql-transport-ws socket, and subscriptions that bisect away a bad field"
```

---

### Task 10: Connector building blocks: publish queue and MQTT publisher

**Files:**
- Create: `apps/rivian/src/{queue,publisher}.ts`, `apps/rivian/test/{queue,publisher}.test.ts`

**Interfaces:**

```ts
// queue.ts
export const QUEUE_CAP_BYTES = 32 * 1024 * 1024
export interface QueuedFrame { topic: string; body: string; bytes: number }
export class PublishQueue {
  constructor(capBytes?: number)
  /** Enqueue; returns how many oldest frames were dropped to make room. */
  push(frame: QueuedFrame): number
  shift(): QueuedFrame | undefined
  get length(): number
  get bytes(): number
}
export function frameFor(vin: string, stream: RivianStream, receivedAt: Date, body: unknown): QueuedFrame
// frameFor builds the v1 envelope, runs cleanStrings over it, JSON.stringify, and measures Buffer.byteLength.

// publisher.ts
export interface MqttLike { publish(topic: string, body: string, opts: { qos: 1; retain: false }, cb: (err?: Error) => void): void; end(force?: boolean, cb?: () => void): void }
export class Publisher {
  constructor(client: MqttLike, queue: PublishQueue, hooks: { onPublished(): void; onFailure(err: unknown): void })
  /** Publish frames one at a time, each acknowledged before the next. Never throws. */
  pump(): void
  /** Wait until the queue is empty or timeoutMs passes; returns frames left. */
  drain(timeoutMs: number): Promise<number>
  /** End the MQTT client cleanly. */
  end(): Promise<void>
  /** Called whenever the queue becomes empty (the connector uses it to schedule a post-drop renewal). */
  onEmpty(fn: () => void): void
}
export function connectMqtt(opts: { url: string; username: string; password: string; clientId: string }): MqttLike
```

- [ ] **Step 1: Write the failing tests**

`queue.test.ts`:
- **`frameFor`:** produces `topic: 'rivian/VIN1/state'` and an envelope with `v: 1`, the stream, the vin, `receivedAt` (ISO) and `body` verbatim. A `\u0000` in the body is cleaned, and `bytes` equals the UTF-8 length.
- **Capacity:** with `capBytes = 100`, pushing frames of 40 bytes drops the oldest once the total exceeds 100, and `push` returns the drop count. A single frame larger than the cap is accepted alone, dropping everything else (never refuse the newest).
- **Order:** FIFO.

`publisher.test.ts`, with a fake `MqttLike`:
- Frames are published in order with `{qos: 1, retain: false}`. The second isn't published until the first's callback fires.
- A failed publish (callback with an error) calls `onFailure`, re-queues the frame at the head, and retries after 1 s. Use fake timers. The frame isn't lost.
- `drain(50)` resolves 0 when empty, and resolves the count left when the broker never acks.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run --project @ev/rivian-connector test/queue.test.ts test/publisher.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`connectMqtt` uses `mqtt.connect(url, { clientId, username, password, clean: true, reconnectPeriod: 2000 })`. `clean: true` is right here: the connector only publishes and has no subscriptions to keep. Comment why.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run --project @ev/rivian-connector`

- [ ] **Step 5: Commit**

```bash
git add apps/rivian
git commit -m "feat(rivian-connector): a byte-bounded publish queue and an acknowledged MQTT pump"
```

---

### Task 11: The connector lifecycle, metrics, entrypoint, image

**Files:**
- Create: `apps/rivian/src/{config,store,connector,metrics,main}.ts`, `apps/rivian/Dockerfile`, `apps/rivian/test/{config,connector}.test.ts`, `apps/rivian/test/support/fake-gateway.ts`
- Modify: `.github/workflows/images.yml` (add the matrix leg `ev-rivian` with `apps/rivian/Dockerfile`)

**Interfaces:**

```ts
// config.ts
export interface ConnectorConfig {
  vin: string; privateJwk: JWK
  mqtt: { url: string; username: string; password: string; clientId: string }
  parallaxRvms: string[] | null; metricsPort: number
}
export function loadConnectorConfig(env?: NodeJS.ProcessEnv): ConnectorConfig
// MQTT_URL default 'tcp://ev-mqtt.ev.svc.cluster.local:1883', MQTT_USERNAME 'rivian', MQTT_CLIENT_ID 'ev-rivian';
// refuses ev-fleet-telemetry / ev-ingest / ev-ingest-rivian; RIVIAN_PARALLAX_RVMS split on ',' trimmed, empty -> null.

// store.ts: the connector's DB seam, so connector.ts is testable without pg
export interface ConnectorStore {
  credentialStamp(): Promise<Date | null>          // throws on query failure
  status(): Promise<RivianStatusRow | null>         // read once in `starting` for dropped_properties; a failure means []
  credential(): Promise<{ sealed: string } | null>
  writeStatus(s: Omit<RivianStatusRow, 'updatedAt'>): Promise<void>
}
export function pgConnectorStore(pool: DbPool): ConnectorStore

// connector.ts
export interface Clock { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void }
export interface ConnectorDeps {
  config: ConnectorConfig; store: ConnectorStore
  http: Pick<RivianHttp, 'createCsrf' | 'userInfo' | 'vehicle' | 'chargingSummaries' | 'introspectVehicleState'>
  openSocket: typeof openSocket; queue: PublishQueue; publisher: Publisher
  clock: Clock; random?: () => number
  metrics: ConnectorMetrics; log: (line: string) => void
}
// metrics.ts exports this, wrapping the prom-client objects, so tests can pass a recording fake:
export interface ConnectorMetrics {
  setState(s: RivianConnectorState): void; frame(stream: RivianStream): void; dropped(n: number): void
  publishFailure(): void; reconnect(reason: string): void; droppedProperties(n: number): void
  pollFailure(): void; lastFrame(atMs: number): void
}
export class Connector {
  constructor(deps: ConnectorDeps)
  start(): void                       // begins the credential poll and the lifecycle
  stop(): Promise<void>               // SIGTERM sequence (spec §5.2)
  get state(): RivianConnectorState
}
```

**Behaviour.** Implement exactly spec §5.2–§5.6, in particular:
- **Credential poll** every 15 s through `store.credentialStamp()`:
  - A throw increments `rivian_credential_poll_failures_total` and changes nothing.
  - `null` from a successful query closes everything and moves to `signed_out`.
  - A changed stamp restarts from `starting`.
- **`starting`:** read `store.status()` for `droppedProperties` (a failure or null means `[]`), then `unsealCredential` (`CredentialUnreadable` moves to `credential_invalid`, and no retry until the stamp changes), then `http.createCsrf()`.
- **`finding_vehicle`:** `http.userInfo`, published as `meta` kind `userInfo` (change-only). `findVehicle(…, config.vin)`. If absent, `waiting_for_vehicle`, retried hourly.
- **HTTP `UNAUTHENTICATED`:** `createCsrf` once and retry. A second one moves to `unauthenticated`.
- **`connecting`:**
  - `openSocket(SUBSCRIPTIONS_URL, connectionInitPayload(session))`.
  - On ack, subscribe everything in `plan.initial()` and move to `subscribed`.
  - Close reason `unauthenticated` moves to `unauthenticated`, which stops until the stamp changes. Any other close or reject moves to `backing_off` with `Backoff.next()`.
  - The first `next` after a connect resets the backoff.
- **Each `next`:** `queue.push(frameFor(vin, plan.streamOf(id), new Date(clock.now()), payload))` with the whole payload, then `publisher.pump()`. If the push dropped frames, add them to `rivian_frames_dropped_total` and set `renewPending`. **Don't renew on every drop.** Each renewal brings a fresh snapshot, which would overflow again into a resubscribe storm against Rivian. Instead, when `renewPending` is set and the publisher reports the queue empty (`publisher.onEmpty`), call `renewAll()` once, then clear the flag. Never renew more than once a minute.
- **Errors from the server:**
  - A `GRAPHQL_VALIDATION_FAILED` error on an id goes to `plan.rejected`; probes are subscribed after 30 s. Newly dropped properties are persisted via `writeStatus` and published as `meta` kind `droppedProperties`.
  - Any other error or complete resubscribes after 30 s.
- **Silence:** a 60 s timer, reset on every frame, calls `renewAll()`: `complete(old)`, then `subscribe(new)`.
- **Slow HTTP**, each published as `meta` and change-only by SHA-256 of the JSON: `vehicle` every 24 h, `chargingSummaries` every 6 h, `schema` introspection every 24 h. On a schema result, `TimeStamped*` fields not in the plan go to `addProperties`. `userInfo` runs every 6 h once found. `connection` meta is published on every state change.
- **`writeStatus`** is fire-and-forget: failures are logged and never awaited by the socket path. `last_frame_at` is written at most once a minute.
- **`stop()`:**
  1. Stop timers.
  2. `publisher.drain(5000)`; frames left count as dropped.
  3. `complete` every id.
  4. `socket.close()`.
  5. `publisher.end()`.
- **Never log a token.** `last_error` is always `RivianApiError.redacted()` or a fixed string.

- [ ] **Step 1: Write the failing tests**

`config.test.ts`:
- The required variables, the client-id refusals, the `RIVIAN_PARALLAX_RVMS` parsing, and a bad private JWK (`parseJwk` throws) failing at load.

`fake-gateway.ts`: a fake `RivianHttp`-shaped object with programmable responses per method and call counters.

`connector.test.ts` uses a manual fake `Clock` (a timer list advanced by `tick(ms)`). It doesn't use a real socket: it passes a fake `openSocket` that returns a scripted `SocketLike` (records `subscribe`/`complete`/`close`; the test drives `handlers.onNext/onError/onComplete/onClose`), and never touches `SUBSCRIPTIONS_URL`. The real ws server stays in `socket.test.ts`. The test also uses a fake store whose methods can be made to throw, a real `PublishQueue`, and a `Publisher` over a fake MQTT that records frames. One test per bullet:

| Area | Expected |
|---|---|
| Sign-in | no row means `signed_out`; a row appearing leads to `subscribed`, with `userInfo` taped as `meta` |
| Delivery | a VIN absent leads to `waiting_for_vehicle`; `userInfo` is retried after 1 h; the VIN appearing leads to `subscribed` |
| Credential | an undecryptable credential leads to `credential_invalid` with no socket; a new stamp leads to recovery |
| Postgres blips | a credential poll that throws three times keeps `subscribed` and counts 3 failures (Review Focus 3); a successful empty poll leads to `signed_out` and the socket is closed |
| Auth | HTTP `UNAUTHENTICATED` on `userInfo` once then OK is fine (one extra `createCsrf`); twice means `unauthenticated`; ws close `"Unauthenticated"` means `unauthenticated`, no reconnect after 1 h of ticks, and a new stamp leads to recovery |
| Backoff | ws close `"Rate limited"` gives `backing_off`, and the reconnect happens no earlier than 30 s; repeated closes follow the schedule; data resets it |
| Silence | 61 s with no frame: every sub gets `complete` + `subscribe` with new ids, and no reconnect occurs |
| Bad field | a validation failure on `state:0`; after the 30 s ticks the probes are subscribed; `dropped_properties` is written; `meta` `droppedProperties` is published |
| Frames | a `next` is published to `rivian/<VIN>/<stream>` with `receivedAt` = the clock at arrival, not at publish (hold the fake MQTT ack, advance the clock, release, compare) |
| Queue overflow | a small `capBytes` drops frames, counts them, and resubscribes all |
| Status writes | a `writeStatus` that throws doesn't change state or close the socket |
| Shutdown | `stop()` drains, completes every id, and closes |
| Restart | with `store.status()` returning `droppedProperties: ['badOne']`, the plan leaves `badOne` out of the subscribed groups; with `status()` throwing, it starts with none dropped |
| Overflow storm | 100 drops during a broker outage cause exactly one `renewAll`, after the queue empties |
| Change-only `meta` | two identical `userInfo` results publish one `meta` frame; a changed one publishes a second |
| Discovery | an introspection result containing `TimeStampedFloat` field `newThing` makes the next `subscribe` include `newThing`; a non-TimeStamped unknown field is listed in `meta.schema` and not subscribed |
| Server `complete`/`error` | a non-validation error resubscribes that subscription after 30 s under a fresh id |
| Envelope `errors` | a `next` whose payload carries `errors` alongside `data` is published with `body.errors` intact |
| Redaction | across the whole run, the captured log lines and every `writeStatus.lastError` contain no `userSessionToken` value (seed a recognisable token) |

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run --project @ev/rivian-connector test/connector.test.ts test/config.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `connector.ts`, `store.ts`, `config.ts`, `metrics.ts` (spec §5.7's names; every series initialised at startup) and `main.ts`:
1. `main.ts` loads config, starts the metrics server (reuse the pattern from `apps/ingest/src/metrics.ts`'s `startMetricsServer`, copied, not imported), `getPool()`, `connectMqtt`, and builds the `Connector`.
2. SIGTERM/SIGINT call `connector.stop()` then `closePool()`.
3. Startup failure calls `process.exit(1)`, with the same reasoning comment as ingest's.

`Dockerfile` follows `apps/ingest/Dockerfile`: build `@ev/core`, `@ev/rivian`, `@ev/db` and `@ev/rivian-connector`; runtime UID 10001; `EXPOSE 9090`; `CMD ["node", "apps/rivian/dist/main.js"]`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the full gate, then `podman build -f apps/rivian/Dockerfile -t ev-rivian-test .`
Expected: PASS, and the image builds.

- [ ] **Step 5: Commit**

```bash
git add apps/rivian .github/workflows/images.yml pnpm-lock.yaml
git commit -m "feat(rivian-connector): hold one Rivian session open and publish everything it says"
```

---

### Task 12: Web: Rivian sign-in and the settings page

**Files:**
- Create:
  - `apps/web/src/lib/server/rivian-pending.ts` and `apps/web/src/lib/server/rivian-auth.ts`
  - `apps/web/src/routes/api/v1/rivian/login/+server.ts`, `apps/web/src/routes/api/v1/rivian/otp/+server.ts` and `apps/web/src/routes/api/v1/rivian/logout/+server.ts`
  - `apps/web/src/routes/settings/rivian/+page.server.ts` and `apps/web/src/routes/settings/rivian/+page.svelte`
  - `apps/web/test/rivian-auth.test.ts`, `apps/web/test/rivian-routes.test.ts` and `apps/web/test/rivian-page-load.test.ts`
- Modify: `apps/web/src/routes/vehicles/[id]/+layout.svelte` (the Settings tab by vendor), `apps/web/package.json` (add `"@ev/rivian": "workspace:*"`), `apps/web/src/lib/server/db.ts` (re-export the Rivian repo functions)

**Interfaces:**

```ts
// rivian-pending.ts: same shape and reasoning as tesla-session.ts
export interface PendingOtp { email: string; app: AppSession; otpToken: string; expiresAt: Date }
export const PENDING_TTL_MS = 10 * 60_000
export function setPendingOtp(subject: string, p: PendingOtp): void        // sweeps expired on write
export function getPendingOtp(subject: string | null | undefined, now?: Date): PendingOtp | null   // evicts expired on read
export function clearPendingOtp(subject: string): void

// rivian-auth.ts: the testable core; routes are thin
export interface RivianAuthDeps {
  http: Pick<RivianHttp, 'createCsrf' | 'login' | 'loginWithOtp'>
  publicJwk: JWK | null          // from RIVIAN_CREDENTIAL_PUBLIC_KEY; null means "not configured"
  save(v: { sealed: string; account: string }): Promise<void>
  remove(): Promise<void>
  now(): Date
}
export type SignInOutcome =
  | { status: 'signed_in' } | { status: 'otp_required' }
  | { status: 'error'; message: string }
// messages, EXACTLY: 'Wrong email or password' | 'Wrong or expired code' | 'Account temporarily locked'
//   | 'Rivian is rate-limiting, try later' | `Rivian error ${code}` | 'Rivian sign-in is not configured on this server'
export function signIn(deps: RivianAuthDeps, subject: string, email: string, password: string): Promise<SignInOutcome>
export function submitOtp(deps: RivianAuthDeps, subject: string, code: string): Promise<SignInOutcome>
export function signOut(deps: RivianAuthDeps, subject: string): Promise<void>
export function defaultRivianAuthDeps(): RivianAuthDeps   // reads $env/dynamic/private, real RivianHttp, @ev/db repo
```

The routes accept `POST` JSON bodies (`{email, password}`, `{code}`, `{}`), call `requireUser`, and return `json(outcome)`. On `signIn` or `submitOtp` failure they return HTTP 200 with `status: 'error'` (the page renders the message), except 401 without a session. Read `apps/web/src/routes/api/v1/telemetry/*` and use the same `run`/`http.ts` helpers if they wrap errors. The page load reads `readRivianStatus`, `readRivianCredential` (account and `updatedAt` only, never `sealed`), whether a pending OTP exists for the subject, and `now`.

- [ ] **Step 1: Write the failing tests**

`rivian-auth.test.ts`, with a fake `http`, a real `generateCredentialKeys()` pair and a recording `save`:
- **No MFA:** `signIn` saves once. Unsealing `sealed` with the private key gives exactly `{userSessionToken}`, and `account` is the email.
- **MFA:** `signIn` returns `otp_required`, saves nothing, and creates a pending entry. `submitOtp` with the right code saves and clears it.
- **Wrong code:** `badOtp` gives `status: 'error'` with 'Wrong or expired code' (exact copy per §4.4), and the pending entry survives.
- **Expiry:** `submitOtp` after `now` passes the 10 min TTL gives the error 'Wrong or expired code' without calling `http`. A later `setPendingOtp` for another subject sweeps the expired one.
- **Classified errors:** `badCredentials`, `locked`, `rateLimited` and an unknown code each give their message.
- **Not configured:** a null `publicJwk` gives the "not configured" message, and `http` isn't called.
- **Review Focus 5:** spy on `console.log/warn/error` for the whole file. No captured line, returned message or `save` argument contains the password, the OTP code, `userSessionToken`, `otpToken` or `csrfToken`.

`rivian-routes.test.ts`:
- All three routes return 401 without `locals` user.
- There is no route-level deps seam in this codebase (`telemetry-routes.test.ts` tests routes only for 401/409 and tests the core with injected deps). So:
  - `login` with a user and `RIVIAN_CREDENTIAL_PUBLIC_KEY` unset gives the "not configured" outcome.
  - `logout` with a user: `vi.mock('../src/lib/server/db.js', …)` the way `telemetry-page-load.test.ts:18-28` does, so it never deletes a real row. Assert the mocked delete was called.
- Re-export the Rivian repo functions from `$lib/server/db.ts` (unconditionally), so routes and loads import them from there and tests can mock that module.

`rivian-page-load.test.ts`:
- **No rows:** `{credential: null, status: null}`.
- **With rows:** the account and `updatedAt` are present, `sealed` is absent anywhere in the returned object (deep search), and `droppedProperties` passes through.
- **Pending flag:** reflects the pending map.

Also add a component render test in `components.test.ts` style (if practical) that the vehicle layout's Settings tab links to `/settings/rivian` for a `vendor: 'rivian'` vehicle and to `/settings/telemetry` for a Tesla. If the layout isn't renderable in isolation, extract `settingsHref(vendor)` to `$lib/format.ts` or a small module and unit-test that.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm install && pnpm -r build && pnpm vitest run --project web test/rivian-auth.test.ts test/rivian-routes.test.ts test/rivian-page-load.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

**The page (`+page.svelte`).** Model it on `settings/telemetry/+page.svelte`'s structure, classes and tone. Reuse its CSS variables and components; don't invent new styling.

It shows:
- **Account:** "Signed in as `<account>` since `<updatedAt>`" plus a Sign out button. When there's no row, the sign-in form: email, password, submit. Render the code input when the last response was `otp_required` or the load says a pending entry exists.
- **Connector status:** the state in words; VIN; last frame age; backoff-until; the last error (already redacted); the dropped properties list. Each is "—" when null.
- **Account advice:** spec §4.3's text, verbatim.

Use `fetch('/api/v1/rivian/...', { method: 'POST' })`, then `invalidateAll()`, the same way the telemetry page calls its actions.

**`defaultRivianAuthDeps`:** `parseJwk(env.RIVIAN_CREDENTIAL_PUBLIC_KEY, 'public')`, or null if unset. If it's set but invalid, throw at first use with a message naming the variable.

**Layout:** the Settings tab `href` is `v.vendor === 'rivian' ? '/settings/rivian' : '/settings/telemetry'`. Update its comment.

**Web Dockerfile:** check whether `pnpm --filter @ev/web... build` already covers the new dependency (it should). If it does, leave it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the full gate, then `podman build -f apps/web/Dockerfile -t ev-web-test .`
Expected: PASS, and the image builds.

- [ ] **Step 5: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): sign in to Rivian, sealed to the connector, and show what it is doing"
```

---

### Task 13: Documentation

**Files:**
- Modify: `README.md`, `docs/superpowers/specs/2026-09-04-ev-app-design.md` (one line under §4.2 pointing at the new spec, saying `VehicleAdapter` was replaced by `VendorProfile`)

- [ ] **Step 1: Update `README.md`**
  - **Status line and Scope:** Rivian ingestion is implemented and awaiting delivery; read-only.
  - **The "How it works" diagram:** add the `ev-rivian`, `rivian/#` and `ev-ingest-rivian` lane.
  - **Repo layout:** `apps/rivian` and `packages/rivian`.
  - **Configuration:**
    - a new `ev-rivian` table (spec §5.1);
    - `EV_VENDOR` (required) added to the `ev-ingest` table;
    - the per-vendor defaults for `MQTT_CLIENT_ID`, `MQTT_TOPIC` and `EV_CURSOR_SOURCE`;
    - `RIVIAN_CREDENTIAL_PUBLIC_KEY` in the `ev-web` table.
  - **Deploying:** the fourth image, and the **upgrade note** (spec §11 step 1: scale ingest to 0, migrate, deploy with `EV_VENDOR=tesla`).
  - **A "Rivian setup" section:** the keygen script, the GitOps list (spec §11 items 2–6), and the first checks.
  - **Documentation list:** add the new spec and this plan.
- [ ] **Step 2: Verify**

Run: `grep -n "Rivian is a designed seam" README.md`
Expected: nothing (the stale line is gone).

- [ ] **Step 3: Commit**

```bash
git add README.md docs/superpowers/specs/2026-09-04-ev-app-design.md
git commit -m "docs: Rivian ingestion in the README, and the seam it replaced"
```

---

### Task 14: Verification against a restored production copy (main session, not a subagent)

This touches production, read-only, and per the user's standing instruction (memory: verify against a restored prod copy) it's run by the main session.

- [ ] **Step 1:** Over SSH as `jonmill@64.42.176.242` (never another user), run `kubectl -n ev exec ev-pg-1 -c postgres -- pg_dump -Fc -d ev > ~/ev-backups/ev-<date>.dump` on the box, then `scp` it to the scratchpad.
- [ ] **Step 2:** Restore it into two podman Postgres databases, `pre` and `post`, on a shared podman network.
- [ ] **Step 3:** Run `reprocess` over the whole tape against `pre` using a worktree at `e6210a8` (pre-change main, built), and against `post` using the branch head. Both run as `node:22-alpine` containers with `--network container:<pg>` and the repo mounted, with `EV_VENDOR=tesla` for the post build only, after applying migrations to latest on `post`.
- [ ] **Step 4:** Diff `sample` (all columns), `session` and `session_point` between `pre` and `post`.

**Accept only** `gear` differences: `ShiftStateX` to `X`, and SNA/Invalid to NULL.

**Explain every other row** from the raw tape. A difference caused by the `handle`/`flush` lock can't occur in a single-threaded reprocess, so any other difference is a regression to fix before reporting done.

---

## Self-review notes

- **Spec coverage:**

  | Spec | Task |
  |---|---|
  | §4 | 7, 8, 12 |
  | §5 | 9, 10, 11 |
  | §6.1 | 2 |
  | §6.2 | 4 |
  | §6.4 | 5, 6 |
  | §7 | 1, 5 |
  | §8 | 1, 8 |
  | §9 | 3, 6 |
  | §10.3 | 14 |
  | §11 | 11, 13 |

- **Deliberately not built:** Kubernetes manifests (GitOps repo), and the post-delivery follow-ups in spec §8.4.
