import type { Handle } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { gateDecision } from '$lib/server/gate.js'
import { SESSION_COOKIE, readSession } from '$lib/server/session.js'

export { PUBLIC_PATHS, isPublicPath } from '$lib/server/public-paths.js'

/**
 * The auth gate. Every request passes through here, and anything the allowlist
 * in $lib/server/public-paths.ts does not name requires a valid session.
 *
 * Default-deny is the point: a route added tomorrow is protected by virtue of
 * existing, and opening one up is an edit to a five-entry list that both
 * test/boundaries.test.ts and test/auth.test.ts inspect.
 */
export const handle: Handle = async ({ event, resolve }) => {
	const key = env.SESSION_KEY
	const token = event.cookies.get(SESSION_COOKIE)

	// A missing key means a broken deployment: tokens are unverifiable, so nobody
	// is signed in and every request falls through to the refusal below. Failing
	// closed is the only safe direction here.
	let session = token && key ? await readSession(token, key) : null

	// Bearer tokens are accepted so a native app can use the same API later
	// without reshaping routes. Nothing issues one yet; the branch exists so the
	// route handlers never need to change when something does. It reads the same
	// sealed format, so it grants nothing a cookie would not.
	if (!session && key) {
		const bearer = event.request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1]
		if (bearer) session = await readSession(bearer, key)
	}

	event.locals.session = session
	event.locals.user = session

	const decision = gateDecision(event.url.pathname, event.url.search, session !== null)
	if (decision.kind === 'unauthorized') {
		return new Response('unauthorized', {
			status: 401,
			headers: { 'content-type': 'text/plain' }
		})
	}
	if (decision.kind === 'redirect') {
		return new Response(null, { status: 302, headers: { location: decision.location } })
	}

	return resolve(event)
}
