const BASE = 'https://fleet-api.prd.na.vn.cloud.tesla.com/api/1'

/**
 * Where the calls go. `baseUrl` INCLUDES the `/api/1` prefix, because the
 * default does and a base that silently meant something else between callers is
 * exactly the kind of thing that only shows up against a real car.
 *
 * There is deliberately no `fetch` seam. The web app talks to ev-teslaproxy,
 * whose certificate comes from the cluster's internal CA issuer that no public
 * trust store knows - but the answer to that is `NODE_EXTRA_CA_CERTS` on the
 * pod, which Node applies to the process trust store. An injected undici
 * `Agent` would need undici as a dependency (it is not one, anywhere in this
 * repo) and would rely on Node's built-in fetch honouring a separately
 * installed undici's dispatcher - which is precisely the sort of thing that
 * works in a test and not in the image. So the whole injectable surface is one
 * string, which is all the tests need.
 */
export interface FleetApiOptions {
  baseUrl?: string
}

/** The `fields` map in Tesla's shape: names to interval and optional delta. */
export type TelemetryFields = Record<string, {
  interval_seconds: number
  minimum_delta?: number
}>

/**
 * The configuration body the car applies, and the same shape it echoes back.
 *
 * These five keys are not a guess: `check-telemetry-synced.sh` reads exactly
 * them out of the applied config today.
 */
export interface AppliedTelemetryConfig {
  hostname: string
  port: number
  ca: string
  prefer_typed: boolean
  fields: TelemetryFields
}

/** The push body: the config plus the VINs it applies to. */
export interface TelemetryConfigRequest {
  vins: string[]
  config: AppliedTelemetryConfig
}

// A trailing slash on the base would produce `//vehicles`, which the proxy
// answers with a 404 that reads like a missing route rather than a typo in a
// manifest. Cheaper to absorb here than to debug there.
const url = (path: string, opts?: FleetApiOptions) =>
  `${(opts?.baseUrl ?? BASE).replace(/\/+$/, '')}${path}`

async function get<T>(path: string, accessToken: string, opts?: FleetApiOptions): Promise<T> {
  const res = await fetch(url(path, opts), {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`)
  return (await res.json() as { response: T }).response
}

export const listVehicles = (t: string, opts?: FleetApiOptions) =>
  get<{ vin: string; display_name: string }[]>('/vehicles', t, opts)

// vehicle_info carries firmware_version, which is the only way to check the
// Fleet Telemetry firmware floor before pushing a config. Without it a push
// against an under-version car looks identical to one against a sleeping car.
export const fleetStatus = (t: string, vins: string[], opts?: FleetApiOptions) =>
  post<{
    key_paired_vins: string[]
    unpaired_vins?: string[]
    vehicle_info?: Record<string, import('./telemetry-preflight.js').VehicleInfo>
  }>('/vehicles/fleet_status', t, { vins }, opts)

// `config` is optional because the car has none until the first push is applied,
// and because Tesla omits it while `synced` is false. Typing it as always
// present would put an undefined behind a type that promises otherwise.
export const getTelemetryConfig = (t: string, vin: string, opts?: FleetApiOptions) =>
  get<{ synced: boolean; config?: AppliedTelemetryConfig }>(
    `/vehicles/${vin}/fleet_telemetry_config`, t, opts)

/**
 * The one write this module is allowed to make.
 *
 * It reconfigures how the car reports; it cannot move it, unlock it or charge
 * it. That distinction is the whole reason `fleet-api.test.ts` pins this
 * module's export list - see the reasoning there before adding a second write.
 *
 * The body is sent verbatim from `buildTelemetryConfig`, because an empty or
 * mangled field map is ACCEPTED by Tesla and silently stops the car streaming
 * anything; nothing here may reshape it.
 */
export const setTelemetryConfig = (
  t: string, config: TelemetryConfigRequest, opts?: FleetApiOptions,
) =>
  post<{ updated_vehicles?: number; skipped_vehicles?: Record<string, string[]> }>(
    '/vehicles/fleet_telemetry_config', t, config, opts)

async function post<T>(
  path: string, accessToken: string, body: unknown, opts?: FleetApiOptions,
): Promise<T> {
  const res = await fetch(url(path, opts), {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`)
  return (await res.json() as { response: T }).response
}
