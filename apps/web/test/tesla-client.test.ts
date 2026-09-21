import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { teslaClient, teslaRedirectUri } from '../src/lib/server/tesla-client.js'

/**
 * The web app's one route to Tesla: through ev-teslaproxy.
 *
 * The config push has to be signed with the application key and only the proxy
 * holds it, so the push CANNOT go direct. Reads go the same way, which buys one
 * base URL, one CA and one network path to reason about (design §2). The
 * failure this file exists to prevent is a call that quietly reaches Tesla's
 * public host instead: it would work for reads, fail confusingly for the push,
 * and there is nothing in @ev/tesla to stop it — `baseUrl` is optional there
 * and its default is Tesla.
 *
 * There is no `fetch` seam anywhere in this path, on purpose: the proxy's
 * certificate comes from the cluster's internal CA and it is trusted through
 * NODE_EXTRA_CA_CERTS on the pod, not through an injected dispatcher (§3.3).
 * That leaves the global as the only place to observe the URL from.
 */

const PROXY = 'https://ev-teslaproxy.ev.svc.cluster.local:4443'

function stubFetch(response: unknown = {}): string[] {
	const urls: string[] = []
	vi.stubGlobal('fetch', async (url: string) => {
		urls.push(url)
		return new Response(JSON.stringify({ response }), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		})
	})
	return urls
}

beforeEach(() => {
	process.env.TESLAPROXY_URL = PROXY
	process.env.TESLA_REDIRECT_URI = 'https://ev.example.com/settings/telemetry/callback'
})

afterEach(() => {
	vi.unstubAllGlobals()
	delete process.env.TESLAPROXY_URL
	delete process.env.TESLA_REDIRECT_URI
})

describe('the Fleet API client the web app uses', () => {
	it('routes every call through the configured proxy', async () => {
		const urls = stubFetch({ synced: false })
		const tesla = teslaClient()
		await tesla.listVehicles('tok')
		await tesla.fleetStatus('tok', ['VIN1'])
		await tesla.getTelemetryConfig('tok', 'VIN1')
		await tesla.setTelemetryConfig('tok', {
			vins: ['VIN1'],
			config: { hostname: 'h', port: 443, ca: 'ca', prefer_typed: true, fields: {} }
		})
		expect(urls).toEqual([
			`${PROXY}/api/1/vehicles`,
			`${PROXY}/api/1/vehicles/fleet_status`,
			`${PROXY}/api/1/vehicles/VIN1/fleet_telemetry_config`,
			`${PROXY}/api/1/vehicles/fleet_telemetry_config`
		])
	})

	it('never falls back to Tesla’s public host', async () => {
		const urls = stubFetch([])
		await teslaClient().listVehicles('tok')
		expect(urls[0]).not.toMatch(/fleet-api\.prd/)
	})

	it('tolerates a TESLAPROXY_URL that already names the API prefix', async () => {
		// The manifest is written by hand in another repo and the design shows the
		// URL both ways (§3.1 with /api/1, §7 without). Accepting either is
		// cheaper than a 404 from the proxy that reads like a missing route.
		for (const configured of [`${PROXY}/api/1`, `${PROXY}/api/1/`, `${PROXY}/`]) {
			process.env.TESLAPROXY_URL = configured
			const urls = stubFetch([])
			await teslaClient().listVehicles('tok')
			expect(urls[0], configured).toBe(`${PROXY}/api/1/vehicles`)
			vi.unstubAllGlobals()
		}
	})

	it('refuses to build a client when TESLAPROXY_URL is unset', () => {
		delete process.env.TESLAPROXY_URL
		// Loudly, and by name. The alternative - defaulting to Tesla's host - is a
		// deployment that looks healthy until the first push fails unsigned.
		expect(() => teslaClient()).toThrow(/TESLAPROXY_URL/)
	})

	it('reads the environment per call, so a redeploy is not required to change it', async () => {
		stubFetch([])
		await teslaClient().listVehicles('tok')
		vi.unstubAllGlobals()
		process.env.TESLAPROXY_URL = 'https://other.invalid'
		const urls = stubFetch([])
		await teslaClient().listVehicles('tok')
		expect(urls[0]).toBe('https://other.invalid/api/1/vehicles')
	})
})

describe('the registered Tesla redirect URI', () => {
	it('comes from the environment, because Tesla matches it byte for byte', () => {
		expect(teslaRedirectUri()).toBe('https://ev.example.com/settings/telemetry/callback')
	})

	it('refuses when it is unset', () => {
		delete process.env.TESLA_REDIRECT_URI
		expect(() => teslaRedirectUri()).toThrow(/TESLA_REDIRECT_URI/)
	})
})
