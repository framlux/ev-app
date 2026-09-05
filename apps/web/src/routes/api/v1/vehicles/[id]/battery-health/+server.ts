import { json, error } from '@sveltejs/kit'
import type { RequestHandler } from './$types.js'
import { run } from '$lib/server/http.js'
import { getBatteryHealth, parseRangeQuery } from '$lib/server/queries.js'

export const GET: RequestHandler = async ({ locals, params, url }) => {
	if (!locals.user) throw error(401, 'unauthorized')
	return json(
		await run(async () => getBatteryHealth(params.id, parseRangeQuery(url.searchParams)))
	)
}
