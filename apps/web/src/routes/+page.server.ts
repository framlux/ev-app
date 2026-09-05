import type { PageServerLoad } from './$types.js'
import { run } from '$lib/server/http.js'
import { listVehicles } from '$lib/server/queries.js'

/**
 * The garage is one query by design (contract: "Garage in one call") — a
 * vehicle with no samples still comes back, with state null and activity
 * 'unknown', rather than being omitted. That is the case this page is built
 * around, because it is the state of a freshly deployed install.
 *
 * The load calls the query helper rather than fetching its own /api/v1 route:
 * the same function serves both, so the page and the published contract cannot
 * drift apart, and the page does not pay for an HTTP round trip to itself.
 */
export const load: PageServerLoad = async () => {
	const { vehicles } = await run(() => listVehicles())
	return { vehicles }
}
