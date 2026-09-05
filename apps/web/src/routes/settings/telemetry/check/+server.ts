import { error, json } from '@sveltejs/kit'
import type { RequestHandler } from './$types.js'
import { run } from '$lib/server/http.js'
import { checkTelemetry, withTeslaSession } from '$lib/server/telemetry.js'

/**
 * "Check now": ask the car what configuration it has applied, and cache the
 * answer (§3.7).
 *
 * A POST rather than a GET because it is not free — it spends two Fleet API
 * calls and writes a row — and because a GET would be prefetched by anything
 * that walks links.
 *
 * The refusals are ordered by what they cost: no app session is 401 from the
 * gate and again here, and no Tesla consent is 409 with a sentence that names
 * the fix. Neither reaches Tesla.
 */
export const POST: RequestHandler = async ({ locals }) => {
	const user = locals.user
	if (!user) error(401, 'unauthorized')
	return json(await run(() => withTeslaSession(user.sub, checkTelemetry)))
}
