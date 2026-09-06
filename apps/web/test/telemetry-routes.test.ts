import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isHttpError, isRedirect } from '@sveltejs/kit'
import {
	TeslaApiError,
	buildTelemetryConfig,
	type AppliedTelemetryConfig,
	type TelemetryConfigRequest,
	type VehicleInfo
} from '@ev/tesla'
import type { DbClient } from '@ev/db'
import { GET as callback } from '../src/routes/settings/telemetry/callback/+server.js'
import { GET as connect } from '../src/routes/settings/telemetry/connect/+server.js'
import { POST as check } from '../src/routes/api/v1/telemetry/check/+server.js'
import { POST as push } from '../src/routes/api/v1/telemetry/push/+server.js'
import { TESLA_FLOW_COOKIE } from '../src/lib/server/tesla-flow.js'
import { clearTeslaToken, getTeslaToken, setTeslaToken } from '../src/lib/server/tesla-session.js'
import type { TeslaClient } from '../src/lib/server/tesla-client.js'
import {
	checkTelemetry,
	pushTelemetry,
	telemetryCa,
	withTeslaSession,
	type TelemetryDeps
} from '../src/lib/server/telemetry.js'

/**
 * The consent flow and the two actions, against a FAKE Fleet API.
 *
 * Nothing in this file may reach Tesla, and that is not a testing preference:
 * the push reconfigures a physical car, and the two paths that must send
 * nothing — a preflight blocker and a configuration the car already has — are
 * only assertable by counting calls that never happen. So the Fleet API is an
 * object with four methods and the database is a query recorder, and every
 * "nothing was sent" below is a count of zero rather than an argument.
 *
 * The other half of the file is the consent itself, where the interesting
 * assertions are also about things NOT happening: no exchange on a bad state,
 * and no token stored when one comes back with a refresh token attached.
 */

const SUBJECT = 'pocketid-subject-telemetry'
const VIN = 'VIN-UNDER-TEST'
const VEHICLE_ID = 'v-local-1'
const NOW = new Date('2026-09-05T12:00:00.000Z')

/** A throwaway PEM. Nothing verifies against it; the rule is presence. */
const CA = ['-----BEGIN CERTIFICATE-----', 'MIIBnotarealcertificate', '-----END CERTIFICATE-----', ''].join('\n')

/** The same certificate, reformatted. §3.6 compares the ca on presence only. */
const CA_REFORMATTED = CA.replace(/\n/g, '\r\n')

const HEALTHY: VehicleInfo = {
	firmware_version: '2025.2.6',
	fleet_telemetry_version: '2025.2.6',
	safety_screen_streaming_toggle_enabled: true
}

/** What `buildTelemetryConfig` would send today, i.e. what "applied" must match. */
const DESIRED = buildTelemetryConfig({ vin: VIN, ca: CA }).config

/* ------------------------------------------------------------------ *
 * Fakes
 * ------------------------------------------------------------------ */

interface FakeTeslaOptions {
	vehicles?: { vin: string; display_name: string }[]
	applied?: { synced: boolean; config?: AppliedTelemetryConfig }
	status?: { key_paired_vins: string[]; vehicle_info?: Record<string, VehicleInfo> }
	pushResult?: { updated_vehicles?: number; skipped_vehicles?: Record<string, string[]> }
	fail?: Error
}

function fakeTesla(o: FakeTeslaOptions = {}): {
	client: TeslaClient
	pushed: TelemetryConfigRequest[]
} {
	const pushed: TelemetryConfigRequest[] = []
	const client: TeslaClient = {
		listVehicles: async () => o.vehicles ?? [{ vin: VIN, display_name: 'Blue' }],
		fleetStatus: async () =>
			o.status ?? { key_paired_vins: [VIN], vehicle_info: { [VIN]: HEALTHY } },
		getTelemetryConfig: async () => {
			if (o.fail) throw o.fail
			return o.applied ?? { synced: false }
		},
		setTelemetryConfig: async (_token, config) => {
			pushed.push(config)
			return o.pushResult ?? { updated_vehicles: 1 }
		}
	}
	return { client, pushed }
}

interface Call {
	sql: string
	values: unknown[]
}

/** The last known row, as `readTelemetryStatus` maps it out of Postgres. */
const CACHED_ROW = {
	synced: false,
	field_count: 7,
	ca_present: true,
	firmware: '2025.2.6',
	key_paired: true,
	streaming_enabled: null,
	checked_at: NOW,
	pushed_at: null
}

/**
 * A stand-in for the telemetry_status table that actually STORES.
 *
 * It returned a canned row for every SELECT to begin with, which quietly made
 * every assertion about `result.status` an assertion about the fake: delete the
 * body of `recordTelemetryCheck` and they all still passed. It now applies the
 * insert the way the upsert does — check writes the observation columns, push
 * writes `pushed_at` onto whatever is there — so reading the row back means
 * what the tests say it means.
 */
function fakeDb(opts: { vehicleId?: string | null } = {}) {
	const writes: Call[] = []
	const reads: Call[] = []
	let stored: Record<string, unknown> | undefined
	const client = {
		async query(sql: string, values: unknown[] = []) {
			if (/^\s*INSERT/i.test(sql)) {
				writes.push({ sql, values })
				if (/pushed_at\)/.test(sql)) {
					stored = { ...(stored ?? CACHED_ROW), pushed_at: values[1] }
				} else {
					const [, synced, fieldCount, caPresent, firmware, keyPaired, streaming, checkedAt] =
						values
					stored = {
						...(stored ?? {}),
						synced,
						field_count: fieldCount,
						ca_present: caPresent,
						firmware,
						key_paired: keyPaired,
						streaming_enabled: streaming,
						checked_at: checkedAt,
						pushed_at: (stored as { pushed_at?: unknown } | undefined)?.pushed_at ?? null
					}
				}
				return { rows: [] }
			}
			reads.push({ sql, values })
			if (/FROM vehicle/.test(sql)) {
				const id = opts.vehicleId === undefined ? VEHICLE_ID : opts.vehicleId
				return { rows: id === null ? [] : [{ id }] }
			}
			if (/FROM telemetry_status/.test(sql)) return { rows: [stored ?? CACHED_ROW] }
			return { rows: [] }
		}
	}
	return {
		writes,
		reads,
		withDb: <T,>(fn: (c: DbClient) => Promise<T>) => fn(client as unknown as DbClient)
	}
}

function makeDeps(
	tesla: TeslaClient,
	db: { withDb: TelemetryDeps['withDb'] },
	ca: string = CA
): TelemetryDeps {
	return {
		tesla,
		accessToken: 'consented-access-token',
		telemetryCa: () => ca,
		withDb: db.withDb,
		now: () => NOW
	}
}

function fakeCookies(initial: Record<string, string> = {}) {
	const jar = new Map(Object.entries(initial))
	const sets: Array<{ name: string; value: string; opts: Record<string, unknown> }> = []
	const deletes: string[] = []
	return {
		sets,
		deletes,
		get: (name: string) => jar.get(name),
		set: (name: string, value: string, opts: Record<string, unknown>) => {
			sets.push({ name, value, opts })
			jar.set(name, value)
		},
		delete: (name: string) => {
			deletes.push(name)
			jar.delete(name)
		}
	}
}

/** The thrown thing, whatever it is: these handlers refuse by throwing. */
async function thrownBy(fn: () => unknown): Promise<unknown> {
	try {
		await fn()
	} catch (e) {
		return e
	}
	throw new Error('expected the handler to throw, and it returned')
}

const USER = { locals: { user: { sub: SUBJECT }, session: { sub: SUBJECT } } }

beforeEach(() => {
	process.env.TESLAPROXY_URL = 'https://ev-teslaproxy.ev.svc.cluster.local:4443'
	process.env.TESLA_REDIRECT_URI = 'https://ev.framlux.io/settings/telemetry/callback'
	process.env.TESLA_CLIENT_ID = 'tesla-client-id'
	process.env.TESLA_CLIENT_SECRET = 'tesla-client-secret'
})

afterEach(() => {
	vi.unstubAllGlobals()
	clearTeslaToken(SUBJECT)
	delete process.env.TESLAPROXY_URL
	delete process.env.TESLA_REDIRECT_URI
	delete process.env.TESLA_CLIENT_ID
	delete process.env.TESLA_CLIENT_SECRET
	delete process.env.TELEMETRY_CA_FILE
})

/* ------------------------------------------------------------------ *
 * The gate, and the consent as a second, independent requirement
 * ------------------------------------------------------------------ */

describe('who may call the telemetry actions', () => {
	it('refuses every route without an app session', async () => {
		// Redundant with hooks.server.ts on purpose: a mistake in PUBLIC_PATHS
		// must not leave a route that reconfigures a car with no second line.
		for (const handler of [check, push]) {
			expect(await thrownBy(() => handler({ locals: {} } as never))).toMatchObject({ status: 401 })
		}
		expect(
			await thrownBy(() => connect({ locals: {}, cookies: fakeCookies() } as never))
		).toMatchObject({ status: 401 })
		expect(
			await thrownBy(() =>
				callback({
					locals: {},
					cookies: fakeCookies(),
					url: new URL('https://ev.framlux.io/settings/telemetry/callback')
				} as never)
			)
		).toMatchObject({ status: 401 })
	})

	it('refuses a signed-in operator who has not connected to Tesla, with 409', async () => {
		// §5: the buttons are disabled in the UI, but the UI is not the check.
		for (const handler of [check, push]) {
			const e = await thrownBy(() => handler(USER as never))
			expect(isHttpError(e, 409)).toBe(true)
			expect((e as { body: { message: string } }).body.message).toMatch(/connect to Tesla/i)
		}
	})

	it('drops a token Tesla has rejected rather than retrying with it', async () => {
		// §5: a 401 means the consent is dead - expired, revoked or withdrawn.
		// Retrying cannot help, and leaving it in memory means every later action
		// fails the same way while the page still claims to be connected.
		setTeslaToken(SUBJECT, { accessToken: 'stale', expiresAt: new Date(Date.now() + 3_600_000) })
		const e = await thrownBy(() =>
			withTeslaSession(SUBJECT, async () => {
				throw new TeslaApiError('/vehicles', 401, '{"error":"token expired"}')
			})
		)
		expect(e).toMatchObject({ status: 409 })
		expect(getTeslaToken(SUBJECT)).toBeNull()
	})

	it('keeps the token when the failure is not an authorization one', async () => {
		// A 500 from Tesla, or a proxy that is down, says nothing about the
		// consent. Throwing it away would cost a full re-login for an outage.
		setTeslaToken(SUBJECT, { accessToken: 'good', expiresAt: new Date(Date.now() + 3_600_000) })
		await expect(
			withTeslaSession(SUBJECT, async () => {
				throw new TeslaApiError('/vehicles', 503, 'upstream unavailable')
			})
		).rejects.toThrow(/503/)
		expect(getTeslaToken(SUBJECT)).not.toBeNull()
	})

	it('names which of the two proxy failures happened, because the fixes differ', async () => {
		// §5. "Cannot reach the signing proxy" is a NetworkPolicy or a dead pod;
		// "the certificate does not verify" is NODE_EXTRA_CA_CERTS on this one.
		setTeslaToken(SUBJECT, { accessToken: 'good', expiresAt: new Date(Date.now() + 3_600_000) })
		const tlsFailure = Object.assign(new TypeError('fetch failed'), {
			cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }
		})
		const unreachable = Object.assign(new TypeError('fetch failed'), {
			cause: { code: 'ECONNREFUSED' }
		})
		const first = await thrownBy(() =>
			withTeslaSession(SUBJECT, async () => {
				throw tlsFailure
			})
		)
		expect(first).toMatchObject({ status: 502 })
		expect(String((first as Error).message)).toMatch(/certificate could not be verified/)

		const second = await thrownBy(() =>
			withTeslaSession(SUBJECT, async () => {
				throw unreachable
			})
		)
		expect(second).toMatchObject({ status: 502 })
		expect(String((second as Error).message)).toMatch(/could not be reached/)
	})
})

/* ------------------------------------------------------------------ *
 * The consent flow
 * ------------------------------------------------------------------ */

describe('starting the Tesla consent', () => {
	it('sends the browser to Tesla with the narrow scopes and a state nonce', async () => {
		const cookies = fakeCookies()
		const redirect = await thrownBy(() => connect({ ...USER, cookies } as never))
		expect(isRedirect(redirect)).toBe(true)

		const url = new URL((redirect as { location: string }).location)
		expect(`${url.origin}${url.pathname}`).toBe('https://auth.tesla.com/oauth2/v3/authorize')
		// The whole point of WEB_SCOPES: no offline_access means Tesla issues no
		// refresh token, so this flow cannot mint a standing credential (§2).
		expect(url.searchParams.get('scope')).toBe('openid vehicle_device_data')
		expect(url.searchParams.get('redirect_uri')).toBe(process.env.TESLA_REDIRECT_URI)

		const cookie = cookies.sets[0]
		expect(cookie?.name).toBe(TESLA_FLOW_COOKIE)
		expect(JSON.parse(cookie!.value).s).toBe(url.searchParams.get('state'))
	})

	it('sets the state cookie sameSite lax, because Strict would kill every consent', async () => {
		// Tesla returns the browser by a TOP-LEVEL GET and a Strict cookie is
		// withheld on exactly that navigation. Every consent would then fail at
		// the callback with "state missing", which reads as a Tesla fault.
		const cookies = fakeCookies()
		await thrownBy(() => connect({ ...USER, cookies } as never))
		expect(cookies.sets[0]?.opts).toMatchObject({
			sameSite: 'lax',
			httpOnly: true,
			secure: true,
			path: '/'
		})
	})

	it('refuses to start before the browser leaves when the app credential is missing', async () => {
		// A consent costs a full Tesla login (prompt=login, §3.4). Finding out at
		// the callback that CLIENT_SECRET is unset would waste the whole ceremony.
		delete process.env.TESLA_CLIENT_SECRET
		await expect(connect({ ...USER, cookies: fakeCookies() } as never)).rejects.toThrow(
			/TESLA_CLIENT_SECRET/
		)
	})

	it('mints a fresh state for every consent', async () => {
		const first = fakeCookies()
		const second = fakeCookies()
		await thrownBy(() => connect({ ...USER, cookies: first } as never))
		await thrownBy(() => connect({ ...USER, cookies: second } as never))
		expect(first.sets[0]!.value).not.toBe(second.sets[0]!.value)
	})
})

describe('the Tesla consent callback', () => {
	/** Every token exchange this file would make, so "none" is assertable. */
	function stubTokenEndpoint(body: Record<string, unknown>): string[] {
		const calls: string[] = []
		vi.stubGlobal('fetch', async (url: string) => {
			calls.push(url)
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		})
		return calls
	}

	function callbackEvent(query: string, cookie?: string) {
		return {
			...USER,
			cookies: fakeCookies(cookie === undefined ? {} : { [TESLA_FLOW_COOKIE]: cookie }),
			url: new URL(`https://ev.framlux.io/settings/telemetry/callback?${query}`)
		}
	}

	it('refuses a mismatched state and never attempts the exchange', async () => {
		// The CSRF boundary of the consent flow (§5). Everything past this line
		// spends a credential, so nothing past it may run on an unverified state.
		const calls = stubTokenEndpoint({ access_token: 'never-minted', expires_in: 28800 })
		const event = callbackEvent('code=abc&state=attacker', JSON.stringify({ s: 'ours' }))
		expect(await thrownBy(() => callback(event as never))).toMatchObject({ status: 400 })
		expect(calls).toEqual([])
		expect(getTeslaToken(SUBJECT)).toBeNull()
	})

	it('refuses when the state cookie is absent, and never attempts the exchange', async () => {
		const calls = stubTokenEndpoint({ access_token: 'never-minted', expires_in: 28800 })
		const event = callbackEvent('code=abc&state=anything')
		expect(await thrownBy(() => callback(event as never))).toMatchObject({ status: 400 })
		expect(calls).toEqual([])
	})

	it('consumes the state cookie whatever happens, so a callback cannot be replayed', async () => {
		stubTokenEndpoint({ access_token: 'never-minted', expires_in: 28800 })
		const event = callbackEvent('code=abc&state=attacker', JSON.stringify({ s: 'ours' }))
		await thrownBy(() => callback(event as never))
		expect(event.cookies.deletes).toEqual([TESLA_FLOW_COOKIE])
	})

	it('REFUSES A REFRESH TOKEN, and stores nothing when one arrives', async () => {
		// The executable form of §2's promise. Without offline_access Tesla issues
		// none; if one ever appears - a widened scope list, a change at Tesla's
		// end - holding it would create exactly the standing, vehicle-capable
		// credential this design exists to remove. So it is refused, not stored.
		stubTokenEndpoint({
			access_token: 'access',
			refresh_token: 'a-standing-credential',
			expires_in: 28800
		})
		const event = callbackEvent('code=abc&state=ours', JSON.stringify({ s: 'ours' }))
		const e = await thrownBy(() => callback(event as never))
		expect(isHttpError(e, 500)).toBe(true)
		expect((e as { body: { message: string } }).body.message).toMatch(/refresh token/i)
		expect(getTeslaToken(SUBJECT)).toBeNull()
	})

	it('stores the access token and returns the operator to the page', async () => {
		const calls = stubTokenEndpoint({ access_token: 'the-consented-token', expires_in: 28800 })
		const event = callbackEvent('code=abc&state=ours', JSON.stringify({ s: 'ours' }))
		const redirect = await thrownBy(() => callback(event as never))
		expect(isRedirect(redirect)).toBe(true)
		expect((redirect as { location: string }).location).toBe('/settings/telemetry')
		expect(calls).toHaveLength(1)
		expect(getTeslaToken(SUBJECT)?.accessToken).toBe('the-consented-token')
		expect(event.cookies.deletes).toEqual([TESLA_FLOW_COOKIE])
	})

	it("reports Tesla's own refusal as itself", async () => {
		const calls = stubTokenEndpoint({ access_token: 'never', expires_in: 1 })
		const event = callbackEvent('error=access_denied&state=ours', JSON.stringify({ s: 'ours' }))
		const e = await thrownBy(() => callback(event as never))
		expect(isHttpError(e, 400)).toBe(true)
		expect((e as { body: { message: string } }).body.message).toMatch(/access_denied/)
		expect(calls).toEqual([])
	})
})

/* ------------------------------------------------------------------ *
 * Check
 * ------------------------------------------------------------------ */

describe('checking what the car has applied', () => {
	/**
	 * The cached row is what §3.7 exists for: the page has to be useful with no
	 * Tesla session, which means the check must record what the car said even
	 * when we cannot work out whether it matches. The telemetry CA is a file
	 * mount, so "cannot work out" is a real state — an empty or mis-projected
	 * mount makes buildTelemetryConfig throw by design.
	 */
	it('still records what the car said when the CA is unusable', async () => {
		const tesla = fakeTesla({ applied: { synced: true, config: { ...DESIRED } } })
		const db = fakeDb()
		const result = await checkTelemetry(makeDeps(tesla.client, db, 'not a certificate'))

		expect(db.writes).toHaveLength(1)
		expect(result.status.checkedAt).toBe(NOW.toISOString())
		expect(result.matches).toBe(false)
		expect(result.differences[0]).toMatch(/cannot build the configuration/)
	})

	it('records the check and hands back the cached row', async () => {
		const tesla = fakeTesla({
			applied: { synced: true, config: { ...DESIRED, ca: CA_REFORMATTED } }
		})
		const db = fakeDb()
		const result = await checkTelemetry(makeDeps(tesla.client, db))

		expect(result.vin).toBe(VIN)
		expect(result.matches).toBe(true)
		expect(result.differences).toEqual([])
		expect(result.blockers).toEqual([])
		expect(result.status.checkedAt).toBe(NOW.toISOString())

		expect(db.writes).toHaveLength(1)
		// The row states every fact explicitly, nulls included: an omitted field
		// would read as "unchanged" against the upsert, which is a claim about
		// the car this check did not make.
		expect(db.writes[0]!.values).toEqual([
			VEHICLE_ID,
			true,
			Object.keys(DESIRED.fields).length,
			true,
			'2025.2.6',
			true,
			true,
			NOW
		])
	})

	it('reports the difference rather than hiding it, when the car has an older config', async () => {
		const stale: AppliedTelemetryConfig = {
			...DESIRED,
			fields: { ...DESIRED.fields, VehicleSpeed: { interval_seconds: 600 } }
		}
		const tesla = fakeTesla({ applied: { synced: true, config: stale } })
		const result = await checkTelemetry(makeDeps(tesla.client, fakeDb()))
		expect(result.matches).toBe(false)
		expect(result.differences.join(' ')).toMatch(/VehicleSpeed/)
	})

	it('records synced false and a null shape when the car has applied nothing', async () => {
		// Day one. Tesla omits `config` entirely while synced is false, and the
		// page must not read that as "applied a config with zero fields".
		const tesla = fakeTesla({ applied: { synced: false } })
		const db = fakeDb()
		await checkTelemetry(makeDeps(tesla.client, db))
		expect(db.writes[0]!.values.slice(0, 4)).toEqual([VEHICLE_ID, false, null, null])
	})

	it('records ca_present false for an applied config whose ca is not a certificate', async () => {
		// Presence means BEGIN CERTIFICATE, not "the string is non-empty" - the
		// same predicate the builder and the §3.6 comparison use. A config
		// applied with mangled bytes fails every connection silently, so the
		// cached row has to say so rather than reporting a CA is there.
		const tesla = fakeTesla({
			applied: { synced: true, config: { ...DESIRED, ca: 'not a certificate' } }
		})
		const db = fakeDb()
		await checkTelemetry(makeDeps(tesla.client, db))
		expect(db.writes[0]!.values[3]).toBe(false)
	})

	it('surfaces the preflight without refusing, because a check changes nothing', async () => {
		const tesla = fakeTesla({
			status: { key_paired_vins: [], vehicle_info: { [VIN]: HEALTHY } }
		})
		const result = await checkTelemetry(makeDeps(tesla.client, fakeDb()))
		expect(result.blockers.join(' ')).toMatch(/virtual key not paired/)
	})

	it('refuses to guess between two vehicles', async () => {
		// §5, matching the script: configuring the wrong VIN is invisible until
		// data arrives from the wrong car.
		const tesla = fakeTesla({
			vehicles: [
				{ vin: 'VIN-A', display_name: 'A' },
				{ vin: 'VIN-B', display_name: 'B' }
			]
		})
		const db = fakeDb()
		await expect(checkTelemetry(makeDeps(tesla.client, db))).rejects.toMatchObject({ status: 409 })
		expect(db.writes).toEqual([])
	})

	it('refuses when no local vehicle row matches the VIN Tesla reports', async () => {
		// telemetry_status is keyed by vehicle.id and nothing can be recorded
		// without one. Saying so beats a foreign key violation.
		const db = fakeDb({ vehicleId: null })
		const e = await thrownBy(() => checkTelemetry(makeDeps(fakeTesla().client, db)))
		expect(e).toMatchObject({ status: 409 })
		expect(String((e as Error).message)).toContain(VIN)
		expect(db.writes).toEqual([])
	})
})

/* ------------------------------------------------------------------ *
 * Push
 * ------------------------------------------------------------------ */

describe('pushing the configuration to the car', () => {
	it('sends exactly one configuration and records the push', async () => {
		const tesla = fakeTesla({ applied: { synced: false } })
		const db = fakeDb()
		const result = await pushTelemetry(makeDeps(tesla.client, db))

		expect(tesla.pushed).toHaveLength(1)
		// Verbatim from the shared builder: the field map, the constants and the
		// CA all come from one producer, so what the page pushes and what the
		// break-glass script pushes cannot diverge.
		expect(tesla.pushed[0]).toEqual(buildTelemetryConfig({ vin: VIN, ca: CA }))
		expect(result.pushed).toBe(true)
		expect(result.pushedAt).toBe(NOW.toISOString())

		// Both halves of the row, in one transaction: what the preflight observed
		// and that a configuration was sent. They describe one button press.
		expect(db.writes).toHaveLength(2)
		expect(db.writes[1]!.values).toEqual([VEHICLE_ID, NOW])
	})

	it('REFUSES on a preflight blocker, sending nothing but recording why', async () => {
		// Tesla accepts a configuration a car cannot apply, reports no error, and
		// leaves synced:false indefinitely - which is indistinguishable from a
		// sleeping car. Pushing anyway replaces a diagnosis with a silent wait.
		const tesla = fakeTesla({
			status: { key_paired_vins: [], vehicle_info: { [VIN]: HEALTHY } }
		})
		const db = fakeDb()
		const e = await thrownBy(() => pushTelemetry(makeDeps(tesla.client, db)))
		expect(e).toMatchObject({ status: 409 })
		expect(String((e as Error).message)).toMatch(/virtual key not paired/)
		expect(tesla.pushed).toEqual([])
		// Nothing SENT, but the observation is recorded: migration 006 keeps the
		// preflight columns so the page can say why it will not push before
		// anyone consents to Tesla again, and discarding the very observation
		// that produced the refusal is what would make that impossible.
		expect(db.writes).toHaveLength(1)
		expect(db.writes[0]!.sql).toMatch(/INSERT INTO telemetry_status/)
		expect(db.writes[0]!.sql).not.toMatch(/pushed_at\)/)
	})

	it('refuses on firmware below the floor, with the version in the message', async () => {
		const tesla = fakeTesla({
			status: {
				key_paired_vins: [VIN],
				vehicle_info: { [VIN]: { firmware_version: '2024.9.1' } }
			}
		})
		const db = fakeDb()
		const e = await thrownBy(() => pushTelemetry(makeDeps(tesla.client, db)))
		// Numerically below 2024.26, not lexically: "2024.9" sorts above it.
		expect(String((e as Error).message)).toMatch(/2024\.9\.1 is below the 2024\.26 floor/)
		expect(tesla.pushed).toEqual([])
		// Recorded, for the same reason as the unpaired-key refusal above.
		expect(db.writes).toHaveLength(1)
	})

	it('reports "already applied" and pushes nothing when the car has this config', async () => {
		// §3.6. The ca differs only in line endings, which is not a difference:
		// too strict a rule means a physical car is reconfigured on every check.
		const tesla = fakeTesla({
			applied: { synced: true, config: { ...DESIRED, ca: CA_REFORMATTED } }
		})
		const db = fakeDb()
		const result = await pushTelemetry(makeDeps(tesla.client, db))

		expect(result.alreadyApplied).toBe(true)
		expect(result.pushed).toBe(false)
		expect(tesla.pushed).toEqual([])
		// Recorded: this outcome refreshes `synced` and `checked_at` at the cost
		// of two Fleet API calls, and throwing that away leaves the page showing
		// a staler row than the one we just paid for.
		expect(db.writes).toHaveLength(1)
		expect(result.status?.checkedAt).toBe(NOW.toISOString())
	})

	/**
	 * "Already applied" is a claim about the CAR, and the car is the thing that
	 * says whether it has applied anything. A config Tesla is holding for a
	 * vehicle that has not acknowledged it comes back matching but unsynced, and
	 * reporting that as already applied is §3.6's too-loose failure: a push
	 * silently declined over a car that never received one.
	 */
	it('pushes a matching config the car has NOT acknowledged', async () => {
		const tesla = fakeTesla({ applied: { synced: false, config: { ...DESIRED } } })
		const result = await pushTelemetry(makeDeps(tesla.client, fakeDb()))
		expect(result.alreadyApplied).toBe(false)
		expect(tesla.pushed).toHaveLength(1)
	})

	it('pushes when a single interval has changed', async () => {
		// The other way of getting §3.6 wrong: too loose, and the page reports
		// everything is fine over a configuration the car never received.
		const stale: AppliedTelemetryConfig = {
			...DESIRED,
			fields: { ...DESIRED.fields, VehicleSpeed: { interval_seconds: 600 } }
		}
		const tesla = fakeTesla({ applied: { synced: true, config: stale } })
		await pushTelemetry(makeDeps(tesla.client, fakeDb()))
		expect(tesla.pushed).toHaveLength(1)
	})

	it('treats a vehicle Tesla skipped as a failure, not a push', async () => {
		// Tesla answers 200 while listing the vehicles it declined. Recording
		// pushed_at for one of those is the exact silent success this feature
		// exists to remove.
		const tesla = fakeTesla({
			applied: { synced: false },
			pushResult: { updated_vehicles: 0, skipped_vehicles: { missing_key: [VIN] } }
		})
		const db = fakeDb()
		const e = await thrownBy(() => pushTelemetry(makeDeps(tesla.client, db)))
		expect(e).toMatchObject({ status: 502 })
		expect(String((e as Error).message)).toMatch(/missing_key/)
		expect(db.writes).toEqual([])
	})

	it('carries a streaming-toggle warning through without refusing', async () => {
		// A warning, not a blocker: some vehicles use the in-car toggle INSTEAD
		// of a virtual key, so this must not stop a push that will work.
		const tesla = fakeTesla({
			applied: { synced: false },
			status: {
				key_paired_vins: [VIN],
				vehicle_info: { [VIN]: { ...HEALTHY, safety_screen_streaming_toggle_enabled: false } }
			}
		})
		const result = await pushTelemetry(makeDeps(tesla.client, fakeDb()))
		expect(result.pushed).toBe(true)
		expect(result.warnings.join(' ')).toMatch(/Third-Party App Data Streaming/)
	})

	it('refuses a CA that is not a certificate, after the preflight rather than before', async () => {
		// A mis-projected mount yields a configuration the car accepts and then
		// fails every connection against - indistinguishable from a car that
		// never wakes. The builder greps for BEGIN CERTIFICATE; so did the script.
		const tesla = fakeTesla({ applied: { synced: false } })
		const db = fakeDb()
		await expect(
			pushTelemetry(makeDeps(tesla.client, db, 'not a certificate'))
		).rejects.toThrow(/BEGIN CERTIFICATE/)
		expect(tesla.pushed).toEqual([])
		expect(db.writes).toEqual([])

		// And the ORDER matters: with both wrong, the operator is told about the
		// blocker, which is the one they can act on from the car.
		const blocked = fakeTesla({
			status: { key_paired_vins: [], vehicle_info: { [VIN]: HEALTHY } }
		})
		const e = await thrownBy(() =>
			pushTelemetry(makeDeps(blocked.client, fakeDb(), 'not a certificate'))
		)
		expect(String((e as Error).message)).toMatch(/virtual key not paired/)
	})
})

/* ------------------------------------------------------------------ *
 * The certificate that travels INSIDE the configuration
 * ------------------------------------------------------------------ */

describe('the telemetry CA', () => {
	it('is read from the projected file, per call', () => {
		const dir = mkdtempSync(join(tmpdir(), 'ev-telemetry-ca-'))
		const path = join(dir, 'tls.crt')
		writeFileSync(path, CA)
		process.env.TELEMETRY_CA_FILE = path
		expect(telemetryCa()).toBe(CA)
	})

	it('says which path failed, because a missing mount and a wrong key look alike', () => {
		process.env.TELEMETRY_CA_FILE = '/nonexistent/tls.crt'
		expect(() => telemetryCa()).toThrow(/\/nonexistent\/tls\.crt/)
	})

	it('refuses loudly when it is not configured at all', () => {
		expect(() => telemetryCa()).toThrow(/TELEMETRY_CA_FILE/)
	})
})

/**
 * Tesla answers 200 to a push it did not apply, in two different ways: by
 * listing the vehicle under `skipped_vehicles`, and — this one — by simply
 * reporting that nothing was updated and saying nothing about why.
 *
 * Recording `pushed_at` for either is the silent success this feature exists to
 * remove: the page would show a push time for a car that was never
 * reconfigured, and the columns it was meant to fill would stay empty with
 * nothing to explain it.
 */
describe('a push Tesla accepted but did not apply', () => {
	it('is a failure when no vehicle was updated, even with no reason given', async () => {
		const tesla = fakeTesla({
			applied: { synced: false },
			pushResult: { updated_vehicles: 0 }
		})
		const db = fakeDb()
		const e = await thrownBy(() => pushTelemetry(makeDeps(tesla.client, db)))

		expect(e).toMatchObject({ status: 502 })
		expect(String((e as Error).message)).toMatch(/no vehicle updated/)
		// The observation may be recorded; a push time must not be.
		expect(db.writes.some((w) => /pushed_at\)/.test(w.sql))).toBe(false)
	})
})

/**
 * §5 again, from the other end: what Tesla SAID must reach the operator.
 *
 * Two real pushes were refused with precise, actionable sentences - an unknown
 * field name, and a rule with the value it wanted - and both arrived as a 500
 * and a stack trace in a pod log, leaving the page showing nothing usable. The
 * refusal is the most useful thing in the exchange, so it gets a status the
 * page can render and the sentence survives verbatim.
 */
describe('what Tesla refused, in front of the operator', () => {
	it('surfaces the refusal as a 502 carrying Tesla\'s own sentence', async () => {
		setTeslaToken(SUBJECT, { accessToken: 'good', expiresAt: new Date(Date.now() + 3_600_000) })
		const e = await thrownBy(() =>
			withTeslaSession(SUBJECT, async () => {
				throw new TeslaApiError(
					'/vehicles/fleet_telemetry_config',
					400,
					JSON.stringify({
						response: null,
						error: 'Unknown field BrickSocMinPercent',
						error_description: '',
						txid: 'c9bdc44ab006aef5d700d8ad05410037',
					})
				)
			})
		)
		expect(e).toMatchObject({ status: 502 })
		expect((e as Error).message).toContain('Unknown field BrickSocMinPercent')
		// The correlation id is what Tesla asks for when reporting a problem, so
		// it must not be the thing that only exists in a log.
		expect((e as Error).message).toContain('c9bdc44ab006aef5d700d8ad05410037')
		// A refusal is not a dead consent: the token stays.
		expect(getTeslaToken(SUBJECT)).not.toBeNull()
	})

	it('still drops the token on a 401, now that the error is typed', async () => {
		setTeslaToken(SUBJECT, { accessToken: 'stale', expiresAt: new Date(Date.now() + 3_600_000) })
		const e = await thrownBy(() =>
			withTeslaSession(SUBJECT, async () => {
				throw new TeslaApiError('/vehicles', 401, JSON.stringify({ error: 'token expired' }))
			})
		)
		expect(e).toMatchObject({ status: 409 })
		expect(getTeslaToken(SUBJECT)).toBeNull()
	})
})
