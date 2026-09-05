import { json, error } from '@sveltejs/kit'
import type { RequestHandler } from './$types.js'
import { run } from '$lib/server/http.js'
import { listVehicles } from '$lib/server/queries.js'

// The `locals.user` check is redundant with hooks.server.ts and is kept on
// purpose: a future edit to PUBLIC_PATHS must not be able to silently expose
// an endpoint. Defence in depth costs one line per route.
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'unauthorized')
	return json(await run(() => listVehicles()))
}
