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
    ['fleetStatus', 'getTelemetryConfig', 'listVehicles', 'setTelemetryConfig'])
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
