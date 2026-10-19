import { error, json } from '@sveltejs/kit'
import type { RequestHandler } from './$types.js'
import { requireUser } from '$lib/server/guards.js'
import { defaultRivianAuthDeps, signIn } from '$lib/server/rivian-auth.js'
import { readStringFields } from '$lib/server/rivian-request.js'

/**
 * Step one of signing in to Rivian: email and password (§4.3).
 *
 * UNDER /api/ ON PURPOSE, for the reason the telemetry actions are: gate.ts
 * answers an unauthenticated /api/ request with a 401, where a page path would
 * get a 302 to the IdP that `fetch()` reads as a CORS failure. A session that
 * expired behind an open settings page then says "sign in again" instead of
 * "Failed to fetch".
 *
 * A POST with a JSON body, never a GET: the password is in it, and a URL is
 * logged by everything between here and the browser. The password lives in this
 * request's memory, goes to Rivian, and is gone. It is not stored, logged,
 * echoed or put in an error, and the body is not read until the session has
 * been checked.
 *
 * A Rivian refusal is a 200 with `status: 'error'` and a message the page shows;
 * only a request that is not a sign-in at all (no session, no fields) is an HTTP
 * error. See rivian-auth.ts for why the line is drawn there.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireUser(event)
	const { email, password } = await readStringFields(event.request, ['email', 'password'])
	const account = email.trim()
	if (account === '' || password === '') error(400, 'an email and a password are required')

	return json(await signIn(defaultRivianAuthDeps(), user.sub, account, password))
}
