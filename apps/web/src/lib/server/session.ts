import { hkdfSync } from 'node:crypto'
import { CompactEncrypt, SignJWT, compactDecrypt, jwtVerify } from 'jose'

/**
 * The application session: one subject, nothing else.
 *
 * There is deliberately no profile, no email and no group list in here. This
 * app has exactly one legitimate user and the only question a request ever asks
 * is "is this him". Anything else stored in the cookie would be a copy of IdP
 * state that goes stale silently.
 */
export interface SessionUser {
	sub: string
}

/** Cookie name. Exported so the hook, the routes and the tests cannot drift. */
export const SESSION_COOKIE = 'ev_session'

/**
 * 30 days. Long because re-authenticating a single-user telemetry dashboard
 * daily buys nothing, bounded because a stolen cookie must eventually die: the
 * cookie is self-contained, so revocation is expiry and only expiry.
 */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60

/**
 * Minimum SESSION_KEY length. The deployment mints it as `openssl rand -hex 32`
 * (64 characters). A shorter value is a misconfiguration rather than a bad
 * token, so it throws instead of quietly producing sessions nobody can forge
 * *and* nobody can trust.
 */
const MIN_KEY_LENGTH = 32

/**
 * These pin the token to this application and this purpose. Without them a
 * token minted by anything else that happens to share the key — a future
 * download-link signer, say — would verify here as a login.
 */
const ISSUER = 'ev-web'
const AUDIENCE = 'ev-session'

interface SealOptions {
	/**
	 * Clock used to stamp `iat`/`exp`. Tests move it to produce a token that is
	 * genuinely expired; nothing in production passes it.
	 */
	now?: Date
	/** Overrides {@link SESSION_TTL_SECONDS}; may be negative in tests. */
	ttlSeconds?: number
}

/**
 * Exactly one Pocket-ID subject may use this application. Authenticating
 * successfully against the IdP is necessary but not sufficient: the SSO
 * instance serves other applications and other people, and every one of them
 * can complete the authorization code flow against our client.
 *
 * The empty-`allowed` case is the dangerous one: an unset ALLOWED_SUBJECT must
 * lock everyone out, never let everyone in.
 */
export function isAuthorisedSubject(sub: string, allowed: string): boolean {
	return allowed.length > 0 && sub.length > 0 && sub === allowed
}

export type AuthorisationResult =
	| { ok: true; user: SessionUser }
	| { ok: false; reason: 'no-subject' | 'not-configured' | 'wrong-subject' }

/**
 * The callback's decision, separated from the HTTP plumbing so it can be tested
 * without an IdP. Refusal is explicit and typed: an unrecognised subject is a
 * distinct outcome from a broken token, because the two want different
 * responses (403 versus retry the flow) and confusing them is how "anyone at
 * the IdP can read the car's location" happens.
 */
export function authoriseClaims(
	claims: { sub?: unknown } | null | undefined,
	allowed: string
): AuthorisationResult {
	const sub = claims?.sub
	if (typeof sub !== 'string' || sub.length === 0) return { ok: false, reason: 'no-subject' }
	if (allowed.length === 0) return { ok: false, reason: 'not-configured' }
	if (sub !== allowed) return { ok: false, reason: 'wrong-subject' }
	return { ok: true, user: { sub } }
}

/**
 * Two independent keys from the one configured secret: HMAC signing and AES
 * encryption must never share key material, and deriving them here means the
 * deployment still only has to manage a single SESSION_KEY.
 */
function deriveKeys(key: string): { sign: Uint8Array; encrypt: Uint8Array } {
	if (key.length < MIN_KEY_LENGTH) {
		throw new Error(`SESSION_KEY must be at least ${MIN_KEY_LENGTH} characters`)
	}
	const ikm = new TextEncoder().encode(key)
	// No salt: the input keying material is already a 256-bit random value, and a
	// fixed salt would have to be shared between pod restarts anyway.
	const info = (label: string) => new TextEncoder().encode(label)
	return {
		sign: new Uint8Array(hkdfSync('sha256', ikm, new Uint8Array(0), info('ev-session-sign'), 32)),
		encrypt: new Uint8Array(
			hkdfSync('sha256', ikm, new Uint8Array(0), info('ev-session-encrypt'), 32)
		)
	}
}

/**
 * Signed, then encrypted (a nested JWT). Signing is what makes the cookie
 * unforgeable; encryption is what stops the subject identifier — which is the
 * whole authorisation model — from being readable by anything that can see the
 * cookie, including the browser's own devtools and any log that captures
 * headers.
 */
export async function sealSession(
	user: SessionUser,
	key: string,
	options: SealOptions = {}
): Promise<string> {
	const { sign, encrypt } = deriveKeys(key)
	const nowSeconds = Math.floor((options.now?.getTime() ?? Date.now()) / 1000)
	const ttl = options.ttlSeconds ?? SESSION_TTL_SECONDS

	const signed = await new SignJWT({})
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject(user.sub)
		.setIssuer(ISSUER)
		.setAudience(AUDIENCE)
		.setIssuedAt(nowSeconds)
		.setExpirationTime(nowSeconds + ttl)
		.sign(sign)

	return new CompactEncrypt(new TextEncoder().encode(signed))
		.setProtectedHeader({ alg: 'dir', enc: 'A256GCM', cty: 'JWT' })
		.encrypt(encrypt)
}

/**
 * Returns null for every reason a token can be unacceptable — wrong key,
 * tampered ciphertext, expired, wrong audience, missing subject. Null means
 * "not signed in", which the hook turns into a redirect to the IdP; it never
 * means "signed in as nobody".
 *
 * A malformed *key* is not a token problem and throws: silently treating a
 * misconfigured deployment as "everyone is signed out" would look like a
 * redirect loop and hide the real fault.
 */
export async function readSession(token: string, key: string): Promise<SessionUser | null> {
	const { sign, encrypt } = deriveKeys(key)
	try {
		const { plaintext } = await compactDecrypt(token, encrypt)
		const { payload } = await jwtVerify(new TextDecoder().decode(plaintext), sign, {
			issuer: ISSUER,
			audience: AUDIENCE
		})
		return typeof payload.sub === 'string' && payload.sub.length > 0 ? { sub: payload.sub } : null
	} catch {
		return null
	}
}

/** Name used by the implementation plan for {@link readSession}. */
export const unsealSession = readSession

/** Cookie attributes, in one place so sign-in and sign-out cannot disagree. */
export const SESSION_COOKIE_OPTIONS = {
	path: '/',
	httpOnly: true,
	secure: true,
	sameSite: 'lax'
} as const
