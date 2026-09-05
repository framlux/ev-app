import type { PageServerLoad } from './$types.js'
import { run } from '$lib/server/http.js'
import { getBatteryHealth, getVehicleStats, parseRangeQuery } from '$lib/server/queries.js'

export const load: PageServerLoad = async ({ params, url }) => {
	// Parsed INSIDE run(), like every sibling page load. parseRangeQuery throws
	// ApiProblem, and run() is the only thing that turns one into a Kit
	// response: called outside, a bad ?from= escaped as an unhandled error and
	// the user got a 500 stack-trace page for a typo in a date, where the drives
	// and charges pages answer the same typo with a clean 400.
	const [health, stats] = await run(() => {
		const range = parseRangeQuery(url.searchParams)

		// A known vehicle with no estimates is an empty samples array, not a 404 —
		// which is exactly the state this page spends its first months in.
		return Promise.all([getBatteryHealth(params.id, range), getVehicleStats(params.id, {})])
	})

	return { health, stats }
}
