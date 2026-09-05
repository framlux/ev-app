import { json, error } from '@sveltejs/kit'
import type { RequestHandler } from './$types.js'
import { run } from '$lib/server/http.js'
import { getSampleSeries, parseSampleQuery } from '$lib/server/queries.js'

export const GET: RequestHandler = async ({ locals, params, url }) => {
	if (!locals.user) throw error(401, 'unauthorized')
	// from, to and fields are all required here: an unbounded window over the
	// partitioned sample table is a request for the whole archive.
	return json(
		await run(async () => getSampleSeries(params.id, parseSampleQuery(url.searchParams)))
	)
}
