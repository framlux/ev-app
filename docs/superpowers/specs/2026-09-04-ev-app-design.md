# EV App — design

**Date:** 2026-09-04
**Status:** Approved for planning
**Scope of this spec:** Tesla Model Y (2022), read-only, end to end. Rivian is a designed seam only; it gets its own spec.
**Background research:** `docs/research/2026-09-04-tesla-rivian-api-investigation.md`

---

## 1. Purpose

A single self-hosted web app that records and displays telemetry for my vehicles, replacing Tessie (Tesla) and eventually Rivian Roamer (Rivian) with one system I own. Deployed to the existing bare-metal k3s cluster via ArgoCD from the `framlux/stack` repo.

The motivating constraint, established in the research: **neither vendor stores history for you.** Both APIs are live-only. Every drive list, charging curve and degradation trend in the commercial products is derived by them from a stream they recorded. If we are not recording, the data is gone permanently. Ingestion is therefore the first thing that must work and the last thing allowed to break.

### Goals

- Continuously record Tesla vehicle state at high resolution without waking the car.
- Derive drives, charges and idles from that stream, with efficiency, charging curves and battery-health trends.
- Present it through a website at `ev.framlux.io`, authenticated with the existing Pocket-ID instance.
- Expose a versioned HTTP API that the website consumes, so a native app can later use the same surface.
- Run for approximately the cost of electricity on hardware that already exists.

### Non-goals for this spec

- **Vehicle commands.** Read-only. OAuth scopes deliberately exclude `vehicle_cmds` and `vehicle_charging_cmds`.
- **Rivian implementation.** The canonical model and adapter interface must accommodate it; no Rivian code is written here.
- **Native mobile app.** The API is designed so one can be added; it is not built.
- **Multi-user.** Single user, single Pocket-ID identity. No user table, no roles, no tenancy.
- **Trip planning.** ABRP exists and is better. Link out if ever needed.

---

## 2. Decisions and rationale

Decisions already settled, recorded here so the plan does not relitigate them.

| Decision | Choice | Why |
|---|---|---|
| Tesla API | Official Fleet API + Fleet Telemetry | The legacy Owner API is decommissioned; it returns 403 pointing at Fleet API. There is no other sanctioned path. |
| Virtual key | Pair one | Fleet Telemetry config must be signed by the app's private key, so streaming is impossible without a paired key. Pairing does not grant command ability — that comes from OAuth scope, which we withhold. |
| Data acquisition | Streaming, not polling | Polling is metered at $1/500 requests and risks wakes at $1/50. Streaming signals are $1/150,000 and never wake the car. With the $10/month discount this is effectively free. |
| Ingest queue | Mosquitto (MQTT) | ~15MB resident, one container, and a persistent session means a worker restart loses nothing. Redpanda was the alternative and is disproportionate for one vehicle. |
| Language | TypeScript throughout | The risk here is domain logic, not throughput. One language means the canonical model is a shared type rather than a generated contract. The engine is isolated as a package so extraction to Go or C# stays cheap. |
| Storage | Plain PostgreSQL 17 via CNPG | TimescaleDB would mean a non-standard CNPG image for a workload of roughly 10–50M rows/year. Native monthly partitioning plus BRIN indexes is sufficient. |
| Web/API split | One SvelteKit deployment | Splitting buys nothing when both halves are TypeScript in one repo. Accepted cost: a UI deploy restarts the API, which is irrelevant for one user. |
| Auth | Pocket-ID OIDC, authorization code + PKCE | Matches the existing `crm-web` pattern and the cluster's established SSO. |
| Hostnames | `ev.framlux.io`, `ev-telemetry.framlux.io` | Web and API on the first, which also serves the Tesla public key and is therefore the registered app domain. The car streams to the second. |

---

## 3. Architecture

### 3.1 Data flow

```
Tesla Model Y
  │ mTLS websocket, protobuf
  ▼
Traefik  ──IngressRouteTCP, TLS passthrough, HostSNI(ev-telemetry.framlux.io)──┐
                                                                              ▼
                                                                     ev-telemetry
                                                          (upstream tesla/fleet-telemetry)
                                                                              │ MQTT, QoS 1,
                                                                              │ reliable_ack
                                                                              ▼
                                                                          ev-mqtt
                                                                       (Mosquitto,
                                                                     persistent session)
                                                                              │
                                                                              ▼
                                                                         ev-ingest
                                                        decode → raw_message → normalise
                                                          → sample → incremental sessionise
                                                                              │
                                                                              ▼
                                                                    ev-pg (CNPG Postgres)
                                                                              ▲
                                                                              │ SQL reads
                                                                          ev-web
                                                            SvelteKit: UI + /api/v1, OIDC
                                                                              ▲
                                                                              │ HTTPS
                                                                        ev.framlux.io
```

`reliable_ack` is the load-bearing detail. The receiver acknowledges a message to the car only once Mosquitto has accepted it. That makes the chain: worker stalls → broker queue grows → receiver stops acking → **the car buffers its own 5,000 messages (~2,500 seconds)**. A deploy, a worker crash or a short outage therefore loses nothing.

### 3.2 Workloads

All in namespace `ev`.

| Workload | Kind | Image | Notes |
|---|---|---|---|
| `ev-telemetry` | Deployment | `tesla/fleet-telemetry` (upstream, pinned) | Terminates mTLS itself. Config from ConfigMap, certs from Secret. |
| `ev-mqtt` | StatefulSet | `eclipse-mosquitto` (pinned) | Persistence enabled on a small PVC so the session queue survives restart. |
| `ev-ingest` | Deployment | `ghcr.io/framlux/ev-ingest` | Long-lived MQTT subscriber. Separate from web deliberately: different failure modes, and it must be able to crash without taking the site down. |
| `ev-web` | Deployment | `ghcr.io/framlux/ev-web` | SvelteKit `adapter-node`, port 3000. |
| `ev-migrator` | Job | `ghcr.io/framlux/ev-migrator` | `argocd.argoproj.io/sync-wave: "5"`, matching the CRM migrator's reasoning about CNPG secret timing. |
| `ev-pg` | CNPG Cluster | `ghcr.io/cloudnative-pg/postgresql:17.6` | `data-disk` storage class, `data-tier` priority class. |
| `ev-teslacmd` | Job, run on demand | `tesla/vehicle-command` | Signs and pushes the telemetry configuration. Not a Deployment: it holds the private key, config changes are rare, and read-only gives it no other purpose. |

Resource requests follow the cluster's documented defaults (~50m CPU / 128Mi) except where noted: `ev-pg` matches the other CNPG clusters at 256Mi/250m requests and 512Mi/1 CPU limits, and `ev-ingest` gets 100m/256Mi requests because protobuf decoding is bursty.

### 3.3 Why the engine is a package, not a service

`packages/core` holds the canonical model and the sessionisation engine. It is imported by `ev-ingest` (incremental, on the write path) and by a reprocess entry point. `ev-web` does not import it — the web reads derived tables.

This is the seam that keeps the "one TypeScript app" decision reversible. Extracting the API to another language later means lifting HTTP handlers over an already-separated engine, not untangling a monolith.

---

## 4. Data model

PostgreSQL 17. Monthly range partitioning on the two high-volume tables, BRIN indexes on their timestamp columns.

### 4.1 Tables

**`vehicle`** — one row per car.
`id`, `vendor` (`tesla` | `rivian`), `vendor_vehicle_id` (Tesla VIN / Rivian vehicle id), `display_name`, `model`, `model_year`, `created_at`.

**`raw_message`** — the replay tape. Partitioned monthly.
`id`, `vehicle_id`, `received_at`, `vendor`, `payload` (`jsonb`), `source` (`telemetry` | `fleet_api` | `graphql_ws`).

Every derived table is rebuildable from this one. It is what makes the engine safe to iterate on: when segmentation logic changes, history is recomputed rather than lost. This is also the reason replay does not depend on the broker.

**`sample`** — the canonical `VehicleSample`. Partitioned monthly. Vendor-neutral by construction.
`vehicle_id`, `ts`, `soc_pct`, `range_km`, `odometer_km`, `lat`, `lon`, `speed_kph`, `power_state`, `charge_state`, `charge_power_kw`, `charge_energy_added_kwh`, `inside_temp_c`, `outside_temp_c`, `locked`, `doors_open`, `tpms` (`jsonb`).

Every field is nullable. Vendors disagree about what they expose, and the R2 in particular is unverified — the model must tolerate absence rather than assume the union.

**`session`** — drives, charges and idles as typed rows.
`id`, `vehicle_id`, `kind` (`drive` | `charge` | `idle`), `started_at`, `ended_at`, `start_odometer_km`, `end_odometer_km`, `start_soc_pct`, `end_soc_pct`, `energy_kwh`, `distance_km`, `efficiency_wh_per_km`, `avg_speed_kph`, `max_charge_power_kw`, `cost` (nullable), `start_location`, `end_location`, `is_open` (boolean).

**`session_point`** — the drive path and the charge curve.
`session_id`, `ts`, `lat`, `lon`, `soc_pct`, `speed_kph`, `power_kw`.

**`battery_health_sample`** — derived, one row per completed full-ish charge or per day.
`vehicle_id`, `observed_on`, `estimated_capacity_kwh`, `rated_range_at_100_km`, `sample_confidence`.

**`ingest_cursor`** — last processed message per source, so restart is exactly-once at the application level.

### 4.2 The Rivian seam

One interface, defined in `packages/core`:

```ts
interface VehicleAdapter {
  readonly vendor: 'tesla' | 'rivian'
  start(sink: (m: RawMessage) => Promise<void>): Promise<void>
  stop(): Promise<void>
  normalise(raw: RawMessage): VehicleSample[]
}
```

Nothing downstream of `normalise` knows the vendor. Writing this now costs nothing and is the entire reason the second car is cheap later.

---

## 5. Tesla integration

### 5.1 One-time setup

1. Tesla account with verified email and MFA enabled.
2. Register the application at `developer.tesla.com`. Domain: `ev.framlux.io`. Requested scopes: `openid`, `offline_access`, `vehicle_device_data`, `vehicle_location`. **Deliberately not** `vehicle_cmds` or `vehicle_charging_cmds`.

   `offline_access` is required and is easy to miss: without it Tesla returns an access token that expires in 8 hours and **no refresh token at all**, so the integration dies overnight with no obvious cause. It grants no vehicle access of its own — it only permits refresh — so it does not weaken the read-only guarantee.
3. Generate an EC secp256r1 keypair. The private key becomes a SealedSecret; the public key is served by `ev-web` at `/.well-known/appspecific/com.tesla.3p.public-key.pem`.
4. Call the partner `register` endpoint for the North America region.
5. OAuth 2.0 authorization code flow → third-party token. Refresh token stored as a SealedSecret; `ev-ingest` owns refreshing it.
6. Pair the virtual key to the car by opening the pairing link on a phone next to the vehicle.
7. Run the `ev-teslacmd` Job to sign and push the telemetry configuration.

Steps 1–2 gate everything and are the first task in the plan.

### 5.2 Telemetry configuration

Fields to request, chosen to support the engine without wasting signal budget: `Location`, `VehicleSpeed`, `Odometer`, `Soc`, `RatedRange`, `ChargeState`, `ChargeAmps`, `ChargerPower`, `ACChargingEnergyIn`, `DCChargingEnergyIn`, `InsideTemp`, `OutsideTemp`, `Locked`, `DoorState`, `TpmsPressure*`, `Gear`.

Signals transmit only on change, subject to a per-field minimum interval. At $1 per 150,000 signals against a $10 monthly discount, the budget is not a practical constraint for one car — but the field list should still be deliberate rather than "everything", because a chatty field with a short interval is where cost would actually come from.

### 5.3 Fleet API use

Even with streaming, a small Fleet API client is needed for the vehicle list, `key_paired` status, and re-pushing telemetry config. It lives in `packages/tesla` and is called rarely. **It must never poll `vehicle_data` on a schedule** — that is the expensive path this design exists to avoid. A lint-level rule or an explicit code comment should record why.

---

## 6. Web and API

### 6.1 Authentication

**Pocket-ID is the only way into this app.** There is no second authentication path and no
"Sign in with Tesla". This matters because the naming invites the opposite: Tesla's application
form requires a redirect URI, and the one registered is `https://ev.framlux.io/tesla_login`.
That path is *not* a login. It is a one-time OAuth callback the operator uses to mint a Fleet
API refresh token, it authenticates nobody, and it must never appear in `PUBLIC_PATHS` or issue
a session cookie. A Tesla token grants access to the *vehicle*; it must never grant access to
the *app*, whose entire authorisation model is a single Pocket-ID `sub`. Enforced by
`apps/web/test/boundaries.test.ts`, which is mutation-verified.

Authorization code + PKCE against `https://sso.framlux.io`. Session in an HttpOnly, Secure, SameSite=Lax cookie. Client credentials and the session signing key are SealedSecrets named `ev-pocketid-client` and `ev-session`, mirroring `crm-pocketid-client` and `crm-session`.

A single Pocket-ID subject is authorised; anyone else authenticating successfully is rejected at the application layer. The allowed subject is configuration, not code.

**Future native app.** The cookie BFF does not extend to a native client. `/api/v1` is therefore written to accept a bearer token as an alternative credential from the outset, even though nothing issues one yet. When the app is built, a Pocket-ID device-code flow slots in without reshaping routes. This is a deliberate small cost now to avoid a large one later.

### 6.2 API surface

Versioned under `/api/v1`, JSON, all reads:

- `GET /vehicles`
- `GET /vehicles/:id/state` — latest sample
- `GET /vehicles/:id/sessions?kind=&from=&to=` — paginated
- `GET /sessions/:id` — with points
- `GET /vehicles/:id/battery-health`
- `GET /vehicles/:id/samples?from=&to=&fields=` — raw series, for charts
- `GET /healthz/{live,ready}`

### 6.3 Pages

Garage (all vehicles, current state), vehicle detail, drives list with map, drive detail, charges list, charge detail with curve, battery health over time. Sequenced in the plan so the garage and drives ship before the rest.

---

## 7. Kubernetes deployment

Manifests live in `framlux/stack` at `clusters/prod/apps/ev/base/`, with `clusters/prod/apps/ev-app.yaml` and a line added to `clusters/prod/kustomization.yaml`. This follows the four-step "Adding a New Application" procedure in the stack repo's CLAUDE.md.

### 7.1 Manifests

`namespace.yaml`, `cnpg-cluster.yaml`, `cnpg-database.yaml`, `cnpg-scheduled-backup.yaml`, `configmap.yaml`, `deployment-web.yaml`, `deployment-ingest.yaml`, `deployment-telemetry.yaml`, `statefulset-mqtt.yaml`, `job-migrator.yaml`, `service-web.yaml`, `service-telemetry.yaml`, `service-mqtt.yaml`, `ingress.yaml`, `ingressroutetcp-telemetry.yaml`, `certificate-telemetry.yaml`, `networkpolicy.yaml`, and SealedSecrets for `ev-pocketid-client`, `ev-session`, `ev-tesla-oauth`, `ev-tesla-privkey`, `ev-mqtt-auth`, `backup-b2-credentials`, `ghcr-pull-secret`.

Image tags are pinned in the kustomization `images:` block, as CRM does.

### 7.2 Ingress

`ev.framlux.io` — standard Ingress, `cert-manager.io/cluster-issuer: letsencrypt-dns`, entrypoint `websecure`, middleware `kube-system-secure-headers@kubernetescrd`. Identical in shape to `crm`'s.

`ev-telemetry.framlux.io` — `IngressRouteTCP` with `tls.passthrough: true`, whose route rule matches `HostSNI` on that hostname, forwarding to `ev-telemetry:443`. Traefik routes on SNI without terminating, so fleet-telemetry performs its own mTLS and validates the vehicle's client certificate. No additional MetalLB address is required.

### 7.3 Backups — deliberately none for now

**Decision, 2026-09-04 (operator):** `ev-pg` ships with **no backup configuration**, matching
`crm`. The data is not considered critical at this stage and losing it is acceptable; the
recorder can simply start again.

This reverses the original position in this section, which argued backups were mandatory
because Tesla and Rivian serve live state only and keep no history, so a lost volume loses
the archive permanently. That reasoning is still true — it is the cost being knowingly
accepted, not a factor that was overlooked. It is recorded here so the trade-off is visible
to whoever revisits it rather than being rediscovered after a disk failure.

What this means concretely:

- No `backup.barmanObjectStore` block on the `Cluster`, no `ScheduledBackup`, and no
  `backup-b2-credentials` SealedSecret in the `ev` namespace.
- **`ev` must be added to the exclusions on `PostgresBackupStale` alongside `crm`, in the
  same change that removes the backup configuration.** This is not optional housekeeping:
  `cnpg_collector_last_available_backup_timestamp` is exported as `0` rather than omitted
  when nothing has ever completed, so an unbacked cluster inside the rule's scope pages at
  `severity: critical` within 26 hours and never clears.
- `PostgresBackupFailed` and `PostgresWalArchivingFailing` need no exclusion, for the same
  reason they need none for `crm`: with no backup configured, both metrics read `0`, and
  `0 > 0` is false. Verify this still holds rather than assuming it — the `crm` comment in
  `alerts.yaml` states it explicitly and the promtool cases pin it.
- The `PostgresExporterMissing` arm for `ev` remains worthwhile and is unaffected by this
  decision: it covers the database being unreachable, not unbacked.

**To reverse it** (restore backups later): add the `barmanObjectStore` block with an explicit
`serverName`, add a `ScheduledBackup` with `immediate: true` at a slot that does not collide
with vord-fleet 02:00 / corp-sso 03:00 / analytics 04:00, seal `backup-b2-credentials` into
the `ev` namespace, and **remove `ev` from the `PostgresBackupStale` exclusion in the same
change**. The analytics cluster is the reference implementation, and its comments record two
real incidents worth reading first — a `serverName` collision between incarnations, and the
fact that `immediate: true` only fires on a `ScheduledBackup`'s first reconcile.

### 7.4 Network policy

Following the CRM precedent: restrict `ev-pg` and `ev-mqtt` ingress to the pods that legitimately reach them. `ev-mqtt` accepts from `ev-telemetry` and `ev-ingest` only. `ev-telemetry` accepts from Traefik.

### 7.5 Observability

CNPG metrics are collected by the existing cluster-wide scrape job that keys on the `cnpg.io/cluster` label; no PodMonitor, matching the comment in the analytics cluster. `ev-ingest` should expose a Prometheus endpoint with, at minimum: messages consumed, samples written, seconds since last sample, and MQTT connection state.

**One alert is worth adding**, because it is the failure this design most needs to catch: no sample written for an extended period while the vehicle is not asleep. Silent ingestion failure is exactly the loss this system exists to prevent, and unlike a crash it produces no other signal. Threshold to be set from observed behaviour rather than guessed.

---

## 8. Testing

- **Engine (highest value).** Recorded `raw_message` fixtures in, expected `session` rows out. Table-driven. Drive/charge/idle segmentation is subtly wrong until proven otherwise: boundary cases are the ones that matter — a charge interrupted and resumed, a drive that pauses at a light long enough to look idle, a session open across a restart, clock skew, a sample gap during the car's buffered replay.
- **Adapters.** Contract tests against captured Tesla payloads, asserting `normalise` produces the expected samples and tolerates missing fields.
- **API.** Route-level tests over a seeded database, plus an auth test asserting an unauthorised subject is rejected.
- **Manifests.** `kustomize build` must succeed; if alert rules are touched, the existing promtool cases must pass.

TDD applies to `packages/core`. It is the part where correctness is hard and feedback is cheap.

---

## 9. Phase 0 — verification before building

These are unknowns, not tasks. Each can invalidate part of the design, so they run first.

1. **Does a hobbyist Fleet API registration get approved?** The application form asks for legal business details. Tesla's own auth documentation names hobbyists using their own vehicle as a supported case, but TeslaMate's documentation still claims the opposite. Registering settles it. *If refused:* fall back to Teslemetry as the provider behind the same adapter interface.
2. **The fleet-telemetry TLS and CA arrangement.** The pushed config names the CA the car will trust for our server certificate, and the receiver validates the vehicle's client certificate in turn. Whether a Let's Encrypt chain works or this wants a self-signed CA is the single most likely place to lose a day. `check_server_cert.sh` from the upstream repo is the gate.
3. **Does the MQTT dispatcher honour `reliable_ack` and publish at QoS 1?** The durability chain in §3.1 depends on it. *If it is fire-and-forget:* switch to Redpanda, which was the runner-up for exactly this reason.
4. **Actual telemetry resolution while driving.** Sources conflict between sub-second and per-minute. It determines how good drive maps look and whether `session_point` needs interpolation.
5. **SNI passthrough with client certificates through Traefik.** Expected to work; cheap to confirm before building around it.

---

## 10. Risks

| Risk | Handling |
|---|---|
| Fleet API registration refused | Teslemetry behind the same adapter interface. The design does not depend on which provider supplies the stream. |
| TLS/CA arrangement fights us | Phase 0 gate. Self-signed CA is the fallback and is well-trodden in the community. |
| Silent ingestion failure | The "no samples while awake" alert in §7.5. This is the failure mode that actually matters. |
| Engine logic wrong, history mis-segmented | `raw_message` is the replay tape; derived tables are rebuildable. This is why raw retention is not optional. |
| Tesla changes Fleet Telemetry | Official and versioned, with announcements. Low, and slow when it happens. |
| R2 schema differs from R1 | Out of scope here, but the reason every `sample` column is nullable and the adapter interface exists now. |
| Single-node Postgres on one bare-metal box, **no backups** | Accepted by the operator on 2026-09-04 (§7.3): losing the volume loses the archive permanently and it cannot be re-fetched from Tesla or Rivian, but the data is not critical at this stage and recording can restart. Revisit before this history becomes something you would miss. |

---

## 11. Deliberately deferred

Vehicle commands. Rivian. Native app. Geofence and sentry alerts. Charging cost from real utility tariffs. History import from Tessie or TezLab. Trip planning. Backup restore rehearsal.

Each is a separate spec if and when it is wanted.
