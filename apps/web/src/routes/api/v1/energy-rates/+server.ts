import { error, json } from '@sveltejs/kit'
import type { RequestHandler } from './$types.js'
import { addManualRate, parseManualRate, readEnergyRates } from '$lib/server/rates.js'

/**
 * The energy-rate history, and the one way to add to it (§4).
 *
 * Two handlers and no others, on purpose. There is no PATCH and no DELETE
 * because a rate is a historical fact: it is the number a charge was priced
 * at, and every closed session carries the rate it was computed with. An edit
 * would re-price closed history with nothing left to notice it happened; a
 * correction is a newer row, which leaves the old price sitting next to the
 * charges it explains.
 *
 * A POST endpoint under /api/v1 rather than a form action, which is how every
 * mutation in this app is shaped — there are no form actions anywhere in it.
 * The `locals.user` check is redundant with hooks.server.ts and kept anyway:
 * gate.ts refuses an unauthenticated /api/ path with a 401 rather than a 302,
 * because a redirect reaches `fetch()` as a CORS failure or as an HTML body
 * parsed as JSON, and a future edit to PUBLIC_PATHS must not be able to
 * silently expose this.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'unauthorized')
	return json(await readEnergyRates())
}

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) error(401, 'unauthorized')

	// Refusals answer with a plain sentence, and the page reads a failure as
	// TEXT — so the sentence IS the error on screen. A status code alone would
	// say "the request failed (400)" and name no field.
	let body: unknown
	try {
		body = await request.json()
	} catch {
		error(400, 'The request body could not be read as JSON.')
	}

	const parsed = parseManualRate(body)
	if (!parsed.ok) error(400, parsed.message)

	// 409 rather than 400: the body is fine, the day is taken. The insert is ON
	// CONFLICT DO NOTHING on (effective_from, source) and the form dates a row
	// at midnight, so a second price for today is a write that cannot land —
	// and answering 201 with the row already there told the operator their
	// correction had been saved when the old number was what stayed.
	const added = await addManualRate(parsed.value)
	if (!added.ok) error(409, added.message)

	// 201 rather than 200: this created a row, and the row it created is what
	// comes back, so the page could show it without a reload if it ever stopped
	// reloading.
	return json(added.rate, { status: 201 })
}
