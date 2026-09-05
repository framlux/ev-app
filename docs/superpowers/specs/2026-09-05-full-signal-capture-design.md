# Full signal capture — design

**Date:** 2026-09-05
**Status:** Approved for planning
**Scope:** Capture every Fleet Telemetry signal that applies to this vehicle, as typed queryable columns. Tesla only.
**Parent spec:** `docs/superpowers/specs/2026-09-04-ev-app-design.md`

---

## 1. Purpose

We subscribe to 21 of the 269 signals `vehicle_data.proto` defines, and two of those 21 (`Gear`, `ChargeAmps`) are billed for and then discarded because `normalise.ts` has nowhere to put them. Everything not subscribed to is not merely missing from the database — it is **gone**, permanently, for every hour we do not ask for it. That is the founding constraint of this project (parent spec §1: neither vendor stores history for you), and it is the entire reason this work is urgent while the UI for it is not.

This spec expands the subscription to every applicable signal, gives each one a typed column, and makes the three things that must agree — what we ask the car for, what we decode, and what we store — derive from a single source of truth.

### Goals

- Subscribe to every signal that applies to a Model Y and store each in a typed, queryable column.
- Stay inside the $10/month streaming credit, by design rather than by luck, and make the actual signal rate observable.
- Make drift between the pushed config, the normaliser and the schema a **test failure**, not a silently dropped signal.
- Replace inferred battery capacity with the car's own measurement.

### Non-goals

- **UI for all of it.** Only the high-value few reach the interface (§3.7). The rest is captured and queryable; charting it is a later spec.
- **Media and personal content.** `MediaNowPlaying*`, `MediaPlaybackSource`, `MediaAudioVolume*` and the rest of the `Media*` family are deliberately excluded (§3.2). Navigation destination and route ARE captured.
- **Other vehicles' signals.** Semi, Cybertruck (`Tonneau*`, `Powershare*`, `Offroad*`) and tri/quad-motor (`*REL`, `*RER`) fields are excluded — a Model Y never sends them.
- **Commands.** Still read-only.
- **Rivian.** The catalogue is Tesla's; the seam is unchanged.

---

## 2. Decisions and rationale

| Decision | Choice | Why |
|---|---|---|
| Storage shape | A typed column per signal on `sample` | Everything queryable without JSON extraction. Measured: 205 columns partitioned, 200k rows, 8 fields set and the rest null → **141 bytes/row**; `ADD COLUMN` on the populated partitioned parent took **0.69 ms**. The limit is 1600 columns and dropped columns keep their slot, so 203 now leaves ~1390 future additions. |
| Rejected: JSONB tail | — | Its main argument was "new Tesla signals get captured with no code change", and that is false: the car sends only what the pushed config names, so a new signal needs a config change regardless. Without that, JSONB is untyped storage for no benefit. |
| Nothing is at risk from a wrong guess | `raw_message` is the tape | Every message is stored before decoding. A field we typed wrongly, or have no column for yet, is still on disk; the fix is a migration plus `reprocess`. This is why the catalogue can be opinionated rather than timid. |
| Single source of truth | A field catalogue in `packages/tesla` | The pushed config, the decoder map, the SQL type and the interval tier are one row per signal in one file. Three lists that must agree cannot drift when there is only one list. |
| Interval policy | Four tiers (10s / 60s / 300s / 3600s) | Signal billing is per message. Tiering is what keeps ~200 signals inside a credit that 21 signals barely dented (§3.4). |
| Enum values | Stored as the vendor's own string, in `TEXT` | `prefer_typed: True` makes the car send enum *names*. Re-mapping them into our own vocabulary would be a second translation to keep correct for no gain; the two enums the engine reasons about (`ChargeState`, `DetailedChargeState`) already have decoders and keep them. |
| Unit conversion | At the normaliser, encoded in the catalogue | Tesla streams miles/mph regardless of the car's display setting. Converted columns carry the unit in the name (`_km`, `_kph`); everything else is stored as sent. |

---

## 3. Architecture

### 3.1 The field catalogue

`packages/tesla/src/catalogue.ts` — one entry per signal:

```ts
{
  field: 'NominalFullPackEnergyKwh',   // proto name; what the config asks for and the topic carries
  column: 'nominal_full_pack_energy_kwh', // SQL column and VehicleSample key (camelCased)
  type: 'real',                         // 'real' | 'double' | 'boolean' | 'text' | 'int' | 'timestamptz'
  tier: 'charge',                       // interval tier — see §3.4
  convert: null,                        // null | 'milesToKm' | 'mphToKph'
}
```

Everything else is derived from it:

- **The pushed config.** `scripts/push-telemetry-config.sh` stops carrying its own field list and reads the catalogue (emitted as JSON by a small script, so the shell script stays shell).
- **The normaliser.** `FIELD_DECODERS` is built from the catalogue rather than hand-written, with the existing hand-written decoders (`Location`, `ChargeState`, `DetailedChargeState`, `DoorState`, the TPMS group, the AC/DC charging pairs) kept as explicit overrides — they collapse several fields into one value or split one into several, which no generic rule expresses.
- **The type.** `VehicleSample` gains the catalogue's fields as a mapped type over the `as const` catalogue, so the TypeScript type cannot disagree with the catalogue and nobody hand-maintains 200 optional properties.
- **The insert.** `insertSample`'s column list and placeholders are generated from the catalogue at module load, not typed out.
- **The migration** is generated from the catalogue by a script and **checked in as static SQL** (`004_full_signal_set.sql`). Migrations are immutable history; generating them at runtime would let an old migration change meaning when the catalogue changes.

### 3.2 What is excluded, and why that is a test

269 fields in the proto. Excluded:

| Group | Count | Reason |
|---|---|---|
| `Unknown`, `Deprecated_*`, `Experimental_*` | 19 | Placeholders with no meaning |
| Semi, Cybertruck, tri/quad-motor (`Semitruck*`, `Tonneau*`, `Powershare*`, `Offroad*`, `*REL`, `*RER`) | 37 | A Model Y never sends them |
| `Media*` | 11 | Personal content, excluded by decision |
| **Captured** | **202** | |

The exclusion list is **explicit, with a reason per group, in the catalogue file**. `vehicle_data.proto` is vendored into `packages/tesla/protos/` and a test asserts every field in it is either catalogued or excluded by name. A proto update that adds a signal therefore fails the test until someone decides about it — which is the only way a missing signal becomes visible before a year of it is lost.

### 3.3 Naming and types

- Existing columns keep their names. `soc_pct`, `speed_kph`, `range_km`, `odometer_km`, `inside_temp_c` and the rest are already in the API contract and the UI; renaming them for consistency would break both to no purpose.
- New columns are the proto name in snake_case, plus a unit suffix where the value is converted (`_km`, `_kph`).
- `Location`-shaped fields (`Location`, `DestinationLocation`, `OriginLocation`) become two `DOUBLE PRECISION` columns each (`_lat`, `_lon`), matching how `lat`/`lon` already work.
- Enums → `TEXT`, storing the name the car sent. Booleans → `BOOLEAN`. Counts → `INT`. Times (`ScheduledChargingStartTime`, `ScheduledDepartureTime`, `TpmsLastSeenPressureTime*`) → `TIMESTAMPTZ`.
- Floats → `REAL`, except position and odometer, which stay `DOUBLE PRECISION` (a `REAL` has ~7 significant digits: enough for a pressure, not for a longitude or a six-figure odometer).

Types are our determination, not the proto's: the MQTT transport unwraps the protobuf `oneof` before publishing, so a payload is a bare number, string, boolean, `{latitude, longitude}` or null (`normalise.ts` header). A wrong guess yields nulls rather than an exception — every decoder already returns null for anything it cannot vouch for — and is corrected by a migration plus `reprocess`.

### 3.4 Interval tiers and the signal budget

Billing is $1 per 150,000 signals against a $10/month credit: **~1.5M signals/month**. Intervals are minimums and the car sends only on change, so these are ceilings, not forecasts.

| Tier | Interval | Count | What is in it |
|---|---|---|---|
| `drive` | 10s | ~20 | Everything that shapes a drive trace: `Location`, `VehicleSpeed`, `Gear`, `GpsHeading`, accelerations, `GradeEstimatePercent`, `PackCurrent`/`PackVoltage`, motor torque and current |
| `charge` | 60s | ~25 | SoC, charge power/energy/limit/port, `EnergyRemaining`, ranges, `TimeToFullCharge` |
| `status` | 300s | ~60 | Climate, temperatures, doors, locks, windows, seats, `SentryMode`, navigation ETA |
| `static` | 3600s | ~97 | Configuration and rarely-changing state: trim, colour, driver-assist settings, TPMS pressures, software version |

Worst-case month, assuming 1.5h/day driving and 6h/day awake and every field changing at its ceiling:

```
drive   20 × 360/h × 1.5h × 30 = 324,000
charge  25 ×  60/h ×   6h × 30 = 270,000
status  60 ×  12/h ×   6h × 30 = 129,600
static  97 ×   1/h ×   6h × 30 =  17,460
                          total ≈ 741,000   (~49% of the credit)
```

**Observed, not just modelled.** `ev_ingest_messages_total` already counts every message by record kind, so the real signal rate is a query away. An alert fires if the 30-day projection exceeds 1.2M — well before the credit runs out, and long before a bill appears.

### 3.5 What this changes in the ingest path

- **`VOLATILE_FIELDS` grows.** `pipeline.ts` treats a value as "true until contradicted" unless it is listed as volatile, and the new drive-tier signals — pedal position, torque, motor current, accelerations, pack current — are exactly the kind that mislead when stale. Everything in the `drive` tier except `Location` and `Gear` becomes volatile. (`Gear` is a level: a car in P stays in P.)
- **Message volume rises roughly fivefold**, which lands on `raw_message` (one row per message). At the budget above that is ~740k rows/month, ~9M/year — inside the parent spec's 10–50M rows/year envelope, and the monthly partitioning is what keeps it manageable.
- **The accumulator's debounce matters more, not less.** More chatty fields make `MAX_SAMPLE_INTERVAL_MS` (30s) the binding constraint during a drive rather than `QUIET_PERIOD_MS` (2s). That is the designed behaviour and needs no change, but it means sample rows get wider without getting more frequent.

### 3.6 Two capabilities that fall out for free

**Battery health becomes a measurement.** `NominalFullPackEnergyKwh` is the pack's full energy as the car computes it, and `EnergyRemaining` is what is in it now. Today `estimateCapacity` infers capacity from a charge session's SoC span, returns null when the span is too narrow, and `rated_range_at_100_km` is never written at all. So:

- `battery_health_sample` gains `measured_capacity_kwh` and `source` (`'measured' | 'estimated'`).
- A daily measured row is written from the car's own number when present; the SoC-span estimator stays as the fallback and as a cross-check.
- The battery page shows the measured series, with the estimate behind it.

**Place labels without a geocoder.** `LocatedAtHome`, `LocatedAtWork` and `LocatedAtFavorite` are booleans the car already computes. A drive that starts where `LocatedAtHome` was true is a drive from home — no reverse geocoding, no third-party API, no coordinates in a request to anyone. Captured now; the UI that uses them is a later spec.

**And one correctness improvement:** `Gear` tells the segmenter definitively whether the car is in park. Today "stopped" is inferred from speed, which cannot distinguish a red light from the end of a drive except by waiting. This spec captures `Gear` and stores it; changing the segmenter to use it is deliberately **out of scope** — that alters how every historical drive would be segmented and deserves its own spec and its own `reprocess`.

### 3.7 The UI's share of this

Only what earns its place:

- **Battery page:** measured capacity and degradation against nameplate; `EnergyRemaining`; pack module temperature range; brick voltage spread (`BrickVoltageMin`/`Max`) as a pack-health indicator.
- **Vehicle overview:** software version (with `SoftwareUpdateAvailable` when one is pending), charge limit and charge-port state, HVAC on/off with cabin overheat protection, `SentryMode`, and gear.
- **Charges page:** charger voltage, phases, `FastChargerType`, `ChargingCableType` — the context that explains why a charge curve looks the way it does.

Everything else is reachable through `/api/v1/vehicles/[id]/samples?fields=…`, which already takes a field allowlist, so a wide table does not become a wide payload.

---

## 4. Failure handling

| Failure | Behaviour |
|---|---|
| A catalogued field name is wrong | The car silently ignores an unknown name — no error anywhere, one signal never arrives. Mitigated by the proto-vendoring test in §3.2: every catalogue entry must name a field that exists in the checked-in proto. |
| A value arrives as an unexpected type | `null` for that field on that sample, never an exception. The existing decoders accept both `12.3` and `"12.3"` for numbers and refuse `''`, `'abc'`, NaN and Infinity. The raw message is taped regardless, so the value is recoverable once the type is corrected. |
| An enum gains a new member | Stored verbatim as `TEXT`. Nothing to update, no lost row. The two engine-facing enums keep their existing "unknown maps to null" decoders. |
| Signal volume exceeds the model | Visible in `ev_ingest_messages_total` before it is visible in a bill; the alert fires at a 30-day projection over 1.2M. The fix is a tier change plus a config re-push, which needs no code deploy. |
| The config push is not applied by the car | Already handled: `scripts/check-telemetry-synced.sh` reports whether the vehicle has taken the config, and the config stays queued at Tesla until the car checks in. |
| A column is added but historical data lacks it | Correct and expected: the car was never asked for that signal, so there is nothing to backfill. The exception is `Gear` and `ChargeAmps`, which have been taped since day one and ARE backfilled by `reprocess`. |

---

## 5. Testing

- **Catalogue integrity** (`packages/tesla`): every entry names a field present in the vendored proto; every proto field is either catalogued or in the exclusion list with a reason; no duplicate columns; no column collides with an existing one; every `convert` names a real converter.
- **Drift** (the point of the catalogue): the generated migration's column set equals the catalogue's; the config script's emitted field list equals the catalogue's; `insertSample`'s generated column list equals the catalogue's. Each of these is the failure the catalogue exists to prevent, so each is pinned rather than assumed.
- **Normaliser** (`packages/tesla`): table-driven over the whole catalogue — every field decodes a representative value of its declared type, and every field returns null for a value of the wrong type. Plus the existing hand-written decoder tests, unchanged.
- **Schema** (`packages/db`, real Postgres): the migration applies; a sample with every column populated round-trips; `insertSample` with all columns is still one statement.
- **Budget**: a unit test computes the §3.4 model from the catalogue's tiers and fails if the projection exceeds 1.2M/month — so adding twenty signals at `drive` tier fails the build rather than the bill.
- **Battery health**: a measured row is written when the car reports pack energy; the estimator still runs and is still recorded as `'estimated'` when it does not.

---

## 6. Rollout

Order matters, because the schema must exist before the signals arrive:

1. Migration applied (the migrator Job runs in ArgoCD wave 5, ahead of the workloads).
2. `ev-ingest` deployed with the new catalogue and normaliser.
3. **Then** `scripts/push-telemetry-config.sh` re-run to subscribe to the new fields, and `scripts/check-telemetry-synced.sh` polled until the car confirms.
4. `reprocess` run over the existing tape to backfill `gear` and `charge_amps`, the two signals we have been recording and discarding.

Reversing 2 and 3 is harmless — unknown fields are taped and simply not decoded — but it wastes signals we are paying for.
