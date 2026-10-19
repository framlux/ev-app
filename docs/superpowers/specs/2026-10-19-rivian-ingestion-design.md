# Rivian ingestion: design

**Date:** 2026-10-19
**Vehicle:** Rivian R2, VIN `7PD2EAAB2VN016249` (check digit valid; model year 2027). On the assembly line, not delivered.
**Background:** `docs/research/2026-09-04-tesla-rivian-api-investigation.md`; `specs/2026-09-04-ev-app-design.md` §4.2 (the seam this replaces).
**Status:** approved in conversation on 2026-10-19 (architecture A, web sign-in with DB-held session). This document is the written form.

---

## 1. Goal

Record everything Rivian will stream about the R2 from the first minute it can, through the same tape, engine and website the Model Y already uses. Rivian keeps no history and charges nothing for what it streams, so the rule is the inverse of the Tesla one: **capture all of it, and decide later what to make of it.**

The car is not delivered, so this work cannot see one real payload. That shapes the scope:

- **Built and verified now:** sign-in, the always-on connection, finding the car by VIN, the subscriptions, the tape, the generalised ingest pipeline, normalisation of the fields whose shape the community has documented, the settings page, and the tooling to read what we have not mapped.
- **Done on delivery, from the tape:** confirming every mapping against real R2 payloads, promoting further fields into columns, and mapping Parallax topics. Each is a migration plus `reprocess`, which is the pattern `signals.ts` already prescribes for fields "whose shape we have not observed".

Success: once the R2 appears on the Rivian account, the connector finds it without anyone touching anything. From delivery day on, every message Rivian sends about it is on the tape. Drives appear on the site next to the Model Y's, and so do charges, with their energy and cost unknown until §8.4's follow-up maps a charging source.

### 1.1 Out of scope

- **Commands, phone-key enrolment, BLE.** Read-only, the same as the Tesla.
- **New `sample` columns for Rivian-only fields.** Their shapes are unobserved. They are taped now and promoted after delivery (§8.4).
- **Decoding Parallax into columns.** Its schemas are unpublished, and the only reverse-engineered set is unlicensed (§2.4). Taped verbatim now; tooling to read it ships now (§9).
- **Smartcar.** A fallback if the community path closes, not a parallel source.
- **Kubernetes manifests.** They live in the GitOps repo. §11 lists what that repo needs.

---

## 2. What Rivian offers, as of 2026-10-19

Verified against `bretterer/rivian-python-client` (last commit 2026-10-14) and `bretterer/home-assistant-rivian` (Apache-2.0, last commit 2026-10-12). Nothing has been tested against the real account yet.

### 2.1 Endpoints

| Purpose | Endpoint |
|---|---|
| Sign-in, user info | `POST https://rivian.com/api/gql/gateway/graphql` |
| Charging (summaries, schedules) | `POST https://rivian.com/api/gql/chrg/user/graphql` |
| Live subscriptions | `wss://api.rivian.com/gql-consumer-subscriptions/graphql`, subprotocol `graphql-transport-ws` |

Every HTTP call carries `Apollographql-Client-Name: com.rivian.ios.consumer-apollo-ios`, a `dc-cid: m-ios-<uuid>`, and a RivianApp `User-Agent`. Authenticated calls add `A-Sess` (app session) and `U-Sess` (user session); mutations add `Csrf-Token`.

### 2.2 Sign-in and session lifetime

1. `CreateCSRFToken` returns `csrfToken` and `appSessionToken`.
2. `Login(email, password)` returns one of two things. A `MobileLoginResponse` carries `accessToken`, `refreshToken` and `userSessionToken`. A `MobileMFALoginResponse` carries an `otpToken`, and Rivian sends the code to the user.
3. `LoginWithOTP(email, otpCode, otpToken)` returns the same `MobileLoginResponse`.

**Lifetime.** The Home Assistant integration runs for months on one sign-in. When a call fails with an expired-token error it calls `CreateCSRFToken` again, with no user involved. Only `UNAUTHENTICATED` sends the user back through sign-in. So: **the user session token is long-lived, and the app session is cheap to renew headlessly.** No refresh mutation is documented; we store `refreshToken` anyway (§4.2) so that one can be used later without a re-sign-in.

### 2.3 The websocket

- The client sends `connection_init` with payload `{client-name, client-version, dc-cid, u-sess}`. The server answers `connection_ack`.
- Subscriptions use `{id, type: "subscribe", payload: {operationName, query, variables}}`. Data arrives as `{id, type: "next", payload: {data}}`, and `{id, type: "complete"}` stops a subscription.
- **The server closes with reason `"Rate limited"` or `"Unauthenticated"`.** The reference client backs off 30 s × 2ⁿ plus up to 30 s of jitter, capped at 900 s, and resets the count once data flows. Its latest commit (2026-10-14) fixed a reconnect storm caused by ignoring this.
- If nothing arrives for 60 s on an acknowledged socket, the client resubscribes. If there's no `connection_ack` within the request timeout, it backs off.

Two subscriptions matter:

- **`vehicleState(id)`.** The caller names every property it wants. Most are `{ timeStamp value }`. `gnssLocation` is `{ latitude longitude timeStamp isAuthorized }`, `cloudConnection` is `{ lastSync isOnline }`, and `gnssError` is `{ timeStamp positionVertical positionHorizontal speed bearing }`. A push carries the full selection; properties that didn't change arrive as `null`. About 140 properties are known, 11 of them subscription-only (`tirePressureFrontLeft` and the like).
- **`parallaxMessages(vehicleId, rvms)`.** Each message is `{ payload timestamp rvm }`, where `payload` is a base64 protobuf for the topic named by `rvm` (`charging.session.notification`, `parallax.wakeup.heartbeat`, …). With `rvms` null there's no topic filter.

### 2.4 Things that bear directly on the design

- **The live charging-session query is gone.** On 2026-10-11 Rivian removed `getLiveSessionData`, and its suggested replacement returns null during a charge. **`vehicleState` carries no charging power and no energy counter.** Those exist, if anywhere, only in Parallax. So until §8.4, a Rivian charge's energy is unknown (§7.4).
- **`getCompletedSessionSummaries`** on the charging endpoint still works and summarises finished charges. It's cheap ground truth for later, so we tape it (§5.5).
- **`getUserInfo` lists the car before delivery.** Each entry has `vin`, `id`, `expectedBuildDate`, `plannedBuildDate` and `actualGeneralAssemblyDate`. The connector can find the R2 by VIN today.
- **Licensing.** `rivian-python-client` has no licence, so its code and `.proto` files cannot be copied. The Home Assistant integration is Apache-2.0. Everything in this repo is written from facts: endpoint names, field names, units, and the protocol above. No code or schema is copied. This is also why Parallax is taped raw rather than decoded against someone else's protos.

### 2.5 Units and vocabularies (from the Apache-2.0 integration)

| Property | Unit / values |
|---|---|
| `batteryLevel`, `batteryLimit` | % |
| `batteryCapacity` | kWh |
| `distanceToEmpty` | km |
| `vehicleMileage` | **metres** |
| `gnssSpeed` | **m/s** |
| `gnssAltitude` | m |
| `cabinClimateInteriorTemperature`, `cabinClimateDriverTemperature` | °C |
| `tirePressure{FrontLeft,…}` | bar |
| `timeToEndOfCharge` | minutes |
| `gearStatus` | `park`, `drive`, `neutral`, `reverse` |
| `powerState` | `sleep`, `standby`, `ready`, `go`, `vehicle_reset` |
| `chargerStatus` | `chrgr_sts_not_connected`, plus `chrgr_sts_connected_*` |
| `chargerState` | `charging_active`, `charging_connecting`, plus others (`charging_complete`, …) |
| `door*Closed`, `closure*Closed`, `window*Closed` | `open` / `closed` |
| `door*Locked`, `closure*Locked` | `locked` / `unlocked` |

These describe the R1. The R2 is a different platform, and every value here is a hypothesis until the tape confirms it (§12).

---

## 3. Architecture

```
 Rivian cloud ──wss: vehicleState (every property) + parallaxMessages (all topics)──┐
            └──https: getUserInfo, getCompletedSessionSummaries (hourly)──────────┐ │
                                                                                  ▼ ▼
 ev-rivian (new: apps/rivian)    session from rivian_credential · finds the car by VIN
     │                           one socket · stamps receivedAt · publishes verbatim
     │  MQTT QoS 1   rivian/<VIN>/state | rivian/<VIN>/parallax | rivian/<VIN>/meta
     ▼
 Mosquitto (existing)            durable queue: the buffer the car does not have
     ▼
 ev-ingest-rivian                the existing ev-ingest image, second Deployment,
     │                           EV_VENDOR=rivian, own client id and cursor
     ▼
 Postgres ──── ev-web            /settings/rivian sign-in; R2 in the garage
```

**Why the connector is separate (approach A).** Nothing on the Rivian side buffers. If the socket is down, whatever the car does in the meantime is gone. So the process that holds the socket must be the one that restarts least. The connector holds no engine logic and decodes nothing, so engine fixes, which are frequent, redeploy only `ev-ingest-rivian`, and the broker holds the R2's messages across that deploy exactly as it holds the Tesla's. Every existing ingest feature then works for the R2 unchanged: the tape, `reprocess`, `Pipeline.resume`, metrics and the stall alert.

**Why `rivian/` and not `ev/`.** The Tesla worker subscribes to `ev/#`. Rivian messages under `ev/` would reach it, fail `parseTopic`, and inflate its `topic` parse-failure counter, which is the signal for "fleet-telemetry changed its layout". A separate root keeps each worker blind to the other.

**Why the connector stamps the time.** fleet-telemetry publishes no timestamp, so the Tesla worker stamps arrival. After an outage that put six days of backlog at drain time and needed a forensic re-timing (memory: re-timing a drained MQTT backlog). The connector stamps `receivedAt` when the frame arrives, and ingest uses that. A drained Rivian backlog lands at the right time with no repair.

---

## 4. Credentials

### 4.1 This is a deliberate departure from the Tesla design

`tesla-session.ts` refuses to store a standing credential anywhere, even at rest, because the Tesla streams by itself and a token is needed only for a config push. The Rivian can't work that way: nothing arrives unless we hold a session open around the clock. A standing Rivian credential is therefore unavoidable. What this design controls is **who can read it**.

### 4.2 Sealed to the connector

- A P-256 keypair is generated once (`scripts/rivian-keygen.mjs`). The connector gets the private JWK (`RIVIAN_CREDENTIAL_PRIVATE_KEY`). The web gets only the public JWK (`RIVIAN_CREDENTIAL_PUBLIC_KEY`).
- After a successful sign-in, the web seals `{userSessionToken, accessToken, refreshToken}` as a compact JWE, using `ECDH-ES+A256KW` and `A256GCM` via `jose`, which the web already depends on. It upserts the result into `rivian_credential` and forgets the plaintext.
- **The internet-facing pod can write the credential but can never read it back.** A compromise of `ev-web` gets nothing it can use, and neither does a database dump without the connector's key.
- The connector decrypts with its private key. If it ever needs to re-seal (a future refresh flow), it holds the public half too: `RIVIAN_CREDENTIAL_PUBLIC_KEY` is set on both.

```sql
CREATE TABLE rivian_credential (
  id          SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- one account, one row
  sealed      TEXT        NOT NULL,                            -- compact JWE
  account     TEXT        NOT NULL,                            -- email, for the page only
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Exactly one row, enforced by the check. The app is single-tenant and the connector serves one account.

### 4.3 The sign-in flow (`/settings/rivian`)

1. **Email and password.** The server action calls `CreateCSRFToken` and then `Login`.
   - It returns tokens: seal and store them, then done.
   - It returns an `otpToken`: keep `{email, csrfToken, appSessionToken, otpToken}` in a module-level map keyed by OIDC subject, for at most 10 minutes. This is the same reasoning and shape as `tesla-session.ts`: one replica, one operator, and losing it costs a retry. The page then asks for the code.
2. **One-time code.** The server action calls `LoginWithOTP`, seals and stores the result, and deletes the pending entry.

The password is never stored, logged or echoed. It lives in one request's memory. Errors map to messages a person can act on: wrong password, wrong or expired code, temporarily locked, rate limited. Rivian's raw response is logged without the request body.

**Sign out** deletes the row. The connector notices within its poll interval (§5.2), closes the socket and reports `signed_out`.

**Recommended, not enforced:** sign in as a **secondary driver** on the Rivian account, so the integration can be revoked from the Rivian app without touching the owner's password. The page says this in one line.

---

## 5. The connector (`apps/rivian`, image `ev-rivian`)

### 5.1 Configuration

| Variable | Required | Notes |
|---|---|---|
| `EV_VEHICLE_VIN` | yes | The car to find. Never guessed: an account can hold several. |
| `RIVIAN_CREDENTIAL_PRIVATE_KEY` | yes | Private JWK (JSON). |
| `RIVIAN_CREDENTIAL_PUBLIC_KEY` | yes | Public JWK, for re-sealing. |
| `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD` | `MQTT_PASSWORD` yes | Same broker; its own user. |
| `MQTT_CLIENT_ID` | no | Default `ev-rivian`. Startup refuses `ev-fleet-telemetry`, `ev-ingest` and `ev-ingest-rivian`: a shared client id makes the two clients evict each other forever. |
| `RIVIAN_PARALLAX_RVMS` | no | Comma-separated topic filter. Unset means all topics. An escape hatch in case Parallax turns out too chatty. |
| `PG*` | yes | Reads the credential, writes status. |
| `METRICS_PORT` | no | Default 9090. |

### 5.2 Lifecycle

A single loop, with its state written to `rivian_status` on every transition:

```
signed_out ──credential appears──▶ finding_vehicle ──VIN found──▶ connecting
    ▲                               │ not found: hourly retry     │ ack
    │                               ▼                             ▼
    └──── row deleted ◀──── waiting_for_vehicle            subscribed ◀─┐
                                                              │ close    │ data
    unauthenticated ◀── "Unauthenticated" / UNAUTHENTICATED ──┤          │
      (stops; waits for a NEW credential row)                 ▼          │
                                            backing_off (30 s·2ⁿ+j, ≤900 s)
```

- **Credential poll:** every 15 s, read `rivian_credential.updated_at`. A changed timestamp means re-read, decrypt and restart the loop from `finding_vehicle`. A missing row means close everything and go to `signed_out`. One indexed single-row read every 15 s costs nothing.
- **Finding the vehicle:** `getUserInfo` once at start, then hourly while the VIN is absent. The response is published to `meta` (§5.5), which tapes the build dates as they move. Matching is by VIN. The Rivian vehicle `id` it yields is the subscription key.
- **Expired app session:** an HTTP error carrying an expired-token reason triggers one `CreateCSRFToken`, held in memory, and a retry. A second failure is treated as `UNAUTHENTICATED`.
- **`UNAUTHENTICATED` or close reason `"Unauthenticated"`:** stop. Don't retry the dead session; retrying it is how accounts get flagged. Report `unauthenticated` and wait until `updated_at` changes, meaning someone signed in again.
- **Close reason `"Rate limited"`, or no ack:** back off as in §2.3. Shutdown is the only thing that cuts a backoff short.
- **Any other close or error:** back off from attempt 0. The 30 s floor means a flapping network can never produce a reconnect storm.
- **Silence:** 60 s with no frame on an acknowledged socket means resubscribe on the same socket, matching the reference client. Five minutes of silence means reconnect.
- **SIGTERM:** send `complete` for both subscriptions, close the socket, end MQTT cleanly, then exit.

### 5.3 Subscriptions

Both subscriptions share one socket, opened once the vehicle is found:

- `vehicleState(id)` with **every property in `packages/rivian/src/catalogue.ts`**, the subscription-only ones included.
- `parallaxMessages(vehicleId, rvms: RIVIAN_PARALLAX_RVMS or null)`.

**Schema drift.** If the server answers `vehicleState` with a validation error naming unknown fields, the connector drops exactly those fields and resubscribes once. It then publishes a `meta` record listing what it dropped, and counts them in `rivian_dropped_properties`. One retired field mustn't cost the other 139. An error that names no fields isn't guessed at: the subscription backs off like a failed connection, and the error goes to the log and `rivian_status.last_error`.

### 5.4 Publishing

Every `next` frame is published verbatim, at QoS 1 and not retained, under topic `rivian/<VIN>/<stream>`. The body is a versioned envelope:

```jsonc
{
  "v": 1,
  "stream": "state" | "parallax" | "meta",
  "vin": "7PD2EAAB2VN016249",
  "receivedAt": "2026-10-19T17:03:11.482Z",   // connector clock, when the frame arrived
  "body": { ... }   // state: payload.data.vehicleState as sent
                    // parallax: payload.data.parallaxMessages ({payload, timestamp, rvm})
                    // meta: { kind, data } — see §5.5
}
```

The publish must be acknowledged by the broker before the next frame is taken from the socket's queue. The queue is in memory and unbounded only up to a cap: past 10,000 frames, the oldest are dropped and counted in `rivian_frames_dropped_total`. **A broker outage therefore costs frames once the cap is reached**, which is the honest limit of a car that does not buffer. The alternative, blocking the socket read, would make Rivian close a slow consumer and lose everything instead. Production alerts on this counter.

### 5.5 `meta` records

`meta.kind` is one of the following:
- `userInfo`: the whole `getUserInfo` response, published at start, hourly while waiting, then every 6 hours. It's published only when it differs from the last one published, compared by a hash of the JSON.
- `chargingSummaries`: `getCompletedSessionSummaries(vehicleId)`, hourly once the vehicle is found, and again only when it changes.
- `connection`: `{state, reason}` on every lifecycle transition, so the tape records its own gaps. A hole in `state` with a `backing_off` beside it is an outage. A hole with nothing beside it is a parked car.
- `droppedProperties`: §5.3.

The HTTP calls are deliberately few: about 24 user-info and 24 charging calls a day at most, and fewer once nothing changes. That mirrors Roamer's stated self-limiting.

### 5.6 Status and metrics

`rivian_status` is a single row, written only by the connector:

```sql
CREATE TABLE rivian_status (
  id               SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  state            TEXT NOT NULL,          -- §5.2 state names
  vin              TEXT,
  rivian_vehicle_id TEXT,
  last_frame_at    TIMESTAMPTZ,
  last_error       TEXT,
  backoff_until    TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`last_frame_at` is written at most once a minute, not once per frame.

Prometheus metrics:
- `rivian_connector_state{state}`: a gauge, one-hot.
- `rivian_frames_total{stream}`
- `rivian_frames_dropped_total`
- `rivian_publish_failures_total`
- `rivian_reconnects_total{reason}`
- `rivian_dropped_properties`
- `rivian_last_frame_timestamp_seconds`

Every series is initialised at zero at startup. That's the same reasoning as `initialiseSeries`: an alert can't see a series that doesn't exist.

---

## 6. Ingest, generalised

### 6.1 The vendor profile replaces `VehicleAdapter`

`packages/core/src/adapter.ts` describes a vendor as `start/stop/normalise(raw) → VehicleSample[]`. The real pipeline proved that shape wrong: a message is a fragment, not a sample, and the accumulator, the staleness classes and the charge inference are where the vendor knowledge actually lives. Today all three are hard-coded against `TeslaFieldState` in `pipeline.ts`. They move behind one interface:

```ts
// apps/ingest/src/profile.ts
export interface VendorProfile {
  readonly vendor: Vendor
  /** One taped message -> the slots it contributes, or null. Pure. */
  decode(raw: RawMessage): Record<string, unknown> | null
  /** Accumulated slots -> the canonical sample. Pure; absent slots -> null. */
  toSample(vehicleId: string, ts: Date, state: Record<string, unknown>): VehicleSample
  /** How long a slot's value may be carried. */
  staleWindowFor(slot: string): number
  /** Slots refreshed while a charge shows signs of life, and the signs. */
  readonly chargeStateSlots: readonly string[]
  readonly chargingPowerSlots: readonly string[]
  readonly chargingEnergySlots: readonly string[]
}
```

- `FieldAccumulator` takes a profile in its constructor and calls `profile.staleWindowFor` and the three slot lists instead of module constants. `Pipeline` takes the profile and passes it to every accumulator it creates, and `emit` calls `profile.toSample`.
- **`apps/ingest/src/profiles/tesla.ts`** builds the Tesla profile from exactly today's constants: `VOLATILE_FIELDS` and its derivation, `CARRIED_DRIVE_FIELDS`, `ALWAYS_VOLATILE` and the three charge lists, all keeping their `satisfies keyof TeslaFieldState` checks, plus `decodeIfKnown`'s Tesla branch and `teslaStateToSample`. **The change is behaviour-neutral for the Tesla**, and is proven so by the existing suite unchanged and a replay against a restored production copy (§10.3).
- `QUIET_PERIOD_MS`, `MAX_SAMPLE_INTERVAL_MS`, `VOLATILE_STALE_MS` and `STALE_VALUE_MS` stay in `pipeline.ts` as shared defaults; profiles compose from them.
- `deps.ts` becomes the registry: `profileFor(vendor)`. It stays the only place the worker names a vendor package.
- `VehicleAdapter` is deleted from `@ev/core`. Its doc comment's promise ("adding Rivian means one implementation of this") moves to `profile.ts`, rewritten to say what's actually true.

### 6.2 One image, a vendor per Deployment

- New `EV_VENDOR` setting, `tesla` or `rivian`, **required**. A default would let a misconfigured Rivian worker decode Rivian payloads as Tesla and tape them under the wrong vendor: silent and permanent.
- The vendor selects the profile, the topic parser, `registerVehicle`'s `vendor`, the metrics `vendor` label and the default cursor source (`tesla:mqtt` or `rivian:mqtt`). Existing deployments must add `EV_VENDOR=tesla`. That's a one-line GitOps change, called out in §11 and the README, and startup fails loudly without it.
- **The Rivian topic parser** accepts only `rivian/<VIN>/{state|parallax|meta}`. A body that isn't a v1 envelope is counted under a new `envelope` parse failure and acked, the same poison-message rule as today.
- **`receivedAt`** comes from the envelope for Rivian. A missing or unparseable value is an `envelope` failure, never arrival time. Arrival time is what produced the drained-backlog bug.
- `raw_message.source` is `graphql_ws`, which already exists in `RawSource`, and the payload is the whole envelope. `reprocess` and `resume` need no change beyond using the profile.
- The `RecordKind` metric label becomes per vendor. For Rivian it's the stream name: `state`, `parallax`, `meta`.

### 6.3 What doesn't change

`Store`, the transaction and ack discipline, `resume`, `reprocess`, pricing, battery health, the segmenter's session rules, and `wentNowhere`. They already operate on `VehicleSample`, and none of them names a vendor once §7.2 is done.

---

## 7. Rivian normalisation (`packages/rivian/src/normalise.ts`)

### 7.1 Decode

`decode(raw)` reads the envelope:

- **`state`:** for each non-null property in `body`, look it up in the catalogue. Unknown properties are ignored; they stay on the tape. A known property decodes to slots. A `{value: null}`, or a value the decoder can't vouch for, is `null` and contributes nothing. That's the same "absent never becomes zero" rule as Tesla's `normalise.ts`, including its type-drift tolerance: numbers accept numeric strings and refuse `''`, NaN and Infinity.
- **`parallax`, `meta`:** return `null`, so they count as unmapped. They're taped for §8.4 and §9.

### 7.2 Mapping onto existing columns

| Rivian property | Column | Conversion |
|---|---|---|
| `batteryLevel` | `soc_pct` | as is |
| `distanceToEmpty` | `range_km` | as is (km) |
| `vehicleMileage` | `odometer_km` | m ÷ 1000 |
| `gnssLocation.{latitude,longitude}` | `lat`, `lon` | both or neither |
| `gnssSpeed` | `speed_kph` | m/s × 3.6 |
| `gnssBearing` | `gps_heading` | as is |
| `powerState` | `power_state` | `sleep`→`asleep`; `standby`/`ready`/`go`/`vehicle_reset`→`online` |
| `cloudConnection.isOnline` | `power_state` | `false`→`offline`. This wins over `powerState`: an offline car's last power state is stale. |
| `chargerState` + `chargerStatus` | `charge_state` | §7.3 |
| `cabinClimateInteriorTemperature` | `inside_temp_c` | as is |
| `door{FL,FR,RL,RR}Locked` + `closure*Locked` | `locked` | `true` only if every reported lock is `locked`. Any `unlocked` makes it `false`. With none reported, null. |
| `door*Closed` + `closure*Closed` | `doors_open` | any `open` → `true`; all `closed` → `false`; none reported → null |
| `tirePressure{FrontLeft,FrontRight,RearLeft,RearRight}` | `tpms` | bar, `{fl,fr,rl,rr}`, the same JSONB shape as Tesla |
| `gearStatus` | `gear` | §7.5 |
| `batteryLimit` | `charge_limit_soc` | as is |
| `batteryCapacity` | `nominal_full_pack_energy_kwh` | as is. It feeds the existing daily measured-capacity row. |
| `timeToEndOfCharge` | `time_to_full_charge_hours` | min ÷ 60 |
| `otaCurrentVersion` | `version` | as is |
| `window{FL,FR,RL,RR}Closed` | `fd_window`, `fp_window`, `rd_window`, `rp_window` | `open`/`closed`, stored as text the same way Tesla's are |

Before writing a mapping, the implementation must check each target column's name and type against `signals.ts`. If a column named here doesn't exist under that name, the field stays tape-only; never add a column to fit. Every other catalogued property is tape-only in v1.

### 7.3 Charge state

The canonical `ChargeState` is `disconnected | connected | charging | complete | stopped`.

| Evidence | `charge_state` |
|---|---|
| `chargerStatus = chrgr_sts_not_connected` | `disconnected` (wins over everything) |
| `chargerState = charging_active` | `charging` |
| `chargerState = charging_complete` | `complete` |
| `chargerState` = any other known value, `chargerStatus` connected | `connected` |
| anything unrecognised | null; the raw value is on the tape |

`charging_connecting` is **not** `charging`. The integration treats it as on for a UI badge, but no energy flows, and a charge session opened on a handshake would start before the energy does.

### 7.4 What the R2 profile does about charging power and energy

`vehicleState` has neither (§2.4). So in v1:

- `chargingPowerSlots` and `chargingEnergySlots` are **empty**, and nothing refreshes the charge-state slots during a long steady charge. That leaves the six-hour carry as the only guard. Tesla needed the refresh because its car sends charge state once per charge; Rivian's push cadence for `chargerState` is unknown. **This is the first thing to check on the tape after delivery**, and the follow-up is to map a Parallax charging topic into these slots.
- A Rivian charge's `energy_kwh` is null, its cost basis is `unknown`, and no battery-health estimate is written from it. That's the existing "no row beats a bad row" behaviour, not a new one. Deriving charge energy from SoC × capacity was rejected: it makes `estimateCapacity` circular, and that circularity would rescale every drive figure.

### 7.5 Canonical gear

`segmenter.ts` compares `sample.gear` against Tesla's raw strings (`'ShiftStateP'`, and D/R/N in `DRIVING_GEARS`). That's the one place a vendor's vocabulary leaked into `@ev/core`. The fix is the one already used for power and charge state: **the engine reads a canonical value, and each normaliser produces it.**

- `@ev/core` gains `type Gear = 'P' | 'R' | 'N' | 'D'` and a `Gear` tag in `TsTypeMap`. The `gear` catalogue entry changes `ts: 'string'` to `ts: 'Gear'`, and `TS_TYPES_FOR_SQL['TEXT']` admits `'Gear'`.
- The segmenter compares against `'P'` and the set `{'D','R','N'}`.
- **Tesla:** `ShiftStateP|R|N|D` map to `P|R|N|D`. Null still decodes as `P` (commit 71aa244). `ShiftStateSNA`, `ShiftStateInvalid` and anything else map to null. The raw tape keeps the original strings.
- **Rivian:** `park|reverse|neutral|drive` map to `P|R|N|D` (case-insensitive). Anything else is null.
- **Migration `008_canonical_gear.sql`** rewrites history so stored samples agree with what a `reprocess` would now produce: `UPDATE sample SET gear = CASE gear WHEN 'ShiftStateP' THEN 'P' WHEN 'ShiftStateR' THEN 'R' WHEN 'ShiftStateN' THEN 'N' WHEN 'ShiftStateD' THEN 'D' END WHERE gear LIKE 'ShiftState%'`. Unmatched values like `ShiftStateSNA` become NULL. Down migration: map the four letters back to their `ShiftState` names.
- **Web:** the vehicle page shows `gear` through `formatText`, and `teslaEnumLabel` strips the `ShiftState` prefix. After the change the stored value is already `P`/`D`. The page renders it as is, and `ShiftState` comes out of `TESLA_ENUM_PREFIXES` only if no other caller needs it there.

### 7.6 Staleness

`staleWindowFor` returns `VOLATILE_STALE_MS` for `speedKph` and `gpsHeading`, and `STALE_VALUE_MS` for everything else, `lat`/`lon` and `gear` included, for the reasons `CARRIED_DRIVE_FIELDS` gives. Like Tesla's, the volatile list is typed against the Rivian slot type (`satisfies readonly (keyof RivianFieldState)[]`), so a misspelling fails to compile.

### 7.7 Accumulation timing

`QUIET_PERIOD_MS` (2 s) was chosen for fleet-telemetry's bursts. A `vehicleState` push is already a coherent snapshot, so a 2 s debounce merges back-to-back pushes. That's harmless, and it keeps one code path. The profile doesn't override the timing constants in v1. If the tape shows pushes more than 2 s apart during a drive, a sample is written per push, which is the right outcome anyway.

---

## 8. Data model changes

### 8.1 Migrations

- `008_canonical_gear.sql`: §7.5.
- `009_rivian.sql`: `rivian_credential` (§4.2) and `rivian_status` (§5.6).

No enum changes: `001_initial.sql` already declares `vendor AS ENUM ('tesla', 'rivian')` and `raw_source AS ENUM ('telemetry', 'fleet_api', 'graphql_ws')`.

### 8.2 The vehicle row

`ev-ingest-rivian` registers `{vendor: 'rivian', id: EV_VEHICLE_ID, vendorVehicleId: EV_VEHICLE_VIN}` at startup, as the Tesla worker does. The VIN is the vendor identifier because it's what we know before delivery. The Rivian vehicle `id` is on the tape in `meta.userInfo`.

### 8.3 Capacity

`EV_USABLE_CAPACITY_KWH` stays required for the Rivian worker; it scales drive energy from SoC. The R2's usable capacity depends on the pack ordered and isn't in this repo. **This is a value only the owner can supply**, and deploying `ev-ingest-rivian` needs it (§11).

### 8.4 After delivery (recorded here, done later)

Each of these is a migration plus `reprocess`, worked from the real tape:
1. Confirm §2.5 and §7.2–7.3 against R2 payloads; fix any mapping that disagrees.
2. Promote Rivian-only properties worth a column (drive mode, gear guard, HV thermal events, the 12 V battery, …) into `signals.ts`, typed from what's observed.
3. Use §9's tooling to find the Parallax topics that carry charging power and energy, write our own `.proto` for them, and fill the profile's charging slots (§7.4).

---

## 9. Parallax tooling

- `packages/rivian/src/protobuf.ts` is a schema-less protobuf wire decoder: varint, 64-bit, length-delimited and 32-bit. It turns bytes into a tree of `{field, wire, value}`. A length-delimited value is shown as a nested message when it parses fully as one, otherwise as UTF-8 if printable, otherwise as hex. Pure, and written from the public protobuf encoding spec.
- `apps/ingest/src/parallax-dump.ts` (`pnpm --filter @ev/ingest parallax-dump -- --rvm <topic> [--from] [--to] [--limit]`) reads `raw_message` rows of stream `parallax`, decodes them, and prints one JSON line per message: `receivedAt`, `rvm`, and the tree. Run it beside `reprocess` in the same pod. Read-only.

That makes §8.4 step 3 an afternoon's work with the tape, not a reverse-engineering project.

---

## 10. Testing

### 10.1 Unit

- **`packages/rivian`:**
  - the catalogue: unique names, and every mapped entry targets a real `SAMPLE_COLUMNS` key of the right type, checked the same way `catalogue.test.ts` checks Tesla's;
  - the decoders, including type drift, nulls, units and both-or-neither location;
  - charge-state precedence;
  - the gear map;
  - the fragment builder, which uses the special templates for the three structured properties;
  - the protobuf decoder, against hand-encoded bytes;
  - JWE sealing and unsealing, round-trip, plus a refusal under the wrong key.
- **Fixtures** are written by hand from §2's documented shapes and **labelled synthetic** in their file header. The memory on verification says fixtures must come from the real tape, and there's no tape yet. The label is how a later reader knows to replace them on delivery.
- **`apps/rivian`:**
  - the lifecycle state machine against a fake clock, a fake GraphQL server and a fake websocket server (a `ws` server in-process). Coverage: every transition, the backoff schedule, unauthenticated stopping and waiting for a new row, rate limits, silence resubscribing then reconnecting, the drop-unknown-fields retry, frame-queue overflow, and SIGTERM sending `complete`.
  - publishing: envelope shape, topic, QoS 1, `receivedAt` taken when the frame arrives rather than when it's published.
- **`apps/ingest`:**
  - the Tesla profile reproduces today's constants exactly: the same `VOLATILE_FIELDS` set and the same slot lists;
  - `EV_VENDOR` is required and validated;
  - the Rivian topic parser;
  - `receivedAt` comes from the envelope;
  - an end-to-end Rivian pipeline test: synthetic `state` envelopes for a drive (park → drive at speed → park for 6 min) and a charge (connected → charging_active → complete) produce one drive and one charge with the expected summaries;
  - `parallax`/`meta` envelopes are taped and counted unmapped;
  - the segmenter suite is moved to canonical gear values.
- **`apps/web`:** the sign-in actions with a faked Rivian HTTP layer:
  - success without MFA;
  - MFA then a correct code;
  - a wrong code, which keeps the pending entry until it expires;
  - an expired pending entry;
  - the password never appears in logs, errors or the stored row;
  - the stored row decrypts only with the private key;
  - sign-out deletes the row;
  - the page loads with no row, with a status row, and with an unknown state;
  - `env-names.test.ts` is extended for the new variables.

### 10.2 Database

Migrations `008` and `009` are tested against a real Postgres. The suite skips silently without one, so `PG*` must point at a throwaway container. Cases: the `008` rewrite (seed `ShiftStateD`, `ShiftStateSNA` and `D`, then assert `D`, NULL, `D`), its down migration, and the single-row checks on both new tables.

### 10.3 The refactor, against production

Following the memory on verifying against a restored prod copy, the profile refactor is proven against real data, not just fixtures:
1. `pg_dump -Fc` production, read-only, over SSH as documented in the memory on prod access.
2. Restore it twice into podman Postgres: one copy kept pristine, the other the target.
3. Run `reprocess` over the whole tape **twice**: once with the pre-change `main` build, once with the post-change build.
4. Diff `sample`, `session` and `session_point` between the two results.
5. **Expected diff:** `gear` values only (ShiftStateX to X, and null for SNA/Invalid). Any other difference is a regression to fix before merge.

### 10.4 What can't be tested until delivery

Real field shapes, R2 enum values, push cadence, Parallax volume, the actual behaviour of `UNAUTHENTICATED`, and the rate-limit thresholds. The sign-in flow and `getUserInfo` *can* be exercised against the real account before delivery, by the owner, once deployed; that's the first post-deploy check in §11.

---

## 11. Deployment (this repo, and what the GitOps repo needs)

**In this repo:**
- `apps/rivian/Dockerfile`, the same pattern as `apps/ingest/Dockerfile` with numeric UID 10001.
- A fourth `ev-rivian` leg in `images.yml`.
- `scripts/rivian-keygen.mjs`, which prints a P-256 private and public JWK pair.
- README updates: architecture diagram, configuration tables, a Rivian setup section, scope.

**Needed in the GitOps repo** (not done here; no production change without the owner's go-ahead):
1. `EV_VENDOR=tesla` on the existing `ev-ingest` Deployment. **Must land with or before the image that requires it.**
2. An `ev-rivian` Deployment with one replica and `Recreate` strategy (two connectors would hold two sockets on one session), plus the private and public JWKs in a SealedSecret, its own MQTT user, `PG*`, and `EV_VEHICLE_VIN=7PD2EAAB2VN016249`.
3. An `ev-ingest-rivian` Deployment: the ev-ingest image, `EV_VENDOR=rivian`, `MQTT_CLIENT_ID=ev-ingest-rivian`, `MQTT_TOPIC=rivian/#`, `EV_VEHICLE_ID` (for example `r2`), `EV_VEHICLE_VIN`, `EV_VEHICLE_NAME`, `EV_USABLE_CAPACITY_KWH` (owner to supply), and home location as for the Tesla.
4. `RIVIAN_CREDENTIAL_PUBLIC_KEY` on `ev-web`.
5. Mosquitto: a user for `ev-rivian` with publish rights on `rivian/#`, and subscribe rights on `rivian/#` for the ingest user.
6. Alerts: the connector is not `subscribed` for over 15 min while a credential exists; `rivian_frames_dropped_total` increases; the existing stall alert covers `ev-ingest-rivian` through its `vehicle` label.

**First checks after deploy, before delivery:**
1. Sign in at `/settings/rivian`.
2. The status reaches `waiting_for_vehicle` or `subscribed`.
3. A `meta.userInfo` row on the tape shows the R2 by VIN with its build dates.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| Rivian changes or closes the API without notice | Everything is taped raw and versioned. The connector degrades field by field (§5.3) and stops cleanly on auth failure. Smartcar stays the fallback. |
| The account is flagged for automated access | One socket; backoff floors at 30 s; about 48 HTTP calls a day; a secondary driver account; client headers that match the app; no retry on a dead session. |
| R2 values differ from the R1's | Unknown values decode to null and stay on the tape. §8.4 fixes mappings from real data and `reprocess` rewrites history. |
| Parallax volume is large | `RIVIAN_PARALLAX_RVMS` filter; `rivian_frames_total{stream}` shows the rate on day one; monthly partitions and BRIN already bound the tape's cost. |
| Broker down while the car is active | Up to 10,000 frames are queued in memory, and anything past that is counted and alerted. The honest limit of a car that does not buffer. |
| Charge state not refreshed through a long charge (§7.4) | The six-hour carry, then the first post-delivery check, then Parallax charging slots. |
| A standing credential at rest | Sealed to the connector's key. The internet-facing pod can't read it; revocable from the Rivian app. |
| The `EV_VENDOR` requirement breaks the Tesla worker on upgrade | Called out in §11, the README and the release notes. Startup fails loudly rather than mis-decoding. |
