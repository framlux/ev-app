import { afterEach, expect, it, vi } from 'vitest'
import * as fleet from '../src/fleet-api.js'

/**
 * This pin does two jobs, and the second one got heavier when the OAuth scopes
 * were widened to include `vehicle_cmds` and `vehicle_charging_cmds`.
 *
 * 1. No vehicle-data helper: polling `/vehicle_data` is metered per request and
 *    wakes a sleeping car. Telemetry streams the same information for free, so
 *    a convenience helper here is a standing invitation to run up a bill.
 *
 * 2. No command helper: the refresh token can now command the vehicle. That was
 *    a deliberate choice - it means adding commands later needs no reconsent -
 *    but it removes the credential as a safety boundary. Nothing outside this
 *    file stops the app from unlocking the car; this list does.
 *
 * `setTelemetryConfig` was added deliberately, and it is the ONLY sanctioned
 * write: the web app pushes the telemetry configuration, which reconfigures how
 * the car reports and cannot move it. A vehicle-data helper and any command
 * helper are still not sanctioned. That pin now carries more weight than it
 * used to, because the credential no longer helps: the web flow requests narrow
 * scopes, but Tesla records a grant per (account, application) and may hand
 * back a token carrying the account's existing command scopes anyway (see the
 * comment in oauth.ts). So this list is the only thing standing between a
 * consented token inside ev-web and a command sent to a physical car.
 *
 * Adding any of them is fine, once it is a decision. Breaking this test first is
 * what makes it one.
 */
it('exposes no vehicle-data or command helper, so neither happens by accident', () => {
  expect(Object.keys(fleet).sort()).toEqual(
    ['TESLA_TIMEOUT_MS', 'TESLA_WRITE_TIMEOUT_MS', 'TeslaApiError',
      'TeslaTimeoutError', 'fleetStatus', 'getTelemetryConfig', 'listVehicles',
      'setTelemetryConfig'])
})

/**
 * There is no `fetch` seam to stub here, on purpose: the web app trusts the
 * proxy's internal-CA certificate through NODE_EXTRA_CA_CERTS on the pod, not
 * through an injected dispatcher, so `baseUrl` is the whole injectable surface.
 * That leaves the global as the only place to observe the URL from.
 */
function stubFetch(response: unknown = {}): { url: string; init?: RequestInit }[] {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init !== undefined && { init }) })
    return new Response(JSON.stringify({ response }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  })
  return calls
}

afterEach(() => { vi.unstubAllGlobals() })

it('defaults to Tesla\'s public host, so existing callers are untouched', async () => {
  const calls = stubFetch([])
  await fleet.listVehicles('tok')
  expect(calls[0]?.url).toBe(
    'https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/vehicles')
})

it('routes every call through an injected baseUrl', async () => {
  // The web app talks to ev-teslaproxy, never to Tesla directly: the config
  // push has to be signed with the application key and only the proxy holds it.
  // Reads go the same way so there is one base URL, one CA and one network path
  // to reason about.
  const base = 'https://ev-teslaproxy.ev.svc.cluster.local:4443/api/1'
  const calls = stubFetch({})
  await fleet.listVehicles('tok', { baseUrl: base })
  await fleet.fleetStatus('tok', ['VIN1'], { baseUrl: base })
  await fleet.getTelemetryConfig('tok', 'VIN1', { baseUrl: base })
  expect(calls.map((c) => c.url)).toEqual([
    `${base}/vehicles`,
    `${base}/vehicles/fleet_status`,
    `${base}/vehicles/VIN1/fleet_telemetry_config`,
  ])
})

it('tolerates a baseUrl with a trailing slash', async () => {
  // TESLAPROXY_URL is typed into a manifest by a human, and a stray trailing
  // slash would otherwise produce `//vehicles` - which the proxy answers with a
  // 404 that reads like a missing route rather than a typo.
  const calls = stubFetch([])
  await fleet.listVehicles('tok', { baseUrl: 'https://proxy.invalid:4443/api/1/' })
  expect(calls[0]?.url).toBe('https://proxy.invalid:4443/api/1/vehicles')
})

it('posts the telemetry configuration as-built, with the bearer token', async () => {
  const config = {
    vins: ['VIN1'],
    config: {
      hostname: 'ev-telemetry.framlux.io', port: 443, ca: '-- CERT --',
      prefer_typed: true, fields: { VehicleSpeed: { interval_seconds: 10 } },
    },
  }
  const calls = stubFetch({ updated_vehicles: 1 })
  const res = await fleet.setTelemetryConfig('tok', config, { baseUrl: 'https://p/api/1' })
  expect(calls[0]?.url).toBe('https://p/api/1/vehicles/fleet_telemetry_config')
  expect(calls[0]?.init?.method).toBe('POST')
  // Sent verbatim: the builder is the only thing allowed to decide what the car
  // is asked for, and a helper that reshaped it here could silently drop fields.
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(config)
  expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe('Bearer tok')
  expect(res).toEqual({ updated_vehicles: 1 })
})

it('reads the applied configuration back, not just the synced flag', async () => {
  // §3.6's comparison and the cached status row both need the applied config
  // itself; `{ synced }` alone cannot answer "is what the car has what the
  // catalogue says". check-telemetry-synced.sh already reads exactly these keys.
  const applied = {
    hostname: 'ev-telemetry.framlux.io', port: 443, ca: '-- CERT --',
    prefer_typed: true, fields: { VehicleSpeed: { interval_seconds: 10, minimum_delta: 1 } },
  }
  stubFetch({ synced: true, config: applied })
  const res = await fleet.getTelemetryConfig('tok', 'VIN1')
  expect(res.synced).toBe(true)
  expect(res.config).toEqual(applied)
  expect(res.config?.fields.VehicleSpeed?.minimum_delta).toBe(1)
})

/**
 * WHAT TESLA'S REFUSAL SAYS, kept intact all the way to the operator.
 *
 * Both 400s this API has returned were precise and actionable - one named the
 * unknown field, one named the rule and the value it wanted - and both reached
 * the operator as a 500 and a stack trace in a log, because the failure was a
 * bare `Error` carrying a JSON blob in its message. The refusal is the most
 * useful thing in the whole exchange; it must survive as data.
 */
it('carries Tesla\'s own refusal, parsed, rather than a JSON blob in a message', async () => {
  const body = JSON.stringify({
    response: null,
    error: 'SelfDrivingMilesSinceReset requires minimum delta be explicitly set and >= 1',
    error_description: '',
    txid: 'cbe224814cdef1d182bb6622da5dd0fc',
  })
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(body, { status: 400, statusText: 'Bad Request' }))

  const thrown = await fleet.setTelemetryConfig('token', {
    vins: ['5YJYGDEE0MF000000'],
    config: {
      hostname: 'h', port: 443, ca: 'x', prefer_typed: true,
      fields: { Soc: { interval_seconds: 60 } },
    },
  }).catch((e: unknown) => e)

  expect(thrown).toBeInstanceOf(fleet.TeslaApiError)
  const err = thrown as InstanceType<typeof fleet.TeslaApiError>
  expect(err.status).toBe(400)
  expect(err.teslaError)
    .toBe('SelfDrivingMilesSinceReset requires minimum delta be explicitly set and >= 1')
  expect(err.txid).toBe('cbe224814cdef1d182bb6622da5dd0fc')
  // The message is what an operator reads: Tesla's sentence, not our wrapper.
  expect(err.message).toContain('requires minimum delta be explicitly set and >= 1')
  expect(err.message).not.toContain('{')
})

it('keeps the body when Tesla answers with something that is not its error shape', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('<html>gateway timeout</html>', { status: 504 }))

  const thrown = await fleet.fleetStatus('token', ['5YJYGDEE0MF000000'])
    .catch((e: unknown) => e) as InstanceType<typeof fleet.TeslaApiError>

  expect(thrown).toBeInstanceOf(fleet.TeslaApiError)
  expect(thrown.status).toBe(504)
  expect(thrown.teslaError).toBeNull()
  // Unparseable is not the same as empty: an operator still needs the bytes.
  expect(thrown.message).toContain('gateway timeout')
})

/**
 * NOTHING IN A REQUEST PATH MAY WAIT FOREVER.
 *
 * Both calls here used a bare `fetch`, which has no timeout. A Tesla or proxy
 * call that hangs therefore held the HTTP request open indefinitely, and the
 * first thing to give up was something outside this app - Traefik, or
 * Cloudflare, which answers with its own HTML `502 Bad gateway`. That page has
 * no idea what was being attempted, and the pod that did know logged nothing
 * because the request never finished. An operator is left with a status code
 * and no way to tell a hung upstream from a crashed one.
 *
 * A bounded wait turns that into our error, with the path in it.
 */
it('gives up on a Tesla call that never answers, rather than hanging', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) =>
    new Promise((_resolve, reject) => {
      // Exactly how fetch behaves on an aborted signal: reject with the
      // signal's reason. Never resolves otherwise, which is the case under test.
      const signal = (init as RequestInit | undefined)?.signal
      signal?.addEventListener('abort', () => { reject(signal.reason as Error) })
    }))

  const thrown = await fleet.fleetStatus('token', ['5YJYGDEE0MF000000'], { timeoutMs: 20 })
    .catch((e: unknown) => e) as InstanceType<typeof fleet.TeslaTimeoutError>

  expect(thrown).toBeInstanceOf(fleet.TeslaTimeoutError)
  expect(thrown.path).toBe('/vehicles/fleet_status')
  expect(thrown.timeoutMs).toBe(20)
  expect(thrown.message).toMatch(/did not respond/i)
})

it('bounds the write as well as the reads', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) =>
    new Promise((_resolve, reject) => {
      const signal = (init as RequestInit | undefined)?.signal
      signal?.addEventListener('abort', () => { reject(signal.reason as Error) })
    }))

  const thrown = await fleet.setTelemetryConfig('token', {
    vins: ['5YJYGDEE0MF000000'],
    config: {
      hostname: 'h', port: 443, ca: 'x', prefer_typed: true,
      fields: { Soc: { interval_seconds: 60 } },
    },
  }, { timeoutMs: 20 }).catch((e: unknown) => e)

  expect(thrown).toBeInstanceOf(fleet.TeslaTimeoutError)
})

it('has a default bound, so a caller cannot forget one', () => {
  expect(fleet.TESLA_TIMEOUT_MS).toBeGreaterThan(0)
  expect(fleet.TESLA_WRITE_TIMEOUT_MS).toBeGreaterThan(fleet.TESLA_TIMEOUT_MS)
})

/**
 * The race this exists to win. A push is two reads and a write, and Cloudflare
 * gives up at 100 seconds with HTML that says nothing about what was attempted.
 * If our bounds ever exceed that budget, the gateway answers first and the
 * operator is back to reading a CDN error page.
 */
it('finishes a whole push inside the 100s the gateway allows', () => {
  const worstCase = fleet.TESLA_TIMEOUT_MS * 2 + fleet.TESLA_WRITE_TIMEOUT_MS
  expect(worstCase).toBeLessThan(100_000)
})
