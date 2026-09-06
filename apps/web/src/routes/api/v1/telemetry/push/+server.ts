import { error, json } from '@sveltejs/kit'
import type { RequestHandler } from './$types.js'
import { run } from '$lib/server/http.js'
import { pushTelemetry, withTeslaSession } from '$lib/server/telemetry.js'

/**
 * "Push configuration": reconfigure a physical car.
 *
 * It is the only write in this application that leaves the cluster, and it is
 * deliberately hard to reach by accident — a POST, behind the gate, behind a
 * Tesla consent, and behind a confirmation on the page that names the VIN.
 *
 * The interesting refusals are in `pushTelemetry`, not here: a preflight
 * blocker and an already-applied configuration both send nothing to Tesla and
 * write nothing to the database. This handler's only job is to establish who is
 * asking and that they are connected.
 */
export const POST: RequestHandler = async ({ locals }) => {
	const user = locals.user
	if (!user) error(401, 'unauthorized')
	return json(await run(() => withTeslaSession(user.sub, pushTelemetry)))
}
