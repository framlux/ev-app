import { isPublicPath } from './public-paths.js'

export type GateDecision =
	/** Hand the request to the router. */
	| { kind: 'allow' }
	/** Machine caller with no usable credential. */
	| { kind: 'unauthorized' }
	/** Browser with no usable credential; send it to the IdP. */
	| { kind: 'redirect'; location: string }

/**
 * What the gate does with a request, as a pure function of the path and whether
 * a session survived verification.
 *
 * Separated from hooks.server.ts so the decision can be tested without a
 * SvelteKit runtime. Note the second argument is *hasSession*, not *hasCookie*:
 * a tampered or expired cookie reduces to `false` here, so it produces exactly
 * the same refusal as no cookie at all rather than being ignored on the way to
 * a handler.
 */
export function gateDecision(pathname: string, search: string, hasSession: boolean): GateDecision {
	if (hasSession || isPublicPath(pathname)) return { kind: 'allow' }
	// An API caller gets a status it can act on. A 302 to a sign-in page arrives
	// at fetch() as either a CORS failure or an HTML body parsed as JSON, which
	// is the wrong thing to spend an afternoon debugging.
	if (pathname.startsWith('/api/')) return { kind: 'unauthorized' }
	return {
		kind: 'redirect',
		location: `/auth/login?next=${encodeURIComponent(pathname + search)}`
	}
}
