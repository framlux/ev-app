import { json, error } from '@sveltejs/kit'
import type { RequestHandler } from './$types.js'
import { run } from '$lib/server/http.js'
import { getSessionDetail } from '$lib/server/queries.js'

// Drives and charges share this endpoint because they are the same rows read
// on different axes: a drive plots lat/lon and speed against ts, a charge
// plots powerKw against socPct.
export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) throw error(401, 'unauthorized')
	return json(await run(() => getSessionDetail(params.id)))
}
