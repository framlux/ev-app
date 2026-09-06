const BASE = 'https://fleet-api.prd.na.vn.cloud.tesla.com/api/1'

/**
 * How long any one Fleet API call may take before this app gives up.
 *
 * NOTHING IN A REQUEST PATH MAY WAIT FOREVER, and both calls below used a bare
 * `fetch`, which has no timeout at all. A hung Tesla or proxy call therefore
 * held the browser's request open indefinitely, and the first thing to give up
 * was something outside this app: Cloudflare sits in front of it and answers
 * with its own HTML `502 Bad gateway`, which knows nothing about what was being
 * attempted, while the pod that did know logged nothing because the request
 * never finished. That is the worst possible failure to debug, and it is the
 * one that actually happened.
 *
 * 15 seconds for a READ. A healthy Fleet API read is well under two seconds;
 * this is a bound on pathology, not a budget.
 */
export const TESLA_TIMEOUT_MS = 15_000

/**
 * The config push gets its own, much longer bound.
 *
 * The two 400s this endpoint returned came back instantly, because rejecting a
 * field name is cheap. A configuration Tesla ACCEPTS is not the same operation
 * - it is stored against the vehicle and acknowledged - and the evidence says
 * it is slower: the reads still succeed (the page's Check button works today)
 * while only the push dies at the gateway. Bounding the write at a read's
 * timeout would turn a slow success into a permanent failure, which is worse
 * than the problem.
 *
 * The ceiling is not ours to choose: Cloudflare fronts this app and gives up at
 * 100 seconds, answering with HTML that says nothing about what was attempted.
 * 15 + 15 + 60 leaves ten seconds of headroom, so OUR message wins that race
 * and the operator is told what happened by the app rather than by a CDN.
 */
export const TESLA_WRITE_TIMEOUT_MS = 60_000

/**
 * A Fleet API call that never answered.
 *
 * Deliberately NOT a `TeslaApiError`: Tesla did not refuse anything, and saying
 * "Tesla refused the request" about a timeout would send someone looking for a
 * rule they broke. The distinction matters most for the push, where a timeout
 * leaves the outcome genuinely unknown - the configuration may have been
 * applied - and the operator needs to be told that rather than reassured.
 */
export class TeslaTimeoutError extends Error {
  readonly path: string
  readonly timeoutMs: number

  constructor(path: string, timeoutMs: number) {
    super(`Tesla did not respond to ${path} within ${Math.round(timeoutMs / 1000)}s`)
    this.name = 'TeslaTimeoutError'
    this.path = path
    this.timeoutMs = timeoutMs
  }
}

/**
 * One fetch, bounded, with the abort turned back into something readable.
 *
 * `AbortSignal.timeout` rejects with a DOMException whose name is
 * `TimeoutError` and whose message says nothing about Tesla or the path, so it
 * is translated here rather than left to surface as "signal timed out".
 */
async function fetchBounded(
  target: string, init: RequestInit, path: string, timeoutMs: number,
): Promise<Response> {
  try {
    return await fetch(target, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    const name = (e as { name?: string } | null)?.name
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new TeslaTimeoutError(path, timeoutMs)
    }
    throw e
  }
}

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
  /** Overridable so a test can bound a hang in milliseconds, not seconds. */
  timeoutMs?: number
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
  const res = await fetchBounded(
    url(path, opts),
    { headers: { authorization: `Bearer ${accessToken}` } },
    path,
    opts?.timeoutMs ?? TESLA_TIMEOUT_MS)
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
  const res = await fetchBounded(
    url(path, opts),
    {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    path,
    opts?.timeoutMs ?? TESLA_WRITE_TIMEOUT_MS)
  if (!res.ok) throw new TeslaApiError(path, res.status, await res.text())
  return (await res.json() as { response: T }).response
}
