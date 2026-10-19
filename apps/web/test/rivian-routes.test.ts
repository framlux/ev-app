import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isHttpError } from '@sveltejs/kit'
import { generateCredentialKeys, unsealCredential } from '@ev/rivian'
import type { JWK } from 'jose'
import { clearPendingOtp, getPendingOtp, setPendingOtp } from '../src/lib/server/rivian-pending.js'

/**
 * The three Rivian routes, thin as they are.
 *
 * There is no route-level seam for dependencies in this codebase (see
 * telemetry-routes.test.ts, which tests the routes for 401 and 409 and the core
 * with injected ones), so these tests go through the same module-level doors
 * the pod does and fake what is on the far side of them:
 *   - the database, with `vi.mock` of `$lib/server/db.js`, so no test can
 *     delete or write a real row (as telemetry-page-load.test.ts does);
 *   - Rivian, by replacing `fetch`. `RivianHttp` is the real one, so the route
 *     is exercised with the actual request shapes and the actual error
 *     reduction, and the stub is the only thing that could be called a network.
 *
 * What they pin that the core's tests cannot: that every route refuses before it
 * reads the body, and that nothing secret is in what a route RESPONDS with.
 */

const upsertRivianCredential = vi.fn()
const deleteRivianCredential = vi.fn()

vi.mock('../src/lib/server/db.js', () => ({
	getPool: () => ({}) as never,
	withTransaction: (_pool: unknown, fn: (c: unknown) => unknown) => fn({}),
	upsertRivianCredential: (...args: unknown[]) => upsertRivianCredential(...args),
	deleteRivianCredential: (...args: unknown[]) => deleteRivianCredential(...args)
}))

const { POST: login } = await import('../src/routes/api/v1/rivian/login/+server.js')
const { POST: otp } = await import('../src/routes/api/v1/rivian/otp/+server.js')
const { POST: logout } = await import('../src/routes/api/v1/rivian/logout/+server.js')

const SUBJECT = 'pocketid-subject-rivian-routes'
const EMAIL = 'owner@example.com'
const PASSWORD = 'Tr0ub4dor&3-correct-horse'
const OTP_CODE = '482913'
const USER_SESSION_TOKEN = 'us-7d1f0c9e4b2a8f36e5d4c3b2a1908f7e6d5c4b3a'
const OTP_TOKEN = 'otp-3b9a1c7e5d2f4a6b8c0e1d3f5a7b9c2e4d6f8a0b'
const CSRF_TOKEN = 'csrf-91c0a2b4d6e8f1a3c5e7092b4d6f8a1c3e5a7b9d'
const APP_SESSION_TOKEN = 'as-5e7a9c1b3d5f7092a4c6e8f0b2d4a6c8e0f2b4d6'
const SECRETS = [PASSWORD, OTP_CODE, USER_SESSION_TOKEN, OTP_TOKEN, CSRF_TOKEN, APP_SESSION_TOKEN]

const KEY = 'RIVIAN_CREDENTIAL_PUBLIC_KEY'
const NOT_CONFIGURED = 'Rivian sign-in is not configured on this server'

const signedIn = { locals: { session: { sub: SUBJECT }, user: { sub: SUBJECT } } }
const anonymous = { locals: { session: null, user: null } }

function post(body: unknown, locals = signedIn.locals) {
	return {
		locals,
		request: new Request('https://ev.example.com/api/v1/rivian/x', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: typeof body === 'string' ? body : JSON.stringify(body)
		})
	} as never
}

const thrownBy = async (fn: () => unknown): Promise<unknown> => {
	try {
		await fn()
	} catch (e) {
		return e
	}
	throw new Error('expected the handler to throw')
}

const original = process.env[KEY]
let publicJwk: JWK
let privateJwk: JWK

beforeEach(async () => {
	;({ publicJwk, privateJwk } = await generateCredentialKeys())
	delete process.env[KEY]
})

afterEach(() => {
	if (original === undefined) delete process.env[KEY]
	else process.env[KEY] = original
	clearPendingOtp(SUBJECT)
	vi.unstubAllGlobals()
	vi.clearAllMocks()
})

/**
 * Each route answers a POST and nothing else.
 *
 * SvelteKit answers a method the module does not export with a 405 of its own,
 * which is exactly what is wanted: a GET of /api/v1/rivian/login must not be a
 * way to sign in (the password would be in the URL, which everything between
 * here and the browser logs), and a GET of /logout must not be a link that signs
 * the car out when something prefetches it. An exported `GET` added later, for
 * convenience, would quietly be both.
 */
describe('the route modules export a POST handler and nothing else', () => {
	it.each([
		['login', '../src/routes/api/v1/rivian/login/+server.js'],
		['otp', '../src/routes/api/v1/rivian/otp/+server.js'],
		['logout', '../src/routes/api/v1/rivian/logout/+server.js']
	])('%s', async (_name, path) => {
		const module = await import(/* @vite-ignore */ path)
		expect(Object.keys(module)).toEqual(['POST'])
		expect(typeof module.POST).toBe('function')
	})
})

describe('every route refuses without a session, before it reads anything', () => {
	it.each([
		['login', login],
		['otp', otp],
		['logout', logout]
	])('%s', async (_name, handler) => {
		// `{ locals: {} }` has neither field, which is what a handler sees if the
		// hook did not run; null is what it sees when the hook ran and refused.
		for (const event of [{ locals: {} }, anonymous]) {
			const e = await thrownBy(() => handler(event as never))
			expect(isHttpError(e, 401)).toBe(true)
		}
		// And nothing reached the far side: no row deleted, none written.
		expect(deleteRivianCredential).not.toHaveBeenCalled()
		expect(upsertRivianCredential).not.toHaveBeenCalled()
	})
})

describe('login', () => {
	it('on a server with no public key says so, in the outcome and not as an error', async () => {
		const res = await login(post({ email: EMAIL, password: PASSWORD }))
		expect(res.status).toBe(200)
		const text = await res.text()
		expect(JSON.parse(text)).toEqual({ status: 'error', message: NOT_CONFIGURED })
		expect(text).not.toContain(PASSWORD)
		expect(upsertRivianCredential).not.toHaveBeenCalled()
	})

	it.each([
		['not JSON', 'definitely not json'],
		['an array', []],
		['no email', { password: PASSWORD }],
		['no password', { email: EMAIL }],
		['a blank email', { email: '  ', password: PASSWORD }],
		['a blank password', { email: EMAIL, password: '' }],
		['a number for the password', { email: EMAIL, password: 123456 }]
	])('refuses %s with a 400 that repeats nothing it was sent', async (_name, body) => {
		const e = await thrownBy(() => login(post(body)))
		expect(isHttpError(e, 400)).toBe(true)
		expect(JSON.stringify(e)).not.toContain(PASSWORD)
	})

	it('signs in through the real client against a stubbed network, and answers with no secret', async () => {
		process.env[KEY] = JSON.stringify(publicJwk)
		const calls = stubRivian({ login: 'session' })

		const res = await login(post({ email: EMAIL, password: PASSWORD }))
		const text = await res.text()

		expect(res.status).toBe(200)
		expect(JSON.parse(text)).toEqual({ status: 'signed_in' })
		for (const secret of SECRETS) expect(text).not.toContain(secret)
		expect(calls).toEqual(['CreateCSRFToken', 'Login'])

		// One write, of the sealed JWE and the account, and nothing else.
		expect(upsertRivianCredential).toHaveBeenCalledTimes(1)
		const [, written] = upsertRivianCredential.mock.calls[0]!
		expect(Object.keys(written).sort()).toEqual(['account', 'sealed'])
		expect(written.account).toBe(EMAIL)
		expect(await unsealCredential(privateJwk, written.sealed)).toEqual({
			userSessionToken: USER_SESSION_TOKEN
		})
		expect(JSON.stringify(written)).not.toContain(USER_SESSION_TOKEN)
	})

	it('a refusal that echoes the request back reaches the browser as one of the messages', async () => {
		process.env[KEY] = JSON.stringify(publicJwk)
		stubRivian({ login: 'echo-bad-password' })

		const res = await login(post({ email: EMAIL, password: PASSWORD }))
		const text = await res.text()

		expect(res.status).toBe(200)
		expect(JSON.parse(text)).toEqual({ status: 'error', message: 'Wrong email or password' })
		for (const secret of SECRETS) expect(text).not.toContain(secret)
		expect(upsertRivianCredential).not.toHaveBeenCalled()
	})
})

describe('login then otp', () => {
	it('keeps the attempt between the two routes and finishes the sign-in', async () => {
		process.env[KEY] = JSON.stringify(publicJwk)
		const calls = stubRivian({ login: 'otp' })

		const first = await login(post({ email: EMAIL, password: PASSWORD }))
		const firstText = await first.text()
		expect(JSON.parse(firstText)).toEqual({ status: 'otp_required' })
		for (const secret of SECRETS) expect(firstText).not.toContain(secret)
		expect(upsertRivianCredential).not.toHaveBeenCalled()
		expect(getPendingOtp(SUBJECT)).not.toBeNull()

		const second = await otp(post({ code: ` ${OTP_CODE} ` }))
		const secondText = await second.text()
		expect(JSON.parse(secondText)).toEqual({ status: 'signed_in' })
		for (const secret of SECRETS) expect(secondText).not.toContain(secret)
		expect(calls).toEqual(['CreateCSRFToken', 'Login', 'LoginWithOTP'])
		expect(upsertRivianCredential).toHaveBeenCalledTimes(1)
		expect(getPendingOtp(SUBJECT)).toBeNull()
	})

	it('a wrong code is an outcome, and the attempt survives it', async () => {
		process.env[KEY] = JSON.stringify(publicJwk)
		stubRivian({ login: 'otp', otp: 'echo-invalid-otp' })
		await login(post({ email: EMAIL, password: PASSWORD }))

		const res = await otp(post({ code: OTP_CODE }))
		const text = await res.text()
		expect(res.status).toBe(200)
		expect(JSON.parse(text)).toEqual({ status: 'error', message: 'Wrong or expired code' })
		for (const secret of SECRETS) expect(text).not.toContain(secret)
		expect(getPendingOtp(SUBJECT)).not.toBeNull()
	})

	it('a code with no attempt behind it is refused as expired, without touching the network', async () => {
		process.env[KEY] = JSON.stringify(publicJwk)
		const calls = stubRivian({ login: 'otp' })
		const res = await otp(post({ code: OTP_CODE }))
		expect(JSON.parse(await res.text())).toEqual({
			status: 'error',
			message: 'Wrong or expired code',
			// The attempt is gone, so the page is told to take the code box away.
			restart: true
		})
		expect(calls).toEqual([])
	})

	it.each([
		['not JSON', 'nope'],
		['no code', {}],
		['a blank code', { code: '   ' }],
		['a number', { code: 482913 }]
	])('refuses %s with a 400', async (_name, body) => {
		const e = await thrownBy(() => otp(post(body)))
		expect(isHttpError(e, 400)).toBe(true)
	})
})

describe('logout', () => {
	it('deletes the credential and forgets an attempt in progress', async () => {
		setPendingOtp(SUBJECT, {
			email: EMAIL,
			app: { csrfToken: CSRF_TOKEN, appSessionToken: APP_SESSION_TOKEN },
			otpToken: OTP_TOKEN,
			expiresAt: new Date(Date.now() + 60_000)
		})

		const res = await logout(post({}))
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ status: 'signed_out' })
		expect(deleteRivianCredential).toHaveBeenCalledTimes(1)
		expect(getPendingOtp(SUBJECT)).toBeNull()
	})

	it('works when the public key is wrong, because it never needs one', async () => {
		process.env[KEY] = JSON.stringify(privateJwk)
		const res = await logout(post({}))
		expect(res.status).toBe(200)
		expect(deleteRivianCredential).toHaveBeenCalledTimes(1)
	})

	it('does not read the body, so an empty POST is enough', async () => {
		const res = await logout({
			locals: signedIn.locals,
			request: new Request('https://ev.example.com/api/v1/rivian/logout', { method: 'POST' })
		} as never)
		expect(res.status).toBe(200)
	})
})

/* ------------------------------------------------------------------ *
 * A Rivian on the other side of `fetch`
 * ------------------------------------------------------------------ */

type Script = {
	login?: 'session' | 'otp' | 'echo-bad-password'
	otp?: 'session' | 'echo-invalid-otp'
}

/**
 * Replace global `fetch` with something that answers the way the gateway does,
 * and return the list of operations it was asked for.
 *
 * The echo cases are the realistic ones. Rivian's error bodies repeat what was
 * sent; the stub's errors carry the password, the tokens and the code in the
 * `message` and beside the errors, and the route must answer without any of it.
 */
function stubRivian(script: Script): string[] {
	const operations: string[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init: { body: string }) => {
			const { operationName } = JSON.parse(init.body) as { operationName: string }
			operations.push(operationName)
			const reply = (body: unknown, status = 200) =>
				new Response(JSON.stringify(body), {
					status,
					headers: { 'content-type': 'application/json' }
				})

			if (operationName === 'CreateCSRFToken') {
				return reply({
					data: {
						createCsrfToken: { csrfToken: CSRF_TOKEN, appSessionToken: APP_SESSION_TOKEN }
					}
				})
			}
			const echo = (code: string, reason?: string) =>
				reply({
					errors: [
						{
							message: `rejected ${EMAIL} ${PASSWORD} ${OTP_CODE} ${OTP_TOKEN} ${CSRF_TOKEN}`,
							extensions: { code, ...(reason ? { reason } : {}) }
						}
					],
					data: { login: { userSessionToken: USER_SESSION_TOKEN } }
				})
			if (operationName === 'Login') {
				if (script.login === 'otp') {
					return reply({ data: { login: { __typename: 'MobileMFALoginResponse', otpToken: OTP_TOKEN } } })
				}
				if (script.login === 'echo-bad-password') return echo('BAD_CURRENT_PASSWORD')
				return reply({
					data: {
						login: {
							__typename: 'MobileLoginResponse',
							userSessionToken: USER_SESSION_TOKEN,
							accessToken: 'access-token-that-must-never-be-stored-0a1b2c3d4e5f',
							refreshToken: 'refresh-token-that-must-never-be-stored-9f8e7d6c5b4a'
						}
					}
				})
			}
			if (operationName === 'LoginWithOTP') {
				if (script.otp === 'echo-invalid-otp') return echo('BAD_USER_INPUT', 'INVALID_OTP')
				return reply({
					data: { loginWithOTP: { __typename: 'MobileLoginResponse', userSessionToken: USER_SESSION_TOKEN } }
				})
			}
			throw new Error(`unexpected operation ${operationName}`)
		})
	)
	return operations
}
