import { randomBytes } from 'node:crypto'
import { error, redirect } from '@sveltejs/kit'
import { WEB_SCOPES, authorizeUrl } from '@ev/tesla'
import type { RequestHandler } from './$types.js'
import { teslaOAuthEnv } from '$lib/server/tesla-client.js'
import {
	TESLA_FLOW_COOKIE,
	TESLA_FLOW_COOKIE_OPTIONS,
	TESLA_FLOW_TTL_SECONDS
} from '$lib/server/tesla-flow.js'

/**
 * Starts the Tesla consent. It is a CONNECT, never a sign-in.
 *
 * Connecting authorises this application to reach the car. Signing in would
 * mean a Tesla account granting access to this application, which nothing here
 * does and nothing ever should — the app has exactly one way in and it is
 * Pocket-ID. `boundaries.test.ts` holds that line, and the wording of the
 * button on the page is part of it (§3.4a).
 *
 * This route sits BEHIND the gate, so the operator is already authenticated
 * when they press it. That is what makes the callback safe to gate too: the
 * session cookie is `sameSite: lax`, so it survives Tesla's top-level GET back.
 *
 * `WEB_SCOPES` is passed explicitly. `authorizeUrl`'s default includes
 * `offline_access` and both command scopes, and using it would mint exactly the
 * standing refresh token this whole design exists to remove — silently, because
 * consent and exchange would both succeed (§3.4).
 */
export const GET: RequestHandler = async ({ cookies, locals }) => {
	// Redundant with the gate and kept for the same reason every route keeps it:
	// a future edit to PUBLIC_PATHS must not be able to open a consent flow.
	if (!locals.user) error(401, 'unauthorized')

	// Both halves demanded before the browser leaves: a missing CLIENT_SECRET
	// discovered at the callback would cost a full Tesla login to find out about.
	const { clientId, redirectUri } = teslaOAuthEnv()

	// 256 bits from the CSPRNG. This is the CSRF boundary of the whole flow (§5),
	// so it is unguessable rather than merely unique.
	const state = randomBytes(32).toString('base64url')

	cookies.set(TESLA_FLOW_COOKIE, JSON.stringify({ s: state }), {
		...TESLA_FLOW_COOKIE_OPTIONS,
		maxAge: TESLA_FLOW_TTL_SECONDS
	})

	redirect(302, authorizeUrl(clientId, redirectUri, state, WEB_SCOPES))
}
