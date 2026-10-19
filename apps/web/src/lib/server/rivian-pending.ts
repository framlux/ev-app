/**
 * A Rivian sign-in that is waiting for its one-time code, held in this process
 * and nowhere else (design §4.3).
 *
 * Rivian's sign-in has two steps when the account has a second factor: `Login`
 * answers with an `otpToken` instead of a session, Rivian sends the code, and
 * `LoginWithOTP` needs that token, the app session it was issued under and the
 * email, all from the first request. Something has to hold them between the two
 * POSTs. This is the same answer `tesla-session.ts` gives for the same
 * question, and for the same reasons: one replica, one operator, and losing the
 * entry costs one retry rather than any data. A cookie would put the half-made
 * sign-in in the browser, and a database row would put it at rest; neither is
 * worth it for something that is useless ten minutes later.
 *
 * WHAT IS HELD is the email, the app session (CSRF token and app session token)
 * and the `otpToken`. The PASSWORD is not among them, by construction: nothing
 * after the first step needs it, so it lives in the memory of one request and
 * is gone when that request is. None of this is a credential on its own (the
 * user session token only exists after the code is accepted), but each part is
 * a secret in the sense of §4.4, so nothing here is ever logged or returned.
 *
 * It dies three ways, all real: expiry is enforced on READ and swept on WRITE,
 * a successful code or a sign-out clears it, and a restart empties the process.
 * A wrong code is deliberately NOT one of them: the entry survives, so a typo in
 * the code costs a retype rather than a second password entry and a second code.
 *
 * Keyed by the app session's SUBJECT, for the reason `tesla-session.ts` spells
 * out at length: the app's session is a stateless sealed cookie with no
 * server-side id, so the subject is the only stable thing to key on. A code
 * requested in one browser can therefore be entered in another signed in as the
 * same subject, which with a single ALLOWED_SUBJECT is one person's two
 * browsers and is the intended reading.
 */

import type { AppSession } from '@ev/rivian'

/** What a first step leaves behind for the second. Nothing else is kept. */
export interface PendingOtp {
	email: string
	app: AppSession
	otpToken: string
	/** Past this the entry is evicted, not returned. */
	expiresAt: Date
}

/**
 * Ten minutes. Rivian's own `otpToken` has a lifetime we have not been told, and
 * a code arrives within seconds, so this is a bound on how long a half-made
 * sign-in may sit in memory rather than a promise about Rivian's side. When
 * Rivian expires the token sooner, the answer is `OTP_TOKEN_EXPIRED`, which the
 * user sees as "Wrong or expired code" and fixes by signing in again.
 */
export const PENDING_TTL_MS = 10 * 60_000

const pending = new Map<string, PendingOtp>()

/**
 * Record a sign-in that needs a code. A second attempt replaces the first rather
 * than accumulating, so signing in again after a mistyped email cannot leave a
 * stale token behind a live one.
 *
 * Sweeps first, for the reason `setTeslaToken` does: expiry on READ alone is
 * enough for the subject who comes back and does nothing for one who does not,
 * and an attempt abandoned at the code prompt would otherwise sit in the pod's
 * memory until the next deploy. The map holds one entry per allowed subject, so
 * a full pass costs nothing.
 *
 * `now` is a parameter, unlike `setTeslaToken`, which sweeps against the new
 * token's expiry. That trick works for a token whose lifetime comes from the
 * provider and gives the wrong answer when the lifetime is ours: it would treat
 * any entry stamped earlier as expired. The sign-in's own clock is passed
 * through instead, so the sweep and the stamp can never disagree about when it
 * is, and a test can move the clock instead of waiting ten minutes.
 */
export function setPendingOtp(subject: string, p: PendingOtp, now: Date = new Date()): void {
	for (const [key, held] of pending) {
		if (now.getTime() >= held.expiresAt.getTime()) pending.delete(key)
	}
	pending.set(subject, p)
}

/**
 * Null for every reason there is nothing to finish: no subject on the request,
 * no attempt for this subject, or one that has run out. The caller turns all
 * three into the same answer, because for the user they are the same: the code
 * cannot be used, sign in again.
 *
 * `subject` is deliberately nullable. The gate refuses an unauthenticated
 * request long before this is reached, but the store must not depend on that: a
 * missing subject reads nothing rather than becoming a Map key of its own.
 *
 * Expiry is enforced on READ and the entry is DELETED, not filtered out, so a
 * dead half-made sign-in does not stay in memory for as long as the pod runs.
 * `>=`, not `>`: at the instant it expires it is expired.
 */
export function getPendingOtp(
	subject: string | null | undefined,
	now: Date = new Date()
): PendingOtp | null {
	if (!subject) return null
	const held = pending.get(subject)
	if (!held) return null
	if (now.getTime() >= held.expiresAt.getTime()) {
		pending.delete(subject)
		return null
	}
	return held
}

/** Finished, abandoned or signed out: forget it. Idempotent. */
export function clearPendingOtp(subject: string): void {
	pending.delete(subject)
}
