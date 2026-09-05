import { redirect } from '@sveltejs/kit'
import type { RequestHandler } from './$types.js'
import { authEnv, oidcConfig } from '$lib/server/auth.js'
import { SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from '$lib/server/session.js'

/**
 * Signs out.
 *
 * The cookie is the session — there is no server-side record to invalidate — so
 * deleting it is the whole of the local logout, and it happens first and
 * unconditionally. The IdP round trip is best effort: without it the browser
 * would bounce straight back through a still-valid Pocket-ID session and appear
 * not to have signed out at all, but a discovery failure must not be able to
 * leave the cookie in place.
 */
async function signOut(cookies: { delete: (name: string, opts: { path: string }) => void }) {
	cookies.delete(SESSION_COOKIE, { path: SESSION_COOKIE_OPTIONS.path })

	try {
		const { clientId, redirectUri } = authEnv()
		const origin = new URL(redirectUri).origin
		const endSession = (await oidcConfig()).serverMetadata().end_session_endpoint
		if (endSession) {
			const target = new URL(endSession)
			target.searchParams.set('client_id', clientId)
			target.searchParams.set('post_logout_redirect_uri', origin)
			return target.href
		}
	} catch {
		// Fall through: locally signed out is still signed out.
	}
	return '/'
}

/**
 * POST is the real entry point; GET exists because a plain link is what a
 * single-user dashboard actually wants. The CSRF exposure of a GET here is a
 * forced sign-out — annoying, not dangerous — and no state is destroyed.
 */
export const POST: RequestHandler = async ({ cookies }) => {
	redirect(303, await signOut(cookies))
}

export const GET: RequestHandler = async ({ cookies }) => {
	redirect(303, await signOut(cookies))
}
