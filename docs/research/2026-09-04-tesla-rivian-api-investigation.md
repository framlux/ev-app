# Building a personal Tesla + Rivian dashboard: API investigation

**Date:** 2026-09-04
**Scope:** One Tesla Model Y, one Rivian R2. Single user. Goal: one app that does what Tessie does for the Tesla and what Rivian Roamer does for the Rivian.
**Status:** Desk research only — nothing tested against live accounts yet. Items marked ⚠️ need to be verified before committing to a design.

---

## 1. Headline conclusion

The two cars need fundamentally different plumbing, and that asymmetry drives the whole architecture:

| | Tesla | Rivian |
|---|---|---|
| Official API | Yes — Fleet API | **None** |
| How you get data | Car **pushes** to your server (Fleet Telemetry) | Car state **pushes** over a GraphQL websocket (unofficial) |
| Auth | OAuth 2.0, registered app, hosted public key | Email/password + OTP → session token |
| Commands | Signed via Vehicle Command Protocol + virtual key | HMAC-signed via enrolled phone key |
| Costs money | Yes, metered (but ~free at our volume) | No |
| Can break without warning | No (versioned, announced) | **Yes, any time** |

Both platforms give you **push-based real-time data**, which means the naive "poll every 30 seconds and drain the battery" design that plagued older EV loggers is avoidable on both sides. Good news for the design.

The realistic shape of the product is: **two thin vendor adapters feeding one shared normalisation + sessionisation engine**, with a single UI on top. Almost all the interesting code (drive/charge/idle segmentation, efficiency, battery degradation, cost) is vendor-neutral and written once.

---

## 2. Tesla

### 2.1 The legacy Owner API is dead — don't design around it

`owner-api.teslamotors.com` has been decommissioned. As of 2026 it returns 403 pointing at Fleet API, and for energy endpoints 401. Old `ownerapi` refresh tokens still refresh at `auth.tesla.com`, but the resulting access token is rejected by both owner-api and fleet-api because of a wrong `aud` claim. The "Access Token Generator for Tesla" browser extensions no longer work (`redirect_uri not registered for this client_id`).

**Implication:** every tutorial and repo older than ~2025 that uses a pasted owner-api token is dead weight. Fleet API is the only cloud path.

### 2.2 Fleet API — and yes, individuals are allowed

Tesla defines three token types. The one we want is the **Third-Party Token**, and Tesla's own auth docs list the canonical use case as *"a hobbyist building an integration with their own Tesla product."* So personal use is explicitly sanctioned.

⚠️ **Conflict to resolve:** TeslaMate's docs page still claims Fleet API is "only for business fleet users" and that individuals should stay on the Owner API. That page is stale — the Owner API it points to no longer works. Tesla's own documentation contradicts it. Worth confirming empirically by actually registering an app before we build on it.

**Setup sequence:**
1. Tesla account with verified email + MFA enabled.
2. Register an application at `developer.tesla.com`. Asks for app name, description, purpose, and "legal business details" — this is the friction point for a personal project, though hobbyists reportedly get through. Approval typically within 5 business days.
3. Generate an EC (secp256r1) keypair. Host the public key, PEM-encoded, at:
   `https://<your-domain>/.well-known/appspecific/com.tesla.3p.public-key.pem`
   This proves domain ownership and is the key later paired into the car. **We need a domain.** GitHub Pages / Cloudflare Pages is sufficient.
4. Call the partner `register` endpoint once per region (we only need North America).
5. OAuth 2.0 flow → third-party token for the vehicle.

**Scopes available:** `openid`, `vehicle_device_data`, `vehicle_location`, `vehicle_cmds`, `vehicle_charging_cmds`.

> ⚠️ **Superseded — do not use this list when performing the OAuth grant.** The design that came out of this research is read-only, and that guarantee is enforced *only* at the grant: no manifest records the scope set, and a token carrying command scopes behaves identically to a read-only one until something calls a command endpoint. The scopes to request are exactly **`openid`, `offline_access`, `vehicle_device_data`, `vehicle_location`** — `vehicle_cmds` and `vehicle_charging_cmds` must **not** be requested. See `docs/superpowers/specs/2026-09-04-ev-app-design.md` §5.1.

### 2.3 Commands need the Vehicle Command Protocol

Since firmware 2023.20+ you cannot just POST a REST command. Commands must be end-to-end signed:

- A **virtual key** (our public key from step 3) must be paired into the car — done once, by tapping a link on the phone that's near the car.
- Commands are signed with the matching private key. In practice you run Tesla's open-source **`tesla-http-proxy`** (`github.com/teslamotors/vehicle-command`), which accepts plain REST calls and signs/forwards them.
- Direct unsigned REST commands only work on firmware < 2023.20; via the proxy, < 2024.26 is handled. **A 2022 Model Y on current firmware absolutely needs the proxy.**

### 2.4 Fleet Telemetry — the thing that makes this cheap and battery-safe

Instead of polling `vehicle_data`, the car opens an mTLS websocket to *your* server and streams fields as they change.

- Requires: virtual key paired, firmware **2024.26+**, and the config pushed through the vehicle-command proxy (it signs the telemetry config).
- You must run **a server on the public internet with real TLS certs**. Tesla open-sources the receiver (`teslamotors/fleet-telemetry`).
- Per-field config: each field has a minimum interval and only transmits when the value actually *changed*. Collector batches every 500ms.
- Signals available are defined in `vehicle_data.proto`: `VehicleSpeed`, `Location` (needs the location scope), SoC, odometer, door/lock states, tyre pressures, charging fields, etc.
- The car **buffers 5,000 messages (~2,500s of data)** when your server is unreachable — so a deploy or a home-internet blip doesn't lose the drive.
- Up to **5 simultaneous third-party telemetry configs per vehicle** — so this coexists with Tessie/ABRP if we keep them.
- Critically: telemetry does **not** require waking the car. Tesla's docs frame it as preventing "unnecessary vehicle wakes and battery drain."

⚠️ One caveat found: at least one source claims Fleet Telemetry's minimum interval is coarser than the old owner-API streaming (per-minute vs per-second). Tesla's own sample config implies sub-second collection while driving. Needs empirical confirmation — it matters for how good the drive maps look.

### 2.5 Cost

| Category | Price |
|---|---|
| Streaming signals | $1 per 150,000 |
| Commands | $1 per 1,000 |
| Data (polling) requests | $1 per 500 |
| Wakes | $1 per 50 |

Every account gets a **$10/month discount**. Tesla's own framing: that covers data streaming, 100 commands and 2 wakes per day *for two vehicles*. Tesla publishes migration case studies showing 94–97% cost reduction moving from polling to telemetry, and quotes ~**$0.006/hour while driving**.

**Verdict: with telemetry as the primary source, one car costs effectively $0/month.** Polling is what's expensive (`$1/500` burns the credit fast at 30s intervals); wakes are brutally expensive at `$1/50`.

Rate limits per device per account: 60 data req/min, 3 wakes/min, 30 commands/min. Default billing limit is $0 until you add a payment method.

### 2.6 Bluetooth — a genuinely useful bonus

Tesla's `vehicle-command` SDK speaks the same signed protocol **over BLE**, using the same virtual key. Commands sent this way cost nothing, consume no API credits, and need no internet. If we run any always-on box in the garage (Pi, NAS, HA), "lock / precondition / start charge" can go local-first with cloud fallback.

### 2.7 So how does Tessie actually work?

**Tessie is not a secret third API.** It's a Fleet API front-end plus a derived-data product:

- `api.tessie.com` is a **drop-in Fleet API proxy** — same paths, but you authenticate with a simple bearer API key instead of OAuth, and Tessie handles regional routing and, crucially, **command signing** for you (so no proxy, no virtual key hosting, no domain).
- They advertise **unlimited free `vehicle_data` polling** and "save up to 99% off your Fleet API bill" — i.e. they absorb Tesla's metered cost themselves and recoup it in subscription.
- On top of that sits **Tessie's own API**, which is the actual value-add. That's where the stuff Tesla doesn't give you lives:
  - `GET /drives`, `/charges`, `/idles`, `/consumption`, `/driving_path`, `/historical_states`
  - `/battery`, `/battery_health`, `/battery_health_measurements`
  - `/map`, `/weather`, `/firmware_alerts`, charging invoices, per-charge cost tagging
  - Full command surface: climate, seat heaters, locks, trunks/frunk, sentry, valet, charge limit/amps/schedules, windows, sunroof, HomeLink, boombox, software updates, speed limit
  - Telemetry config get/set/delete
- Pricing ~$6.99/mo (basic) to $12.99/mo (Pro: automations, sentry tracking, detailed battery). API access comes with the subscription.

**The key insight for us:** everything in that second bullet list — drives, charges, idles, battery health — is *derived by Tessie from a raw state stream*. It is not something Tesla hands you. **That derivation engine is the actual product we'd be building**, and it's the same engine that has to run for the Rivian.

**Alternative worth serious consideration: Teslemetry** — ~€3.17/month (~€31.62/yr) per device, 500 command credits/month included, built Home-Assistant-first, and unlike Tessie it exposes **Fleet Telemetry streaming directly**, plus webhooks and server-sent events. For our purposes (we want a raw stream to run our own engine on, not their dashboard) Teslemetry is a better fit and roughly half the price.

---

## 3. Rivian

### 3.1 There is no official API

Rivian publishes nothing. Every third-party Rivian tool — Rivian Roamer, ElectraFi, Outpost, the Home Assistant integration, ABRP — talks to the **same GraphQL endpoints the Rivian mobile app uses**. The community documents them at `rivian-api.kaedenb.org` ("RivDocs") and `github.com/kaedenbrinkman/rivian-api`, with reference implementations in `bretterer/rivian-python-client` and `bretterer/home-assistant-rivian`.

Roamer is explicit about this on its own help pages: *"Rivian has no official companion API"*, it *"integrates with the same services that power the Rivian app"*, and it *"deliberately rate-limits itself."* It also claims its integration was built **in coordination with Rivian** — which is the closest thing to a blessing that exists here.

### 3.2 Authentication

Endpoint: `POST https://rivian.com/api/gql/gateway/graphql`

1. **`CreateCSRFToken`** mutation → returns `csrfToken` and `appSessionToken`.
2. **`Login(email, password)`** mutation, with headers:
   - `csrf-token: <csrfToken>`
   - `a-sess: <appSessionToken>`
   - `apollographql-client-name: com.rivian.android.consumer`

   Returns `userSessionToken` directly if no MFA; returns `otpToken` + `targetChannel` + available channels if MFA is on.
3. **`LoginWithOTP`** (field `loginWithOTPV2`) with email + OTP code + `otpToken` → `userSessionToken`.
4. Subsequent calls carry `u-sess: <userSessionToken>`.

⚠️ Token lifetimes and the refresh mechanism aren't documented on the pages I could reach. Needs to be read out of `rivian-python-client`. Practically, this means the app needs an interactive re-auth path (OTP prompt) — not fully headless.

**Strong recommendation from the owner forums:** create a **secondary driver account** on the Rivian account and authenticate the integration as that, rather than embedding primary credentials. Access can be revoked from the Rivian app or by changing the password. Roamer supports exactly this pattern.

### 3.3 Reading state

The `vehicleState` GraphQL query is rich. Confirmed fields include:

- **Battery/charging:** `batteryLevel`, `batteryLimit`, `distanceToEmpty`, `rangeThreshold`, `chargerState`, `chargerStatus`, `chargerDerateStatus`, `timeToEndOfCharge`
- **Location:** `gnssLocation { latitude, longitude, timeStamp }`
- **Vehicle:** `powerState`, `driveMode`, odometer, doors/windows/locks, tyre pressures, OTA/software update status
- **Thermal:** `batteryHvThermalEvent`, `batteryHvThermalEventPropagation`

Known gap: **battery temperature is not exposed** — Roamer calls this out explicitly as a Rivian API limitation, so it's not something we can fix.

Note the API has visibly versioned over time (community docs exist for app versions 2.6.1 → 3.1.0 at edman007.com), which is the concrete evidence of drift risk.

### 3.4 Live updates — the good part

`wss://api.rivian.com/gql-consumer-subscriptions/graphql` supports **GraphQL subscriptions** over websocket, authenticated with the session + CSRF tokens. Vehicle state is **pushed**, not polled.

This is the Rivian equivalent of Fleet Telemetry and it means a single long-lived connection per vehicle gives us continuous state with no polling pressure on Rivian's servers — which is presumably why Roamer can operate at the scale it does without upsetting anyone.

### 3.5 Commands

Write-scoped commands (lock/unlock, climate, charging, etc.) require an **HMAC signature** computed over the command name + current timestamp, using a shared secret derived via ECDH between an **enrolled phone key's private key** and the **vehicle's public key**. So there's a one-time phone-key enrolment ceremony, conceptually parallel to Tesla's virtual key.

There's also **"Parallax"** — the newer command/state bus, organised into domains: Energy, Charging, Body, Dynamics, Comfort, Security, Access, OTA, Navigation, Geofencing. And a **BLE API** offering the same controls without internet.

Commands are the hardest and most fragile part of the Rivian side. **Recommend deferring them past v1.**

### 3.6 R2 specifically

R2 deliveries began **9 June 2026**. Roamer already tracks and supports R2 (dedicated R2 tracker, 313 delivered / 307 on order at time of writing) and its marketing names R2 alongside R1S/R1T. Since R2 uses the same consumer app and the same gateway, the existing integration path should apply.

⚠️ Unverified until the car is actually in the driveway. Field availability may differ (R2 is a different platform, likely different `driveMode`/domain values). Plan for the adapter to tolerate unknown/missing fields rather than assume the R1 schema.

### 3.7 What Rivian Roamer actually offers (feature teardown)

- **Free, no account:** inventory browsing, software release notes, charger search, community trackers
- **Free, linked account:** live vehicle status/telemetry, software-update notifications, vehicle config details
- **Roamer Plus ($4.99/mo, $54.99/yr):** drive sessions with maps, charging curves, efficiency analytics, advanced trip stats, unlimited history, multi-vehicle

Two things worth stealing conceptually:
1. **"Rivian's feed is live-only"** — Rivian stores no history for you. If you aren't recording, the data is gone forever. Roamer only has your history *from the moment you subscribe*. This is the single strongest argument for standing up ingestion **before** the R2 arrives.
2. They support **importing history from ElectraFi / TezLab** to backfill. Where existing Tesla history lives in a third-party service, an importer is worth having.

---

## 4. Undocumented / unofficial API surfaces — summary

Since this was called out specifically:

| Surface | Status | Useful to us? |
|---|---|---|
| Tesla Owner API (`owner-api.teslamotors.com`) | **Dead.** Decommissioned, 403/401 | No |
| Tesla Fleet API | Official, documented | **Yes — primary** |
| Tesla Fleet Telemetry | Official, documented | **Yes — primary** |
| Tesla BLE / Vehicle Command Protocol | Officially open-sourced by Tesla; community docs at teslabtapi.com | Yes — optional local commands |
| Rivian consumer GraphQL gateway | **Unofficial, reverse-engineered**, well documented by community | **Yes — only option** |
| Rivian GraphQL websocket subscriptions | Unofficial | **Yes — primary for live data** |
| Rivian Parallax command bus | Unofficial, partially documented | Later |
| Rivian BLE API | Unofficial | Later / probably never |

There is **no hidden Tesla API worth using** — Tesla closed that door deliberately and the paid Fleet API is the replacement. On the Rivian side, essentially *everything* is undocumented; the question isn't whether to use unofficial APIs, it's how defensively.

**Risk posture I'd adopt for Rivian:** self-imposed rate limiting (mirror Roamer's stated discipline), a single websocket rather than polling, a secondary driver account, `apollographql-client-name` matching the real app, and adapter code that degrades gracefully when fields vanish. This is personal interoperability with my own vehicle, which is the defensible end of the spectrum — but it can still break or get an account flagged, so don't make it load-bearing for anything safety-related.

---

## 5. Recommended architecture

### 5.1 Shape

```
┌──────────────────┐        ┌──────────────────┐
│  Tesla adapter   │        │  Rivian adapter  │
│  fleet-telemetry │        │  GraphQL WS      │
│  receiver (mTLS) │        │  subscription    │
└────────┬─────────┘        └────────┬─────────┘
         │  raw signal events        │
         └───────────┬───────────────┘
                     ▼
         ┌───────────────────────────┐
         │  Normaliser               │  vendor → canonical VehicleSample
         └───────────┬───────────────┘
                     ▼
         ┌───────────────────────────┐
         │  Sessioniser              │  drives / charges / idles
         │  + derived metrics        │  efficiency, cost, degradation
         └───────────┬───────────────┘
                     ▼
              Postgres + TimescaleDB
                     ▼
         ┌───────────────────────────┐
         │  Next.js app (single user)│
         └───────────────────────────┘
```

**The whole bet:** the two adapters are the only vendor-specific code. Everything downstream operates on a canonical `VehicleSample` (timestamp, soc, range, odometer, location, power state, charge state, speed, …). Add a third car brand later = write one adapter.

### 5.2 Concrete stack recommendation

- **App:** Next.js (App Router) + TypeScript. Single-user auth — a single passkey or a shared secret; no user table, no multi-tenancy. YAGNI hard here.
- **DB:** Postgres with TimescaleDB for the sample hypertable. Sessions/derived tables are plain relational.
- **Workers:** two long-running Node processes (or one process, two supervised connections). The Tesla telemetry receiver is Tesla's Go binary writing to a queue/DB; the Rivian one is ours.
- **Hosting:** Fly.io or Railway — both give a public hostname with TLS, which we need anyway for the Tesla telemetry endpoint and the `.well-known` public key. A single small VM would also do.
- **Maps:** MapLibre + a free tile source.

### 5.3 Phasing

**Phase 0 — de-risk (do this first, ~a day)**
- Register the Tesla developer app and confirm a hobbyist gets approved. This is the single biggest unknown.
- Log into the Rivian GraphQL gateway with a secondary account and pull `vehicleState` for... nothing yet (no R2). Test the flow against the account itself (orders/deliveries endpoints exist, which is how Roamer does R2 delivery tracking).
- Decision point falls out of this: self-host Fleet API, or start behind Teslemetry.

**Phase 1 — ingestion and storage.** Get raw samples landing in Postgres from the Tesla. Nothing else. Do this early even with a placeholder UI, because history not captured is history lost forever.

**Phase 2 — the engine.** Drive/charge/idle segmentation, efficiency, charging curves, cost. Vendor-neutral, fully testable against recorded fixtures. This is where the real work is and it's where TDD pays off — segmentation logic is exactly the kind of thing that's easy to get subtly wrong.

**Phase 3 — UI.** Unified garage view, drive list + map, charge sessions with curves, battery health over time.

**Phase 4 — Rivian adapter.** Slot in when the R2 lands. Ideally the adapter is written and tested against recorded fixtures before delivery day.

**Phase 5 — commands.** Tesla first (proxy is well-trodden), Rivian later or never.

**Phase 6 — nice-to-haves.** Geofence/sentry alerts, charging cost from utility rates, ABRP-style planning (probably just link out to ABRP rather than rebuild it).

### 5.4 Running cost estimate

| Item | Monthly |
|---|---|
| Tesla Fleet API (telemetry-primary) | ~$0 — covered by the $10 credit |
| Rivian | $0 |
| Hosting (Fly.io small + Postgres) | ~$5–15 |
| Domain | ~$1 |
| **Total** | **~$6–16/mo** |

vs. ~$12–18/mo for Tessie + Roamer Plus. So this doesn't pay for itself financially — it pays for itself in having both cars in one place, owning the data, and unlimited history.

---

## 6. Open questions for me to answer before design

1. **Self-host Tesla, or ride Teslemetry?** Self-hosting means the app registration, a domain, the `.well-known` key, virtual-key pairing, running the vehicle-command proxy, and standing up an mTLS telemetry receiver. Teslemetry (~€3.17/mo) collapses all of that into an API key and still exposes the raw stream. My inclination: **start on Teslemetry to get the engine built, keep the adapter interface clean enough to swap to self-hosted later.**
2. **Do I want commands at all**, or is this a read-only dashboard? Commands roughly double the Tesla integration surface and are the most fragile part of Rivian.
3. **Is there existing Tesla history to import** (TeslaMate / Tessie / TezLab export)?
4. **Where does this run** — cloud, or a box at home? A box at home unlocks the free BLE command path but complicates the Tesla telemetry endpoint (needs a stable public TLS hostname).
5. **Phone-first or desktop-first?** Roamer is explicitly a responsive web app, not a native app — probably the right call for us too.

---

## 7. Sources

- Tesla: [What is Fleet API](https://developer.tesla.com/docs/fleet-api/getting-started/what-is-fleet-api), [Authentication overview](https://developer.tesla.com/docs/fleet-api/authentication/overview), [Billing and limits](https://developer.tesla.com/docs/fleet-api/billing-and-limits), [Fleet Telemetry](https://developer.tesla.com/docs/fleet-api/fleet-telemetry), [Vehicle commands](https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-commands), [pricing table](https://developer.tesla.com/), [teslamotors/vehicle-command](https://github.com/teslamotors/vehicle-command), [teslamotors/fleet-telemetry](https://github.com/teslamotors/fleet-telemetry)
- Owner API deprecation: [Tessie status incident](https://status.tessie.com/incident/384149), [TeslaMate discussion #5048](https://github.com/teslamate-org/teslamate/discussions/5048), [batpred issue #3965](https://github.com/springfall2008/batpred/issues/3965), [TMC: Death of the Owner-API](https://teslamotorsclub.com/tmc/threads/death-of-the-tesla-owner-api.356542/)
- Tessie: [Access Tesla Fleet API](https://developer.tessie.com/reference/access-tesla-fleet-api), [Tessie developers](https://www.tessie.com/developers), [API index](https://developer.tessie.com/llms.txt), [Tessie + Fleet API](https://www.tessie.com/integrations/tesla-fleet-api)
- Teslemetry: [teslemetry.com](https://teslemetry.com/), [integration comparison](https://teslemetry.com/docs/home-assistant/compare), [Bluetooth control](https://teslemetry.com/docs/topics/bluetooth), [python-tesla-fleet-api](https://github.com/Teslemetry/python-tesla-fleet-api)
- Rivian: [Unofficial Rivian API docs (RivDocs)](https://rivian-api.kaedenb.org/), [authentication](https://rivian-api.kaedenb.org/app/authentication/), [kaedenbrinkman/rivian-api](https://github.com/kaedenbrinkman/rivian-api), [bretterer/rivian-python-client](https://github.com/bretterer/rivian-python-client), [bretterer/home-assistant-rivian](https://github.com/bretterer/home-assistant-rivian), [edman007 API version notes](https://www.edman007.com/article/Rivian/Rivian-App-API---v3.1.0)
- Rivian Roamer: [rivianroamer.com](https://rivianroamer.com/), [help](https://rivianroamer.com/help), [terms](https://rivianroamer.com/terms-of-service), [R2 tracker](https://rivianroamer.com/r2)
- R2: [R2 deliveries begin, 9 June 2026](https://rivian.com/stories/r2-deliveries-begin-june-9-2026)
- Community/context: [TeslaMate API config](https://docs.teslamate.org/docs/configuration/api/) (⚠️ stale on individual access), [TeslaMate Fleet API pricing discussion](https://github.com/teslamate-org/teslamate/discussions/4408), [Tesla API pricing announcement](https://www.notateslaapp.com/news/2415/tesla-announces-api-pricing-third-party-service-costs-expected-to-rise), [Rivian Forums: 3rd-party integrations, main vs driver profile](https://www.rivianforums.com/forum/threads/3rd-party-integrations-use-main-profile-or-create-a-new-driver.62303/)
