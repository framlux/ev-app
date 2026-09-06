const BASE = 'https://fleet-api.prd.na.vn.cloud.tesla.com/api/1'

/**
 * A non-2xx from the Fleet API, with Tesla's own refusal kept as data.
 *
 * Tesla's refusals are the most useful thing this integration receives. Both
 * that this app has hit named exactly what was wrong - an unknown field, and a
 * rule with the value it wanted - and both reached the operator as a 500 with a
 * stack trace, because the failure was a bare Error whose message happened to
 * contain a JSON document. The page then had nothing to show but "Internal
 * Error", and the actual sentence had to be dug out of a pod log.
 *
 * So the refusal is parsed HERE, once, at the boundary that knows the shape:
 * `{ response, error, error_description, txid }`. `message` is Tesla's sentence
 * so anything that merely logs the error is already better off, and the parts
 * stay addressable so the web layer can put the sentence in front of a person
 * and quote the txid, which is what Tesla asks for when reporting a problem.
 *
 * A body that is not that shape - an HTML gateway page, an empty 502 - keeps
 * its bytes verbatim, because "unparseable" and "empty" are different problems
 * and the difference is the whole diagnosis.
 */
export class TeslaApiError extends Error {
  readonly status: number
  readonly path: string
  /** Tesla's `error`, or null when the body was not its error shape. */
  readonly teslaError: string | null
  /** Tesla's `error_description`. Frequently empty, even on a real refusal. */
  readonly teslaErrorDescription: string | null
  /** Tesla's correlation id. What they ask for when reporting a problem. */
  readonly txid: string | null

  constructor(path: string, status: number, body: string) {
    const parsed = TeslaApiError.parse(body)
    const detail = parsed.error ?? (body.trim() === '' ? '(no body)' : body.trim())
    super(`Tesla refused ${path} with ${status}: ${detail}`)
    this.name = 'TeslaApiError'
    this.status = status
    this.path = path
    this.teslaError = parsed.error
    this.teslaErrorDescription = parsed.description
    this.txid = parsed.txid
  }

  private static parse(body: string): {
    error: string | null; description: string | null; txid: string | null
  } {
    try {
      const o: unknown = JSON.parse(body)
      if (typeof o !== 'object' || o === null) return { error: null, description: null, txid: null }
      const r = o as Record<string, unknown>
      const str = (v: unknown): string | null =>
        typeof v === 'string' && v.trim() !== '' ? v : null
      return { error: str(r['error']), description: str(r['error_description']), txid: str(r['txid']) }
    } catch {
      return { error: null, description: null, txid: null }
    }
  }
}

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
  if (!res.ok) throw new TeslaApiError(path, res.status, await res.text())
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
    `/vehicles/${encodeURIComponent(vin)}/fleet_telemetry_config`, t, opts)

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
  if (!res.ok) throw new TeslaApiError(path, res.status, await res.text())
  return (await res.json() as { response: T }).response
}
