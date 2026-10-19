import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types.js'
import { requireUser } from '$lib/server/guards.js'
import { defaultRivianAuthDeps, signOut } from '$lib/server/rivian-auth.js'

/**
 * Sign out of Rivian: delete the stored credential (§4.3).
 *
 * The connector notices within its poll interval (§5.2), sees that there is no
 * row, and closes the socket, so this is the one click that stops the stream.
 * It also forgets a sign-in waiting for its code.
 *
 * A POST, and idempotent: signing out when nobody is signed in is not an error,
 * it is the state the caller asked for. The body is not read, so `{}`, nothing
 * at all, and anything else behave the same.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireUser(event)
	await signOut(defaultRivianAuthDeps(), user.sub)
	return json({ status: 'signed_out' })
}
