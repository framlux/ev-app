# Telemetry configuration in the web app — design

**Date:** 2026-09-05
**Status:** Approved for planning
**Scope:** Replace `scripts/push-telemetry-config.sh` and `scripts/check-telemetry-synced.sh` as the everyday path, with a page in the web app. Tesla only.
**Parent specs:** `2026-09-04-ev-app-design.md`, `2026-09-05-full-signal-capture-design.md`

---

## 1. Purpose

Checking whether the car has applied its telemetry configuration currently means finding a laptop with `kubectl`, exporting a client id and a refresh token, and waiting while a script starts a pod in the cluster. Pushing a new configuration is the same ceremony again. Both are things you do repeatedly — the check especially, because a car applies its config on its own schedule and "not yet" is the normal answer for hours.

This spec puts both in the web app, and takes the opportunity to make the credential story **better** than the scripts', not merely more convenient: the vehicle-capable credential stops existing at rest.

### Goals

- Check applied telemetry status from the website, and see the last known result without any Tesla session at all.
- Push the configuration from the website, with the same preflight the script performs, refusing on a blocker.
- Hold **no Tesla refresh token** anywhere — not in a Secret, not in the database, not in a cookie.
- One configuration builder shared by the website and the scripts, so what the two push cannot diverge.

### Non-goals

- **Retiring the scripts.** They stay as the break-glass path: the moment you most need to know whether telemetry is flowing is when the website is not answering. They are re-pointed at the shared builder, not deleted.
- **Vehicle commands.** Unchanged, and §3.4 explains what now holds that line.
- **Editing the field set from the UI.** The catalogue is the source of truth and it is code with tests behind it. The page pushes what the catalogue says; it does not offer a field picker.
- **Multi-vehicle.** One car, as everywhere else. The VIN comes from `listVehicles` and a second vehicle is an error, exactly as the script refuses to guess.

---

## 2. Decisions and rationale

| Decision | Choice | Why |
|---|---|---|
| Tesla credential | **Interactive consent at the moment of use** | The scripts need a refresh token, which is a standing, vehicle-capable credential. Mounting one into an internet-facing pod is the part of this change that would have made the deployment less safe. An authorization-code flow per session removes the credential from rest entirely. |
| Where the access token lives | **Web pod memory**, keyed to the app session | Not the database (it would be at rest), not a cookie (it would be in the browser, and it is vehicle-capable). One replica makes memory sufficient; losing it on restart costs one re-consent and is honest. |
| Scopes for the web flow | `openid vehicle_device_data`, **no `offline_access`** | Without `offline_access` Tesla issues **no refresh token at all**, so the flow cannot create a long-lived credential even by accident. Command scopes are not requested. See §4 for the caveat that makes this weaker than it sounds, and what actually holds the line. |
| Client secret | Mounted into `ev-web` | `exchangeCode` is a confidential-client exchange and needs it. It is an *application* credential: alone it grants nothing about any vehicle, because vehicle access requires a user's consent token. |
| Transport | Everything through `ev-teslaproxy` | The config push must be signed with the application key, which only the proxy holds. Reads do not need signing, but routing them the same way means one base URL, one CA, and one network path to reason about. The NetworkPolicy already admits `ev-web` to it. |
| Cached status | A `telemetry_status` row | Otherwise the page is empty until you consent, which defeats the point: the common case is glancing at whether the car has applied the config yet. |
| Config builder | Moved into `packages/tesla`, shared | Two producers of the same JSON is precisely the drift the field catalogue exists to prevent. |

---

## 3. Architecture

### 3.1 The flow

```
browser (already signed in via Pocket-ID)
  │  GET /settings/telemetry
  ▼
ev-web ── reads telemetry_status ──► shows last known result + its age
  │
  │  "Connect to Tesla"  →  state nonce in a short-lived signed cookie
  ▼
auth.tesla.com  (consent)
  │  ?code&state
  ▼
ev-web  /settings/telemetry/callback
  │  verify state → exchangeCode(code, clientId, clientSecret, redirectUri)
  │  access token → in-memory store, keyed by app session, TTL = token expiry
  ▼
"Check now" / "Push configuration"
  │  https://ev-teslaproxy.ev.svc.cluster.local:4443/api/1/...   (proxy CA)
  ▼
Tesla Fleet API ──► telemetry_status updated on every check and push
```

### 3.2 The token's life

Held in a module-level `Map` in `apps/web/src/lib/server/tesla-session.ts`, keyed by the app session's **subject**, holding `{accessToken, expiresAt}`. Nothing else. It is dropped when the token expires, when the operator disconnects, and when the pod restarts — which is on every deploy.

Keying by subject rather than by session has a consequence worth stating rather than discovering: the app's session is a stateless sealed cookie with no server-side id, so there is nothing else stable to key on, and a consent granted in one browser is therefore usable from another browser signed in as the same subject. With a single `ALLOWED_SUBJECT` that is one person's two browsers, which is the intended reading of "the operator is connected". It would be the wrong model for more than one operator, and that is a reason to revisit it if the app ever has one.

There is no refresh path, deliberately: without `offline_access` there is no refresh token to use, and a flow that cannot renew itself cannot quietly become a standing credential. The page shows the expiry and offers "Connect" again.

This is per-process state in a stateful-looking place, which is normally a smell. It is correct here for the same reason the live-stream listener is a singleton: one replica, one operator, and the failure mode of losing it is a re-consent rather than data loss. If the deployment were ever scaled out, the honest consequence is that a consent would apply to whichever pod served the callback — noted, not solved.

### 3.3 The client

`packages/tesla/src/fleet-api.ts` currently hard-codes `BASE` at Tesla's public host and uses global `fetch`. It gains an options argument — `{ baseUrl, fetch }` — defaulting to today's behaviour, so existing callers are untouched. The web app passes the proxy's URL and a `fetch` bound to an undici `Agent` carrying the proxy CA, because the proxy presents a certificate from the cluster's internal issuer that no public trust store knows.

`apps/web/src/lib/server/tesla-client.ts` owns that construction and reads three values from the environment: `TESLAPROXY_URL`, the CA path, and `TESLA_REDIRECT_URI`.

### 3.4 The one write, and what still holds the line

`fleet-api.ts` gains `setTelemetryConfig(token, config, opts)`. That **breaks `packages/tesla/test/fleet-api.test.ts` on purpose** — the test pins the module's export list precisely so that adding a write is a decision rather than a slip. The test is updated to the new list, and its comment gains a paragraph: a telemetry-config write is sanctioned; a vehicle-data helper (metered, wakes the car) and any command helper are still not.

That test is now doing more work than before. Previously the refresh token was the only vehicle-capable credential and it lived outside the cluster. Now a consented access token exists inside `ev-web` for hours at a time, and `ev-web` can reach the signing proxy. The Tesla grant is recorded per (account, application) and already includes `vehicle_cmds`, so — per the hard-won comment in `oauth.ts` — a fresh authorize may return a token carrying the original grant's scopes regardless of what we ask for. **Requesting narrow scopes is therefore a best-effort reduction, not a guarantee.** The guarantee is that this codebase has no function that sends a command, and one test fails if that changes.

### 3.5 One config builder

`scripts/telemetry-fields.mjs` currently prints the catalogue in Tesla's shape for the shell script. That logic moves into `packages/tesla/src/telemetry-config.ts` as a pure function:

```ts
buildTelemetryConfig(input: {
  vin: string; hostname: string; port: number; ca: string
}): TelemetryConfig
```

It reads the field catalogue for names, intervals and `minimum_delta`, and sets `prefer_typed: true`. The script keeps working by calling it through a thin `.mjs` shim; the website calls it directly. Neither can push a field set the other would not.

### 3.6 Preflight, and not pushing when there is nothing to push

The push runs `fleetStatus` first and **refuses** on any blocker — virtual key not paired, firmware below the floor — because Tesla accepts a configuration it cannot apply, reports no error, and leaves `synced: false` indefinitely, which looks exactly like a sleeping car. A disabled "Allow Third-Party App Data Streaming" toggle is surfaced as a warning, matching the script.

Before pushing it fetches the applied configuration and compares it to what the catalogue would produce. If they match, it reports "already applied" and pushes nothing. A push is not free and is not instant, and re-pushing an identical config resets nothing usefully.

### 3.7 Cached status

Migration `006`, table `telemetry_status`, one row per vehicle:

| Column | Meaning |
|---|---|
| `vehicle_id` | PK, FK to `vehicle` |
| `synced` | what the car reports |
| `field_count`, `ca_present` | shape of the applied config |
| `firmware`, `key_paired`, `streaming_enabled` | last preflight result |
| `checked_at`, `pushed_at` | when, so the page can show age |

Written on every check and every push. Read with no Tesla session, which is what makes the page useful the other 23 hours of the day. It also gives the ingest-side alerting something to read later — an unsynced config is a cause of the silent-stall alert that already exists.

### 3.8 The page

`/settings/telemetry`, inside the existing gate. It shows: the applied status with its age, the preflight facts, the difference between what is applied and what the catalogue says (field count, and a list when they differ), the Tesla connection state with its expiry, and two buttons. "Check now" and "Push configuration" are POSTs, and the push asks for confirmation naming the VIN — it reconfigures a physical car, and a mis-click should not.

Nothing about this page belongs on the vehicle pages; it is operations, not driving.

---

## 4. Security posture, stated plainly

What `ev-web` gains:

- `CLIENT_ID` and `CLIENT_SECRET` — an application credential. On its own it grants nothing about any vehicle; vehicle access needs a user's consent.
- Read access to the telemetry CA certificate, which is public information by nature.
- A network path to `ev-teslaproxy`, which the NetworkPolicy already allowed.
- For hours at a time, after an interactive consent, an access token that Tesla may issue with the account's full existing grant — including command scopes.

What it does **not** gain, and what the scripts require: a refresh token. There is no standing credential at rest anywhere in the cluster after this change, which is a genuine improvement over mounting `ev-tesla-oauth`'s `REFRESH_TOKEN` into a pod — the design this replaced.

The remaining exposure is a compromise of `ev-web` *while an operator is consented*. In that window the attacker has a command-capable token and a route to the signing proxy, and is limited by the absence of any command code in this repo (§3.4). Shortening that window is why the token dies with the session, the expiry, and every deploy.

---

## 5. Failure handling

| Failure | Behaviour |
|---|---|
| No Tesla session when Check/Push is called | 409 with "connect to Tesla first". The buttons are disabled in the UI, but the API refuses independently — the UI is not the check. |
| `state` missing or mismatched at the callback | Refuse, log, no exchange. This is the CSRF boundary of the consent flow. |
| Tesla returns 401 to a call | The token is dead (expired, revoked, consent withdrawn). Drop it from the store and ask for a reconnect rather than retrying. |
| Preflight blocker | The push is refused with the specific blocker. Nothing is sent to Tesla. |
| Applied config already matches | Reported as "already applied"; no push. |
| Proxy unreachable or its certificate fails to verify | 502 naming which, because "cannot reach the signing proxy" and "the CA is wrong" have completely different fixes. |
| Push succeeds but `synced` stays false | The normal case, not an error: the car applies on next check-in, which can be hours. The page says so, and `pushed_at` gives the age. |
| Two vehicles on the account | Refuse rather than guess, matching the script. Configuring the wrong VIN is invisible until data arrives from the wrong car. |
| The pod restarts mid-consent | The store is empty; the page shows disconnected. One re-consent. |

---

## 6. Testing

- **Builder** (`packages/tesla`): `buildTelemetryConfig` output equals what the script's shim produces for the same inputs — one test that makes the two callers provably identical; every catalogued field appears with its tier's interval and its delta; `prefer_typed` is set.
- **Export surface** (`packages/tesla`): the updated pin lists exactly `fleetStatus`, `getTelemetryConfig`, `listVehicles`, `setTelemetryConfig` — no vehicle-data helper, no command helper.
- **Client** (`packages/tesla`): `baseUrl`/`fetch` injection is honoured, so the web can route through the proxy and the default stays Tesla's host.
- **Token store** (`apps/web`): a token expires and is then absent rather than stale; disconnect clears it; a request carrying no session reads nothing; a consent is keyed by subject, so the same subject in a second browser shares it — pinned as the documented behaviour, not left to be discovered.
- **Routes** (`apps/web`): unauthenticated → 401 (the gate); authenticated with no Tesla session → 409; callback with a bad `state` → refused, no exchange attempted; push with a preflight blocker → refused and no write issued; push with an identical applied config → "already applied", no write; every one of these asserted against a fake Fleet API rather than the real one.
- **Status row** (`packages/db`, real Postgres): upsert round-trips; the page renders from a row with a stale `checked_at` and says how old it is.
- **Page** (`apps/web`): renders with no status row at all (day one), with a stale row and no Tesla session, and with a connected session — the three states that actually occur.

---

## 7. What changes outside this repo

**`framlux/stack`:**
- Mount `ev-tesla-oauth`'s `CLIENT_ID` and `CLIENT_SECRET` into `ev-web` — **not** `REFRESH_TOKEN`, which is the point of the design and should be called out in the manifest comment.
- Mount the telemetry CA (`ev-telemetry-ca`, `tls.crt`) and the proxy CA (`ev-teslaproxy-tls`, `ca.crt`) read-only.
- Add `TESLAPROXY_URL` and `TESLA_REDIRECT_URI` to `ev-config`.
- No NetworkPolicy change: `ev-web` is already admitted to `ev-teslaproxy:4443`, and the comment there anticipated this.
- `SECRETS.md` §7 gains a note that `REFRESH_TOKEN` is now used only by the break-glass scripts.

**Tesla developer portal**, and nothing in either repo can do it:
- Register `https://ev.framlux.io/settings/telemetry/callback` as an allowed redirect URI. Until it is, consent fails at Tesla with a redirect-mismatch error before ever reaching us.
