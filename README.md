# ev-app

Self-hosted telemetry recording for an electric car. It streams live signals out
of a Tesla, stores every sample in Postgres, derives drives, charges and
battery-health trends from that stream, and shows them on a small website behind
your own SSO.

It exists because **neither Tesla nor Rivian stores history for you.** Both APIs
are live-only: every drive list and charging curve you see in a commercial
product was derived from a stream that product recorded. If nothing is
recording, the data is gone permanently. So ingestion is the part that has to
work; the website is the easy half.

Status: running in production for one car. Tesla is implemented end to end and
read-only. Rivian is a designed seam with no implementation behind it.

---

## How it works

```
  Tesla vehicle
      │  mTLS websocket, protobuf  (the car dials out; nothing polls it)
      ▼
  fleet-telemetry          upstream tesla/fleet-telemetry, terminates mTLS
      │  MQTT, QoS 1, reliable_ack
      ▼
  Mosquitto                persistent session, so a restart loses nothing
      │
      ▼
  ev-ingest                decode → normalise → sample → sessionise
      │
      ▼
  Postgres 17              monthly partitions, BRIN indexes
      ▲
      │  SQL
  ev-web                   SvelteKit: UI + /api/v1, OIDC sign-in
```

Two properties are worth knowing before you judge the design:

- **Streaming, not polling.** Polling the Fleet API is metered per request and
  risks waking the car (which costs range and money). Streamed signals are
  effectively free and never wake it.
- **`reliable_ack` covers the broker, not the worker.** The receiver only
  acknowledges a message to the car once the broker has accepted it, so a
  broker outage means the car buffers its own messages (~5,000 of them, roughly
  40 minutes) rather than dropping them. A stalled worker is different: the
  broker keeps accepting into the worker's durable queue (100,000 messages or
  128 MiB) and drops past that while still acknowledging, so the car holds
  nothing back. Deploys and crashes cost nothing; a worker down for longer than
  the queue holds loses data for good, which is why production alerts on a
  worker that is not consuming.

---

## What you need before you start

This is not a one-command install. It talks to a real car through Tesla's Fleet
API, which imposes most of the prerequisites:

1. **A Tesla developer application.** Free, at
   [developer.tesla.com](https://developer.tesla.com). You need a client ID and
   secret.
2. **A public domain you control**, with two names pointing at your deployment —
   one for the web app, one for the telemetry collector. Tesla will not let you
   register the application until your *public key* is already being served from
   the app's domain, which inverts the obvious order: the site has to be live
   before any Tesla work can begin.
3. **Somewhere to run four long-lived things**: Postgres, an MQTT broker,
   `tesla/fleet-telemetry`, and this repo's two services. The production
   deployment is Kubernetes (k3s, CNPG, ArgoCD), but nothing here requires it —
   the services are plain containers that read environment variables.
4. **An OIDC provider with discovery and PKCE.** The deployment uses
   [Pocket-ID](https://github.com/pocket-id/pocket-id); any compliant provider
   works. There is no local password login, by design.
5. **A compatible car.** Fleet Telemetry needs firmware ≥ 2024.26 and a paired
   virtual key. A 2022 Model Y on current firmware is the reference vehicle.

Optional: a free [NREL/OpenEI](https://openei.org/services/) API key, which
lets charges be priced from your utility's published rates instead of a rate you
type in yourself.

---

## Repo layout

```
apps/web         SvelteKit site and /api/v1  (also serves the Tesla public key)
apps/ingest      MQTT subscriber: decode, normalise, sessionise
packages/core    canonical model + the sessionisation engine (no I/O)
packages/db      schema, migrations, repositories
packages/tesla   Fleet API client, signal catalogue, telemetry config
scripts          operational scripts for pairing, pushing config, verifying
docs             the design specs this was built from — read these
```

`packages/core` is deliberately a package rather than a service: it is imported
by the ingest worker on the write path, and the web app never imports it (the
web reads derived tables). That seam is what keeps "one TypeScript app"
reversible.

---

## Local development

Requires Node 22+ and pnpm.

```sh
pnpm install
pnpm -r build          # packages/* emit to dist/ and the apps import from there
pnpm typecheck
pnpm test
```

Most of the suite runs with no services. The schema and read-API tests need a
real Postgres and **skip themselves silently without one**, so run them against
a throwaway database before trusting a green run:

```sh
docker run --rm -d -p 55432:5432 \
  -e POSTGRES_USER=ev -e POSTGRES_PASSWORD=ev -e POSTGRES_DB=ev \
  --name ev-pg postgres:17-alpine

PGHOST=localhost PGPORT=55432 PGUSER=ev PGPASSWORD=ev PGDATABASE=ev pnpm test
```

CI does exactly this (`.github/workflows/test.yml`).

To run the website against that database:

```sh
cd apps/web && pnpm dev
```

It will refuse to start a sign-in until the OIDC variables below are set.

---

## Configuration

Everything is environment variables; there is no config file. Nothing has a
default that would be wrong-but-plausible — where a guess could silently corrupt
a derived number, the service refuses to start instead.

### ev-web

| Variable | Required | Notes |
|---|---|---|
| `APP_ORIGIN` | yes | e.g. `https://ev.example.com`. **Not** `PUBLIC_ORIGIN` — SvelteKit strips that prefix from the private environment, and it cost one production outage. |
| `POCKETID_ISSUER` | yes | OIDC issuer URL; discovery is fetched from it. |
| `POCKETID_CLIENT_ID` | yes | |
| `POCKETID_CLIENT_SECRET` | yes | |
| `ALLOWED_SUBJECT` | yes | The one OIDC subject allowed in. This app is single-tenant; there is no user table. |
| `SESSION_KEY` | yes | Random secret; signing and encryption keys are derived from it. |
| `TESLA_CLIENT_ID` | yes | From your Tesla developer application. |
| `TESLA_CLIENT_SECRET` | yes | |
| `TESLA_REDIRECT_URI` | yes | Must match Tesla byte for byte, e.g. `https://ev.example.com/settings/telemetry/callback`. |
| `TESLAPROXY_URL` | yes | Your `tesla/vehicle-command` proxy, which holds the signing key. |
| `EV_TELEMETRY_HOSTNAME` | to push config | The public name **the car dials**, e.g. `ev-telemetry.example.com`. Pushing a configuration without it is refused: Tesla would accept an empty hostname and the car would then stream to nowhere. |
| `EV_TELEMETRY_PORT` | no | Defaults to 443, which is the only port guaranteed to survive whatever network the car is on. |
| `PGHOST` `PGPORT` `PGUSER` `PGPASSWORD` `PGDATABASE` | yes | Standard libpq names. `PGPOOL_MAX` tunes the pool. |

### ev-ingest

| Variable | Required | Notes |
|---|---|---|
| `EV_VEHICLE_ID` | yes | Your stable id for the car; also the display name unless `EV_VEHICLE_NAME` is set. |
| `EV_USABLE_CAPACITY_KWH` | yes | **No default on purpose.** A guessed capacity rescales every drive's energy and efficiency figure, and the error is plausible enough never to be noticed. |
| `MQTT_PASSWORD` | yes | |
| `MQTT_URL` | no | Defaults to the in-cluster broker. |
| `MQTT_USERNAME` | no | Defaults to `telemetry`. |
| `MQTT_CLIENT_ID` | no | Defaults to `ev-ingest`. It must **not** be `ev-fleet-telemetry`: MQTT allows one connection per client id, so sharing it makes the two evict each other in a permanent loop where both look healthy alone. |
| `MQTT_TOPIC` | no | Defaults to `ev/#`. |
| `EV_VEHICLE_VIN` | no | Optional. Used to key the vehicle row; the app works without it. |
| `EV_HOME_LAT` / `EV_HOME_LON` | no | All or nothing — half a coordinate is not a location, and ignoring the set half fails invisibly. Enables "charged at home" classification. |
| `EV_HOME_RADIUS_KM` | no | Defaults to 0.1 — a driveway, not a postcode. |
| `OPENEI_API_KEY` | no | Without it, charge pricing falls back entirely to the rate you enter in the UI, which is still a working product. |
| `METRICS_PORT` | no | Prometheus endpoint, default 9090. |

---

## Deploying

Three images build from this repo:

```sh
docker build -f apps/web/Dockerfile     -t ev-web .
docker build -f apps/ingest/Dockerfile  -t ev-ingest .
docker build -f packages/db/Dockerfile  -t ev-migrator .
```

`.github/workflows/images.yml` publishes all three to GHCR under your own
GitHub owner, on version tags only — a `main` build never publishes.

Run the migrator before the services on every upgrade:

```sh
pnpm --filter @ev/db migrate
```

Migrations take a Postgres advisory lock, so several callers racing is safe.

**Kubernetes manifests are not in this repo.** The production deployment keeps
them in a separate GitOps repo synced by ArgoCD, so an image-tag bump and a code
change stay separate decisions with separate review. What you need to recreate
is described in `docs/superpowers/specs/2026-09-04-ev-app-design.md` §3.2 and §6
— workloads, ingress, and the TLS-passthrough route that lets fleet-telemetry do
its own mTLS.

---

## Tesla setup, in the order it actually works

1. **Generate your own application keypair.** The file at
   `apps/web/static/.well-known/appspecific/com.tesla.3p.public-key.pem` is a
   placeholder from another deployment — **replace it.** Its private half must
   never enter this repo; `.gitignore` already refuses `tesla-private-key.pem`.
2. **Deploy the website first**, so that key is served over HTTPS at that exact
   path. Tesla checks it before it will register anything.
3. **Register the application** at developer.tesla.com against your domain.
   Request `openid`, `offline_access`, `vehicle_device_data`, `vehicle_location`
   — and deliberately **not** `vehicle_cmds` or `vehicle_charging_cmds`. This
   app is read-only, and the grant is the only place that is enforced: no
   manifest records the scope set, and a token carrying command scopes behaves
   identically until something calls a command endpoint.
4. **Pair the virtual key** with the car, from the Tesla mobile app on a phone
   standing next to it. Pairing does not grant command ability — that comes from
   scope, which you withheld in step 3 — but telemetry configuration must be
   signed by the paired key, so streaming is impossible without it.
5. **Sign in and connect** at `/settings/telemetry`, which runs the OAuth flow
   and pushes the telemetry configuration for you. `scripts/` holds the
   break-glass equivalents (`push-telemetry-config.sh`,
   `check-telemetry-synced.sh`, `verify-teslaproxy.sh`) for when the UI cannot
   reach the car.

The signal list is not in any script. It is `packages/tesla/src/catalogue.ts`,
the single source for what the car is asked to send, what the decoder expects,
and what the schema stores — the three have to agree, and a shell script cannot
be checked against a database.

---

## Documentation

`docs/` holds the design specs the app was built from, and they carry the
reasoning this README only summarises:

- `specs/2026-09-04-ev-app-design.md` — the whole system, and why each choice
  beat the alternative it was weighed against
- `specs/2026-09-05-full-signal-capture-design.md` — the signal catalogue
- `specs/2026-09-05-realtime-updates-design.md` — SSE and the live indicator
- `specs/2026-09-05-telemetry-config-in-the-web-app-design.md` — moving the push
  out of a shell script
- `specs/2026-09-07-charge-cost-design.md` — pricing a charge, and saying why
  when it cannot
- `research/2026-09-04-tesla-rivian-api-investigation.md` — the API landscape,
  including what the commercial products do and what the legacy Owner API no
  longer does

---

## Scope

**Read-only, on purpose.** No vehicle commands, now or planned.

**Single user.** One OIDC subject, no user table, no roles, no tenancy. Running
this for two people means writing that.

**Tesla only, so far.** The canonical model and adapter interface accommodate
Rivian; no Rivian code exists.

**No trip planning.** ABRP exists and is better.
