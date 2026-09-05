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
  │  "Connect to Tesla"  →  state nonce in a short-lived cookie (sameSite: lax)
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

**The state cookie must be `sameSite: 'lax'`, not `'strict'`.** Tesla returns the browser by top-level GET, and a Strict cookie is withheld on exactly that navigation — every consent would die with "state missing", intermittently enough to look like a Tesla problem. `auth/login/+server.ts` already sets `FLOW_COOKIE` this way with the reasoning attached; the Tesla flow reuses that shape (`FLOW_TTL_SECONDS`, a parsed-and-validated state, delete-on-use) rather than hand-rolling a second one.

### 3.2 The token's life

Held in a module-level `Map` in `apps/web/src/lib/server/tesla-session.ts`, keyed by the app session's **subject**, holding `{accessToken, expiresAt}`. Nothing else. It is dropped when the token expires, when the operator disconnects, and when the pod restarts — which is on every deploy.

Keying by subject rather than by session has a consequence worth stating rather than discovering: the app's session is a stateless sealed cookie with no server-side id, so there is nothing else stable to key on, and a consent granted in one browser is therefore usable from another browser signed in as the same subject. With a single `ALLOWED_SUBJECT` that is one person's two browsers, which is the intended reading of "the operator is connected". It would be the wrong model for more than one operator, and that is a reason to revisit it if the app ever has one.

There is no refresh path, deliberately: without `offline_access` there is no refresh token to use, and a flow that cannot renew itself cannot quietly become a standing credential. The page shows the expiry and offers "Connect" again.

This is per-process state in a stateful-looking place, which is normally a smell. It is correct here for the same reason the live-stream listener is a singleton: one replica, one operator, and the failure mode of losing it is a re-consent rather than data loss. If the deployment were ever scaled out, the honest consequence is that a consent would apply to whichever pod served the callback — noted, not solved.

### 3.3 The client

`packages/tesla/src/fleet-api.ts` currently hard-codes `BASE` at Tesla's public host and uses global `fetch`. It gains an options argument — **`{ baseUrl }` only** — defaulting to today's behaviour, so existing callers are untouched.

**Trust, without a fetch injection.** The proxy presents a certificate from the cluster's internal CA issuer, which no public trust store knows. The obvious route — an undici `Agent` carrying the CA — is rejected: `undici` is not a dependency of `apps/web` (or of anything in this repo), and whether an `Agent` from a separately-installed undici is honoured as a `dispatcher` by Node 22's built-in `fetch` is exactly the kind of thing that works in a test and not in the image.

Instead `NODE_EXTRA_CA_CERTS=/etc/tesla/proxy-ca.crt` is set on the web Deployment. Node applies it to the process trust store, so global `fetch` trusts the proxy with no dependency, no injection seam, and nothing for the implementation to get subtly wrong. It also keeps the injectable surface to `baseUrl`, which is all the tests need.

`apps/web/src/lib/server/tesla-client.ts` owns the client and reads `TESLAPROXY_URL` and `TESLA_REDIRECT_URI` from the environment. The CA is not read by the application at all — it is a mount and an env var on the pod.

### 3.4 The one write, and what still holds the line

`fleet-api.ts` gains `setTelemetryConfig(token, config, opts)`. That **breaks `packages/tesla/test/fleet-api.test.ts` on purpose** — the test pins the module's export list precisely so that adding a write is a decision rather than a slip. The test is updated to the new list, and its comment gains a paragraph: a telemetry-config write is sanctioned; a vehicle-data helper (metered, wakes the car) and any command helper are still not.

**Three things about `authorizeUrl` this design has to name, because its defaults are wrong for this flow.** It hard-codes `prompt: 'login'`, which forces a full Tesla re-authentication — password and MFA — not a click-through consent. Combined with §3.2's "a restart costs one re-consent", that means **every deploy costs a full Tesla login**, which is a real cost to accept knowingly rather than discover. It also hard-codes `prompt_missing_scopes` and `require_requested_scopes`, both added to *widen* an existing grant; their behaviour when the request is a strict *subset* is undocumented by that comment and unverified here, so the first consent is the test. And its default `SCOPES` includes `offline_access` and both command scopes, so the web flow passes an explicit narrower constant — `WEB_SCOPES = ['openid', 'vehicle_device_data']` — pinned by a test beside the export-surface one, because a flow that silently used the default would mint exactly the standing credential this design exists to avoid.

**`TokenSet.refreshToken` becomes optional.** `exchangeCode` reads `j.refresh_token` into a `string`, and without `offline_access` Tesla returns none — so the field would be `undefined` behind a type that says otherwise, which is the same silent-shape trap `oauth.ts`'s own header documents in the other direction. It becomes `refreshToken?: string`, and the callback **asserts it is absent**. That assertion is the executable form of "this flow cannot create a long-lived credential", which is otherwise only prose in §2.

That test is now doing more work than before. Previously the refresh token was the only vehicle-capable credential and it lived outside the cluster. Now a consented access token exists inside `ev-web` for hours at a time, and `ev-web` can reach the signing proxy. The Tesla grant is recorded per (account, application) and already includes `vehicle_cmds`, so — per the hard-won comment in `oauth.ts` — a fresh authorize may return a token carrying the original grant's scopes regardless of what we ask for. **Requesting narrow scopes is therefore a best-effort reduction, not a guarantee.** The guarantee is that this codebase has no function that sends a command, and one test fails if that changes.

### 3.4a The authentication boundary this feature runs into

`apps/web/test/boundaries.test.ts` carries a whole `describe` block whose comment states the invariant plainly: *"Tesla tokens grant vehicle access. They must never grant app access."* It exists because the registered Tesla redirect is named `/tesla_login`, which reads like a sign-in option and is not one. Three tests, and this feature meets all three head-on:

1. **No Tesla path in `PUBLIC_PATHS`.** We comply unchanged — the callback stays behind the gate (§3.1), which works because the session cookie is `sameSite: 'lax'` and Tesla returns the browser by top-level GET.
2. **"Never issues an app session from a Tesla credential"**, implemented as `touchesTesla && /sealSession|ev_session|cookies\.set\(/`. Our connect route *must* set a state cookie in a file that mentions Tesla, so **this test goes red on a correct implementation**. It is narrowed to the invariant it is actually defending — `/sealSession|SESSION_COOKIE\b|ev_session/` — and its comment gains a line recording that `cookies.set(` was a proxy for "mints a credential" and stopped being a usable one when a Tesla flow legitimately needed a state nonce. Narrowing a guard is exactly the move that should be suspicious, so it is called out here rather than done quietly in a commit.
3. **"Offers no Tesla sign-in affordance in the UI"**, matching `/sign in with tesla|log in with tesla|tesla login/i` in `.svelte` files. This test **stays exactly as it is**, and it constrains our wording: the button says **"Connect to Tesla"**, never "Sign in with Tesla". That is not a workaround — the distinction is the whole invariant. Connecting authorises *this app to reach the car*; signing in would mean a Tesla account granting access to *the app*, which nothing here does and nothing ever should.

### 3.5 One config builder

`scripts/telemetry-fields.mjs` currently prints the catalogue in Tesla's shape for the shell script. That logic moves into `packages/tesla/src/telemetry-config.ts` as a pure function:

```ts
buildTelemetryConfig(input: { vin: string; ca: string }): TelemetryConfig
```

It reads the field catalogue for names, intervals and `minimum_delta`, sets `prefer_typed: true`, and takes the **hostname and port from constants in `packages/tesla`** rather than from its caller — they are `ev-telemetry.framlux.io` and `443` today, hard-coded in the script, and a value both callers must agree on is exactly what this module exists to hold.

**Two guards from the script move into the builder**, because they are the reason it is not a one-liner:

- **An empty field set is refused.** The script has `[ "$COUNT" -gt 0 ] || fail` with the comment that a config with no fields is *accepted* and stops the car streaming anything. That is the highest-consequence failure in the whole flow — a successful push that silently ends ingestion — and it must throw from the builder, where both callers get it.
- **The CA must look like a certificate.** The script greps for `BEGIN CERTIFICATE`. A mis-mounted or empty CA yields a config the car accepts and then fails every connection against, which is indistinguishable from a car that never wakes.

**The shim keeps its current shape.** `packages/tesla/test/push-config.test.ts` pins the script's literal text — the `telemetry-fields.mjs` invocation, `"fields": fields`, `"prefer_typed": True`, and the `-gt 0` guard. So `scripts/telemetry-fields.mjs` goes on printing **the fields map only**, now sourced from the builder's field-map half, and the script's python assembly is untouched. Those four assertions stay green, and the drift they guard stays guarded.

### 3.6 Preflight, and not pushing when there is nothing to push

The push runs `fleetStatus` first and **refuses** on any blocker — virtual key not paired, firmware below the floor — because Tesla accepts a configuration it cannot apply, reports no error, and leaves `synced: false` indefinitely, which looks exactly like a sleeping car. A disabled "Allow Third-Party App Data Streaming" toggle is surfaced as a warning, matching the script.

Before pushing it fetches the applied configuration and compares it to what the catalogue would produce. If they match, it reports "already applied" and pushes nothing.

**What "match" means has to be defined here rather than left to the implementation**, because both ways of getting it wrong are silent. Too strict — a deep equality over whatever Tesla echoes — and a whitespace difference in the PEM or an omitted defaulted `minimum_delta` means it never matches, which merely wastes a push. Too loose, and the page refuses to push a genuinely changed configuration and says everything is fine. The rule is:

- the **set of field names**, and for each, `interval_seconds` and `minimum_delta`;
- `hostname` and `port`;
- `ca` compared **on presence only**, not on bytes.

Anything else Tesla echoes is ignored. This is pinned by a test against a captured response fixture, not asserted against the live API.

**`getTelemetryConfig`'s return type is too narrow for any of this.** It is typed `{ synced: boolean }`, but §3.6's comparison and §3.7's `field_count`/`ca_present` both need the applied config itself. It gains `config?: { hostname, port, ca, prefer_typed, fields }` — a shape already known, because `check-telemetry-synced.sh` reads exactly those keys today.

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
- Read access to the telemetry CA **certificate** — `tls.crt` only, projected by name (§7). Not the Secret, which also holds `tls.key`.
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
- **Scopes** (`packages/tesla`): `WEB_SCOPES` is exactly `['openid', 'vehicle_device_data']` — no `offline_access`, no command scope — pinned like the export surface, because the failure of using the default constant is silent and creates the credential this design exists to avoid.
- **Guards in the builder** (`packages/tesla`): an empty field set throws; a CA that is not a certificate throws; `scripts/telemetry-fields.mjs` still prints only the fields map, so `push-config.test.ts`'s four text assertions stay green.
- **Comparison rule** (`packages/tesla`): the §3.6 equality is tested against a captured `fleet_telemetry_config` fixture — an identical config matches, a changed interval does not, a `ca` differing only in whitespace still matches, and an omitted defaulted `minimum_delta` does not cause a spurious mismatch.
- **Boundaries** (`apps/web`): the narrowed session test still catches the thing it defends — a file that calls `sealSession` or writes `ev_session` alongside Tesla OAuth is still an offender — proven by a fixture string, not by inspection. The UI-affordance test is unchanged and the settings page passes it.
- **Client** (`packages/tesla`): `baseUrl` injection is honoured, so the web routes through the proxy while the default stays Tesla's host. There is no `fetch` seam to test — trust comes from `NODE_EXTRA_CA_CERTS` on the pod (§3.3).
- **Token store** (`apps/web`): the callback refuses a token set that carries a refresh token, which is the executable form of §2's promise; a token expires and is then absent rather than stale; disconnect clears it; a request carrying no session reads nothing; a consent is keyed by subject, so the same subject in a second browser shares it — pinned as the documented behaviour, not left to be discovered.
- **Routes** (`apps/web`): unauthenticated → 401 (the gate); authenticated with no Tesla session → 409; callback with a bad `state` → refused, no exchange attempted; push with a preflight blocker → refused and no write issued; push with an identical applied config → "already applied", no write; every one of these asserted against a fake Fleet API rather than the real one.
- **Status row** (`packages/db`, real Postgres): upsert round-trips; the page renders from a row with a stale `checked_at` and says how old it is.
- **Page** (`apps/web`): renders with no status row at all (day one), with a stale row and no Tesla session, and with a connected session — the three states that actually occur.

---

## 7. What changes outside this repo

**`framlux/stack`:**
- Mount `ev-tesla-oauth`'s `CLIENT_ID` and `CLIENT_SECRET` into `ev-web` — **not** `REFRESH_TOKEN`, which is the point of the design and should be called out in the manifest comment.
- Mount the telemetry CA (`ev-telemetry-ca`, `tls.crt`) and the proxy CA (`ev-teslaproxy-tls`, `ca.crt`) read-only, **each with an explicit `items:` projection** — never a bare `secret:` volume. Both Secrets are cert-manager CA secrets and therefore also contain `tls.key`: `ev-telemetry-ca` holds the private key of the ten-year root **the car pins**, carrying `rotationPolicy: Never` precisely because rotating it means re-pushing config to a physical vehicle. Projecting the whole Secret into the one internet-facing pod in the namespace would be strictly worse than the refresh-token exposure this design removes. `deployment-teslaproxy.yaml` already does exactly this projection for the signing key, with the reasoning attached; copy that shape.
- Add `TESLAPROXY_URL`, `TESLA_REDIRECT_URI` and `NODE_EXTRA_CA_CERTS` (pointing at the projected proxy CA) to the web Deployment.
- No NetworkPolicy change: `ev-web` is already admitted to `ev-teslaproxy:4443`, and the comment there anticipated this.
- `SECRETS.md` §7 gains a note that `REFRESH_TOKEN` is now used only by the break-glass scripts.

**Tesla developer portal**, and nothing in either repo can do it:
- Register `https://ev.framlux.io/settings/telemetry/callback` as an allowed redirect URI. Until it is, consent fails at Tesla with a redirect-mismatch error before ever reaching us.
- This is an **addition, not a replacement**. `SECRETS.md` records `https://ev.framlux.io/tesla_login` as the already-registered redirect — a path that deliberately does not exist, used once by hand to mint the refresh token. It stays registered for the break-glass flow, and `boundaries.test.ts` guards its name against ever becoming a sign-in (§3.4a). The `SECRETS.md` edit says both things: the second URI, and that `REFRESH_TOKEN` is now used only by the scripts.
