import { redirect } from '@sveltejs/kit'
import * as client from 'openid-client'
import type { RequestHandler } from './$types.js'
import {
	FLOW_COOKIE,
	FLOW_TTL_SECONDS,
	authEnv,
	oidcConfig,
	type FlowState
} from '$lib/server/auth.js'
import { safeNextPath } from '$lib/server/public-paths.js'

/**
 * Starts the Pocket-ID authorization code flow.
 *
 * PKCE plus `state` plus `nonce`, all three stored in one short-lived HttpOnly
 * cookie. One cookie rather than three so the callback cannot end up with a
 * verifier from one attempt and a state from another — opening two tabs on the
 * sign-in page is the ordinary way that happens.
 */
export const GET: RequestHandler = async ({ cookies, url }) => {
	const config = await oidcConfig()
	const { clientId, redirectUri } = authEnv()

	const verifier = client.randomPKCECodeVerifier()
	const flow: FlowState = {
		v: verifier,
		s: client.randomState(),
		n: client.randomNonce(),
		next: safeNextPath(url.searchParams.get('next'))
	}

	cookies.set(FLOW_COOKIE, JSON.stringify(flow), {
		path: '/',
		httpOnly: true,
		secure: true,
		// Lax, not Strict: the IdP redirects the browser back with a top-level GET
		// and Strict would withhold the cookie on that navigation, breaking every
		// sign-in that starts from an external link.
		sameSite: 'lax',
		maxAge: FLOW_TTL_SECONDS
	})

	const authorizationUrl = client.buildAuthorizationUrl(config, {
		client_id: clientId,
		redirect_uri: redirectUri,
		// No offline_access and no vendor scopes: this flow proves who is at the
		// keyboard and nothing else.
		scope: 'openid profile email',
		state: flow.s,
		nonce: flow.n,
		code_challenge: await client.calculatePKCECodeChallenge(verifier),
		code_challenge_method: 'S256'
	})

	redirect(302, authorizationUrl.href)
}
