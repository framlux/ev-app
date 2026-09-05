import { TELEMETRY_HOSTNAME, TELEMETRY_PORT, buildTelemetryFields } from '@ev/tesla'
import type { PageServerLoad } from './$types.js'
import { getPool, readTelemetryStatus, withTransaction } from '$lib/server/db.js'
import { run } from '$lib/server/http.js'
import { listVehicles } from '$lib/server/queries.js'
import { toTelemetryStatusDto } from '$lib/server/telemetry.js'
import { getTeslaToken } from '$lib/server/tesla-session.js'

/**
 * Everything this page can say WITHOUT a Tesla session (§3.8).
 *
 * That is the whole reason the cached row exists: the common visit is a glance
 * at whether the car has applied its configuration yet, and "not yet" is the
 * normal answer for hours. A page that needed a consent before it could show
 * anything would cost a full Tesla re-authentication — password and MFA, per
 * §3.4 — to answer a question the database already knows the answer to.
 *
 * So this load reaches Tesla for nothing at all. It reads three local things:
 * the vehicle, its cached status row, and whether a consent is currently held
 * in this process. The two buttons do the rest, and only when pressed.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const { vehicle, status } = await run(async () => {
		const { vehicles } = await listVehicles()

		/**
		 * The car this page is about — or nothing, deliberately, in two cases.
		 *
		 * A fresh install has no vehicle row at all, because the ingest worker
		 * registers the vehicle it is configured for and nothing else does. And
		 * an install with two Tesla vehicles cannot name ONE VIN, which is what
		 * the push confirmation exists to do: a confirmation naming the wrong car
		 * is worse than no confirmation, because it is read and believed. The
		 * actions refuse to guess for the same reason against the Tesla account
		 * (§5); this refuses against the local database.
		 */
		const teslas = vehicles.filter((v) => v.vehicle.vendor === 'tesla')
		const only = teslas.length === 1 ? teslas[0]!.vehicle : null

		// No vehicle, no row to read: `telemetry_status` is keyed by vehicle.id.
		const row = only
			? await withTransaction(getPool(), (c) => readTelemetryStatus(c, only.id))
			: null

		return {
			vehicle: only
				? { id: only.id, displayName: only.displayName, vin: only.vendorVehicleId }
				: null,
			// Three states, not two: null means no row has ever been written, which
			// is not the same as a row saying `synced: false`.
			status: row ? toTelemetryStatusDto(row) : null
		}
	})

	// Reading the store is also what EVICTS an expired consent (tesla-session.ts),
	// so a page load after an expiry both reports and completes the disconnect.
	const token = getTeslaToken(locals.user?.sub)

	return {
		vehicle,
		status,
		tesla: {
			connected: token !== null,
			// There is no refresh path by design, so this is not trivia: it is how
			// long the operator has before connecting again costs a full Tesla login.
			expiresAt: token?.expiresAt.toISOString() ?? null
		},
		/**
		 * What the buttons WOULD push, from the field catalogue in @ev/tesla —
		 * knowable with no Tesla session, and the other half of §3.8's difference.
		 * The page compares this count against the applied one it has cached.
		 */
		catalogue: {
			fieldCount: Object.keys(buildTelemetryFields()).length,
			hostname: TELEMETRY_HOSTNAME,
			port: TELEMETRY_PORT
		},
		/**
		 * The server's clock at render, so ages are computed against a fixed
		 * instant rather than against `Date.now()` inside a `$derived` — which is
		 * not a reactive dependency and would freeze the moment it was first read
		 * (the defect LiveIndicator shipped with, and its test still pins).
		 */
		now: new Date().toISOString()
	}
}
