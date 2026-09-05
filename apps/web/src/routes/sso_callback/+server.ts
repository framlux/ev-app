import { error, redirect } from '@sveltejs/kit'
import * as client from 'openid-client'
import type { RequestHandler } from './$types.js'
import { FLOW_COOKIE, authEnv, callbackUrl, oidcConfig, parseFlowState } from '$lib/server/auth.js'
import { safeNextPath } from '$lib/server/public-paths.js'
import {
	SESSION_COOKIE,
	SESSION_COOKIE_OPTIONS,
	SESSION_TTL_SECONDS,
	authoriseClaims,
	sealSession
} from '$lib/server/session.js'

/**
 * The registered redirect URI. Completes the code exchange, then applies the
 * single-subject rule.
 *
 * The order matters: the token exchange succeeding means Pocket-ID
 * authenticated somebody, not that it authenticated the owner of this car. The
 * SSO instance serves other applications and other people, and every one of
 * them can reach this endpoint with a valid code. A subject that is not the
 * configured one gets 403 and, critically, no cookie — the refusal happens
 * before anything is sealed.
 */
export const GET: RequestHandler = async ({ cookies, url }) => {
	const { allowedSubject, sessionKey, redirectUri } = authEnv()

	const flow = parseFlowState(cookies.get(FLOW_COOKIE))
	// Consumed exactly once, whatever happens next: a replayed callback must not
	// find a verifier waiting for it.
	cookies.delete(FLOW_COOKIE, { path: '/' })
	if (!flow) error(400, 'sign-in expired; start again')

	const config = await oidcConfig()

	let claims: client.IDToken | undefined
	try {
		const tokens = await client.authorizationCodeGrant(
			config,
			callbackUrl(url, new URL(redirectUri).origin),
			{ pkceCodeVerifier: flow.v, expectedState: flow.s, expectedNonce: flow.n }
		)
		claims = tokens.claims()
	} catch {
		// Deliberately opaque. A mismatched state, a reused code and a revoked
		// client all land here; telling the caller which one would help nobody who
		// is entitled to be here.
		error(400, 'sign-in failed')
	}

	const decision = authoriseClaims(claims, allowedSubject)
	if (!decision.ok) {
		error(403, 'this account is not permitted to use this application')
	}

	cookies.set(SESSION_COOKIE, await sealSession(decision.user, sessionKey), {
		...SESSION_COOKIE_OPTIONS,
		maxAge: SESSION_TTL_SECONDS
	})

	redirect(303, safeNextPath(flow.next))
}
