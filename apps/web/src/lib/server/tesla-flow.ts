import { FLOW_TTL_SECONDS } from './auth.js'

/**
 * The `state` nonce of the Tesla consent flow, and nothing else.
 *
 * This is the CSRF boundary of an OUTBOUND authorization request (§5): it
 * proves the browser arriving at the callback is the one that started the
 * consent. It grants nothing about this application — the app session is a
 * separate, sealed cookie that Pocket-ID alone mints, and `boundaries.test.ts`
 * exists to keep those two facts from ever merging.
 *
 * Shaped after `auth.ts`'s FLOW_COOKIE rather than sharing it. Sharing the name
 * would let a Tesla consent overwrite an in-flight sign-in's PKCE verifier (and
 * the reverse), which fails as "sign-in expired" long after the cause; and this
 * flow has no verifier or nonce to store, because Tesla's authorize endpoint
 * takes neither.
 */
export const TESLA_FLOW_COOKIE = 'ev_tesla_flow'

/**
 * Ten minutes, the same window the Pocket-ID flow uses, and for the same
 * reason: the cookie is worthless once the callback consumes it, and the span
 * only has to cover a human typing a Tesla password and an MFA code. Note that
 * `authorizeUrl` hard-codes `prompt: 'login'`, so that IS what happens here
 * every time — see §3.4.
 */
export const TESLA_FLOW_TTL_SECONDS = FLOW_TTL_SECONDS

/**
 * `sameSite: 'lax'`, and this is the one attribute that must not be "hardened"
 * later.
 *
 * Tesla returns the browser by a top-level GET navigation, and a Strict cookie
 * is withheld on exactly that navigation. Every consent would then die at the
 * callback with "state missing" — intermittently enough, depending on how the
 * browser got there, to look like a Tesla fault rather than a cookie
 * attribute. `auth/login/+server.ts` carries the same note for the same reason.
 */
export const TESLA_FLOW_COOKIE_OPTIONS = {
	path: '/',
	httpOnly: true,
	secure: true,
	sameSite: 'lax'
} as const

/** What the cookie holds: the expected `state`, and deliberately nothing else. */
export interface TeslaFlowState {
	s: string
}

/**
 * Parses the cookie, or null for every way it can be unusable — absent,
 * truncated, not JSON, JSON of the wrong shape.
 *
 * Null is not distinguished from a mismatch by the caller: both mean "this
 * callback cannot be tied to a consent this browser started", which is refused
 * identically and without attempting an exchange.
 */
export function parseTeslaFlowState(raw: string | undefined): TeslaFlowState | null {
	if (!raw) return null
	try {
		const parsed: unknown = JSON.parse(raw)
		if (typeof parsed !== 'object' || parsed === null) return null
		const { s } = parsed as Record<string, unknown>
		// Length-checked, not merely typed: an empty string would otherwise
		// compare equal to an empty `state` query parameter and pass the check.
		return typeof s === 'string' && s.length > 0 ? { s } : null
	} catch {
		return null
	}
}
