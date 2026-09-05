# Full signal capture — design

**Date:** 2026-09-05
**Status:** Approved for planning
**Scope:** Capture every Fleet Telemetry signal that applies to this vehicle, as typed queryable columns. Tesla only.
**Parent spec:** `docs/superpowers/specs/2026-09-04-ev-app-design.md`

---

## 1. Purpose

We subscribe to 21 of the 270 signals `vehicle_data.proto` defines, and two of those 21 (`Gear`, `ChargeAmps`) are billed for and then discarded because `normalise.ts` has nowhere to put them. Everything not subscribed to is not merely missing from the database — it is **gone**, permanently, for every hour we do not ask for it. That is the founding constraint of this project (parent spec §1: neither vendor stores history for you), and it is the entire reason this work is urgent while the UI for it is not.

This spec expands the subscription to every applicable signal, gives each one a typed column, and makes the three things that must agree — what we ask the car for, what we decode, and what we store — derive from a single source of truth.

### Goals

- Subscribe to every signal that applies to a Model Y and store each in a typed, queryable column.
- Stay inside the $10/month streaming credit, by design rather than by luck, and make the actual signal rate observable.
- Make drift between the pushed config, the normaliser and the schema a **test failure**, not a silently dropped signal.
- Replace inferred battery capacity with the car's own measurement.

### Non-goals

- **UI for all of it.** Only the high-value few reach the interface (§3.8). The rest is captured and queryable; charting it is a later spec.
- **Media and personal content.** The 11 `Media*` fields are excluded (§3.2). Navigation destination and route ARE captured.
- **Other vehicles' signals.** Semi, Cybertruck (`Tonneau*`, `Powershare*`, `Offroad*`) and tri/quad-motor (`*REL`, `*RER`) fields are excluded — a Model Y never sends them.
- **Changing the segmenter.** `Gear` is captured and stored, but making the segmenter use it would re-segment every historical drive. Its own spec, its own `reprocess`.
- **Commands. Rivian.** Unchanged.

---

## 2. Decisions and rationale

| Decision | Choice | Why |
|---|---|---|
| Storage shape | A typed column per signal on `sample` | Everything queryable without JSON extraction. Measured: 205 columns partitioned, 200k rows → `ADD COLUMN` on the populated partitioned parent took **0.69 ms**, and a sparse row cost 141 bytes. Real rows will be denser — the accumulator carries levels forward for six hours, so expect roughly 1 kB — which is still nothing at ~22k sample rows/month. The limit is 1600 columns and dropped columns keep their slot, so 204 now leaves ~1390 future additions. |
| Rejected: JSONB tail | — | Its main argument was "new Tesla signals get captured with no code change", and that is false: the car sends only what the pushed config names, so a new signal needs a config change regardless. |
| Nothing is at risk from a wrong guess | `raw_message` is the tape | Every message is stored before decoding. A field we typed wrongly, or have no column for yet, is still on disk; the fix is a migration plus `reprocess`. This is what lets the catalogue be opinionated rather than timid, and it is why a field of uncertain shape starts as `TEXT` (§3.4). |
| Single source of truth | **Two** catalogues, split by ownership | One list per concern, in the package that owns it — see §3.1. A single catalogue in `packages/tesla` was the first design and does not build: `packages/core` declares no dependencies, `packages/tesla` depends on it, and `makeSample` spreads `NULL_SAMPLE` at runtime, so core→tesla is a real value-level cycle, not an erasable type import. |
| Interval policy | Four tiers **plus `minimum_delta`** | Billing is per message. Tiering alone does not survive a car that is awake 24/7 on Sentry (§3.5); `minimum_delta` suppresses noise-level change, which is what actually bounds the bill. |
| Enum values | Stored as the vendor's own string, in `TEXT` | `prefer_typed: True` makes the car send enum *names* (`normalise.ts` header: "this includes every enum, rendered as its `.String()` name"). The two enums the engine reasons about keep their existing decoders. |
| Unit conversion | At the normaliser, named in the catalogue | Tesla streams miles/mph regardless of the car's display setting. Converted columns carry the unit in the name (`_km`, `_kph`). |

---

## 3. Architecture

### 3.1 Two catalogues, not one

The column set is canonical and vendor-neutral; the mapping from a vendor's field names onto it is not. So:

**`packages/core/src/signals.ts` — the column catalogue.** One entry per column: `{ column, sql, ts }` — the SQL type, the TypeScript type, and nothing about Tesla. This is what generates:
- `VehicleSample` (a mapped type over the `as const` catalogue) and `NULL_SAMPLE`,
- `@ev/db`'s `insertSample` column list and placeholders (`@ev/db` already depends on `@ev/core`),
- the checked-in migration (§3.3).

**`packages/tesla/src/catalogue.ts` — the field catalogue.** One entry per proto signal:

```ts
{
  field: 'NominalFullPackEnergyKwh',  // proto name: what the config asks for, what the topic carries
  column: 'nominalFullPackEnergyKwh', // a column that MUST exist in @ev/core's catalogue
  slot: 'nominalFullPackEnergyKwh',   // accumulator key in TeslaFieldState — usually the column, not always
  tier: 'charge',                     // interval tier (§3.5)
  convert: null,                      // null | 'milesToKm' | 'mphToKph' | 'epochSecondsToDate'
  delta: 0.5,                         // minimum_delta, or null
}
```

This drives the pushed config, `FIELD_DECODERS`, and the proto-vendoring test. The dependency runs `tesla → core`, the direction it already runs.

**On "vendor-neutral by construction"** (`model.ts:22-28`): the column set added here is, in practice, the set of things a Tesla can report. That is honest and unavoidable — it is the only vehicle we have. What stays true is the *shape*: columns are named for what they mean, not for Tesla's proto, and a Rivian adapter maps its own fields onto whichever of these columns it can fill, adding its own where it cannot. Vendor-neutral means no vendor's names leak into the canonical model, not that every vendor fills every column.

**Why not JSONB or a hand-written map:** §5's drift tests are only possible because both catalogues are data. The failure this design exists to prevent — a field asked for but not decoded, or decoded but not stored — is invisible at runtime, because the car silently ignores a config entry it does not recognise and the normaliser silently ignores a field it cannot place.

### 3.2 What is excluded, and why that is a test

The `Field` enum has **270** members. Excluded:

| Group | Count | Reason |
|---|---|---|
| `Unknown`, `Deprecated_*`, `Experimental_*` | 19 | Placeholders with no meaning |
| `Semitruck*` (11), `Tonneau*` (3), `Powershare*` (5), `Offroad*` (1) | 20 | Semi and Cybertruck only |
| `*REL`, `*RER` | 16 | Rear-left/rear-right drive units — tri- and quad-motor cars only |
| `Media*` | 11 | Personal content, excluded by decision |
| **Captured** | **204** | |

The exclusion list is explicit, **by name with a reason per group**, in the field catalogue. `vehicle_data.proto` is vendored at `packages/tesla/protos/vehicle_data.proto`, and a test asserts every enum member is either catalogued or excluded. A proto update that adds a signal fails that test until someone decides about it — the only way a missing signal becomes visible before a year of it is lost.

### 3.3 Column naming and the migration

- Existing columns keep their names. `soc_pct`, `speed_kph`, `range_km`, `odometer_km` and the rest are in the API contract and the UI already.
- New columns are the proto name in snake_case, plus a unit suffix where converted (`_km`, `_kph`).
- Floats → `REAL`, except: position and odometer stay `DOUBLE PRECISION`, and **cumulative counters** (`LifetimeEnergyUsed`, `LifetimeEnergyChargedKwh`, `LifetimeEnergyGainedRegen`, `LifetimeEnergyUsedDrive`, `MilesSinceReset`, `SelfDrivingMilesSinceReset`) are `DOUBLE PRECISION` too — a `REAL` carries ~7 significant digits, and tens of thousands of kWh with a decimal exhausts that.
- Enums → `TEXT` (the name as sent). Booleans → `BOOLEAN`. Counts → `INT`.
- **`type: 'location'`** is a first-class catalogue type with a documented expansion: one entry emits `<column>_lat` and `<column>_lon`, both `DOUBLE PRECISION`, applied identically by the migration, the insert and the type generators. `Location` itself carries `targets: ['lat','lon']` — it maps onto the existing columns rather than creating new ones, which is also what keeps it from tripping §5's "no column collides with an existing one" check.

The migration is **generated from the column catalogue by a script and checked in as static SQL** (`004_full_signal_set.sql`). Migrations are immutable history; generating one at runtime would let it change meaning when the catalogue changes.

### 3.4 Types the proto does not actually tell us

The MQTT transport unwraps the protobuf `oneof` before publishing, so a payload is a bare number, string, boolean, `{latitude, longitude}` or null — and the proto gives no field→type mapping. Types are therefore our determination, and two families need care:

**Time-shaped fields are not timestamps.** The proto's `message Time` is `{ hour, minute, second }` — a wall clock with no date and no zone. So:

| Catalogue type | SQL | Used for |
|---|---|---|
| `time_of_day` | `TIME` | proto `Time` values — `ScheduledChargingStartTime`, `ScheduledDepartureTime` if they arrive in this shape |
| `epoch_seconds` | `TIMESTAMPTZ` | values that arrive as a Unix epoch, via a new `epochSecondsToDate` converter |
| numeric duration | `REAL` | `TimeToFullCharge`, `MinutesToArrival`, `EstimatedHoursToChargeTermination` — durations, with the unit in the column name |
| `text` | `TEXT` | **anything whose shape we have not observed** |

`RouteLastUpdated`, `SoftwareUpdateScheduledStartTime` and the four `TpmsLastSeenPressureTime*` fields are exactly the ones a naming rule would get wrong — and note that a `REAL` holding a Unix epoch has a 128-second resolution, so guessing "float" there is silently lossy. **Every field of unobserved shape starts as `TEXT`**, storing what the car sent verbatim. Once real payloads are in hand (they arrive within a day of the config push), a follow-up migration plus `reprocess` promotes it to the right type from the tape. Guessing costs a re-typing; `TEXT` costs nothing.

**A bad type is not a null — it wedges ingest.** §2's "nothing is at risk" is true of the *tape*, not of the pipeline: `insertSample` binds every column in one statement, and `pipeline.ts`'s `transactionally` rolls back and rethrows, so a value the column rejects (a float bound to `INT`, a number bound to `TIMESTAMPTZ`) fails the transaction, is never acked, and is redelivered forever — the exact permanent-stall failure `registerVehicle` exists to prevent elsewhere. So:

- Each catalogue type owns a **decoder that coerces into the column's domain or returns null**. `int` rounds or rejects; `timestamptz` accepts only what the converter produced; `text` accepts anything stringifiable.
- §5 pins this: for every catalogue entry, a wrong-typed input must produce `null`, and every decoder's output must be bindable to its declared SQL type.

### 3.5 Interval tiers, `minimum_delta`, and the budget

Billing is $1 per 150,000 signals against a $10/month credit: **~1.5M signals/month**.

| Tier | Interval | Count | Contents |
|---|---|---|---|
| `drive` | 10s | 20 | Motion only: `VehicleSpeed`, `Gear`, `Location`, `GpsHeading`, pedals, motor torque/current, axle speeds, accelerations, `GradeEstimatePercent` |
| `charge` | 60s | 27 | SoC, charge power/energy/limit/port, `EnergyRemaining`, ranges, `TimeToFullCharge`, **`PackVoltage`, `PackCurrent`** |
| `status` | 300s | 60 | Climate, temperatures, doors, locks, windows, seats, `SentryMode`, navigation ETA |
| `static` | 3600s | 97 | Configuration and rarely-changing state, TPMS pressures, software version |

**The interval is a floor on frequency, not a cap on cost.** The car sends on change, so what a tier costs depends on how often its fields actually change — and that varies with how long the car is awake, not with how long it is driven. Sentry mode (which §3.8 puts on the overview) keeps a car awake all day.

Worst case, every field changing at its tier's ceiling, no deltas:

| Awake hours/day | drive¹ | charge | status | static | **Total/month** |
|---|---|---|---|---|---|
| 6 | 324,000 | 291,600 | 129,600 | 17,460 | **762,660** |
| 12 | 324,000 | 583,200 | 259,200 | 34,920 | **1,201,320** |
| 24 | 324,000 | 1,166,400 | 518,400 | 69,840 | **2,078,640** ⚠ |

¹ Drive-tier fields pin to constants in Park — speed 0, gear P, torque 0 — so they are billed over 1.5h/day of driving, not over awake hours. `Location` and `GpsHeading` are the exception: a stationary GPS fix jitters.

So a 24h-awake month **exceeds the credit**, and tiering alone cannot fix it: the only per-field knob in the pushed config is the interval, and a slower interval on `PackCurrent` is also a worse charge curve.

**`minimum_delta` is the actual answer.** Tesla supports it per numeric field from firmware 2024.44.32, and for location (in metres) from 2025.2.6 — comfortably below what this car runs, and above our preflight floor of 2024.26. It suppresses change that is below the threshold of meaning, which is precisely what the 24h row is made of: pack current wobbling under standby draw, a parked GPS fix jittering by a metre, an inside temperature drifting a tenth of a degree. `push-telemetry-config.sh` currently emits only `interval_seconds`; it gains `minimum_delta` from the catalogue's `delta`, set for every continuously-varying numeric field (pack voltage/current, charger voltage, SoC, energy, temperatures, location).

**And it is observed, not just modelled.** `ev_ingest_messages_total` already counts every message. An alert fires when the 30-day projection exceeds **1.2M** — before the credit runs out, not after a bill. Tuning is a catalogue change plus a config re-push, with no code deploy. §5 pins the model itself, so adding twenty `drive`-tier signals fails the build rather than the bill.

### 3.6 What this changes in the ingest path

- **`VOLATILE_FIELDS` is keyed by accumulator slot, and is currently wrong.** `pipeline.ts:175` lists `'chargePowerKw'`, which is not a slot: the accumulator's keys are `acPowerKw` and `dcPowerKw`, and `chargePowerKw` only exists after `teslaStateToSample` collapses them (`normalise.ts:231`). `staleWindowFor` is only ever called with slot keys, so **that entry is dead today** and charge power is being carried for six hours instead of expiring after five minutes — the stale-value failure the constant was written to prevent. Fixed here as part of this work: the set becomes `{speedKph, acPowerKw, dcPowerKw}` plus every `drive`-tier slot except `Location` and `Gear` (a car in P stays in P). Driving the set from the catalogue's `slot` field is what stops this class of bug recurring at 20× the scale.
- **Message volume rises roughly fivefold**, landing on `raw_message` (one row per message): ~740k rows/month at the 6h-awake model, ~9M/year — inside the parent spec's 10–50M/year envelope, and monthly partitioning is what keeps it manageable. At ~200 bytes/row that is ~150 MB/month of tape. Worth stating plainly given the parent spec §7.3 records that there are **no backups**: this increases what is lost if the volume is lost, and does not change the decision.
- **The debounce does more work.** With more chatty fields, `MAX_SAMPLE_INTERVAL_MS` (30s) becomes the binding constraint during a drive rather than `QUIET_PERIOD_MS` (2s). That is the designed behaviour; sample rows get wider without getting more frequent (~22k/month).
- **One transaction per message still holds.** At the 6h model that is ~0.3 messages/second average and a few per second during a drive — the same order as today, and each transaction is one insert plus, only when a sample is produced, one `pg_notify`.

### 3.7 Battery health becomes a measurement

`NominalFullPackEnergyKwh` is the pack's full energy as the car computes it; `EnergyRemaining` is what is in it now. Today `estimateCapacity` infers capacity from a charge session's SoC span, returns null when the span is too narrow, and `rated_range_at_100_km` is never written at all.

The existing table cannot hold both series as-is — `battery_health_sample` is `PRIMARY KEY (vehicle_id, observed_on)`, one row per day. **One row, two columns** (migration `005`):

- Add `measured_capacity_kwh REAL NULL`.
- Drop `NOT NULL` from `estimated_capacity_kwh` and `sample_confidence`, so a day with a measurement but no qualifying charge is insertable.
- No `source` column: which value is present says which it is.

**And the existing upsert must not be reused for it.** `upsertBatteryHealth` guards its update with `WHERE battery_health_sample.sample_confidence < EXCLUDED.sample_confidence`, and a losing `DO UPDATE … WHERE` is a **silent no-op**. A measured value has no confidence on the estimator's scale, so routing it through that function would discard it on any day the estimator had already written a higher-confidence row — with no error anywhere. A separate `recordMeasuredCapacity` writes only `measured_capacity_kwh`, with no confidence guard.

**Write site.** `recordBatteryHealth` is called only at charge-session close (`pipeline.ts:478`), because the estimator needs a session. The measurement has no session: it is a sample field. It is therefore written **on the first sample of a new UTC day that carries `NominalFullPackEnergyKwh`** — once a day, in the sample path, inside the same transaction as the sample.

`rated_range_at_100_km` also becomes writable for the first time: with `EnergyRemaining` and `RatedRange` on the same sample, range at 100% is `ratedRange / (energyRemaining / nominalFullPackEnergy)` — but only when SoC is high enough for that ratio to be meaningful, so it keeps the estimator's existing "no row beats a bad row" discipline.

### 3.8 The UI's share of this

Only what earns its place:

- **Battery page:** measured capacity and degradation against nameplate; `EnergyRemaining`; pack module temperature range; brick voltage spread (`BrickVoltageMin`/`Max`).
- **Vehicle overview:** software version (with `SoftwareUpdateAvailable`), charge limit and charge-port state, HVAC on/off with cabin overheat protection, `SentryMode`, gear.
- **Charges page:** charger voltage, phases, `FastChargerType`, `ChargingCableType`.

Everything else is reachable through `/api/v1/vehicles/[id]/samples?fields=…`, which already takes a field allowlist.

**The live stream needs one change.** `VehicleState` grows from 17 fields to ~204, and the SSE stream serialises a full `VehicleState` per notification *and* per snapshot — so an idle tab would receive a ~4 kB payload every couple of seconds rather than ~400 bytes. The stream therefore sends a **projection**: the fields the pages actually render (the overview tiles, the pill, plus §3.8's additions), named by one exported constant shared by `getVehicleState`'s SSE path and the client store. The REST endpoint keeps returning everything.

---

## 4. Failure handling

| Failure | Behaviour |
|---|---|
| A catalogued field name is wrong | The car silently ignores an unknown name — no error, one signal never arrives. Caught by the proto test in §3.2: every catalogue entry must name a member of the vendored enum. |
| A value arrives as an unexpected type | `null` for that field, never an exception and **never a bind error** — §3.4's per-type decoders coerce or refuse. The raw message is taped regardless. |
| A catalogue type is simply wrong for a field | The failure is a wedged pipeline, not a null (§3.4). Mitigated by starting unobserved shapes as `TEXT`, by the bindability test in §5, and — if one still slips through — by the fact that the fix is a migration plus `reprocess` from the tape. |
| An enum gains a new member | Stored verbatim as `TEXT`. Nothing to update. The two engine-facing enums keep their "unknown maps to null" decoders. |
| Signal volume exceeds the model | Visible in `ev_ingest_messages_total` before it is visible in a bill; alert at a 30-day projection over 1.2M. Fix is a catalogue tier or `delta` change plus a config re-push — no code deploy. |
| The car's firmware predates `minimum_delta` | Deltas are ignored by an older build and the intervals still apply, so the config remains valid — it just costs more. `telemetry-preflight.ts` already checks firmware; its floor stays 2024.26 for streaming, and the budget's assumption of delta support is noted where the alert would catch it. |
| The config push is not applied by the car | Already handled: the config stays queued at Tesla until the car checks in, and `scripts/check-telemetry-synced.sh` reports whether it has been taken. |
| A column exists but history lacks it | Correct: the car was never asked. The exceptions are `Gear` and `ChargeAmps`, taped since day one and backfilled by `reprocess` — which requires the `ON CONFLICT DO NOTHING` in `insertSample` to become an explicit update for the reprocess path, or the backfilled columns will not be written to rows that already exist. **This is a real constraint on the backfill and is part of the work.** |

---

## 5. Testing

- **Catalogue integrity:** every field entry names a member of the vendored proto enum; every enum member is catalogued or excluded by name; every field entry's `column` exists in the core column catalogue; no duplicate columns; no new column collides with an existing one (`Location`'s `targets` is the sanctioned exception); every `convert` and every `delta` is valid for its type.
- **Drift** — the reason the catalogues exist: the generated migration's column set equals the core catalogue's; the config script's emitted field list equals the field catalogue's; `insertSample`'s generated column list equals the core catalogue's.
- **Types:** for every catalogue entry, a representative value of its declared type decodes, a wrong-typed value yields `null`, and the decoder's output is bindable to its SQL type (§3.4's wedge).
- **Volatility:** `VOLATILE_FIELDS` contains only real `TeslaFieldState` slots — the test that would have caught the live `chargePowerKw` bug — and every `drive`-tier slot except `Location`/`Gear` is volatile.
- **Budget:** the §3.5 model is computed from the catalogue's tiers and fails if the 6h projection exceeds 1.2M/month.
- **Schema** (real Postgres): the migration applies; a sample with every column populated round-trips; the insert is still one statement and its bind-parameter count is well inside Postgres's 65535 limit.
- **Battery health:** a measured row is written on the first sample of a UTC day; it is NOT discarded when an estimated row for that day already exists (the silent-no-op case); the estimator still writes as before.

---

## 6. Rollout

Order matters, because the schema must exist before the signals arrive:

1. Migrations applied — the migrator Job is ArgoCD wave 5, ahead of the workloads in wave 6, so this ordering is already enforced by the stack repo rather than by hand.
2. `ev-ingest` deployed with the new catalogues and normaliser.
3. **Then** `scripts/push-telemetry-config.sh` re-run, and `scripts/check-telemetry-synced.sh` polled until the car confirms.
4. `reprocess` over the tape to backfill `gear` and `charge_amps` — the two signals we have been recording and discarding — which requires the write path noted in §4's last row.
5. After a day of real payloads, review the fields parked at `TEXT` (§3.4) and promote the ones whose shape is now known.

Reversing 2 and 3 is harmless — unknown fields are taped and simply not decoded — but wastes signals we are paying for.
