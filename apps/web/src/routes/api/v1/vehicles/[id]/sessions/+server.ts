import { json, error } from '@sveltejs/kit'
import type { RequestHandler } from './$types.js'
import { run } from '$lib/server/http.js'
import { listSessions, parseSessionQuery } from '$lib/server/queries.js'

export const GET: RequestHandler = async ({ locals, params, url }) => {
	if (!locals.user) throw error(401, 'unauthorized')
	// Parsing happens inside `run` so a rejected parameter becomes a 400 with a
	// message naming the parameter, not an unhandled 500.
	return json(
		await run(async () => listSessions(params.id, parseSessionQuery(url.searchParams)))
	)
}
