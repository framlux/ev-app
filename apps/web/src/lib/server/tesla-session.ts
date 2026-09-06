/**
 * The consented Tesla access token, held in this process and nowhere else.
 *
 * The scripts this feature replaces need a Fleet API refresh token — a
 * standing, vehicle-capable credential. Mounting one into the internet-facing
 * pod is the part of the change that would have made the deployment less safe,
 * so design §2 removes it: the operator consents at the moment of use, and what
 * comes back is an access token with no refresh token behind it (the web flow
 * asks for no `offline_access`, so Tesla issues none). It lives here.
 *
 * Not the database, which would be at rest. Not a cookie, which would put a
 * vehicle-capable credential in the browser. A module-level Map is per-process
 * state in a stateful-looking place, which is normally a smell; it is right
 * here for the same reason the live-stream listener is a singleton — one
 * replica, one operator, and the cost of losing it is one re-consent rather
 * than data loss. If this were ever scaled out, a consent would apply only to
 * the pod that served the callback. That is noted, not solved.
 *
 * The three ways the credential dies are real, not aspirational: expiry is
 * enforced on read AND swept on write, disconnect is `POST
 * /api/v1/telemetry/disconnect`, and a restart empties the process. There is
 * deliberately no renewal path. Without a refresh token there is
 * nothing to renew with, and a flow that cannot renew itself cannot quietly
 * become the standing credential this design exists to remove. The page shows
 * the expiry and offers "Connect to Tesla" again.
 */

/** What a consent leaves behind. Nothing else about the grant is kept. */
export interface TeslaToken {
	accessToken: string
	/** From Tesla's `expires_in`. Past this the entry is evicted, not returned. */
	expiresAt: Date
}

/**
 * Keyed by the app session's SUBJECT, and that has a consequence worth stating
 * rather than discovering.
 *
 * The app's own session is a stateless sealed cookie with no server-side id, so
 * the subject is the only stable thing to key on. A consent granted in one
 * browser is therefore usable from another browser signed in as the same
 * subject: there is no browser dimension in this map for them to differ in.
 * With a single ALLOWED_SUBJECT that is one person's two browsers, which is the
 * intended reading of "the operator is connected". It would be the wrong model
 * for a second operator, and that is the reason to revisit this if there is
 * ever one.
 */
const tokens = new Map<string, TeslaToken>()

/**
 * The consent's result. A second consent replaces the first rather than
 * accumulating, so reconnecting after an expiry cannot leave a dead token
 * behind a live one.
 */
export function setTeslaToken(subject: string, token: TeslaToken): void {
	// Sweep first. Expiry was enforced on READ alone, which is enough for the
	// subject who comes back and does nothing at all for one who does not: an
	// operator who consents, closes the tab and never returns left a dead
	// credential in the pod's memory until the next deploy. The map holds one
	// entry per allowed subject, so a full pass costs nothing and makes the
	// promise in this file's header — the token dies when it expires — true
	// without needing someone to ask for it.
	const at = token.expiresAt.getTime()
	for (const [key, held] of tokens) {
		if (held.expiresAt.getTime() <= at) tokens.delete(key)
	}
	tokens.set(subject, token)
}

/**
 * Null for every reason there is no usable token: no session on the request, no
 * consent for this subject, or a consent that has run out. The caller turns all
 * three into the same answer — "connect to Tesla first" — because they are the
 * same answer.
 *
 * `subject` is deliberately nullable. The gate refuses unauthenticated requests
 * long before this is reached, but the store must not depend on that: a missing
 * subject reads nothing rather than becoming a Map key of its own.
 *
 * Expiry is enforced on READ and the entry is DELETED, not filtered out. A
 * filtered read would leave a dead credential in the pod's memory for as long
 * as the pod ran, which is exactly what §2 promises does not happen. `now` is
 * injectable so a test can observe an expiry without waiting an hour for one.
 */
export function getTeslaToken(
	subject: string | null | undefined,
	now: Date = new Date()
): TeslaToken | null {
	if (!subject) return null
	const token = tokens.get(subject)
	if (!token) return null
	// `>=`, not `>`: Tesla refuses a token on its final second anyway, and asking
	// for a reconnect is a better answer than a 401 the page has to interpret.
	if (now.getTime() >= token.expiresAt.getTime()) {
		tokens.delete(subject)
		return null
	}
	return token
}

/** Disconnect. Also what a 401 from Tesla does: the token is dead, drop it. */
export function clearTeslaToken(subject: string): void {
	tokens.delete(subject)
}
