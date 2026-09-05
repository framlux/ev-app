import { isPublicPath } from './public-paths.js'
import { isAuthorisedSubject } from './session.js'
import type { SessionUser } from './session.js'

export type GateDecision =
	/** Hand the request to the router. */
	| { kind: 'allow' }
	/** Machine caller with no usable credential. */
	| { kind: 'unauthorized' }
	/** Browser with no usable credential; send it to the IdP. */
	| { kind: 'redirect'; location: string }

/**
 * What the gate does with a request, as a pure function of the path, the
 * session that survived verification, and who is currently allowed in.
 *
 * Separated from hooks.server.ts so the decision can be tested without a
 * SvelteKit runtime. Note the third argument is the *verified session*, not
 * *hasCookie*: a tampered or expired cookie reduces to `null` here, so it
 * produces exactly the same refusal as no cookie at all rather than being
 * ignored on the way to a handler.
 *
 * The subject is re-checked here on every request rather than only at the
 * callback. The cookie is self-contained and lives 30 days, so a session sealed
 * while a subject was allowed keeps verifying long after ALLOWED_SUBJECT
 * changes: without this check, editing the config would not evict the session
 * and "revoke access" would revoke nothing until the token expired.
 * `isAuthorisedSubject` also fails closed on an empty `allowedSubject`, so a
 * deployment that loses its configuration locks everyone out instead of
 * honouring every cookie it ever issued.
 */
export function gateDecision(
	pathname: string,
	search: string,
	session: SessionUser | null,
	allowedSubject: string
): GateDecision {
	const authorised = session !== null && isAuthorisedSubject(session.sub, allowedSubject)
	if (authorised || isPublicPath(pathname)) return { kind: 'allow' }
	// An API caller gets a status it can act on. A 302 to a sign-in page arrives
	// at fetch() as either a CORS failure or an HTML body parsed as JSON, which
	// is the wrong thing to spend an afternoon debugging.
	if (pathname.startsWith('/api/')) return { kind: 'unauthorized' }
	return {
		kind: 'redirect',
		location: `/auth/login?next=${encodeURIComponent(pathname + search)}`
	}
}
