import type { LayoutServerLoad } from './$types.js'
import { run } from '$lib/server/http.js'
import { getVehicle } from '$lib/server/queries.js'

/**
 * Loaded once for the vehicle header and tab strip, so every page under
 * /vehicles/[id] agrees about the car's name and what it is doing. A 404
 * ('vehicle not found') from here renders the error page for the whole
 * subtree, which is right: none of the tabs mean anything without a vehicle.
 */
export const load: LayoutServerLoad = async ({ params }) => {
	const entry = await run(() => getVehicle(params.id))
	return { entry }
}
