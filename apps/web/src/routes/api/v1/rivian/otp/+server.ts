import { error, json } from '@sveltejs/kit'
import type { RequestHandler } from './$types.js'
import { requireUser } from '$lib/server/guards.js'
import { defaultRivianAuthDeps, submitOtp } from '$lib/server/rivian-auth.js'
import { readStringFields } from '$lib/server/rivian-request.js'

/**
 * Step two of signing in to Rivian: the one-time code (§4.3).
 *
 * It finishes the attempt `login` parked in memory, which is why the body is the
 * code alone: the email, the app session and the token Rivian needs with it are
 * held server-side and never travel to the browser and back. A wrong code is a
 * 200 with `status: 'error'` and leaves the attempt in place, so the user can
 * retry until the ten minutes are up.
 *
 * The code is trimmed because it is typed or pasted, and a trailing newline in
 * a pasted SMS is not part of it. It is not logged, echoed or stored.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireUser(event)
	const { code } = await readStringFields(event.request, ['code'])
	const trimmed = code.trim()
	if (trimmed === '') error(400, 'a code is required')

	return json(await submitOtp(defaultRivianAuthDeps(), user.sub, trimmed))
}
