import { formatWithOptions } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JWK } from 'jose'
import {
	RivianApiError,
	generateCredentialKeys,
	toRivianApiError,
	unsealCredential,
	type AppSession,
	type LoginResult
} from '@ev/rivian'
import {
	clearPendingOtp,
	getPendingOtp,
	PENDING_TTL_MS,
	setPendingOtp
} from '../src/lib/server/rivian-pending.js'
import {
	defaultRivianAuthDeps,
	signIn,
	signOut,
	submitOtp,
	type RivianAuthDeps
} from '../src/lib/server/rivian-auth.js'

/**
 * The Rivian sign-in core, against a FAKE Rivian.
 *
 * Nothing here reaches the network, and the assertions that matter most are
 * about things that must NOT happen: a sign-in that needs a code saves nothing,
 * a wrong code does not end the attempt, an expired attempt never calls Rivian,
 * and no secret appears anywhere it should not. The last of those is checked
 * for the whole file rather than per test (Review Focus 5): the console is
 * spied on from the first test to the last, so a log line added to the sign-in
 * path later fails here whichever test happens to exercise it.
 *
 * The secrets are shaped like secrets on purpose. `@ev/rivian` refuses to keep
 * a code or reason that looks like one, so a test token that was a short word
 * would pass that filter and prove nothing about what this layer does with it.
 */

const SUBJECT = 'pocketid-subject-rivian'
const EMAIL = 'owner@example.com'
const PASSWORD = 'Tr0ub4dor&3-correct-horse'
const OTP_CODE = '482913'
const USER_SESSION_TOKEN = 'us-7d1f0c9e4b2a8f36e5d4c3b2a1908f7e6d5c4b3a'
const OTP_TOKEN = 'otp-3b9a1c7e5d2f4a6b8c0e1d3f5a7b9c2e4d6f8a0b'
const CSRF_TOKEN = 'csrf-91c0a2b4d6e8f1a3c5e7092b4d6f8a1c3e5a7b9d'
const APP_SESSION_TOKEN = 'as-5e7a9c1b3d5f7092a4c6e8f0b2d4a6c8e0f2b4d6'

const SECRETS = [PASSWORD, OTP_CODE, USER_SESSION_TOKEN, OTP_TOKEN, CSRF_TOKEN, APP_SESSION_TOKEN]

const APP: AppSession = { csrfToken: CSRF_TOKEN, appSessionToken: APP_SESSION_TOKEN }
const NOW = new Date('2026-10-19T12:00:00.000Z')

const NOT_CONFIGURED = 'Rivian sign-in is not configured on this server'
const WRONG_CODE = 'Wrong or expired code'

/** Every console line the sign-in path wrote, for the file-wide secrecy check. */
const logged: string[] = []
const spies: ReturnType<typeof vi.spyOn>[] = []

/**
 * A console call as the terminal would show it. NOT `JSON.stringify`: that
 * gives `{}` for an Error (its message and stack are not enumerable), so a
 * `console.error(err)` with a secret in `err.message`, the most likely way a
 * secret ever reaches a log, would have passed this file's check unseen.
 * `formatWithOptions` is what `console` itself uses, with the depth limit lifted
 * so a secret nested four levels down in an object is not hidden as `[Object]`.
 * An Error comes out as its stack, which begins with its message.
 */
const asLogged = (args: unknown[]) => formatWithOptions({ depth: null }, ...args)

beforeEach(() => {
	logged.length = 0
	for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
		spies.push(
			vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
				logged.push(asLogged(args))
			})
		)
	}
})

afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore()
	clearPendingOtp(SUBJECT)
	clearPendingOtp('someone-else')
	// The assertion that makes the whole file a Review Focus 5 test.
	for (const line of logged) {
		for (const secret of SECRETS) expect(line).not.toContain(secret)
	}
})

/** A body Rivian might send back that echoes every secret the request held. */
function echoingBody(code: string, reason?: string) {
	return {
		errors: [
			{
				message: `Login failed for ${EMAIL} with ${PASSWORD} (${OTP_CODE}) under ${USER_SESSION_TOKEN}`,
				extensions: { code, ...(reason ? { reason } : {}) }
			}
		],
		data: { login: { userSessionToken: USER_SESSION_TOKEN, otpToken: OTP_TOKEN } },
		request: { csrfToken: CSRF_TOKEN, appSessionToken: APP_SESSION_TOKEN, password: PASSWORD }
	}
}

const apiError = (code: string, reason?: string, status = 200) =>
	toRivianApiError(status, echoingBody(code, reason), 'Login')

interface FakeHttp {
	createCsrf: ReturnType<typeof vi.fn>
	login: ReturnType<typeof vi.fn>
	loginWithOtp: ReturnType<typeof vi.fn>
}

function fakeHttp(
	o: {
		login?: LoginResult | Error
		loginWithOtp?: { userSessionToken: string } | Error
		createCsrf?: Error
	} = {}
): FakeHttp {
	const settle = <T>(v: T | Error) => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v))
	return {
		createCsrf: vi.fn(() => (o.createCsrf ? settle(o.createCsrf) : Promise.resolve(APP))),
		login: vi.fn(() =>
			settle(o.login ?? { kind: 'session' as const, userSessionToken: USER_SESSION_TOKEN })
		),
		loginWithOtp: vi.fn(() =>
			settle(o.loginWithOtp ?? { userSessionToken: USER_SESSION_TOKEN })
		)
	}
}

interface Harness {
	deps: RivianAuthDeps
	http: FakeHttp
	saved: { sealed: string; account: string }[]
	removed: () => number
	privateJwk: JWK
	clock: { now: Date }
}

async function harness(
	http: FakeHttp = fakeHttp(),
	over: Partial<RivianAuthDeps> = {}
): Promise<Harness> {
	const { privateJwk, publicJwk } = await generateCredentialKeys()
	const saved: { sealed: string; account: string }[] = []
	let removals = 0
	const clock = { now: NOW }
	const deps: RivianAuthDeps = {
		http: http as unknown as RivianAuthDeps['http'],
		publicJwk,
		save: async (v) => {
			saved.push(v)
		},
		remove: async () => {
			removals++
		},
		now: () => clock.now,
		...over
	}
	return { deps, http, saved, removed: () => removals, privateJwk, clock }
}

const noSecrets = (text: string) => {
	for (const secret of SECRETS) expect(text).not.toContain(secret)
}

describe('the file-wide console check', () => {
	// The check in `afterEach` is only worth having if it can fail. These write
	// a secret to the console the ways a careless line would, confirm the
	// recorder sees it, and then empty the record so that the check itself does
	// not fail the test that proves it works.
	it.each([
		['an Error whose message carries the password', () => console.error(new Error(`failed for ${PASSWORD}`))],
		[
			'an Error whose cause carries a token',
			() => console.warn(new Error('sign-in failed', { cause: new Error(USER_SESSION_TOKEN) }))
		],
		['an object with the code four levels down', () => console.log({ a: { b: { c: { code: OTP_CODE } } } })],
		['a string argument', () => console.info('token', OTP_TOKEN)]
	])('records %s', (_name, write) => {
		write()
		expect(logged.length).toBeGreaterThan(0)
		expect(SECRETS.some((secret) => logged.join('\n').includes(secret))).toBe(true)
		logged.length = 0
	})
})

describe('signing in without a second factor', () => {
	it('seals the user session token alone, saves it once, and names the account', async () => {
		const h = await harness()
		const outcome = await signIn(h.deps, SUBJECT, EMAIL, PASSWORD)

		expect(outcome).toEqual({ status: 'signed_in' })
		expect(h.saved).toHaveLength(1)
		expect(h.saved[0]!.account).toBe(EMAIL)
		expect(Object.keys(h.saved[0]!).sort()).toEqual(['account', 'sealed'])

		// What the connector will read: exactly one field.
		expect(await unsealCredential(h.privateJwk, h.saved[0]!.sealed)).toEqual({
			userSessionToken: USER_SESSION_TOKEN
		})
		// And nothing the DB row holds is the token in the clear.
		noSecrets(JSON.stringify(h.saved))
		expect(getPendingOtp(SUBJECT, NOW)).toBeNull()
	})

	it('asks Rivian for an app session, then signs in under it', async () => {
		const h = await harness()
		await signIn(h.deps, SUBJECT, EMAIL, PASSWORD)
		expect(h.http.createCsrf).toHaveBeenCalledTimes(1)
		expect(h.http.login).toHaveBeenCalledWith(APP, EMAIL, PASSWORD)
		expect(h.http.loginWithOtp).not.toHaveBeenCalled()
	})

	it('drops a stale pending code entry, because a session has superseded it', async () => {
		const h = await harness()
		setPendingOtp(
			SUBJECT,
			{ email: EMAIL, app: APP, otpToken: OTP_TOKEN, expiresAt: new Date(NOW.getTime() + 60_000) },
			NOW
		)
		await signIn(h.deps, SUBJECT, EMAIL, PASSWORD)
		expect(getPendingOtp(SUBJECT, NOW)).toBeNull()
	})
})

describe('signing in with a second factor', () => {
	it('answers otp_required, saves nothing, and keeps the attempt for ten minutes', async () => {
		const h = await harness(fakeHttp({ login: { kind: 'otp', otpToken: OTP_TOKEN } }))
		const outcome = await signIn(h.deps, SUBJECT, EMAIL, PASSWORD)

		expect(outcome).toEqual({ status: 'otp_required' })
		expect(h.saved).toEqual([])

		const pending = getPendingOtp(SUBJECT, NOW)
		expect(pending).toMatchObject({ email: EMAIL, app: APP, otpToken: OTP_TOKEN })
		expect(pending!.expiresAt.getTime()).toBe(NOW.getTime() + PENDING_TTL_MS)
		expect(PENDING_TTL_MS).toBe(10 * 60_000)
		// The password is in the request and nowhere else: the pending entry must
		// not be where it is kept for later.
		expect(JSON.stringify(pending)).not.toContain(PASSWORD)
	})

	it('finishes with the right code: saves the sealed token and clears the attempt', async () => {
		const h = await harness(fakeHttp({ login: { kind: 'otp', otpToken: OTP_TOKEN } }))
		await signIn(h.deps, SUBJECT, EMAIL, PASSWORD)
		const outcome = await submitOtp(h.deps, SUBJECT, OTP_CODE)

		expect(outcome).toEqual({ status: 'signed_in' })
		expect(h.http.loginWithOtp).toHaveBeenCalledWith(APP, EMAIL, OTP_CODE, OTP_TOKEN)
		expect(h.saved).toHaveLength(1)
		expect(h.saved[0]!.account).toBe(EMAIL)
		expect(await unsealCredential(h.privateJwk, h.saved[0]!.sealed)).toEqual({
			userSessionToken: USER_SESSION_TOKEN
		})
		noSecrets(JSON.stringify(h.saved))
		expect(getPendingOtp(SUBJECT, NOW)).toBeNull()
	})

	it('a wrong code says so, keeps the attempt, and lets the next try succeed', async () => {
		const http = fakeHttp({ login: { kind: 'otp', otpToken: OTP_TOKEN } })
		const h = await harness(http)
		await signIn(h.deps, SUBJECT, EMAIL, PASSWORD)

		http.loginWithOtp.mockRejectedValueOnce(apiError('BAD_USER_INPUT', 'INVALID_OTP', 400))
		const wrong = await submitOtp(h.deps, SUBJECT, '000000')
		expect(wrong).toEqual({ status: 'error', message: WRONG_CODE })
		expect(h.saved).toEqual([])
		expect(getPendingOtp(SUBJECT, NOW)).not.toBeNull()

		// Not a hypothesis about "kept": the kept entry is what the retry uses.
		expect(await submitOtp(h.deps, SUBJECT, OTP_CODE)).toEqual({ status: 'signed_in' })
		expect(http.loginWithOtp).toHaveBeenLastCalledWith(APP, EMAIL, OTP_CODE, OTP_TOKEN)
		expect(h.saved).toHaveLength(1)
	})

	it('a wrong code gives the one message the design names, and no restart', async () => {
		const h = await harness(fakeHttp({ login: { kind: 'otp', otpToken: OTP_TOKEN } }))
		await signIn(h.deps, SUBJECT, EMAIL, PASSWORD)
		h.http.loginWithOtp.mockRejectedValueOnce(apiError('BAD_USER_INPUT', 'INVALID_OTP', 200))
		const outcome = await submitOtp(h.deps, SUBJECT, OTP_CODE)
		// `toEqual` ignores an absent key but not a present one, so this proves
		// the page is not told to take the code box away.
		expect(outcome).toEqual({ status: 'error', message: WRONG_CODE })
		expect(outcome).not.toHaveProperty('restart')
		expect(getPendingOtp(SUBJECT, NOW)).not.toBeNull()
	})

	it('an expired token ends the attempt: same message, entry cleared, page told to restart', async () => {
		const h = await harness(fakeHttp({ login: { kind: 'otp', otpToken: OTP_TOKEN } }))
		await signIn(h.deps, SUBJECT, EMAIL, PASSWORD)
		h.http.loginWithOtp.mockRejectedValueOnce(apiError('UNAUTHENTICATED', 'OTP_TOKEN_EXPIRED', 200))

		expect(await submitOtp(h.deps, SUBJECT, OTP_CODE)).toEqual({
			status: 'error',
			message: WRONG_CODE,
			restart: true
		})
		expect(h.saved).toEqual([])
		// A dead token cannot succeed, so keeping it would only invite retries.
		expect(getPendingOtp(SUBJECT, NOW)).toBeNull()

		// And the next code is refused WITHOUT another call to Rivian: the user
		// has to sign in again, which is the whole point of clearing it.
		expect(await submitOtp(h.deps, SUBJECT, OTP_CODE)).toEqual({
			status: 'error',
			message: WRONG_CODE,
			restart: true
		})
		expect(h.http.loginWithOtp).toHaveBeenCalledTimes(1)
	})

	it('signing in again after an expired token starts a fresh attempt that can finish', async () => {
		const http = fakeHttp({ login: { kind: 'otp', otpToken: OTP_TOKEN } })
		const h = await harness(http)
		await signIn(h.deps, SUBJECT, EMAIL, PASSWORD)
		http.loginWithOtp.mockRejectedValueOnce(apiError('UNAUTHENTICATED', 'OTP_TOKEN_EXPIRED', 200))
		await submitOtp(h.deps, SUBJECT, OTP_CODE)

		await signIn(h.deps, SUBJECT, EMAIL, PASSWORD)
		expect(await submitOtp(h.deps, SUBJECT, OTP_CODE)).toEqual({ status: 'signed_in' })
		expect(h.saved).toHaveLength(1)
	})

	it('with no attempt in progress, a code is refused without calling Rivian', async () => {
		const h = await harness()
		expect(await submitOtp(h.deps, SUBJECT, OTP_CODE)).toEqual({
			status: 'error',
			message: WRONG_CODE,
			restart: true
		})
		expect(h.http.loginWithOtp).not.toHaveBeenCalled()
		expect(h.http.createCsrf).not.toHaveBeenCalled()
	})

	it('an attempt belongs to the subject that started it', async () => {
		const h = await harness(fakeHttp({ login: { kind: 'otp', otpToken: OTP_TOKEN } }))
		await signIn(h.deps, SUBJECT, EMAIL, PASSWORD)
		expect(await submitOtp(h.deps, 'someone-else', OTP_CODE)).toEqual({
			status: 'error',
			message: WRONG_CODE,
			restart: true
		})
		expect(h.http.loginWithOtp).not.toHaveBeenCalled()
		expect(getPendingOtp(SUBJECT, NOW)).not.toBeNull()
	})
})

describe('the ten-minute window', () => {
	it('one millisecond before the window closes the code is still tried', async () => {
		const h = await harness(fakeHttp({ login: { kind: 'otp', otpToken: OTP_TOKEN } }))
		await signIn(h.deps, SUBJECT, EMAIL, PASSWORD)
		h.clock.now = new Date(NOW.getTime() + PENDING_TTL_MS - 1)
		expect(await submitOtp(h.deps, SUBJECT, OTP_CODE)).toEqual({ status: 'signed_in' })
	})

	it('once it has closed, the code is refused WITHOUT calling Rivian, and the entry is gone', async () => {
		const h = await harness(fakeHttp({ login: { kind: 'otp', otpToken: OTP_TOKEN } }))
		await signIn(h.deps, SUBJECT, EMAIL, PASSWORD)

		h.clock.now = new Date(NOW.getTime() + PENDING_TTL_MS)
		expect(await submitOtp(h.deps, SUBJECT, OTP_CODE)).toEqual({
			status: 'error',
			message: WRONG_CODE,
			restart: true
		})
		expect(h.http.loginWithOtp).not.toHaveBeenCalled()
		expect(h.saved).toEqual([])
		// DELETED on read, not merely filtered: asking with an earlier clock finds
		// nothing, which a filtered read would not have made true.
		expect(getPendingOtp(SUBJECT, NOW)).toBeNull()
	})

	it('a later write for another subject sweeps an expired entry nobody came back for', () => {
		const held = {
			email: EMAIL,
			app: APP,
			otpToken: OTP_TOKEN,
			expiresAt: new Date(NOW.getTime() + PENDING_TTL_MS)
		}
		setPendingOtp(SUBJECT, held, NOW)

		const later = new Date(NOW.getTime() + PENDING_TTL_MS + 5 * 60_000)
		setPendingOtp(
			'someone-else',
			{ ...held, expiresAt: new Date(later.getTime() + PENDING_TTL_MS) },
			later
		)

		// Read with the ORIGINAL clock, at which the first entry had not expired:
		// it can only be absent because the write above removed it.
		expect(getPendingOtp(SUBJECT, NOW)).toBeNull()
		expect(getPendingOtp('someone-else', later)).not.toBeNull()
	})

	it('reads nothing for a missing subject rather than keying a Map on it', () => {
		expect(getPendingOtp(null, NOW)).toBeNull()
		expect(getPendingOtp(undefined, NOW)).toBeNull()
		expect(getPendingOtp('', NOW)).toBeNull()
	})
})

describe('what Rivian can say, and what the user is told', () => {
	// The echoing body is the point of the `apiError` helper: each of these is
	// built the way the real client builds one, from a response that repeats the
	// password, the code and the tokens in its `message` and beside its errors.
	it.each([
		['BAD_CURRENT_PASSWORD', apiError('BAD_CURRENT_PASSWORD', undefined, 200), 'Wrong email or password'],
		['BAD_USER_INPUT', apiError('BAD_USER_INPUT', undefined, 400), 'Wrong email or password'],
		['SESSION_MANAGER_ERROR', apiError('SESSION_MANAGER_ERROR', undefined, 200), 'Account temporarily locked'],
		['RATE_LIMIT', apiError('RATE_LIMIT', undefined, 200), 'Rivian is rate-limiting, try later'],
		['HTTP 429 with no code', apiError('x'.repeat(60), undefined, 429), 'Rivian is rate-limiting, try later'],
		['an unknown code', apiError('SOMETHING_NEW', undefined, 200), 'Rivian error SOMETHING_NEW'],
		['a gateway timeout', new RivianApiError(null, [{ code: 'TIMEOUT' }], 'Login'), 'Rivian error TIMEOUT'],
		['a malformed answer', new RivianApiError(200, [{ code: 'BAD_RESPONSE' }], 'Login'), 'Rivian error BAD_RESPONSE'],
		['a bare 502', new RivianApiError(502, [], 'Login'), 'Rivian error HTTP_502']
	])('sign-in: %s', async (_name, error, message) => {
		const h = await harness(fakeHttp({ login: error }))
		const outcome = await signIn(h.deps, SUBJECT, EMAIL, PASSWORD)
		expect(outcome).toEqual({ status: 'error', message })
		expect(h.saved).toEqual([])
		expect(getPendingOtp(SUBJECT, NOW)).toBeNull()
		noSecrets(JSON.stringify(outcome))
	})

	it('sign-in: a failure of the app-session call is classified the same way', async () => {
		const h = await harness(fakeHttp({ createCsrf: apiError('RATE_LIMIT') }))
		expect(await signIn(h.deps, SUBJECT, EMAIL, PASSWORD)).toEqual({
			status: 'error',
			message: 'Rivian is rate-limiting, try later'
		})
		expect(h.http.login).not.toHaveBeenCalled()
	})

	it.each([
		['locked', apiError('SESSION_MANAGER_ERROR'), 'Account temporarily locked'],
		['rate-limited', apiError('RATE_LIMIT'), 'Rivian is rate-limiting, try later'],
		['an unknown code', apiError('SOMETHING_NEW'), 'Rivian error SOMETHING_NEW'],
		// The user has just typed a code and nothing else, so a validation error
		// at this step cannot be about the email or password and must not say it is.
		['a validation error', apiError('BAD_USER_INPUT'), WRONG_CODE]
	])('code step: %s', async (_name, error, message) => {
		const http = fakeHttp({ login: { kind: 'otp', otpToken: OTP_TOKEN } })
		const h = await harness(http)
		await signIn(h.deps, SUBJECT, EMAIL, PASSWORD)
		http.loginWithOtp.mockRejectedValueOnce(error)

		const outcome = await submitOtp(h.deps, SUBJECT, OTP_CODE)
		expect(outcome).toEqual({ status: 'error', message })
		expect(h.saved).toEqual([])
		expect(getPendingOtp(SUBJECT, NOW)).not.toBeNull()
		noSecrets(JSON.stringify(outcome))
	})

	it('a code shaped like a secret never reaches the message', async () => {
		// Rivian's own `extensions.code` carrying a token. @ev/rivian drops it, so
		// the message falls back to the status and the token is nowhere.
		const h = await harness(fakeHttp({ login: apiError(USER_SESSION_TOKEN, undefined, 400) }))
		const outcome = await signIn(h.deps, SUBJECT, EMAIL, PASSWORD)
		expect(outcome).toEqual({ status: 'error', message: 'Rivian error HTTP_400' })
	})
})

describe('a server that cannot seal', () => {
	it('without a public key it says so and never calls Rivian', async () => {
		const h = await harness(fakeHttp(), { publicJwk: null })
		expect(await signIn(h.deps, SUBJECT, EMAIL, PASSWORD)).toEqual({
			status: 'error',
			message: NOT_CONFIGURED
		})
		expect(await submitOtp(h.deps, SUBJECT, OTP_CODE)).toEqual({
			status: 'error',
			message: NOT_CONFIGURED
		})
		expect(h.http.createCsrf).not.toHaveBeenCalled()
		expect(h.http.login).not.toHaveBeenCalled()
		expect(h.http.loginWithOtp).not.toHaveBeenCalled()
		expect(h.saved).toEqual([])
		// Nothing was started, so nothing is held that a later configuration
		// would find and finish.
		expect(getPendingOtp(SUBJECT, NOW)).toBeNull()
	})

	/**
	 * Keys that `parseJwk` would let through or that a caller could hand the deps
	 * directly, and that cannot seal. Each must fail BEFORE Rivian is asked for
	 * anything: found at the end of a sign-in, it would have spent a password
	 * login (or a single-use code) on a session nobody can store.
	 */
	const unusableKeys = async (): Promise<[string, JWK, string][]> => {
		const keys = await generateCredentialKeys()
		return [
			['one with a private part', keys.privateJwk, keys.privateJwk.d!],
			// A well-formed public key whose point is not on the curve: it parses,
			// and only importing it finds out.
			['one that is not a point on the curve', { ...keys.publicJwk, y: keys.publicJwk.x! }, '']
		]
	}

	it.each([0, 1])('sign-in refuses an unusable key (%#) before any call to Rivian', async (i) => {
		const [, key, privatePart] = (await unusableKeys())[i]!
		const h = await harness(fakeHttp(), { publicJwk: key })
		const failure = await signIn(h.deps, SUBJECT, EMAIL, PASSWORD).then(
			() => null,
			(e: unknown) => e
		)
		expect(failure).toBeInstanceOf(Error)
		// Not one Rivian call, so no login was spent and no token ever existed.
		expect(h.http.createCsrf).not.toHaveBeenCalled()
		expect(h.http.login).not.toHaveBeenCalled()
		expect(h.saved).toEqual([])
		expect(getPendingOtp(SUBJECT, NOW)).toBeNull()
		// Neither a secret nor the key's private part is in what was thrown.
		noSecrets(String((failure as Error).message) + String((failure as Error).stack))
		if (privatePart) expect((failure as Error).message).not.toContain(privatePart)
	})

	it.each([0, 1])(
		'code step refuses an unusable key (%#) before Rivian sees the code, and keeps the attempt',
		async (i) => {
			const [, key] = (await unusableKeys())[i]!
			const http = fakeHttp({ login: { kind: 'otp', otpToken: OTP_TOKEN } })
			const good = await harness(http)
			await signIn(good.deps, SUBJECT, EMAIL, PASSWORD)
			expect(getPendingOtp(SUBJECT, NOW)).not.toBeNull()

			// The same attempt, now meeting a server whose key has gone wrong.
			const failure = await submitOtp({ ...good.deps, publicJwk: key }, SUBJECT, OTP_CODE).then(
				() => null,
				(e: unknown) => e
			)
			expect(failure).toBeInstanceOf(Error)
			// A code is single-use: Rivian must not have been given it.
			expect(http.loginWithOtp).not.toHaveBeenCalled()
			expect(good.saved).toEqual([])
			noSecrets(String((failure as Error).message) + String((failure as Error).stack))

			// And the attempt is untouched, so once the key is fixed the SAME
			// attempt finishes without another password entry.
			expect(getPendingOtp(SUBJECT, NOW)).not.toBeNull()
			expect(await submitOtp(good.deps, SUBJECT, OTP_CODE)).toEqual({ status: 'signed_in' })
			expect(good.saved).toHaveLength(1)
		}
	)

	it('a failed save after sign-in is rethrown as the save\'s own error, never reported as a sign-in', async () => {
		const failureFromSave = new Error('connection terminated')
		const h = await harness(fakeHttp(), {
			save: async () => {
				throw failureFromSave
			}
		})
		// Rejected with that very error: no outcome object was returned, so the
		// page cannot be told `signed_in` about a credential that was not stored.
		await expect(signIn(h.deps, SUBJECT, EMAIL, PASSWORD)).rejects.toBe(failureFromSave)
		// What was thrown is the save's own text and carries none of what was in
		// flight; the token was sealed, and the sealed value is not in it either.
		noSecrets(failureFromSave.message + failureFromSave.stack)
		expect(h.saved).toEqual([])
	})

	it('a failed save after the code is rethrown too, and the spent attempt is already gone', async () => {
		const failureFromSave = new Error('connection terminated')
		const http = fakeHttp({ login: { kind: 'otp', otpToken: OTP_TOKEN } })
		const h = await harness(http, {
			save: async () => {
				throw failureFromSave
			}
		})
		await signIn(h.deps, SUBJECT, EMAIL, PASSWORD)

		await expect(submitOtp(h.deps, SUBJECT, OTP_CODE)).rejects.toBe(failureFromSave)
		// Rivian accepted the code, so its token is spent; keeping the entry
		// would only invite a retry that cannot work.
		expect(getPendingOtp(SUBJECT, NOW)).toBeNull()
	})
})

describe('signing out', () => {
	it('removes the credential and forgets an attempt in progress', async () => {
		const h = await harness(fakeHttp({ login: { kind: 'otp', otpToken: OTP_TOKEN } }))
		await signIn(h.deps, SUBJECT, EMAIL, PASSWORD)
		expect(getPendingOtp(SUBJECT, NOW)).not.toBeNull()

		await signOut(h.deps, SUBJECT)
		expect(h.removed()).toBe(1)
		expect(getPendingOtp(SUBJECT, NOW)).toBeNull()
	})

	it('is idempotent, because the state it asks for may already hold', async () => {
		const h = await harness()
		await signOut(h.deps, SUBJECT)
		await signOut(h.deps, SUBJECT)
		expect(h.removed()).toBe(2)
	})
})

describe('the default dependencies', () => {
	const KEY = 'RIVIAN_CREDENTIAL_PUBLIC_KEY'
	const before = process.env[KEY]

	afterEach(() => {
		if (before === undefined) delete process.env[KEY]
		else process.env[KEY] = before
	})

	it('read an unset or blank variable as "not configured"', () => {
		delete process.env[KEY]
		expect(defaultRivianAuthDeps().publicJwk).toBeNull()
		process.env[KEY] = '   '
		expect(defaultRivianAuthDeps().publicJwk).toBeNull()
	})

	it('parse a public key out of the variable', async () => {
		const { publicJwk } = await generateCredentialKeys()
		process.env[KEY] = JSON.stringify(publicJwk)
		expect(defaultRivianAuthDeps().publicJwk).toEqual(publicJwk)
	})

	/** What reading `publicJwk` throws, as text, or '' if it does not throw. */
	const thrownBy = (deps: RivianAuthDeps): string => {
		try {
			void deps.publicJwk
			return ''
		} catch (e) {
			return (e as Error).message
		}
	}

	it('throw at first use, naming the variable, when it holds the PRIVATE key', async () => {
		const { privateJwk } = await generateCredentialKeys()
		process.env[KEY] = JSON.stringify(privateJwk)

		// Building the deps is not use: sign-out must still work with a bad key.
		const deps = defaultRivianAuthDeps()
		const message = thrownBy(deps)
		expect(message).toContain(KEY)
		expect(message).toContain('private part')
		expect(message).not.toContain(privateJwk.d!)
	})

	it('throw at first use, naming the variable, when it is not a key at all', () => {
		process.env[KEY] = 'not json {"d":"leaky-secret-value"}'
		const message = thrownBy(defaultRivianAuthDeps())
		expect(message).toContain(KEY)
		expect(message).not.toContain('leaky-secret-value')
	})
})
