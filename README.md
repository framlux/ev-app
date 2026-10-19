# ev-app

Self-hosted telemetry recording for an electric car. It streams live signals out
of a Tesla (and, once it is delivered, a Rivian), stores every sample in
Postgres, derives drives, charges and battery-health trends from that stream,
and shows them on a small website behind your own SSO.

It exists because **neither Tesla nor Rivian stores history for you.** Both APIs
are live-only: every drive list and charging curve you see in a commercial
product was derived from a stream that product recorded. If nothing is
recording, the data is gone permanently. So ingestion is the part that has to
work; the website is the easy half.

Status: running in production for one car. Tesla is implemented end to end and
read-only. Rivian ingestion is implemented, read-only, and awaiting delivery of
the car: it has been built and tested against fakes and synthetic payloads, and
has not yet seen the live gateway or a real vehicle's data.

---

## How it works

```
  Tesla vehicle                           Rivian cloud
      │  mTLS websocket, protobuf             │  websocket + HTTPS, signed in
      │  (the car dials out;                  │  as you; one session held
      │  nothing polls it)                    │  open, round the clock
      ▼                                       ▼
  fleet-telemetry                         ev-rivian
  upstream tesla/fleet-telemetry,         stamps each frame, publishes it
  terminates mTLS                         verbatim, decodes nothing
      │  MQTT, QoS 1, reliable_ack            │  MQTT, QoS 1
      │  topic ev/#                           │  topic rivian/<VIN>/<stream>
      ▼                                       ▼
  ┌──────────────────────────────────────────────────────────────────────────┐
  │ Mosquitto   persistent sessions, so a restart loses nothing              │
  └──────────────────────────────────────────────────────────────────────────┘
      │  subscribes to ev/#                   │  subscribes to rivian/#
      ▼                                       ▼
  ev-ingest                               ev-ingest-rivian
  EV_VENDOR=tesla                         EV_VENDOR=rivian
  one image, a Deployment per vendor: decode → normalise → sample → sessionise
      │                                       │
      └───────────────────┬───────────────────┘
                          ▼
                     Postgres 17    monthly partitions, BRIN indexes
                          ▲
                          │  SQL
                     ev-web         SvelteKit: UI + /api/v1, OIDC sign-in,
                                    and the Rivian sign-in page
```

Three properties are worth knowing before you judge the design:

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
- **Rivian is the opposite case, and holds a credential.** Nothing arrives from
  Rivian unless a signed-in session is kept open around the clock, and nothing
  on Rivian's side buffers, so `ev-rivian` stays up and does as little as it
  can: it stamps each frame and publishes it verbatim, and ingest does the
  decoding. The session token is sealed by `ev-web` to the connector's public
  key, so the web pod can store it and can never read it back. The broker is the
  only buffer: the connector holds at most 32 MiB of frames while the broker is
  away, then drops the oldest and counts them. The alert on that count is one to
  create (it is on the list under "Rivian setup"), not one that already exists.

---

## What you need before you start

This is not a one-command install. It talks to a real car through Tesla's Fleet
API, which imposes most of the prerequisites (a Rivian needs fewer, listed
after these):

1. **A Tesla developer application.** Free, at
   [developer.tesla.com](https://developer.tesla.com). You need a client ID and
   secret.
2. **A public domain you control**, with two names pointing at your deployment —
   one for the web app, one for the telemetry collector. Tesla will not let you
   register the application until your *public key* is already being served from
   the app's domain, which inverts the obvious order: the site has to be live
   before any Tesla work can begin.
3. **Somewhere to run four long-lived things**: Postgres, an MQTT broker,
   `tesla/fleet-telemetry`, and this repo's two services. A Rivian adds two more
   containers of this repo's own: the `ev-rivian` connector, and a second
   `ev-ingest` Deployment. The production deployment is Kubernetes (k3s, CNPG,
   ArgoCD), but nothing here requires it — the services are plain containers
   that read environment variables.
4. **An OIDC provider with discovery and PKCE.** The deployment uses
   [Pocket-ID](https://github.com/pocket-id/pocket-id); any compliant provider
   works. There is no local password login, by design.
5. **A compatible car.** Fleet Telemetry needs firmware ≥ 2024.26 and a paired
   virtual key. A 2022 Model Y on current firmware is the reference vehicle.

Optional: a free [NREL/OpenEI](https://openei.org/services/) API key, which
lets charges be priced from your utility's published rates instead of a rate you
type in yourself.

**For a Rivian** the list is shorter. There is no developer application to
register, no public key to serve and no virtual key to pair. You need the car's
VIN, the email and password of the Rivian account that holds it (and a phone for
the one-time code, if that account has a second factor), and the same Postgres,
broker, OIDC provider and web app as above. What the connector talks to is the
API Rivian's own app uses: it is unpublished and unsupported, and it can change
or close without notice.

---

## Repo layout

```
apps/web         SvelteKit site and /api/v1  (also serves the Tesla public key,
                 and the Rivian sign-in page)
apps/ingest      MQTT subscriber: decode, normalise, sessionise; one image, a
                 Deployment per vendor
apps/rivian      Rivian connector: holds one signed-in session open and
                 publishes every frame it receives to MQTT
packages/core    canonical model + the sessionisation engine (no I/O)
packages/db      schema, migrations, repositories
packages/rivian  Rivian client, signal catalogue, normaliser, credential
                 sealing, Parallax wire decoder
packages/tesla   Fleet API client, signal catalogue, telemetry config
scripts          operational scripts for pairing, pushing config, verifying,
                 and generating the Rivian credential keys
docs             the design specs this was built from — read these
```

`packages/core` is deliberately a package rather than a service: it is imported
by the ingest worker on the write path, and the web app never imports it (the
web reads derived tables). That seam is what keeps "one TypeScript app"
reversible.

Each vendor's facts live in its own package (`packages/tesla`,
`packages/rivian`). Ingest reaches them through one `VendorProfile` per vendor,
chosen by `EV_VENDOR`, and the engine behind it reasons only in canonical
values.

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

Each vitest project that writes to Postgres (`@ev/db`, `@ev/ingest`, `web` and
`@ev/rivian-connector`) is given a database of its own,
`<PGDATABASE>_test_<project>` (`ev_test_web`, `ev_test_rivian` and so on),
dropped and recreated at the start of every run. The projects run at the same
time, and sharing one database made unrelated tests fail intermittently on each
other's rows. It means the role needs `CREATEDB` (the container's `ev` user has
it), the `PGDATABASE` you name is only used to connect and create, and two test
runs against one server at the same moment will drop each other's databases.

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
| `RIVIAN_CREDENTIAL_PUBLIC_KEY` | to sign in to Rivian | The **public** half of the credential keypair, as one line of JSON, from `scripts/rivian-keygen.mjs`. Unset, a sign-in attempt answers that Rivian sign-in is not configured on this server, and nothing else is affected. Set but unusable (damaged JSON, the wrong curve, a private key), the first sign-in fails with only a generic error in the browser (`Internal Error`, or `the request failed (500)`); the web pod's log has the line `RIVIAN_CREDENTIAL_PUBLIC_KEY is not usable: …` naming the variable and what is wrong with it, and signing out still works. A private key is refused here on purpose: a web pod that held it could read back every credential it writes. It must be the public half of the **same** `scripts/rivian-keygen.mjs` run as the connector's private key (see "Rivian setup", step 1). The web pod also needs outbound HTTPS to `rivian.com`, because it performs the sign-in itself. |
| `PGHOST` `PGPORT` `PGUSER` `PGPASSWORD` `PGDATABASE` | yes | Standard libpq names. `PGPOOL_MAX` tunes the pool. |

### ev-ingest

One image, run once per vendor: a Tesla Deployment and a Rivian Deployment
differ only in their environment.

| Variable | Required | Notes |
|---|---|---|
| `EV_VENDOR` | yes | `tesla` or `rivian`. **No default on purpose.** It picks the decoder, the topic parser and the `vendor` stamped on the tape and the vehicle row, and a default would let a manifest that forgot it tape one car's payloads as the other's, silently and for good. |
| `EV_VEHICLE_ID` | yes | Your stable id for the car; also the display name unless `EV_VEHICLE_NAME` is set. **One id, one car**: a Rivian worker needs an id that is new and unique, never the Tesla's. Every table is keyed by it and registering an existing id changes nothing, so a worker that reused another car's id would file its tape and samples under that car, silently and for good. The worker therefore reads the row at startup (`reprocess`, `backfill-costs` and `parallax-dump` do the same, before they delete or write anything) and refuses to run if the row belongs to the other vendor, or if both it and `EV_VEHICLE_VIN` hold a VIN and they differ. The error names `EV_VEHICLE_ID`, `EV_VENDOR` and `EV_VEHICLE_VIN` and quotes no value. An id with no row yet is fine. |
| `EV_USABLE_CAPACITY_KWH` | yes | **No default on purpose.** A guessed capacity rescales every drive's energy and efficiency figure, and the error is plausible enough never to be noticed. For a Rivian it depends on the pack that was ordered, so only you can supply it. |
| `MQTT_PASSWORD` | yes | |
| `MQTT_URL` | no | Defaults to the in-cluster broker. |
| `MQTT_USERNAME` | no | Defaults to `telemetry`. |
| `MQTT_CLIENT_ID` | no | Defaults to `ev-ingest` for Tesla and `ev-ingest-rivian` for Rivian. Startup refuses the receiver's `ev-fleet-telemetry`, the connector's `ev-rivian`, and the other vendor's id: MQTT allows one connection per client id, so sharing one makes two processes evict each other in a permanent loop where both look healthy alone, and a Rivian worker that took `ev-ingest` would be handed the Tesla backlog and acknowledge it as parse failures. |
| `MQTT_TOPIC` | no | Defaults to `ev/#` for Tesla and `rivian/#` for Rivian. Startup refuses a topic outside the vendor's own tree (`ev/` or `rivian/`), a bare `#` included, for the same reason. |
| `EV_CURSOR_SOURCE` | no | The key the worker files its resume watermark under, in `ingest_cursor`. Defaults to `tesla:mqtt` for Tesla (what it has always been) and `rivian:mqtt` for Rivian, so two workers never share one. |
| `EV_VEHICLE_VIN` | Rivian: yes | Optional for Tesla, where it only keys the vehicle row and the app works without it. Required for Rivian: it is the vehicle's vendor id and what the worker checks every topic against, and without it frames for any VIN on `rivian/#` would be taped as this car's, so the worker refuses to start. Upper-cased at startup for both vendors, as the connector's is, so the two always agree on the topic. |
| `EV_HOME_LAT` / `EV_HOME_LON` | no | All or nothing — half a coordinate is not a location, and ignoring the set half fails invisibly. Enables "charged at home" classification. |
| `EV_HOME_RADIUS_KM` | no | Defaults to 0.1 — a driveway, not a postcode. |
| `OPENEI_API_KEY` | no | Without it, charge pricing falls back entirely to the rate you enter in the UI, which is still a working product. |
| `METRICS_PORT` | no | Prometheus endpoint, default 9090. |

The backfill-costs job (`apps/ingest/dist/backfill-costs.js`), `reprocess` and
`parallax-dump` read this same configuration, so each of them also needs
`EV_VENDOR` now.

### ev-rivian

The connector. It holds the one Rivian websocket, publishes what arrives to
`rivian/<VIN>/<stream>`, and reads its credential from Postgres.

| Variable | Required | Notes |
|---|---|---|
| `EV_VEHICLE_VIN` | yes | The car to find. Never guessed: an account can hold several. Letters and digits only, because it becomes a segment of the MQTT topic and a `/`, `+` or `#` in it would publish somewhere ingest is not listening. Upper-cased at startup, because ingest upper-cases its own and a lower-case topic would publish where nothing listens. It is also what the settings page shows as the VIN, in every state, including the ones before the car has been found. |
| `RIVIAN_CREDENTIAL_PRIVATE_KEY` | yes | The **private** half of the credential keypair, as one line of JSON, from `scripts/rivian-keygen.mjs`. Checked as a P-256 key at startup. It goes to this pod only, never to `ev-web`. |
| `MQTT_PASSWORD` | yes | |
| `MQTT_URL` | no | Defaults to the in-cluster broker. |
| `MQTT_USERNAME` | no | Defaults to `rivian`. |
| `MQTT_CLIENT_ID` | no | Defaults to `ev-rivian`. Startup refuses `ev-fleet-telemetry`, `ev-ingest` and `ev-ingest-rivian`: an id that belongs to another process would evict it, or inherit its durable session. |
| `RIVIAN_PARALLAX_RVMS` | no | Comma-separated Parallax topic filter. Unset, empty or only commas means every topic. An escape hatch if Parallax turns out to be too chatty. |
| `PGHOST` `PGPORT` `PGUSER` `PGPASSWORD` `PGDATABASE` | yes | Standard libpq names. It reads the credential and writes its status here. |
| `METRICS_PORT` | no | Prometheus endpoint, default 9090; it also serves `/healthz`. Must be a port number, 0 to 65535. |

Metrics, all created at startup so that "never" is a value an alert can see:
`rivian_connector_state{state}` (one-hot), `rivian_frames_total{stream}`,
`rivian_frames_dropped_total`, `rivian_publish_failures_total`,
`rivian_reconnects_total{reason}`, `rivian_dropped_properties`,
`rivian_credential_poll_failures_total`, `rivian_last_frame_timestamp_seconds`
and `rivian_mqtt_connected`. The last is the only sign of a wrong broker
password, which makes the client retry for ever without failing a single frame.

---

## Deploying

Four images build from this repo:

```sh
docker build -f apps/web/Dockerfile     -t ev-web .
docker build -f apps/ingest/Dockerfile  -t ev-ingest .
docker build -f apps/rivian/Dockerfile  -t ev-rivian .
docker build -f packages/db/Dockerfile  -t ev-migrator .
```

`ev-ingest` serves both vendors: a Rivian car gets a second Deployment of the
same image with `EV_VENDOR=rivian`, and `ev-rivian` is the connector it reads
from.

`.github/workflows/images.yml` publishes all four to GHCR under your own
GitHub owner, on version tags only — a `main` build never publishes.

Run the migrator before the services on every upgrade:

```sh
pnpm --filter @ev/db migrate
```

Migrations take a Postgres advisory lock, so several callers racing is safe.

### Upgrading a Tesla-only deployment to this release

The order matters, because the new `ev-ingest` image refuses to start without
`EV_VENDOR` and the old one would write Tesla gear values in the old form after
migration `008`:

1. **Scale `ev-ingest` to 0.** The broker keeps queueing the Tesla messages in
   the worker's durable session, up to the 100,000 messages or 128 MiB described
   under "How it works", so keep the gap short. A worker at zero replicas is
   exactly what the existing worker-not-consuming alert fires on, so expect it,
   or silence it for the length of the upgrade.
2. **Run the migrator.** `008` rewrites each stored Tesla gear from its raw
   string (`ShiftStateD`) to the canonical `P`, `R`, `N` or `D`, and anything
   unmatched (`ShiftStateSNA`) becomes NULL, which is what the decoder now
   writes for it. `009` adds `rivian_credential` and `rivian_status`.
3. **Deploy `ev-ingest` on the new image with `EV_VENDOR=tesla`.** Its client
   id, topic and cursor defaults are the Tesla ones it always had, so nothing
   else in its configuration changes and it resumes from its own watermark.
4. **Confirm it drains the backlog.**

Anything else that runs from the ingest image needs `EV_VENDOR` as well: the
backfill-costs job, and `reprocess` if you run it by hand.

**Kubernetes manifests are not in this repo.** The production deployment keeps
them in a separate GitOps repo synced by ArgoCD, so an image-tag bump and a code
change stay separate decisions with separate review. What you need to recreate
is described in `docs/superpowers/specs/2026-09-04-ev-app-design.md` §3.2 and §6
— workloads, ingress, and the TLS-passthrough route that lets fleet-telemetry do
its own mTLS — and, for the Rivian workloads, in the list under "Rivian setup"
below.

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

## Rivian setup, in the order it actually works

Everything here is read-only: the connector sends no commands, enrols no phone
key and uses no Bluetooth. The pieces the two cars share (Postgres, the broker,
OIDC, the web app) are set up once, as above; what follows is only what Rivian
adds.

1. **Generate the credential keypair, once.**

   ```sh
   pnpm --filter "@ev/rivian..." build   # or pnpm -r build
   node scripts/rivian-keygen.mjs
   ```

   It prints two lines, each ready to paste as an environment variable. The
   `RIVIAN_CREDENTIAL_PRIVATE_KEY` line goes into the connector's SealedSecret
   and nowhere else; `RIVIAN_CREDENTIAL_PUBLIC_KEY` goes to `ev-web`. The script
   writes no file, so the only copy of the private key is the one you store.
   Anyone holding it can read the stored Rivian session: keep it out of chats,
   tickets and terminals whose output is logged. The two lines are a pair, so
   take both from **one** run. A public key from one run and a private key from
   another seals every sign-in to a key the connector cannot open, and the
   connector reports `credential_invalid` even straight after a fresh sign-in:
   that is the usual cause of it on a first setup, and signing in again cannot
   fix it. Running the script again makes a *new* pair, and a credential sealed
   to the old public key will not open with the new private one, so the
   connector reports `credential_invalid` until someone signs in again. Rotate
   on purpose.
2. **Deploy the workloads.** None of this is in this repo, and nothing changes
   in production without your go-ahead. Two things on the list only you can
   supply: the manifests themselves, and `EV_USABLE_CAPACITY_KWH`, which has no
   default and depends on the pack you ordered.
   - **`ev-rivian`**: one replica with a `Recreate` strategy, since two
     connectors would hold two sockets on one session; the private key in a
     SealedSecret; its own MQTT user (`rivian`); `PG*`; `EV_VEHICLE_VIN`. Its
     probe on the metrics port says the process is up, not that a session is
     held — `rivian_connector_state` says that.
   - **`ev-ingest-rivian`**: the `ev-ingest` image with `EV_VENDOR=rivian`;
     `EV_VEHICLE_ID` (for example `r2`: **new and unique, never the Tesla's**,
     since the worker refuses to start against a row that belongs to the other
     vendor or has a different VIN), `EV_VEHICLE_VIN`, `EV_VEHICLE_NAME`;
     `EV_USABLE_CAPACITY_KWH`; the home location, as for the Tesla. Leave
     `MQTT_CLIENT_ID`, `MQTT_TOPIC` and `EV_CURSOR_SOURCE` unset: the Rivian
     defaults are the safe ones.
   - **`ev-web`**: `RIVIAN_CREDENTIAL_PUBLIC_KEY`.
   - **Mosquitto**: user `rivian` may publish to `rivian/#`; the ingest user may
     subscribe to `rivian/#`; per-client queue limits for `ev-ingest-rivian`
     matching `ev-ingest`'s.
   - **Alerts**: the connector in `backing_off`, `unauthenticated` or
     `credential_invalid` for over 15 minutes; any increase in
     `rivian_frames_dropped_total`; `rivian_mqtt_connected == 0` for more than
     a few minutes, which is the only sign of a wrong broker password (the
     client retries for ever and no frame fails, so nothing else moves). The
     existing stall alert already covers `ev-ingest-rivian` through its
     `vehicle` label, but it must **exclude the Rivian until delivery**, because
     before then no samples is the correct state.
3. **Sign in** at `/settings/rivian`. The Rivian vehicle's Settings tab leads
   there, but the vehicle only exists once `ev-ingest-rivian` has started and
   registered it, so deploy that first (or open the URL directly: the page does
   not depend on the vehicle). The web pod signs in to Rivian itself, so it
   needs outbound HTTPS to `rivian.com`. Use the owner account until the car is
   delivered: whether a secondary-driver account can see an undelivered car is
   unknown, and after delivery a secondary-driver account can be revoked from
   the Rivian app without changing the owner's password. If the account has a
   second factor the page asks for the code next; that half-made sign-in is held
   in the web pod's memory for 10 minutes, and a restart loses it at the cost of
   a retry. The password is never stored, logged or echoed. What is stored is
   the session token, sealed to the connector's key, and the connector picks it
   up within 15 seconds. Signing out deletes it and the connector closes its
   socket in the same interval, so nothing is recorded while signed out. If the
   web pod were compromised it would see the *next* sign-in in plaintext,
   because it performs the sign-in; revoking the session from the Rivian app is
   the remedy.
4. **Check the plumbing, before the car is delivered.** The account has nothing
   to stream yet, but these show the rest works:
   1. The settings page shows the account you signed in with.
   2. The connector's state on that page reaches `waiting_for_vehicle` (the
      VIN is not on the account yet, and it asks again every hour) or
      `subscribed`. The VIN tile shows the VIN the connector was configured to
      look for, in every state. `credential_invalid` straight after a first
      sign-in means the web's public key and the connector's private key came
      from different keygen runs (step 1), which signing in again cannot fix.
   3. The tape holds the account's vehicles, taped by `ev-ingest-rivian`:

      ```sql
      SELECT received_at, payload->'body'->'data' AS user_info
      FROM raw_message
      WHERE vendor = 'rivian'
        AND payload->>'stream' = 'meta'
        AND payload->'body'->>'kind' = 'userInfo'
      ORDER BY received_at DESC LIMIT 1;
      ```
   4. Once the car is listed (so **not** while the state is
      `waiting_for_vehicle`, where nothing has been subscribed and the page says
      "not probed yet"), `dropped_properties` on the page, and the latest
      `meta.schema` record on the tape, show what the gateway accepts today. A
      non-empty dropped list is the connector working as designed: it found a
      field Rivian rejects, and stopped asking for it.

Parallax, Rivian's opaque channel, is taped verbatim and decoded by nothing.
`parallax-dump` reads the tape back as schema-less protobuf trees, so that what
is in a topic can be worked out from the tape:

```sh
# from a checkout (after pnpm -r build)
pnpm --filter @ev/ingest parallax-dump -- --rvm <topic> \
  [--from <date>] [--to <date>] [--limit <n>]

# inside the ingest pod, which has no pnpm: the image's WORKDIR is /app
node apps/ingest/dist/parallax-dump.js --rvm <topic> \
  [--from <date>] [--to <date>] [--limit <n>]
```

It loads the ingest worker's configuration (so `EV_VENDOR=rivian` and the rest
of that table), and it is read-only, so it is safe to run in the ingest pod
beside the live worker.

### Reading what the connector reports

The page's State, Last error, Backing off until and Dropped properties come
from the connector's own row, `rivian_status`, and each has a meaning that is
easy to misread.

- **State.** `subscribed` only says the socket was acknowledged, and it stays
  that when the server then refuses or ends every subscription. The page
  therefore calls it *Streaming* only once a frame is on record, and otherwise
  says *Subscribed, no frame yet*. A `signed_out` row beside a stored credential
  means the connector has not yet read the new sign-in (it polls every 15 s),
  not that nothing was saved.
- **A dead session.** `unauthenticated` is Rivian refusing the saved session:
  a websocket close with code 4401 or 4403 (whatever its text says), an HTTP
  401 with no Rivian error code, or a subscription refused as `UNAUTHENTICATED`.
  The connector stops and waits for a new sign-in (sign out, then sign in)
  instead of retrying, because retrying a dead session is how accounts get
  flagged.
- **A refused subscription** shows as `last_error` on the page, as
  `subscription <stream> refused: <CODE>`, and as a line in the connector's log,
  and it clears when that subscription is next heard from. Each refused or ended
  subscription retries on **its own** backoff, 30 s doubling with up to 30 s of
  jitter and capped at 900 s, reset by its own next frame, so one bad stream
  never slows another and a stream that is refused for ever settles at one
  attempt per 15 minutes. A subscription the server merely ends carries no
  code, so it retries on the same backoff and leaves `last_error` alone. The
  state stays `subscribed` throughout, which is why *Last error* is the place
  to look.
- **A restart does not cut a backoff short.** The connector saves
  `backoff_until` and honours it after a restart, so a deploy or a crash loop
  cannot become the reconnect storm the backoff exists to prevent.
- **Dropped properties** are the `vehicleState` fields Rivian rejected by name.
  The connector finds them by splitting a rejected group, saves the list in
  `rivian_status.dropped_properties`, reads it back at start, and tries each
  saved name again an hour after start (spread over the hour after that); a
  newly dropped name is tried again after a day. Before the connector has
  subscribed to anything the page says *not probed yet*, not *None*.
- **Whole-request rejection drops nothing.** If Rivian rejects *every*
  `vehicleState` group of a subscribe (or a group on every one of its
  properties), the fault is the request and not any field, so the connector
  drops nothing. When every group is rejected it also subscribes a one-property
  `batteryLevel` canary: a canary refused too means the documents are wrong,
  and one accepted means each group has a bad field of its own, so the search
  goes ahead. `last_error` says `every vehicleState group refused:
  GRAPHQL_VALIDATION_FAILED` (or `the vehicleState canary refused: …`), and the
  groups retry on the per-subscription backoff until a state frame shows the
  documents are fine.
- **Clearing a dropped list.** After fixing the cause (a list saved by an
  earlier build, say), stop the connector, run `UPDATE rivian_status SET
  dropped_properties = '{}';`, and start it. The connector rewrites the whole
  row from memory, so an UPDATE under a running connector is overwritten again,
  and the list is read only at start. Left alone, saved names are re-probed an
  hour after each start in any case.
- **A parked car keeps its levels for seven days.** Rivian streams changes
  only, so a car that has not moved says nothing new about its state of charge,
  odometer, position or tyres for as long as it sits. Ingest carries those
  levels for up to 7 days from when each last changed (speed, heading and charge
  power for five minutes, the charge words for six hours, so a stale word cannot
  hold a session open). After an ingest restart the connector's resubscribe,
  which it makes after every 60 s without a frame, re-sends the levels.

### What is not known until the car is real

Nothing here has run against the live account or a real payload. The decoder's
field shapes, units and enum values come from community documentation of the
R1 and are hypotheses for the R2 until the tape confirms them; each correction
is a migration plus `reprocess`. Two things in particular need a live check:

- **The `getCompletedSessionSummaries` selection is unverified.** The field
  names are what the app is known to show, not taken from a schema, because the
  gateway schema snapshot does not cover the charging endpoint. If Rivian
  rejects the selection, the connector logs it and tries again six hours later;
  nothing else is affected.
- **Whether `chargingSession` is live, and every other subscription besides
  `vehicleState` and `parallaxMessages`, is unverified.** A subscription Rivian
  rejects as invalid is marked unavailable and retried daily; one it refuses for
  another reason is retried on its own backoff and named in *Last error* (see
  "Reading what the connector reports"). If `chargingSession` is
  rejected, charge power and energy stay unknown until the Parallax topics that
  carry them are found with `parallax-dump` and mapped.

Also open: whether an undelivered car is listed on the account at all (the
connector copes with both), whether introspection is allowed, what an expired
session looks like on the wire, and Rivian's rate-limit thresholds.

---

## Documentation

`docs/` holds the design specs the app was built from (and the plan for the
Rivian work), and they carry the reasoning this README only summarises:

- `specs/2026-09-04-ev-app-design.md` — the whole system, and why each choice
  beat the alternative it was weighed against
- `specs/2026-09-05-full-signal-capture-design.md` — the signal catalogue
- `specs/2026-09-05-realtime-updates-design.md` — SSE and the live indicator
- `specs/2026-09-05-telemetry-config-in-the-web-app-design.md` — moving the push
  out of a shell script
- `specs/2026-09-07-charge-cost-design.md` — pricing a charge, and saying why
  when it cannot
- `specs/2026-10-19-rivian-ingestion-design.md` — the Rivian connector, the
  sealed credential, the vendor-generalised ingest, and what could not be tested
  before the car exists
- `plans/2026-10-19-rivian-ingestion.md` — the implementation plan for it,
  task by task
- `research/2026-09-04-tesla-rivian-api-investigation.md` — the API landscape,
  including what the commercial products do and what the legacy Owner API no
  longer does

---

## Scope

**Read-only, on purpose.** No vehicle commands, now or planned.

**Single user.** One OIDC subject, no user table, no roles, no tenancy. Running
this for two people means writing that.

**Tesla in production, Rivian awaiting delivery.** Both are implemented. The
Rivian side is read-only, the same as the Tesla, and has been exercised only
against fakes and synthetic payloads (see "What is not known until the car is
real").

**No trip planning.** ABRP exists and is better.
