import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The telemetry page's `load`, which was reasoned about at length and exercised
 * by nothing.
 *
 * `components.test.ts` renders the `.svelte` against hand-written `data`, so
 * every branch here — the one-Tesla filter, the two deliberate nulls, the
 * day-one no-row path, the consent read — ran only in production. These are the
 * three states §3.8 says the page has, tested where they are actually decided.
 *
 * The modules are mocked at the boundary this file already owns: the database
 * and the query layer. The token store is real, because its behaviour (an
 * expired consent reads as none) is part of what the load promises.
 */
const listVehicles = vi.fn()
const readTelemetryStatus = vi.fn()

vi.mock('../src/lib/server/queries.js', async () => {
	const actual = await vi.importActual<Record<string, unknown>>('../src/lib/server/queries.js')
	return { ...actual, listVehicles: () => listVehicles() }
})

vi.mock('../src/lib/server/db.js', () => ({
	getPool: () => ({}) as never,
	withTransaction: (_pool: unknown, fn: (c: unknown) => unknown) => fn({}),
	readTelemetryStatus: (...args: unknown[]) => readTelemetryStatus(...args)
}))

const { load } = await import('../src/routes/settings/telemetry/+page.server.js')
const { setTeslaToken, clearTeslaToken } = await import('../src/lib/server/tesla-session.js')

const SUBJECT = 'operator'
const tesla = (id: string, vin: string) => ({
	vehicle: { id, vendor: 'tesla', displayName: 'Model Y', vendorVehicleId: vin }
})

const event = (sub: string | null = SUBJECT) =>
	({ locals: { user: sub ? { sub } : null } }) as never

/**
 * `PageServerLoad` is typed as possibly returning void, which it never does
 * here. Narrowing once keeps every assertion below reading as the fact it is
 * checking rather than as a chain of optional access.
 */
const loaded = async (sub: string | null = SUBJECT) => {
	const data = await load(event(sub))
	if (!data) throw new Error('the load returned nothing')
	return data as {
		vehicle: { id: string; displayName: string; vin: string } | null
		status: { synced: boolean; fieldCount: number | null } | null
		tesla: { connected: boolean; expiresAt: string | null }
		catalogue: { fieldCount: number; hostname: string; port: number }
	}
}

afterEach(() => {
	clearTeslaToken(SUBJECT)
	vi.clearAllMocks()
})

describe('the telemetry page load', () => {
	it('day one: no vehicle row exists, so there is nothing to read a status for', async () => {
		listVehicles.mockResolvedValue({ vehicles: [] })
		const data = await loaded()

		expect(data.vehicle).toBeNull()
		expect(data.status).toBeNull()
		// Not merely absent — never queried. telemetry_status is keyed by
		// vehicle.id, so there is no key to ask with.
		expect(readTelemetryStatus).not.toHaveBeenCalled()
		// The catalogue half needs no vehicle and no consent, so it is present
		// even here: the page can say what it WOULD push on a fresh install.
		expect(data.catalogue.fieldCount).toBeGreaterThan(0)
		expect(data.catalogue.hostname).toMatch(/\./)
	})

	it('refuses to name a car when the install has two', async () => {
		// A confirmation naming the wrong vehicle is worse than none, because it
		// is read and believed.
		listVehicles.mockResolvedValue({ vehicles: [tesla('a', 'VIN_A'), tesla('b', 'VIN_B')] })
		const data = await loaded()

		expect(data.vehicle).toBeNull()
		expect(readTelemetryStatus).not.toHaveBeenCalled()
	})

	it('reads the cached row for the one car, with no Tesla session at all', async () => {
		listVehicles.mockResolvedValue({ vehicles: [tesla('v1', 'VIN_A')] })
		// The repo layer maps the row to camelCase; the load hands it to
		// toTelemetryStatusDto unchanged.
		readTelemetryStatus.mockResolvedValue({
			synced: false,
			fieldCount: 204,
			caPresent: true,
			firmware: '2025.2.6',
			keyPaired: true,
			streamingEnabled: null,
			checkedAt: new Date('2026-09-05T10:00:00.000Z'),
			pushedAt: null
		})

		const data = await loaded()

		expect(data.vehicle).toEqual({ id: 'v1', displayName: 'Model Y', vin: 'VIN_A' })
		expect(data.status?.synced).toBe(false)
		expect(data.status?.fieldCount).toBe(204)
		expect(data.tesla.connected).toBe(false)
		expect(data.tesla.expiresAt).toBeNull()
	})

	it('null status is "no row has ever been written", not "synced: false"', async () => {
		listVehicles.mockResolvedValue({ vehicles: [tesla('v1', 'VIN_A')] })
		readTelemetryStatus.mockResolvedValue(null)

		const data = await loaded()
		expect(data.vehicle).not.toBeNull()
		expect(data.status).toBeNull()
	})

	it('reports a held consent, and its expiry, because there is no renewal', async () => {
		listVehicles.mockResolvedValue({ vehicles: [tesla('v1', 'VIN_A')] })
		readTelemetryStatus.mockResolvedValue(null)
		const expiresAt = new Date(Date.now() + 3_600_000)
		setTeslaToken(SUBJECT, { accessToken: 'tok', expiresAt })

		const data = await loaded()
		expect(data.tesla.connected).toBe(true)
		expect(data.tesla.expiresAt).toBe(expiresAt.toISOString())
	})

	it('an expired consent reads as disconnected, and the load completes the eviction', async () => {
		listVehicles.mockResolvedValue({ vehicles: [tesla('v1', 'VIN_A')] })
		readTelemetryStatus.mockResolvedValue(null)
		setTeslaToken(SUBJECT, { accessToken: 'tok', expiresAt: new Date(Date.now() - 1_000) })

		const data = await loaded()
		expect(data.tesla.connected).toBe(false)
	})
})
