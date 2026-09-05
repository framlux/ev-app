import { afterEach, describe, expect, it } from 'vitest'
import {
	clearTeslaToken,
	getTeslaToken,
	setTeslaToken
} from '../src/lib/server/tesla-session.js'

/**
 * The consented Tesla access token, and the promises made about it.
 *
 * Design §2 says the vehicle-capable credential stops existing at rest: it is
 * in this process's memory, keyed to the app session's subject, and nowhere
 * else. These tests pin the parts of that promise a future change could break
 * without anything else noticing — an expired token still being handed out, a
 * disconnect that does not disconnect, and a request with no session reading
 * somebody's token.
 */

const SUBJECT = 'pocketid-subject-123'
const OTHER_SUBJECT = 'pocketid-subject-999'
const T0 = new Date('2026-09-05T12:00:00Z')
const later = (seconds: number) => new Date(T0.getTime() + seconds * 1000)

afterEach(() => {
	clearTeslaToken(SUBJECT)
	clearTeslaToken(OTHER_SUBJECT)
})

describe('the in-memory Tesla token store', () => {
	it('hands back the token the consent produced', () => {
		setTeslaToken(SUBJECT, { accessToken: 'tok', expiresAt: later(3600) })
		expect(getTeslaToken(SUBJECT, T0)).toEqual({ accessToken: 'tok', expiresAt: later(3600) })
	})

	it('reads nothing for a subject that never consented', () => {
		expect(getTeslaToken(OTHER_SUBJECT, T0)).toBeNull()
	})

	it('reads nothing at all when the request carries no session', () => {
		setTeslaToken(SUBJECT, { accessToken: 'tok', expiresAt: later(3600) })
		// The gate should have refused first, but the store is not allowed to
		// depend on that: an unauthenticated request must never be able to reach
		// a token, and `undefined` must not become a Map key of its own.
		expect(getTeslaToken(null, T0)).toBeNull()
		expect(getTeslaToken(undefined, T0)).toBeNull()
		expect(getTeslaToken('', T0)).toBeNull()
	})

	it('treats an expired token as absent rather than stale', () => {
		setTeslaToken(SUBJECT, { accessToken: 'tok', expiresAt: later(60) })
		expect(getTeslaToken(SUBJECT, later(59))).not.toBeNull()
		// At the expiry, not after it: Tesla will already refuse a token on its
		// last second, and "connect again" is a better answer than a 401 the page
		// has to interpret.
		expect(getTeslaToken(SUBJECT, later(60))).toBeNull()
		expect(getTeslaToken(SUBJECT, later(600))).toBeNull()
	})

	it('drops an expired token from memory rather than merely hiding it', () => {
		setTeslaToken(SUBJECT, { accessToken: 'tok', expiresAt: later(60) })
		expect(getTeslaToken(SUBJECT, later(600))).toBeNull()
		// Reading with a clock BEFORE the expiry proves the entry is gone, not
		// filtered on the way out. There is no clock that goes backwards in
		// production; this is how you observe an eviction without exporting the
		// Map for a test to rummage through. §2's promise is that the credential
		// does not linger, and a filtered read would leave it in memory for the
		// life of the pod.
		expect(getTeslaToken(SUBJECT, T0)).toBeNull()
	})

	it('forgets the token when the operator disconnects', () => {
		setTeslaToken(SUBJECT, { accessToken: 'tok', expiresAt: later(3600) })
		clearTeslaToken(SUBJECT)
		expect(getTeslaToken(SUBJECT, T0)).toBeNull()
	})

	it('clears only the subject asked for', () => {
		setTeslaToken(SUBJECT, { accessToken: 'his', expiresAt: later(3600) })
		setTeslaToken(OTHER_SUBJECT, { accessToken: 'hers', expiresAt: later(3600) })
		clearTeslaToken(SUBJECT)
		expect(getTeslaToken(OTHER_SUBJECT, T0)?.accessToken).toBe('hers')
	})

	it('replaces the previous consent rather than accumulating them', () => {
		setTeslaToken(SUBJECT, { accessToken: 'old', expiresAt: later(60) })
		setTeslaToken(SUBJECT, { accessToken: 'new', expiresAt: later(3600) })
		expect(getTeslaToken(SUBJECT, later(120))?.accessToken).toBe('new')
	})

	/**
	 * Pinned as the documented behaviour, not left to be discovered.
	 *
	 * Design §3.2: the key is the subject because the app's session is a
	 * stateless sealed cookie with no server-side id, so there is nothing else
	 * stable to key on. The consequence is that a consent granted in one browser
	 * is usable from another browser signed in as the same subject. With one
	 * ALLOWED_SUBJECT that is one person's two browsers — the intended reading of
	 * "the operator is connected" — and it would be the wrong model the moment
	 * this app had a second operator.
	 */
	it('shares one consent across every browser signed in as the same subject', () => {
		setTeslaToken(SUBJECT, { accessToken: 'tok', expiresAt: later(3600) })
		// A second browser presents a different cookie carrying the same subject;
		// the store has no browser dimension for it to differ in.
		expect(getTeslaToken(SUBJECT, T0)?.accessToken).toBe('tok')
	})
})
