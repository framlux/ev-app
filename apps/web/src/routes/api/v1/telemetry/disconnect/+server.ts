import { error, json } from '@sveltejs/kit'
import type { RequestHandler } from './$types.js'
import { clearTeslaToken } from '$lib/server/tesla-session.js'

/**
 * Give the consent back before it expires.
 *
 * §3.2 lists three ways the Tesla credential dies — expiry, disconnect, and a
 * pod restart — and this is the one that needed a caller. Without it the only
 * ways to end a consent early were to redeploy or to wait, which makes the
 * shortest window the design can offer eight hours rather than one click.
 *
 * A POST, and idempotent: disconnecting when nothing is connected is not an
 * error, it is the state the caller asked for.
 */
export const POST: RequestHandler = ({ locals }) => {
	const user = locals.user
	if (!user) error(401, 'unauthorized')
	clearTeslaToken(user.sub)
	return json({ connected: false })
}
