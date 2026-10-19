import type { PageServerLoad } from './$types.js'
import {
	getPool,
	readRivianCredential,
	readRivianStatus,
	withTransaction
} from '$lib/server/db.js'
import { getPendingOtp } from '$lib/server/rivian-pending.js'

/**
 * Everything the Rivian page can say, from this database and this process (§4.3,
 * §5.7). It reaches Rivian for nothing: signing in and out are buttons, and the
 * connector, not this page, is what talks to Rivian's websocket.
 *
 * Two rows are read, and they answer different questions. The CREDENTIAL says
 * who is signed in and since when, which is the web's own doing. The STATUS says
 * what the connector is doing about it, which only the connector knows and
 * writes (best-effort, so it may lag or be absent). They are shown side by side
 * and never merged: "signed in as X" with a status of `credential_invalid` is
 * exactly the situation the page exists to make visible.
 *
 * WHAT IS NOT PASSED ON. `readRivianCredential` returns the sealed credential
 * with the account, and this load takes the account and the stamp from it and
 * nothing else. The sealed string is no use without the connector's private
 * key, which this pod never holds, but there is no reason for the browser to
 * have it, and a page `data` object is serialised into the HTML of every
 * render. The status's internal vehicle id is left out too: nothing shows it.
 * `lastError` is passed as the connector stored it, which is the §4.4 redacted
 * form and nothing richer; this load adds no text of its own to it.
 *
 * Dates become ISO strings here, as the telemetry page's DTO does, so what the
 * page receives is plain data whatever the transport does to a `Date`.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const { credential, status } = await withTransaction(getPool(), async (c) => ({
		credential: await readRivianCredential(c),
		status: await readRivianStatus(c)
	}))

	// One reading of the clock for the flag and for `now`, so the page is
	// rendered against a single instant. Reading the store also EVICTS an expired
	// attempt (rivian-pending.ts), so a load after the ten minutes both reports
	// and completes its death.
	const now = new Date()

	return {
		credential: credential
			? { account: credential.account, updatedAt: credential.updatedAt.toISOString() }
			: null,
		status: status
			? {
					state: status.state,
					vin: status.vin,
					lastFrameAt: status.lastFrameAt?.toISOString() ?? null,
					lastError: status.lastError,
					backoffUntil: status.backoffUntil?.toISOString() ?? null,
					droppedProperties: status.droppedProperties,
					updatedAt: status.updatedAt.toISOString()
				}
			: null,
		/**
		 * Whether a sign-in is waiting for its code. A boolean and nothing else:
		 * the attempt itself (the email, the app session, the token) is never put
		 * in data that is sent to the browser. It is what makes the code box
		 * survive a reload, which is the one thing local page state cannot do.
		 */
		pendingOtp: getPendingOtp(locals.user?.sub, now) !== null,
		/**
		 * The server's clock at render, so ages are computed against a fixed
		 * instant rather than `Date.now()` inside a `$derived`, which is not a
		 * reactive dependency and would freeze when first read (the defect
		 * LiveIndicator shipped with; the telemetry page says the same).
		 */
		now: now.toISOString()
	}
}
