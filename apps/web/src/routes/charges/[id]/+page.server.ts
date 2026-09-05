import { redirect } from '@sveltejs/kit'
import type { PageServerLoad } from './$types.js'
import { run } from '$lib/server/http.js'
import { getSessionDetail, getVehicle } from '$lib/server/queries.js'

export const load: PageServerLoad = async ({ params }) => {
	const detail = await run(() => getSessionDetail(params.id))

	// One endpoint serves every kind, so a drive id in a /charges/ URL is a
	// realistic mistake (a hand-edited link, a stale bookmark). Send it to the
	// page that can actually draw it, rather than rendering a charge with no
	// curve and no energy.
	if (detail.session.kind === 'drive') redirect(307, `/drives/${detail.session.id}`)

	const vehicle = await run(() => getVehicle(detail.session.vehicleId))

	return { detail, vehicle: vehicle.vehicle }
}
