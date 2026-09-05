import { error, redirect } from '@sveltejs/kit'
import { exchangeCode } from '@ev/tesla'
import type { RequestHandler } from './$types.js'
import { teslaOAuthEnv } from '$lib/server/tesla-client.js'
import { TESLA_FLOW_COOKIE, parseTeslaFlowState } from '$lib/server/tesla-flow.js'
import { setTeslaToken } from '$lib/server/tesla-session.js'

/** Where the operator came from, and where they are put back. */
const SETTINGS_PAGE = '/settings/telemetry'

/**
 * Where Tesla returns the browser after a consent.
 *
 * NOT in PUBLIC_PATHS, and that is deliberate rather than an oversight (§3.4a).
 * A vendor OAuth callback authenticates nobody here: it exchanges a code for a
 * token that grants access to a CAR, and it runs behind the app's own gate like
 * every other route. That works because the session cookie is `sameSite: lax`
 * and Tesla returns the browser by a top-level GET, which carries it.
 *
 * Nothing in this file may issue an app session. The only credential it
 * produces is a Tesla access token, and it goes into process memory keyed by
 * the subject the gate already verified — never into a cookie, never into the
 * database.
 */
export const GET: RequestHandler = async ({ cookies, locals, url }) => {
	const user = locals.user
	if (!user) error(401, 'unauthorized')

	const flow = parseTeslaFlowState(cookies.get(TESLA_FLOW_COOKIE))
	// Consumed exactly once, whatever happens next: a replayed callback must not
	// find a state waiting for it.
	cookies.delete(TESLA_FLOW_COOKIE, { path: '/' })

	// Tesla's own refusal — the operator cancelled, or the redirect URI is not
	// registered. Reported as itself rather than as a missing code, because
	// "consent denied" and "our flow is broken" have nothing in common.
	const denial = url.searchParams.get('error')
	if (denial) error(400, `Tesla refused the consent: ${denial}`)

	const state = url.searchParams.get('state')
	const code = url.searchParams.get('code')

	// THE EXCHANGE IS NOT ATTEMPTED unless the state matches the cookie this
	// browser was given. Everything below this line spends a Tesla credential;
	// this is the line that says the browser asking for it is the one that
	// started the consent (§5).
	if (!flow || !state || state !== flow.s) {
		error(400, 'the Tesla consent could not be verified; start again')
	}
	if (!code) error(400, 'Tesla returned no authorization code')

	const { clientId, clientSecret, redirectUri } = teslaOAuthEnv()
	const tokens = await exchangeCode(code, clientId, clientSecret, redirectUri)

	// THE ASSERTION THIS WHOLE DESIGN RESTS ON (§3.4).
	//
	// Without `offline_access` Tesla issues no refresh token, so this flow cannot
	// mint a standing, vehicle-capable credential. That is prose in §2 and a
	// scope constant in @ev/tesla; here it is a fact that is checked. If one ever
	// arrives — a widened WEB_SCOPES, a change at Tesla's end — the right answer
	// is to refuse and store nothing, not to quietly hold the thing the design
	// exists to avoid. The token is dropped on the floor unstored, and the
	// operator sees a failed connect rather than a silent downgrade in posture.
	if (tokens.refreshToken !== undefined) {
		error(
			500,
			'Tesla returned a refresh token for a flow that did not request offline_access; ' +
				'refusing to hold a standing vehicle credential. Nothing was stored.'
		)
	}

	// Keyed by the SUBJECT the gate verified, not by anything in the callback:
	// the consent belongs to the operator who started it.
	setTeslaToken(user.sub, { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt })

	// 303, so a refresh of the landing page does not replay a consumed code.
	redirect(303, SETTINGS_PAGE)
}
