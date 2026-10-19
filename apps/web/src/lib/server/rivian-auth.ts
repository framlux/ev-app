/**
 * SIGNING IN TO RIVIAN, AND SEALING WHAT COMES BACK (design §4.2, §4.3).
 *
 * The routes under /api/v1/rivian are thin; the decisions are here, so they can
 * be tested with a fake Rivian and a recording `save` and no network, no
 * database and no SvelteKit runtime.
 *
 * THE FLOW. `signIn` asks Rivian for an app session and signs in under it. With
 * no second factor, Rivian answers with a user session token: it is sealed to
 * the connector's PUBLIC key and the sealed string is saved. With a second
 * factor, Rivian answers with an `otpToken`: the half-made sign-in is parked in
 * `rivian-pending.ts` and `submitOtp` finishes it when the user types the code.
 * Either way the plaintext token exists inside one function call, between
 * Rivian's answer and `sealCredential`, and nowhere else.
 *
 * THIS POD CAN SEAL AND CANNOT UNSEAL. `publicJwk` is the only key it has, and
 * `sealCredential` refuses a key with a private part, so a pod mistakenly given
 * the connector's private key fails its first sign-in instead of quietly being
 * able to read back every credential it writes (`defaultRivianAuthDeps` fails
 * earlier still, naming the variable). The access and refresh tokens Rivian
 * also returns never reach this file: `RivianHttp` does not return them.
 *
 * NOTHING SECRET LEAVES. Review Focus 5 is the reason this file looks the way it
 * does. The password is an argument and goes to Rivian and nowhere else; the
 * OTP code likewise; the tokens are held in the pending map or sealed. What the
 * caller gets back is an outcome with a message chosen from a fixed list below,
 * and the only variable text in any of them is a Rivian error CODE, which
 * `@ev/rivian` has already reduced to a short identifier (it keeps two fields
 * of an error response, `code` and `reason`, and drops one shaped like a
 * secret). No error is ever formatted from the request, the response, `message`
 * or `cause`, and nothing in this file logs: a failure that is worth a log line
 * is already a thrown error, and SvelteKit logs those once, from a message this
 * file never put a secret in.
 *
 * A Rivian refusal is an OUTCOME, not an exception. The user typed something
 * wrong, or Rivian is busy, and the page has a sentence for each; making those
 * HTTP errors would turn "wrong password" into a failed request. Anything that
 * is not a Rivian answer (the database is down, the key is unusable) IS thrown,
 * because that is a fault in this deployment and not something the user can
 * fix by retyping.
 */

import type { JWK } from 'jose'
import { env } from '$env/dynamic/private'
import {
	RivianApiError,
	RivianHttp,
	parseJwk,
	sealCredential,
	type AppSession,
	type LoginResult
} from '@ev/rivian'
import { deleteRivianCredential, getPool, upsertRivianCredential, withTransaction } from './db.js'
import {
	PENDING_TTL_MS,
	clearPendingOtp,
	getPendingOtp,
	setPendingOtp
} from './rivian-pending.js'

export interface RivianAuthDeps {
	/** Only the three sign-in calls. This module cannot reach a query by construction. */
	http: Pick<RivianHttp, 'createCsrf' | 'login' | 'loginWithOtp'>
	/** From `RIVIAN_CREDENTIAL_PUBLIC_KEY`; null means "not configured". */
	publicJwk: JWK | null
	save(v: { sealed: string; account: string }): Promise<void>
	remove(): Promise<void>
	now(): Date
}

export type SignInOutcome =
	| { status: 'signed_in' }
	| { status: 'otp_required' }
	| { status: 'error'; message: string }

/**
 * The messages, and the only sentences a user is ever shown about a Rivian
 * failure (design §4.4). They are constants rather than formatted from the
 * error so that "what can reach the browser" is this list and one code, and a
 * reviewer can read the whole of it in a screen.
 */
const WRONG_CREDENTIALS = 'Wrong email or password'
const WRONG_CODE = 'Wrong or expired code'
const LOCKED = 'Account temporarily locked'
const RATE_LIMITED = 'Rivian is rate-limiting, try later'
const NOT_CONFIGURED = 'Rivian sign-in is not configured on this server'

const failure = (message: string): SignInOutcome => ({ status: 'error', message })

/**
 * Turn a Rivian refusal into one of the messages.
 *
 * `step` matters for exactly one thing. A `BAD_USER_INPUT` is "wrong email or
 * password" at the first step, where those are the only things the user typed,
 * and cannot be that at the second, where the user typed a code and the email is
 * the one already accepted. Saying the password was wrong to someone who has
 * just entered a code sends them to retype a password that was fine.
 *
 * Locked and rate-limited are checked first because they are the more specific
 * truth: a lock or a throttle may arrive with a validation code beside it, and
 * "wrong password" would then invite retries that make both worse.
 *
 * Anything else is `Rivian error <code>`, the first code Rivian gave. The code
 * is safe to show for the reason in the file comment; with none (a bare 502
 * from a proxy) the status stands in for it, spelled like a code, and with
 * neither the word is `UNKNOWN`, so a message never has a hole in it.
 */
function messageFor(e: RivianApiError, step: 'password' | 'code'): string {
	if (e.locked) return LOCKED
	if (e.rateLimited) return RATE_LIMITED
	if (step === 'code') {
		if (e.badOtp || e.badCredentials) return WRONG_CODE
	} else if (e.badCredentials) {
		return WRONG_CREDENTIALS
	}
	const code = e.codes[0]?.code ?? (e.httpStatus !== null ? `HTTP_${e.httpStatus}` : 'UNKNOWN')
	return `Rivian error ${code}`
}

/**
 * Seal and save. The plaintext token is used for one thing, the
 * `sealCredential` call, and what `save` receives is the JWE and the account:
 * nothing downstream of this function has the token to leak.
 *
 * Throws, rather than returning an outcome, for a key that cannot seal or a
 * database that cannot save. The user has signed in to Rivian by now, and
 * telling them "signed in" about a credential that was not stored would be the
 * one wrong answer; a 500 is honest, and the cost is a second sign-in.
 */
async function sealAndSave(
	deps: RivianAuthDeps,
	publicJwk: JWK,
	account: string,
	userSessionToken: string
): Promise<void> {
	const sealed = await sealCredential(publicJwk, { userSessionToken })
	await deps.save({ sealed, account })
}

/** Step one: email and password. */
export async function signIn(
	deps: RivianAuthDeps,
	subject: string,
	email: string,
	password: string
): Promise<SignInOutcome> {
	// Before any call to Rivian: a server that cannot seal must not take a
	// password, still less spend a login on a session it could not keep.
	const publicJwk = deps.publicJwk
	if (!publicJwk) return failure(NOT_CONFIGURED)

	let app: AppSession
	let result: LoginResult
	try {
		app = await deps.http.createCsrf()
		result = await deps.http.login(app, email, password)
	} catch (e) {
		if (e instanceof RivianApiError) return failure(messageFor(e, 'password'))
		throw e
	}

	if (result.kind === 'otp') {
		// One reading of the clock for the stamp and the sweep, so they cannot
		// disagree about when it is.
		const now = deps.now()
		setPendingOtp(
			subject,
			{
				email,
				app,
				otpToken: result.otpToken,
				expiresAt: new Date(now.getTime() + PENDING_TTL_MS)
			},
			now
		)
		return { status: 'otp_required' }
	}

	// A session came back, so any half-made sign-in from before is superseded.
	clearPendingOtp(subject)
	await sealAndSave(deps, publicJwk, email, result.userSessionToken)
	return { status: 'signed_in' }
}

/** Step two, when there was one: the code. */
export async function submitOtp(
	deps: RivianAuthDeps,
	subject: string,
	code: string
): Promise<SignInOutcome> {
	const publicJwk = deps.publicJwk
	if (!publicJwk) return failure(NOT_CONFIGURED)

	// "Nothing in progress" and "it ran out" are one answer, and it is the one
	// for a wrong code, because to the user they are the same: this code cannot
	// be used. Rivian is not asked: a call spent on an attempt we have already
	// decided is dead is a call that counts toward its rate limit for nothing.
	const pending = getPendingOtp(subject, deps.now())
	if (!pending) return failure(WRONG_CODE)

	let userSessionToken: string
	try {
		const session = await deps.http.loginWithOtp(
			pending.app,
			pending.email,
			code,
			pending.otpToken
		)
		userSessionToken = session.userSessionToken
	} catch (e) {
		// The entry stays: a mistyped code is retried against the same token.
		if (e instanceof RivianApiError) return failure(messageFor(e, 'code'))
		throw e
	}

	// Cleared as soon as Rivian has accepted the code, not after the save: the
	// `otpToken` is spent either way, so an entry kept past this point could
	// only be retried into a failure, and the app session in it is not worth
	// holding for longer than it was needed.
	clearPendingOtp(subject)
	await sealAndSave(deps, publicJwk, pending.email, userSessionToken)
	return { status: 'signed_in' }
}

/**
 * Sign out: delete the credential, and forget a sign-in in progress.
 *
 * The connector notices within its poll interval, sees no row, and closes the
 * socket (§5.2). Idempotent, and it needs no key: `deps.publicJwk` is never read
 * here, which is why a pod with a bad key can still sign out.
 */
export async function signOut(deps: RivianAuthDeps, subject: string): Promise<void> {
	clearPendingOtp(subject)
	await deps.remove()
}

const PUBLIC_KEY_VARIABLE = 'RIVIAN_CREDENTIAL_PUBLIC_KEY'

/**
 * The real dependencies: the environment, the real client, the repository.
 *
 * `publicJwk` is a GETTER, and that is the whole of the "throw at first use"
 * rule. Parsing happens when something reads the key, which is `signIn` and
 * `submitOtp` and not `signOut`, so a pod with an unusable key can still sign a
 * user out, and building these dependencies never fails by itself. A variable
 * that is unset, or only whitespace (what an empty ConfigMap entry gives), is
 * "not configured" and not an error: the page says so and nothing else breaks.
 * One that is SET and wrong throws a message naming the variable and what is
 * wrong with it. `parseJwk`'s messages are fixed text and never quote the key,
 * which matters because the likeliest mistake is pasting in the PRIVATE one.
 *
 * It is read from the environment on each use rather than captured at import:
 * `$env/dynamic/private` is the form that exists for exactly this (see
 * auth.ts), and a value read at import is a value that cannot be changed under
 * a test.
 */
export function defaultRivianAuthDeps(): RivianAuthDeps {
	return {
		http: new RivianHttp(),
		get publicJwk(): JWK | null {
			const text = env[PUBLIC_KEY_VARIABLE]
			if (text === undefined || text.trim() === '') return null
			try {
				return parseJwk(text, 'public')
			} catch (e) {
				throw new Error(`${PUBLIC_KEY_VARIABLE} is not usable: ${(e as Error).message}`)
			}
		},
		save: (v) => withTransaction(getPool(), (c) => upsertRivianCredential(c, v)),
		remove: () => withTransaction(getPool(), (c) => deleteRivianCredential(c)),
		now: () => new Date()
	}
}
