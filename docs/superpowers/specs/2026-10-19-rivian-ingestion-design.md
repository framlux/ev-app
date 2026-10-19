# Rivian ingestion: design

**Date:** 2026-10-19 (revised the same day after adversarial review)
**Vehicle:** Rivian R2, VIN `7PD2EAAB2VN016249` (check digit valid; model year 2027). On the assembly line, not delivered.
**Background:** `docs/research/2026-09-04-tesla-rivian-api-investigation.md`; `specs/2026-09-04-ev-app-design.md` §4.2 (the seam this replaces).
**Status:** approved in conversation on 2026-10-19 (architecture A, web sign-in with a DB-held session). This document is the written form.

---

## 1. Goal

Record everything Rivian will stream about the R2 from the first minute it can, through the same tape, engine and website the Model Y already uses. Rivian keeps no history and charges nothing for what it streams, so the rule is the inverse of the Tesla one: **capture all of it, and decide later what to make of it.**

The car is not delivered, so this work cannot see one real payload. That shapes the scope:

- **Built and verified now:**
  - sign-in, the always-on connection, and finding the car by VIN;
  - every subscription the gateway offers for a vehicle, plus schema discovery so fields we don't know about still reach the tape;
  - the generalised ingest pipeline;
  - normalisation of the fields whose shape the community has documented;
  - the settings page, and the tooling to read what we have not mapped.
- **Done on delivery, from the tape:** confirming every mapping against real R2 payloads, promoting further fields into columns, and mapping Parallax topics. Each is a migration plus `reprocess`, which is the pattern `signals.ts` already prescribes for fields "whose shape we have not observed".

**Success:**
- Once the R2 appears on the Rivian account, the connector finds it without anyone touching anything.
- From delivery day, every message Rivian sends about it is on the tape.
- Drives and charges appear on the site next to the Model Y's. Charge energy and power appear if the `chargingSession` subscription is still live (§2.4).

### 1.1 Out of scope

- **Commands, phone-key enrolment, BLE.** Read-only, the same as the Tesla.
- **New `sample` columns for Rivian-only fields.** Their shapes are unobserved, so they're taped now and promoted after delivery (§8.4).
- **Decoding Parallax into columns.** Its schemas are unpublished, and the only reverse-engineered set is unlicensed (§2.4). It's taped verbatim now, and tooling to read it ships now (§9).
- **Smartcar.** A fallback if the community path closes, not a parallel source.
- **Kubernetes manifests.** They live in the GitOps repo; §11 lists what that repo needs. Nothing here deploys to production.

---

## 2. What Rivian offers, as of 2026-10-19

Verified against `bretterer/rivian-python-client` (last commit 2026-10-14; its gateway schema file dates from 2025-04) and `bretterer/home-assistant-rivian` (Apache-2.0, last commit 2026-10-12). Nothing has been tested against the real account yet.

### 2.1 Endpoints

| Purpose | Endpoint |
|---|---|
| Sign-in, user info, vehicle info | `POST https://rivian.com/api/gql/gateway/graphql` |
| Charging (summaries) | `POST https://rivian.com/api/gql/chrg/user/graphql` |
| Live subscriptions | `wss://api.rivian.com/gql-consumer-subscriptions/graphql`, subprotocol `graphql-transport-ws` |

Every HTTP call carries three headers: `Apollographql-Client-Name: com.rivian.ios.consumer-apollo-ios`, a `dc-cid: m-ios-<uuid>`, and a RivianApp `User-Agent`. Authenticated calls add `A-Sess` (app session) and `U-Sess` (user session). Mutations add `Csrf-Token`.

### 2.2 Sign-in and session lifetime

1. `CreateCSRFToken` returns `csrfToken` and `appSessionToken`.
2. `Login(email, password)` returns one of two things:
   - a `MobileLoginResponse` carrying `accessToken`, `refreshToken` and `userSessionToken`; or
   - a `MobileMFALoginResponse` carrying an `otpToken`, after which Rivian sends the code to the user.
3. `LoginWithOTP(email, otpCode, otpToken)` returns the same `MobileLoginResponse`.

**Lifetime.** The Home Assistant integration runs for months on one sign-in, but it calls `CreateCSRFToken` at **every startup**. Its "expired token, renew" branch is dead code: nothing raises that error. So what we actually know is narrower:
- the user session is long-lived;
- a fresh app session is cheap to get;
- it is **unknown** whether an expired app session shows up as `UNAUTHENTICATED`.

The connector therefore renews the app session at every start, and once more before it gives up on any HTTP `UNAUTHENTICATED` (§5.2). The websocket authenticates with `u-sess` alone, so a close reason of `"Unauthenticated"` means the user session is dead.

### 2.3 The websocket

**Connecting.** The client sends `connection_init` with payload `{client-name, client-version, dc-cid, u-sess}`, and the server answers `connection_ack`.

**Messages.**
- To subscribe, the client sends `{id, type: "subscribe", payload: {operationName, query, variables}}`.
- Data arrives as `{id, type: "next", payload: {data, errors?}}`.
- `complete` ends a subscription and may come from either side. `error` is the server rejecting one.

**Close reasons.** The server closes with reason `"Rate limited"` or `"Unauthenticated"`. The reference client backs off 30 s × 2ⁿ plus up to 30 s of jitter, capped at 900 s, and resets the count once data flows. Its latest commit (2026-10-14) fixed a reconnect storm caused by ignoring the rate limit.

**Silence.** With nothing received for 60 s on an acknowledged socket, the reference client resubscribes on the same socket. It does **not** reconnect on silence. Parked cars are silent for hours, so this is what thousands of Home Assistant installs do all day.

**Initial snapshot.** Home Assistant waits up to 60 s after subscribing for a first full push, observed about 27 s in. So a subscribe probably **re-sends current values that may be hours old.** Each property carries its own `timeStamp`, and that's what makes an old value recognisable (§6.4).

**Subscriptions** in the gateway schema (2025-04; liveness unverified for any but `vehicleState` and `parallaxMessages`):

| Subscription | Carries |
|---|---|
| `vehicleState(id)` | The properties the caller names. Most are `{ timeStamp value }`. `gnssLocation` is `{ latitude longitude timeStamp isAuthorized }`, `cloudConnection` is `{ lastSync isOnline }`, and `gnssError` is `{ timeStamp positionVertical positionHorizontal speed bearing }`. Properties that didn't change arrive as `null`. About 140 are known for the R1. |
| `parallaxMessages(vehicleId, rvms)` | `{ payload timestamp rvm }`: a base64 protobuf for topic `rvm`. A null `rvms` means all topics. |
| `chargingSession(vehicleId)` | `liveData { powerKW kilometersChargedPerHour rangeAddedThisSession totalChargedEnergy timeElapsed timeRemaining price currency isFreeSession vehicleChargerState startTime }` and `chartData [{ soc powerKW startTime endTime timeEstimationValidityStatus vehicleChargerState }]` |
| `vehicleCloudConnection(id)` | `{ lastSync isOnline }` |
| `otaInstallState(vehicleId)`, `otaInstallSchedules(vehicleId)`, `vehicleGeofences(vehicleId)` | `ParallaxMessageResponse { payload sequenceNumber }`: a base64 protobuf with no topic field |
| `vehicleDepartureSchedules(vehicleId)` | A list of schedules |

**Schema drift.** Rivian rejects a selection containing an unknown field with `GRAPHQL_VALIDATION_FAILED` errors that **do not name the offending field** (upstream PR #214, 2026-10-10). Upstream found the cause by bisecting by hand. Two fields changed in that same week.

### 2.4 Things that bear directly on the design

- **The live charging-session query is gone.** On 2026-10-11 Rivian removed `getLiveSessionData`. `vehicleState` carries no charging power or energy. The `chargingSession` *subscription* (above) carries both if it still validates. If it doesn't, charge energy is unknown (§7.4).
- **`getCompletedSessionSummaries`** on the charging endpoint still works. It's cheap ground truth, so we tape it.
- **`getUserInfo`** returns `vehicles { id vin name state roles createdAt updatedAt vehicle { modelYear make model expectedBuildDate plannedBuildDate expectedGeneralAssemblyStartDate actualGeneralAssemblyDate … } }`. Whether an undelivered car is listed there is **unverified**: the research note says Roamer tracks deliveries through the order endpoints. The connector handles both cases (§5.2).
- **Licensing.** `rivian-python-client` has no licence, so its code, `.proto` files and schema files cannot be copied. The Home Assistant integration is Apache-2.0. Everything here is written from facts: endpoint names, field names, units and the protocol. That's also why Parallax is taped raw.
- **Leaks.** Upstream PR #220 removed request headers and bodies from exception text. Error handling here never carries a token or a body (§4.4).

### 2.5 Units and vocabularies (from the Apache-2.0 integration; R1-derived)

| Property | Unit / values |
|---|---|
| `batteryLevel`, `batteryLimit` | % |
| `batteryCapacity` | kWh |
| `distanceToEmpty` | km |
| `vehicleMileage` | **metres** |
| `gnssSpeed` | **m/s**, from GPS |
| `cabinClimateInteriorTemperature` | °C |
| `tirePressure{FrontLeft,FrontRight,RearLeft,RearRight}` | bar; value may be null |
| `timeToEndOfCharge` | minutes |
| `gearStatus` | `park`, `drive`, `neutral`, `reverse` |
| `powerState` | `sleep`, `standby`, `ready`, `go`, `vehicle_reset` |
| `chargerStatus` | `chrgr_sts_not_connected`, plus `chrgr_sts_connected_*` |
| `chargerState` | `charging_active`, `charging_connecting`, `charging_complete`, … |
| `doorFrontLeftClosed` …, `closure*Closed` | `open` / `closed` |
| `doorFrontLeftLocked` …, `closure*Locked` | `locked` / `unlocked` |
| any property | `fault`, `signal_not_available` and `undefined` are placeholders, not values |
| `chargingSession.liveData.powerKW` | kW |
| `chargingSession.liveData.totalChargedEnergy` | assumed kWh, this session; **unverified** |

The R2 is a different platform. Every value here is a hypothesis until the tape confirms it (§8.4).

---

## 3. Architecture

```
 Rivian cloud ──wss: vehicleState (grouped) · parallaxMessages · chargingSession ·
            │        vehicleCloudConnection · otaInstallState · otaInstallSchedules ·
            │        vehicleGeofences · vehicleDepartureSchedules ───────────────────┐
            └──https: getUserInfo, getVehicle, getCompletedSessionSummaries,         │
                      VehicleState introspection (all slow, §5.6) ────────────────┐  │
                                                                                  ▼  ▼
 ev-rivian (new: apps/rivian)   session from rivian_credential · finds the car by VIN
     │                          one socket · stamps receivedAt · publishes verbatim
     │  MQTT QoS 1   rivian/<VIN>/<stream>
     ▼
 Mosquitto (existing)           durable queue: the buffer the car does not have
     ▼
 ev-ingest-rivian               the existing ev-ingest image, second Deployment,
     │                          EV_VENDOR=rivian, its own client id, topic and cursor
     ▼
 Postgres ──── ev-web           /settings/rivian sign-in; the R2 in the garage
```

**Why the connector is separate (approach A).** Nothing on the Rivian side buffers, so the process holding the socket must restart least. The connector holds no engine logic and decodes nothing. Engine fixes redeploy only `ev-ingest-rivian`, and the broker holds the R2's messages across the deploy exactly as it holds the Tesla's. The tape, `reprocess`, `Pipeline.resume`, metrics and the stall alert then work for the R2 unchanged.

**Why `rivian/` and not `ev/`.** The Tesla worker subscribes to `ev/#`. Rivian messages under `ev/` would inflate its `topic` parse-failure counter, which is the signal for "fleet-telemetry changed its layout". A separate root keeps each worker blind to the other.

**Why the connector stamps the time.** fleet-telemetry publishes no timestamp, so the Tesla worker stamps arrival. After one outage that put six days of backlog at drain time and needed a forensic re-timing. The connector stamps `receivedAt` when the frame arrives, and ingest uses it. Values inside a frame also carry Rivian's own per-property `timeStamp`, which governs staleness (§6.4).

---

## 4. Credentials

### 4.1 A deliberate departure from the Tesla design

`tesla-session.ts` refuses to store a standing credential anywhere, because the Tesla streams by itself and a token is needed only for a config push. The Rivian can't work that way: nothing arrives unless a session is held open around the clock. A standing credential is unavoidable, so the design controls **who can read it**.

### 4.2 Sealed to the connector

**Keys.** A P-256 keypair is generated once by `scripts/rivian-keygen.mjs`. The connector gets the private JWK (`RIVIAN_CREDENTIAL_PRIVATE_KEY`). The web gets only the public JWK (`RIVIAN_CREDENTIAL_PUBLIC_KEY`).

**Sealing.** After a successful sign-in, the web seals `{userSessionToken}` and nothing else as a compact JWE (`ECDH-ES+A256KW`, `A256GCM`, using `jose`, which the web already depends on). It upserts that into `rivian_credential`, setting `updated_at = now()` **explicitly**, since the column default applies only on insert. Then it forgets the plaintext. `accessToken` and `refreshToken` are discarded: nothing uses them, and storing them only widens exposure.

**Who can read what.**
- The web pod can write the stored credential but can never read it back.
- A database dump without the connector's key yields nothing.
- A compromised web pod would still see the *next* sign-in in plaintext, because it performs the sign-in. That's the residual risk, and revoking the session from the Rivian app is the remedy.

**Reading.** The connector decrypts with its private key. A row that won't decrypt (wrong key, rotated SealedSecret, corrupt value) puts it in state `credential_invalid` (§5.2). It never crashes into a restart loop.

```sql
CREATE TABLE rivian_credential (
  id          SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- one account, one row
  sealed      TEXT        NOT NULL,                            -- compact JWE
  account     TEXT        NOT NULL,                            -- email, shown on the page only
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 4.3 The sign-in flow (`/settings/rivian`)

1. **Email and password.** `POST /api/v1/rivian/login` calls `CreateCSRFToken`, then `Login`.
   - **Tokens come back:** seal and store them, then done.
   - **An `otpToken` comes back:** keep `{email, csrfToken, appSessionToken, otpToken}` in a module-level map keyed by OIDC subject, for at most 10 minutes. This mirrors `tesla-session.ts`: one replica, one operator, and losing it costs a retry. Expiry is enforced on read and swept on write. The page then asks for the code.
2. **One-time code.** `POST /api/v1/rivian/otp` calls `LoginWithOTP`, seals and stores the result, and deletes the pending entry. A wrong code keeps the entry, so the user can retry until it expires.
3. **Sign out.** `POST /api/v1/rivian/logout` deletes the row. The connector notices within its poll interval (§5.2) and closes the socket.

All three routes call `requireUser`, as the telemetry routes do. The password is never stored, logged or echoed. It lives in one request's memory.

**Account advice on the page:** "Use the owner account until the car is delivered. Whether a secondary-driver account can see an undelivered car is unknown. After delivery, a secondary-driver account can be revoked from the Rivian app without changing the owner's password."

### 4.4 Errors never carry secrets

Every Rivian HTTP or websocket error is reduced to `{httpStatus, codes: errors[].extensions.{code,reason}}` before it's logged, thrown, written to `rivian_status.last_error`, or returned to the browser. No request header, request body, response body, or token goes anywhere. A redaction test in both `packages/rivian` and `apps/web` asserts that no token, password or OTP value appears in any log line, error message or stored row.

The user sees one of these messages:
- wrong email or password
- wrong or expired code
- account temporarily locked
- Rivian is rate-limiting, try later
- Rivian error `<code>`

---

## 5. The connector (`apps/rivian`, image `ev-rivian`)

### 5.1 Configuration

| Variable | Required | Notes |
|---|---|---|
| `EV_VEHICLE_VIN` | yes | The car to find. Never guessed: an account can hold several. |
| `RIVIAN_CREDENTIAL_PRIVATE_KEY` | yes | Private JWK (JSON). Validated at startup. |
| `MQTT_URL` | no | Same default as ingest. |
| `MQTT_USERNAME` | no | Default `rivian`. |
| `MQTT_PASSWORD` | yes | |
| `MQTT_CLIENT_ID` | no | Default `ev-rivian`. Startup refuses `ev-fleet-telemetry`, `ev-ingest` and `ev-ingest-rivian`. |
| `RIVIAN_PARALLAX_RVMS` | no | Comma-separated topic filter; unset means all. An escape hatch if Parallax turns out too chatty. |
| `PG*` | yes | Reads the credential, writes status. |
| `METRICS_PORT` | no | Default 9090. |

### 5.2 Lifecycle

```
            ┌──────── row deleted (successful query, zero rows) ◀──────────────┐
            ▼                                                                   │
  signed_out ──row appears──▶ starting ──CSRF ok──▶ finding_vehicle            │
                               │ decrypt fails            │ VIN absent: hourly  │
                               ▼                          ▼                     │
                     credential_invalid        waiting_for_vehicle              │
                                                          │ VIN found           │
                                                          ▼                     │
   unauthenticated ◀── ws close "Unauthenticated" ── connecting ──ack──▶ subscribed
   (waits for a NEW row)   or HTTP UNAUTHENTICATED twice      ▲           │ close/err
                                                              └─backing_off◀┘
```

**Postgres is never on the socket's critical path.**
- The credential poll runs every 15 s. Only a **successful** query returning zero rows means `signed_out`.
- A failed poll query is logged and counted, and changes nothing: the socket stays up.
- A changed `updated_at` restarts the loop from `starting` with the new credential.

**Starting.** Decrypt the credential, then call `CreateCSRFToken`. The app session is renewed at every start (§2.2).

**Finding the vehicle.**
- `getUserInfo` runs at start, then hourly while the VIN is absent. The response is published as `meta` (§5.6), so the build dates are taped as they move.
- Matching is by VIN, and yields Rivian's vehicle `id`.
- If the car is listed before delivery, the connector subscribes anyway. A subscription to a car that never reports costs one resubscribe a minute, exactly what the reference client does for every parked car (§2.3).

**HTTP `UNAUTHENTICATED`.** Call `CreateCSRFToken` once and retry. A second `UNAUTHENTICATED` means `unauthenticated`.

**Websocket close `"Unauthenticated"`** means `unauthenticated` straight away. In both cases the connector stops and waits until `updated_at` changes. It never retries a dead session: retrying one is how accounts get flagged.

**Websocket close `"Rate limited"`, no ack within 15 s, or any other close or error** means `backing_off`: 30 s × 2ⁿ plus 0–30 s of jitter, capped at 900 s. The count resets once a `next` arrives. The 30 s floor means no failure mode reconnects faster than twice a minute. Only shutdown cuts a backoff short.

**Silence.** With 60 s of nothing on an acknowledged socket, every active subscription is resubscribed. The connector sends `complete` for the old id, then `subscribe` under a **fresh** id: `graphql-transport-ws` forbids reusing a live id. It never reconnects on silence alone.

**A server `complete` or `error` for one subscription** resubscribes that subscription after 30 s, under a fresh id. A `GRAPHQL_VALIDATION_FAILED` error goes to §5.4 instead.

**SIGTERM.**
1. Stop reading the socket.
2. Drain the publish queue for up to 5 s.
3. Send `complete` for every subscription.
4. Close the socket and end MQTT cleanly.
5. Exit.

Frames still queued after 5 s are counted as dropped.

### 5.3 Subscriptions

They share one socket, opened once the vehicle is found:

| Stream | Subscription |
|---|---|
| `state` | `vehicleState(id)`, split into groups of at most 16 properties (§5.4) |
| `parallax` | `parallaxMessages(vehicleId, rvms: RIVIAN_PARALLAX_RVMS or null)` |
| `charging` | `chargingSession(vehicleId)`, every `liveData` and `chartData` field in §2.3 |
| `cloud` | `vehicleCloudConnection(id)` |
| `ota` | `otaInstallState(vehicleId)` and `otaInstallSchedules(vehicleId)` |
| `geofence` | `vehicleGeofences(vehicleId)` |
| `departure` | `vehicleDepartureSchedules(vehicleId)` with the full selection |

The `vehicleState` property list starts from `packages/rivian/src/catalogue.ts` and is widened by discovery (§5.6).

### 5.4 Schema drift: groups and bisection

Rivian's validation errors don't name fields (§2.3), so the connector finds the bad field itself:

- **Groups.** `vehicleState` is subscribed in groups of at most 16 properties, so a rejected field silences at most 15 others, and only until the bisection below finds it. Every non-`vehicleState` subscription is its own group.
- **Bisection.** When a group is rejected with `GRAPHQL_VALIDATION_FAILED`, it's split in half and each half subscribed 30 s later. A single property that is rejected alone is **dropped**. 16 properties settle in at most 8 probes, a few minutes. Healthy halves keep flowing during the search.
- **A rejected subscription other than `vehicleState`**, with no properties to bisect, is marked unavailable and retried once a day.
- **Persistence.** The dropped list is written to `rivian_status.dropped_properties` and published as `meta.droppedProperties`, so a restart doesn't repeat the search and the tape records what's missing.
- **Retry.** Dropped properties are re-probed once a day, alone, in case a field comes back for the R2.

### 5.5 Publishing

Every `next` frame is published, at QoS 1 and not retained, under topic `rivian/<VIN>/<stream>`. The body is a versioned envelope:

```jsonc
{
  "v": 1,
  "stream": "state" | "parallax" | "charging" | "cloud" | "ota" | "geofence" | "departure" | "meta",
  "vin": "7PD2EAAB2VN016249",
  "receivedAt": "2026-10-19T17:03:11.482Z",   // connector clock, when the frame arrived
  "body": { ... }   // subscription streams: the frame's WHOLE payload ({data, errors?}), verbatim
                    // meta: { kind, data }
}
```

**Strings are cleaned before publishing.** `\u0000` is removed, and unpaired UTF-16 surrogates are replaced with U+FFFD. Postgres JSONB rejects both, and a rejected `insertRaw` would roll back, never ack, and be redelivered forever. Ingest applies the same clean before taping (§6.2), so neither side can wedge the other.

**The publish queue.**
- It sits between the socket reader and MQTT. The reader never waits on the broker or the database: a slow consumer is something Rivian closes.
- It's bounded at **32 MiB** of serialised envelopes. Past that, the oldest frames are dropped and counted in `rivian_frames_dropped_total`.
- Because unchanged properties arrive as null, a dropped `state` frame can lose a change permanently. **After any drop, every subscription is resubscribed**, which re-sends a current snapshot. The tape keeps the per-property timestamps, so the snapshot is recognised for what it is (§6.4).

**The honest limit.** A broker outage longer than 32 MiB of frames costs data. The car doesn't buffer, and a Rivian close would cost more. Production alerts on drops.

### 5.6 Slow HTTP, all published as `meta`

| `meta.kind` | Source | Cadence |
|---|---|---|
| `userInfo` | `getUserInfo` (§2.4 selection) | at start; hourly while the VIN is absent; then every 6 h |
| `vehicle` | `getVehicle(id)` with `mobileConfiguration` (trim, drive system, pack) | at start once found; every 24 h |
| `chargingSummaries` | `getCompletedSessionSummaries(vehicleId)` | every 6 h once found |
| `schema` | introspection: `__type(name: "VehicleState") { fields { name type { name kind ofType { name } } } }` | every 24 h |
| `connection` | lifecycle transitions `{state, reason}` | on change |
| `droppedProperties` | §5.4 | on change |

**Change-only.** Each kind is published only when its JSON differs from the last one published (compared by SHA-256), except `connection`, which is always published. That keeps the tape free of hourly duplicates.

**Discovery.** If the introspection answers, any `VehicleState` field missing from the catalogue whose type name starts with `TimeStamped` is added to the selection, with the `{ timeStamp value }` template. Other unknown fields are listed in the `meta.schema` record and not selected; their shape is unknown. If introspection is refused, it's tried again in 24 h and nothing else changes. This is how an R2-only property reaches the tape at all: `vehicleState` returns only the fields you name.

**Volume.** At most about 31 HTTP calls a day once things settle. That mirrors Roamer's stated self-limiting.

### 5.7 Status and metrics

```sql
CREATE TABLE rivian_status (
  id                 SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  state              TEXT NOT NULL,            -- §5.2 state names
  vin                TEXT,
  rivian_vehicle_id  TEXT,
  last_frame_at      TIMESTAMPTZ,
  last_error         TEXT,                     -- §4.4 redacted form only
  backoff_until      TIMESTAMPTZ,
  dropped_properties TEXT[] NOT NULL DEFAULT '{}',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Written only by the connector, asynchronously and best-effort: a failed write is logged and retried with the next change. `last_frame_at` is written at most once a minute.

Metrics:
- `rivian_connector_state{state}`, a one-hot gauge
- `rivian_frames_total{stream}`
- `rivian_frames_dropped_total`
- `rivian_publish_failures_total`
- `rivian_reconnects_total{reason}`
- `rivian_dropped_properties`
- `rivian_credential_poll_failures_total`
- `rivian_last_frame_timestamp_seconds`

All are initialised at startup.

---

## 6. Ingest, generalised

### 6.1 The vendor profile replaces `VehicleAdapter`

`packages/core/src/adapter.ts` describes a vendor as `start/stop/normalise(raw) → VehicleSample[]`. The real pipeline proved that shape wrong: a message is a fragment, and the accumulator, the staleness classes and the charge inference are where the vendor knowledge lives. Today those are hard-coded against `TeslaFieldState` in `pipeline.ts`, which imports `@ev/tesla` directly. They move behind one interface:

```ts
// apps/ingest/src/profile.ts
export interface Decoded {
  /** Slot -> value. An explicit null is stored ("the car says unknown"); an absent key changes nothing. */
  slots: Record<string, unknown>
  /** Slot -> when the vehicle observed it, epoch ms. Absent: the message's receivedAt. */
  observedAt?: Record<string, number>
}

export interface VendorProfile {
  readonly vendor: Vendor
  /** One taped message -> what it contributes, or null. Pure. Must return null for another vendor's message. */
  decode(raw: RawMessage): Decoded | null
  /** Accumulated slots -> the canonical sample. Pure; absent slots -> null. */
  toSample(vehicleId: string, ts: Date, state: Record<string, unknown>): VehicleSample
  staleWindowFor(slot: string): number
  readonly chargeStateSlots: readonly string[]
  readonly chargingPowerSlots: readonly string[]
  readonly chargingEnergySlots: readonly string[]
}
```

**Timing constants** (`QUIET_PERIOD_MS`, `MAX_SAMPLE_INTERVAL_MS`, `VOLATILE_STALE_MS`, `STALE_VALUE_MS`) move to `apps/ingest/src/timing.ts`. `pipeline.ts` re-exports them so existing imports keep working. Profiles import `timing.ts`, never `pipeline.ts`. That avoids widening the existing `pipeline.ts` ↔ `deps.ts` cycle, which is a top-level import today, despite `pipeline.ts`'s comment calling it lazy.

**The accumulator.** `FieldAccumulator` takes the profile in its constructor. `apply(decoded, at)` stamps each slot with `decoded.observedAt?.[slot] ?? at` and uses the profile's slot lists for the charge refresh. `take()` measures staleness from each slot's own stamp. `Pipeline` takes a profile, passes it to every accumulator it creates, and calls `profile.toSample` in `emit`.

**`apps/ingest/src/profiles/tesla.ts`** is built from exactly today's constants and functions:
- `VOLATILE_FIELDS` and its derivation, `CARRIED_DRIVE_FIELDS`, `ALWAYS_VOLATILE` and the three charge lists, all keeping their `satisfies keyof TeslaFieldState` checks;
- `decodeIfKnown`'s Tesla branch;
- `teslaStateToSample`.

The Tesla decoder supplies no `observedAt`, so every slot is stamped with arrival time exactly as today. **The refactor is behaviour-neutral for the Tesla.** The existing suite proves it unchanged, plus a replay against a restored production copy (§10.3).

**Registry.** `deps.ts` becomes `profileFor(vendor)`. After this change, `deps.ts` and the two profile files are the only places in `apps/ingest` that import a vendor package. A test greps for that.

**`VehicleAdapter`** is deleted from `@ev/core`. Nothing imports it.

**Serialised work.** `Pipeline` runs `handle` and `flush` one at a time behind a promise-chain lock. Today the flush timer can run in the middle of a `handle`, and a rollback in one restores a snapshot over the other's committed state. That's a latent bug for the Tesla too, and it becomes likely once Rivian backlogs drain. `resume` replays through `handle`/`flush`, which take the lock per call, and its `reconcile` runs after the replay, so nothing nests.

### 6.2 One image, a vendor per Deployment

**`EV_VENDOR` is required** (`tesla` or `rivian`). A default would let a misconfigured worker decode one vendor's payloads as the other's and tape them under the wrong vendor. That would be silent and permanent.

**Defaults derive from the vendor.** A worker can't land on the other vendor's broker session:

| | `tesla` | `rivian` |
|---|---|---|
| `MQTT_CLIENT_ID` default | `ev-ingest` | `ev-ingest-rivian` |
| `MQTT_TOPIC` default | `ev/#` | `rivian/#` |
| `EV_CURSOR_SOURCE` default | `tesla:mqtt` | `rivian:mqtt` |

Startup refuses:
- a client id belonging to the other vendor, the receiver (`ev-fleet-telemetry`) or the connector (`ev-rivian`);
- a topic that doesn't start with the vendor's own root.

A Rivian worker that took over `ev-ingest`'s durable session would ack the Tesla backlog as parse failures, and the car would already have discarded it.

The vendor also selects the profile, the topic parser, `registerVehicle`'s `vendor` and the metrics `vendor` label.

**The Rivian topic parser** accepts `rivian/<VIN>/<stream>` for any stream name. It drops and acks only what can never be replayed: a topic that doesn't match that shape, a VIN that isn't ours, an empty body, or a body that isn't JSON. **Every body that parses as JSON is taped.** That includes an unknown envelope version or a missing field, which is counted under `envelope` and left for `decode` to return null. A connector deployed ahead of its reader then loses nothing.

**`receivedAt`** comes from the envelope. If it's missing or unparseable, local arrival time is used and the message is counted under `envelope`. Taping at a slightly wrong time beats not taping.

**Cleaning.** The parser cleans `\u0000` and unpaired surrogates exactly as the connector does (§5.5), before the message reaches the pipeline.

**Tape.** `raw_message.source` is `graphql_ws`, and the payload is the whole envelope.

**Metrics.** The `RecordKind` label is per vendor. For Rivian it's the stream name. `messagesTotal` series are initialised for the known streams.

**`reprocess`** passes `config.vehicle.id` to `streamRaw`. Today it replays every vehicle's tape (`reprocess.ts:105`), which is harmless only by accident. Its comment at lines 88–92 is updated. It builds its `Pipeline` with `profileFor(config.vendor)`.

**The flush clock.** For Tesla, `receivedAt` is local arrival time, so the timer's `new Date()` is the right clock. For Rivian it's the connector's clock, and a draining backlog would make every pending burst look overdue. So `main.ts` keeps `skewMs = Date.now() - raw.receivedAt` from the last message handled, and the timer calls `flush(new Date(Date.now() - skewMs))`. For Tesla `skewMs` is about 0, so behaviour is unchanged. Shutdown's `flush(…, true)` is unaffected.

### 6.3 What doesn't change

`Store`, the transaction and ack discipline, `resume`, pricing, battery health, the segmenter's session rules, and `wentNowhere`. They operate on `VehicleSample`, and none of them names a vendor once §7.5 is done.

### 6.4 Old values look old

A subscribe re-sends current values, which may be hours old (§2.3). Stamped with `receivedAt`, a parked car's last non-zero speed would hold a drive open for good, and a `charging_active` from before the car went offline would hold a charge open for days. So:

- **The Rivian decoder sets `observedAt[slot]`** from the property's own `timeStamp`, clamped to at most `receivedAt`. A clock ahead of ours must not make a value look fresher than its frame.
- **Too old to apply.** A property whose `timeStamp` is older than `receivedAt - staleWindowFor(slot)` contributes nothing. It would expire at the next emit anyway, and applying it would briefly resurrect it.
- **Unparseable timestamps.** A missing or unparseable `timeStamp` falls back to `receivedAt` and is counted in `ev_ingest_untimed_values_total`. That's an ingest metric, fed by `Decoded.untimed` through `PipelineResult.untimed`.
- **`chargingSession`** has no per-field timestamps. Its values take `receivedAt`. It pushes only during a session, and its power slot is volatile (§7.6).
- **Emit timing still uses `receivedAt`**: the debounce is about frames, not observations. Only the carry uses `observedAt`.

---

## 7. Rivian normalisation (`packages/rivian/src/normalise.ts`)

### 7.1 Decode

`decode(raw)` reads the envelope by stream:

**`state`.** For each property in `body.data.vehicleState`:
- **Absent, or the property object is `null`:** nothing (unchanged, per §2.3).
- **Present in the catalogue:**
  - A `value` of `null`, or one of the placeholders `fault`, `signal_not_available` or `undefined`: nothing, so the previous value carries. The one exception is `gearStatus`, where a placeholder is an explicit null gear (§7.5), so a carried `D` can't hold a drive open.
  - A value the decoder can't vouch for: nothing.
  - Otherwise, slots plus `observedAt` (§6.4).
  - Numbers accept numeric strings and refuse `''`, NaN and Infinity, as Tesla's decoder does.
- **Not in the catalogue:** ignored, but it stays on the tape.

**`charging`.** From `body.data.chargingSession.liveData`:
- `powerKW` → `chargePowerKw`
- `totalChargedEnergy` → `chargeEnergyAddedKwh`
- `vehicleChargerState` → the `chargerState` slot, using §7.3's vocabulary

`chartData` stays on the tape only.

**`cloud`.** `body.data.vehicleCloudConnection.isOnline` → the `cloudOnline` slot.

**Any other stream, an unknown `v`, or a malformed body:** `null`, counted as unmapped.

### 7.2 Slots and columns

Each slot is named for the column it fills. The exceptions are the inputs combined in `toSample` (marked †).

| Rivian property | Slot → column | Conversion |
|---|---|---|
| `batteryLevel` | `socPct` → `soc_pct` | as is |
| `distanceToEmpty` | `rangeKm` → `range_km` | as is (km) |
| `vehicleMileage` | `odometerKm` → `odometer_km` | m ÷ 1000 |
| `gnssLocation` | `lat`, `lon` | both or neither |
| `gnssSpeed` | `speedKph` → `speed_kph` | m/s × 3.6; 0 to below 0.5 m/s → 0 (GPS noise floor); negative → nothing |
| `gnssBearing` | `gpsHeading` → `gps_heading` | as is |
| `powerState` | `powerStateRaw` † | §7.3 |
| `cloudConnection.isOnline`, `vehicleCloudConnection.isOnline` | `cloudOnline` † | §7.3 |
| `chargerState`, `chargerStatus` | `chargerState` †, `chargerStatus` † | §7.3 |
| `cabinClimateInteriorTemperature` | `insideTempC` → `inside_temp_c` | as is |
| `doorFrontLeftLocked`, `doorFrontRightLocked`, `doorRearLeftLocked`, `doorRearRightLocked`, `closure{Frunk,Liftgate,Tailgate,Tonneau,SideBinLeft,SideBinRight}Locked` | one slot each † → `locked` | `true` only if every reported lock is `locked`; any `unlocked` → `false`; none → null |
| the same set with `Closed` | one slot each † → `doors_open` | any `open` → `true`; all `closed` → `false`; none → null |
| `tirePressureFrontLeft/FrontRight/RearLeft/RearRight` | `tpmsFl/Fr/Rl/Rr` † → `tpms` | bar, `{fl,fr,rl,rr}`, the same JSONB shape as Tesla |
| `gearStatus` | `gear` | §7.5 |
| `batteryLimit` | `chargeLimitSoc` → `charge_limit_soc` | as is |
| `batteryCapacity` | `nominalFullPackEnergyKwh` → `nominal_full_pack_energy_kwh` | as is; feeds the existing daily measured-capacity row |
| `timeToEndOfCharge` | `timeToFullChargeHours` → `time_to_full_charge_hours` | min ÷ 60 |
| `otaCurrentVersion` | `version` → `version` | as is |
| `chargingSession.liveData.powerKW` | `chargePowerKw` → `charge_power_kw` | as is |
| `chargingSession.liveData.totalChargedEnergy` | `chargeEnergyAddedKwh` → `charge_energy_added_kwh` | as is (assumed kWh) |

Every column named here exists in `signals.ts` today; the implementation's catalogue test asserts it. Windows and every other property are tape-only in v1. Tesla's window columns hold Tesla's own vocabulary, and mixing Rivian's into them would break the rule that a TEXT enum column holds one vendor's words.

### 7.3 Power state and charge state, in `toSample`

**`power_state`:**
- `cloudOnline === false` → `offline`. This wins: an offline car's last power state is stale.
- Otherwise `sleep` → `asleep`, and `standby`, `ready`, `go` or `vehicle_reset` → `online`.
- Otherwise null.

**`charge_state`**, from the slots `chargerStatus` and `chargerState`:

| Evidence | `charge_state` |
|---|---|
| `chargerStatus = chrgr_sts_not_connected` | `disconnected` (wins) |
| `chargerState = charging_active` | `charging` |
| `chargerState = charging_complete` | `complete` |
| any other or absent `chargerState`, and `chargerStatus` starting `chrgr_sts_connected` | `connected` |
| anything else | null; the raw value is on the tape |

`charging_connecting` is **not** `charging`. No energy flows yet, and a session opened on a handshake starts before the energy does.

### 7.4 The charge profile

- `chargeStateSlots = ['chargerState', 'chargerStatus']`
- `chargingPowerSlots = ['chargePowerKw']`
- `chargingEnergySlots = ['chargeEnergyAddedKwh']`

With `chargingSession` live, a long steady charge keeps its state refreshed by positive power or a rising energy counter, as Tesla's does. Its energy is measured, so pricing and battery health work unchanged.

If `chargingSession` is rejected (§5.4), the power and energy slots are never filled:
- charge energy is null;
- cost follows today's rules (`basis 'home'` with a null cost at home, `'unknown'` elsewhere);
- no battery-health estimate is written;
- the six-hour carry is the only guard on charge state.

Deriving energy from SoC × capacity was rejected: it makes `estimateCapacity` circular, and that circularity would rescale every drive figure.

### 7.5 Canonical gear

`segmenter.ts` compares `sample.gear` against Tesla's raw strings (`'ShiftStateP'` at line 200; D, R and N at 212). That's the one place a vendor's vocabulary leaked into `@ev/core`. The fix is the one already used for power and charge state: the engine reads a canonical value, and each normaliser produces it.

- **`@ev/core`.**
  - Gains `type Gear = 'P' | 'R' | 'N' | 'D'`.
  - `'Gear'` joins the `TsType` union in `signals.ts` and `TS_TYPES_FOR_SQL['TEXT']`.
  - `Gear: Gear` joins `TsTypeMap` in `model.ts`.
  - The `gear` catalogue entry becomes `ts: 'Gear'`.
  - The segmenter compares against `'P'` and `{'D','R','N'}`.
- **Tesla.**
  - `ShiftStateP|R|N|D` map to `P|R|N|D`.
  - Null still decodes to `P` (commit 71aa244).
  - Any other string (`ShiftStateSNA`, `ShiftStateInvalid`, …) decodes to an **explicit `{gear: null}`**. Today such a string *overwrites* an earlier `D`. A plain null return from `one()` would instead carry the `D`, which holds drives open, the bug 71aa244 fixed.
  - A non-string still decodes to nothing.
  - The tape keeps the original strings.
- **Rivian.**
  - `park|reverse|neutral|drive` (case-insensitive) map to `P|R|N|D`. Anything else is an explicit null.
  - `powerState` of `sleep` or `standby` also sets `gear: 'P'`. A car that powers down without reporting P would otherwise carry D, the same reasoning as Tesla's null gear.
  - In `toSample`, a sample whose gear is `P` reports `speedKph = 0` whenever speed is known: GPS speed on a car in Park is noise. Together with §7.2's noise floor, this keeps GPS jitter from opening phantom drives or splitting a charge.
- **Migration `008_canonical_gear.sql`:**
  ```sql
  UPDATE sample SET gear = CASE gear
      WHEN 'ShiftStateP' THEN 'P' WHEN 'ShiftStateR' THEN 'R'
      WHEN 'ShiftStateN' THEN 'N' WHEN 'ShiftStateD' THEN 'D' END
  WHERE gear LIKE 'ShiftState%';
  ```
  - `ShiftStateSNA` and anything else unmatched become NULL. That's exactly what a reprocess would now produce.
  - The down migration maps `P/R/N/D` back to `ShiftState*` **only for vehicles whose `vendor = 'tesla'`**. It's lossy for SNA, and the file says so.
  - Rollout order is in §11. The old worker must not write after the migration runs.
- **Web.** The vehicle page shows `gear` through `formatText`, and `teslaEnumLabel` already passes unknown values through untouched, so `P`/`D` render as is. `ShiftState` stays in `TESLA_ENUM_PREFIXES`; it's harmless.

### 7.6 Staleness

- `staleWindowFor` returns `VOLATILE_STALE_MS` for `speedKph`, `gpsHeading` and `chargePowerKw`, and `STALE_VALUE_MS` for everything else. That includes `lat`/`lon` and `gear`, for the reasons `CARRIED_DRIVE_FIELDS` gives.
- The volatile list is typed `satisfies readonly (keyof RivianFieldState)[]`, so a misspelling fails to compile.
- Staleness is measured from `observedAt` (§6.4).

### 7.7 Accumulation timing

`QUIET_PERIOD_MS` (2 s) was chosen for fleet-telemetry's bursts. A `vehicleState` push is a *delta* (unchanged properties null), and the accumulator is exactly the thing that turns deltas into a whole sample, so the same machinery applies. Back-to-back pushes within 2 s merge into one sample. Pushes further apart produce one sample each. The profile doesn't override timing in v1.

---

## 8. Data model changes

### 8.1 Migrations

- `008_canonical_gear.sql`: §7.5.
- `009_rivian.sql`: `rivian_credential` (§4.2) and `rivian_status` (§5.7).

No enum changes: `001_initial.sql` already declares `vendor AS ENUM ('tesla', 'rivian')` and `raw_source AS ENUM ('telemetry', 'fleet_api', 'graphql_ws')`.

### 8.2 The vehicle row

`ev-ingest-rivian` registers `{vendor: 'rivian', id: EV_VEHICLE_ID, vendorVehicleId: EV_VEHICLE_VIN, displayName}` at startup, as the Tesla worker does. `registerVehicle` takes the vendor from config instead of hard-coding `'tesla'`. Rivian's own vehicle `id` is on the tape in `meta.userInfo`.

### 8.3 Capacity

`EV_USABLE_CAPACITY_KWH` stays required; it scales drive energy from SoC. The R2's usable capacity depends on the pack ordered and isn't in this repo. **Only the owner can supply it**, and deploying `ev-ingest-rivian` needs it (§11).

### 8.4 After delivery (recorded here, done later)

Each is a migration plus `reprocess`, worked from the real tape:
1. Confirm §2.5 and §7.2–7.5 against R2 payloads, including the `totalChargedEnergy` unit, and fix whatever disagrees.
2. Promote Rivian-only properties worth a column, typed from what's observed. Candidates: drive mode, Gear Guard, HV thermal events, the 12 V battery, windows (in their own columns).
3. If `chargingSession` was rejected, use §9's tooling to find the Parallax topics carrying charge power and energy, write our own `.proto`, and fill §7.4's slots from them.
4. Replace the synthetic test fixtures (§10.1) with excerpts from the real tape.

---

## 9. Parallax tooling

- **`packages/rivian/src/protobuf.ts`** is a schema-less protobuf wire decoder covering varint, 64-bit, length-delimited and 32-bit fields. It turns bytes into a tree of `{field, wire, value}`. A length-delimited value is shown as a nested message if it parses fully as one, otherwise as UTF-8 if printable, otherwise as hex. It's pure and written from the public encoding spec, and it refuses to recurse deeper than 16 levels.
- **`apps/ingest/src/parallax-dump.ts`** runs as `pnpm --filter @ev/ingest parallax-dump -- --rvm <topic> [--from <date>] [--to <date>] [--limit <n>]`. It reads `raw_message` rows with stream `parallax` for the configured vehicle, decodes their payloads, and prints one JSON line per message: `receivedAt`, `rvm` and the tree. It's read-only, and runs in the ingest pod beside `reprocess`.

---

## 10. Testing

### 10.1 Unit

**`packages/rivian`:**
- **Catalogue.** Names are unique. Every mapped slot targets a real `SAMPLE_COLUMNS` key whose SQL type admits the decoded value.
- **Decoders.**
  - Type drift, `null` and placeholder values, units, and both-or-neither location.
  - `observedAt` clamping, too-old-to-apply, and the untimed fallback.
  - The speed noise floor.
- **`toSample`.** Charge-state precedence, power state, locks and doors, TPMS, and gear `P` forcing speed to 0.
- **Gear.** The Rivian gear map, and sleep/standby setting `P`.
- **Fragment builder.** The three structured templates, and the 16-property grouping.
- **Protobuf decoder.** Hand-encoded bytes, including a truncated buffer and the depth limit.
- **JWE.** Round-trip; refusal under the wrong key; a corrupt value.
- **Redaction.** An error built from a response containing every token type, and a body, carries none of them.

**Fixtures** are written by hand from §2's documented shapes, and each file header **labels them synthetic**. The memory on verification says fixtures should come from the real tape, and there isn't one yet; the label tells the reader to replace them (§8.4).

**`apps/rivian`:** the lifecycle runs against a fake clock, an in-process GraphQL HTTP server and an in-process `ws` server speaking `graphql-transport-ws`:

| Area | Cases |
|---|---|
| Lifecycle transitions | every transition in §5.2 |
| Postgres failures | a failed credential poll keeps the socket up; a zero-row poll signs out; `credential_invalid` |
| Authentication | CSRF renewed at start; HTTP `UNAUTHENTICATED` renews once, then stops; ws `"Unauthenticated"` stops at once and resumes only on a new `updated_at` |
| Backoff | the schedule and its floor, rate limit, missing ack |
| Silence | resubscribe under fresh ids, never reconnect |
| Server frames | server `complete`/`error` resubscribes after 30 s |
| Schema drift | bisection finds one bad property among 16 within 8 probes while the healthy half keeps flowing; dropped list persisted and re-probed daily; a non-state subscription marked unavailable |
| Queue | overflow by bytes drops oldest, then resubscribes all; SIGTERM drains, sends `complete`, exits |
| Envelope | shape and topic; `receivedAt` taken at frame arrival; string cleaning; the whole payload, `errors` included |
| `meta` | change-only publishing; introspection-driven selection growth |

**`apps/ingest`:**
- **The Tesla profile reproduces today exactly:** the same `VOLATILE_FIELDS` set, slot lists and decode outputs. The existing pipeline, resume and reprocess suites pass with their logic and assertions unchanged. The only edits are mechanical: passing the Tesla profile to `new Pipeline(...)`, importing `VOLATILE_FIELDS`/`staleWindowFor` from `profiles/tesla.js`, and canonical gear strings.
- **`EV_VENDOR`:** required; vendor-derived defaults; cross-vendor client ids and topics refused.
- **The Rivian topic parser:** taped-not-dropped for unknown versions and missing fields; dropped for non-JSON; string cleaning.
- **`receivedAt`** comes from the envelope, with the fallback.
- **The flush clock** uses `skewMs`.
- **`handle`/`flush` serialisation:** a flush started during a handle waits for it.
- **The import boundary:** only `deps.ts` and `profiles/*` import a vendor package.
- **An end-to-end Rivian pipeline**, from synthetic envelopes:
  - A drive: park, then drive at speed, then park for 6 minutes.
  - A charge: connected, then `charging_active` with `chargingSession` power, then complete.
  - A parked car whose resubscribe snapshot re-sends a 3-hour-old non-zero speed.
  - Expected: exactly one drive and one charge with the expected summaries. The re-sent snapshot opens nothing.
- **`parallax`, `meta` and other streams** are taped and counted unmapped.
- **`reprocess`** passes the vehicle id.
- **`parallax-dump`** decodes a taped row.
- **The segmenter suite** moves to canonical gear values.

**`apps/web`**, with a faked Rivian HTTP layer:
- **Sign-in:**
  - success without MFA;
  - MFA followed by a correct code;
  - a wrong code keeps the pending entry;
  - an expired pending entry, swept on write.
- **Secrets stay put:**
  - the password, the tokens and the OTP appear in no log, error or response;
  - the stored row decrypts only with the private key and holds only `userSessionToken`;
  - the upsert bumps `updated_at`.
- **Routes:** sign-out deletes the row; all three routes return 401 without a session.
- **Page load:** no rows; a status row; an unknown state; dropped properties listed.
- **Settings tab:** points at `/settings/rivian` for a Rivian vehicle and at `/settings/telemetry` for a Tesla.
- **`env-names.test.ts`** still passes with the new variables.

### 10.2 Database

`008` and `009` are tested against a real Postgres, with `PG*` pointing at a throwaway container. The suite skips silently without one.
- **`008`:** seed `ShiftStateD`, `ShiftStateSNA` and `D`; assert `D`, NULL and `D`.
- **Down migration:** restores Tesla rows only.
- **`009`:** both single-row checks hold, and the repo functions work against the real tables (credential upsert bumps `updated_at`; status upsert; dropped list round-trips).

### 10.3 The refactor, against production

Following the memory on verifying against a restored production copy:
1. Take a `pg_dump -Fc` of production, read-only, over SSH as documented in the memory on prod access.
2. Restore it twice into podman Postgres, keeping one copy pristine.
3. Run `reprocess` over the whole tape twice: once with the pre-change `main` build and once with the post-change build, each against its own restored copy.
4. Diff `sample`, `session` and `session_point` between the two results.

**Expected diff:** `gear` values only (`ShiftStateX` to `X`, null for SNA and Invalid). Any other difference is a regression, or one of the latent races §6.1 fixes. Each one is checked against the raw tape and explained before merge.

### 10.4 What can't be tested until delivery

- real field shapes, R2 enum values, push cadence and Parallax volume;
- whether `chargingSession` and the other secondary subscriptions validate, and whether introspection is allowed;
- the real behaviour of `UNAUTHENTICATED` and the rate-limit thresholds.

Sign-in, `getUserInfo` and the subscriptions validating can all be exercised against the real account before delivery, once deployed. That's the first check in §11.

---

## 11. Deployment (this repo, and what the GitOps repo needs)

**In this repo:**
- `apps/rivian/Dockerfile`, the same pattern as `apps/ingest/Dockerfile`, numeric UID 10001.
- An `ev-rivian` leg in `images.yml`.
- `scripts/rivian-keygen.mjs`, which prints a P-256 private and public JWK pair.
- README updates: architecture, configuration tables (including `EV_VENDOR`), a Rivian setup section, scope.

**Needed in the GitOps repo.** None of this is done here, and nothing changes in production without the owner's go-ahead.

1. **Rollout order for the release that carries this work:**
   1. scale `ev-ingest` to 0 (the broker queues the Tesla backlog);
   2. run the migrator (`008`, `009`);
   3. deploy `ev-ingest` with `EV_VENDOR=tesla` on the new image;
   4. confirm it drains the backlog.

   The new image refuses to start without `EV_VENDOR`, and the old image would write `ShiftState*` rows after `008`.
2. **`ev-rivian` Deployment:**
   - one replica, `Recreate` strategy, since two connectors would hold two sockets on one session;
   - the private JWK in a SealedSecret;
   - its own MQTT user (`rivian`);
   - `PG*`;
   - `EV_VEHICLE_VIN=7PD2EAAB2VN016249`.
3. **`ev-ingest-rivian` Deployment:**
   - the ev-ingest image, with `EV_VENDOR=rivian`;
   - `EV_VEHICLE_ID` (for example `r2`), `EV_VEHICLE_VIN`, `EV_VEHICLE_NAME`;
   - `EV_USABLE_CAPACITY_KWH`, which the owner supplies;
   - home location as for the Tesla;
   - client id and topic come from the vendor defaults.
4. **`ev-web`:** `RIVIAN_CREDENTIAL_PUBLIC_KEY`.
5. **Mosquitto:**
   - user `rivian` may publish to `rivian/#`;
   - the ingest user may subscribe to `rivian/#`;
   - per-client queue limits for `ev-ingest-rivian` matching `ev-ingest`'s.
6. **Alerts:**
   - the connector is in `backing_off`, `unauthenticated` or `credential_invalid` for over 15 minutes;
   - `rivian_frames_dropped_total` increases;
   - the existing stall alert covers `ev-ingest-rivian` through its `vehicle` label, but **excludes the R2 until delivery**, since before then no samples is the correct state.

**First checks after deploy, before delivery:**
1. sign in at `/settings/rivian`;
2. the status reaches `waiting_for_vehicle` or `subscribed`;
3. `meta.userInfo` on the tape shows the account's vehicles;
4. `dropped_properties` and `meta.schema` show what the gateway accepts today.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| Rivian changes or closes the API without notice | Everything is taped raw and versioned. Grouped subscriptions bisect away a bad field automatically (§5.4). Discovery picks up new fields. The connector stops cleanly on auth failure. Smartcar remains the fallback. |
| The account is flagged for automated access | One socket. Backoff floors at 30 s. Resubscribing on silence mirrors the reference client. About 31 HTTP calls a day. Client headers match the app. No retry on a dead session. The owner account until delivery, a secondary driver after. |
| R2 values differ from the R1's | Unknown values decode to null and stay on the tape. §8.4 fixes mappings from real data, and `reprocess` rewrites history. |
| Re-sent snapshots resurrect old values | Per-property `observedAt` and too-old-to-apply (§6.4), with an end-to-end test. |
| GPS speed noise opens phantom drives or splits charges | A noise floor, plus speed 0 in Park (§7.2, §7.5). |
| Parallax volume is large | The `RIVIAN_PARALLAX_RVMS` filter. `rivian_frames_total{stream}` shows the rate on day one. Monthly partitions and BRIN bound the tape. |
| Broker down while the car is active | A 32 MiB queue, then counted drops, an alert, and a resubscribe for a fresh snapshot. The honest limit of a car that doesn't buffer. |
| A poison string wedges ingest | String cleaning on both sides (§5.5, §6.2). |
| A misconfigured worker steals the other vendor's session | Vendor-derived defaults; cross-vendor ids and topics refused at startup (§6.2). |
| A standing credential at rest | Only the session token is stored, sealed to the connector's key. The internet-facing pod can't read it, and it's revocable from the Rivian app. |
| Migration `008` races the old worker | The §11 rollout order. |
