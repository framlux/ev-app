import type { PageServerLoad } from './$types.js'
import { run } from '$lib/server/http.js'
import { getBatteryHealth, getVehicleStats, parseRangeQuery } from '$lib/server/queries.js'

export const load: PageServerLoad = async ({ params, url }) => {
	const range = parseRangeQuery(url.searchParams)

	// A known vehicle with no estimates is an empty samples array, not a 404 —
	// which is exactly the state this page spends its first months in.
	const [health, stats] = await run(() =>
		Promise.all([getBatteryHealth(params.id, range), getVehicleStats(params.id, {})])
	)

	return { health, stats }
}
