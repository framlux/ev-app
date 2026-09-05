import { error, type RequestEvent } from '@sveltejs/kit'
import type { SessionUser } from './session.js'

/**
 * Asserts a session inside a route handler.
 *
 * Redundant with the gate in hooks.server.ts, and kept deliberately: the gate
 * is a path allowlist, and a mistake in that list would otherwise expose an
 * endpoint with no second line of defence. Calling this costs a property read.
 */
export function requireUser(event: Pick<RequestEvent, 'locals'>): SessionUser {
	const user = event.locals.session
	if (!user) error(401, 'unauthorized')
	return user
}
