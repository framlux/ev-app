import { describe, expect, it } from 'vitest'
import { hkdfSync } from 'node:crypto'
import { SignJWT, compactDecrypt, jwtVerify } from 'jose'
import { gateDecision } from '../src/lib/server/gate.js'
import {
	PUBLIC_PATHS,
	isPublicPath,
	safeNextPath
} from '../src/lib/server/public-paths.js'
import {
	SESSION_COOKIE,
	SESSION_COOKIE_OPTIONS,
	SESSION_TTL_SECONDS,
	authoriseClaims,
	isAuthorisedSubject,
	readSession,
	sealSession,
	unsealSession
} from '../src/lib/server/session.js'

const KEY = 'a'.repeat(64)
const OTHER_KEY = 'b'.repeat(64)
const SUBJECT = 'pocketid-subject-123'
const OTHER_SUBJECT = 'pocketid-subject-999'

function derivedEncryptionKey(key: string): Uint8Array {
	return new Uint8Array(
		hkdfSync(
			'sha256',
			new TextEncoder().encode(key),
			new Uint8Array(0),
			new TextEncoder().encode('ev-session-encrypt'),
			32
		)
	)
}

/**
 * The signing key readSession actually verifies against, re-derived here rather
 * than exported from session.ts.
 *
 * Duplicating the derivation is the point: a test that signs with the raw
 * SESSION_KEY produces a token readSession rejects for the wrong reason — bad
 * signature — so the "must be encrypted" guard it claims to cover goes
 * untested. Signing with this key makes the JWE layer the only thing standing
 * between the token and acceptance. If session.ts changes its derivation, this
 * derivation stops matching and the JWE test would quietly degrade back into a
 * signature-mismatch test, so the test below named "signs the bare token with
 * the key readSession verifies against" asserts the derivation still agrees.
 */
function derivedSigningKey(key: string): Uint8Array {
	const ikm = new TextEncoder().encode(key)
	return new Uint8Array(
		hkdfSync(
			'sha256',
			ikm,
			new Uint8Array(0),
			new TextEncoder().encode('ev-session-sign'),
			32
		)
	)
}

describe('isAuthorisedSubject', () => {
	// Table-driven because every one of these is a way the single-user rule has
	// historically been lost: a fallback that treats unset config as "allow", a
	// trimmed comparison, a case-insensitive one.
	const cases: Array<[name: string, sub: string, allowed: string, expected: boolean]> = [
		['the configured subject', SUBJECT, SUBJECT, true],
		['a different subject the IdP also authenticates', 'someone-else', SUBJECT, false],
		['an unset allowlist, which must lock everyone out', SUBJECT, '', false],
		['an empty subject against an empty allowlist', '', '', false],
		['an empty subject against a real allowlist', '', SUBJECT, false],
		['a subject differing only in case', SUBJECT.toUpperCase(), SUBJECT, false],
		['a subject with surrounding whitespace', ` ${SUBJECT} `, SUBJECT, false],
		['a subject that merely starts with the allowed one', `${SUBJECT}x`, SUBJECT, false]
	]

	for (const [name, sub, allowed, expected] of cases) {
		it(`${expected ? 'accepts' : 'rejects'} ${name}`, () => {
			expect(isAuthorisedSubject(sub, allowed)).toBe(expected)
		})
	}
})

describe('authoriseClaims', () => {
	it('admits the configured subject', () => {
		expect(authoriseClaims({ sub: SUBJECT }, SUBJECT)).toEqual({
			ok: true,
			user: { sub: SUBJECT }
		})
	})

	it('refuses a different subject that authenticated successfully at the IdP', () => {
		// The whole point of the check: Pocket-ID serves other applications and
		// other people, and all of them can complete the code flow against this
		// client. A successful token exchange is not an authorisation decision.
		expect(authoriseClaims({ sub: 'someone-else' }, SUBJECT)).toEqual({
			ok: false,
			reason: 'wrong-subject'
		})
	})

	it('refuses everyone when ALLOWED_SUBJECT is unset rather than admitting everyone', () => {
		expect(authoriseClaims({ sub: SUBJECT }, '')).toEqual({ ok: false, reason: 'not-configured' })
	})

	it.each([
		['missing claims', undefined],
		['null claims', null],
		['a non-string subject', { sub: 42 }],
		['an empty subject', { sub: '' }]
	])('refuses %s', (_name, claims) => {
		const result = authoriseClaims(claims as { sub?: unknown } | null | undefined, SUBJECT)
		expect(result.ok).toBe(false)
	})
})

describe('session sealing', () => {
	it('round-trips a subject', async () => {
		const token = await sealSession({ sub: SUBJECT }, KEY)
		expect(await readSession(token, KEY)).toEqual({ sub: SUBJECT })
	})

	it('exposes the plan’s unsealSession name for the same function', async () => {
		const token = await sealSession({ sub: SUBJECT }, KEY)
		expect(await unsealSession(token, KEY)).toEqual({ sub: SUBJECT })
	})

	it('encrypts, so the cookie does not leak the subject to anything that can read it', async () => {
		const token = await sealSession({ sub: SUBJECT }, KEY)
		expect(token).not.toContain(SUBJECT)
		// A JWS would carry the subject as readable base64url in its payload; a JWE
		// does not. Decoding every segment and finding the subject nowhere is what
		// distinguishes the two.
		const decoded = token
			.split('.')
			.map((part) => Buffer.from(part, 'base64url').toString('binary'))
			.join('')
		expect(decoded).not.toContain(SUBJECT)
	})

	it('rejects a token sealed with a different key', async () => {
		const token = await sealSession({ sub: SUBJECT }, KEY)
		expect(await readSession(token, OTHER_KEY)).toBeNull()
	})

	// Every segment of a compact JWE: header, encrypted key, IV, ciphertext, tag.
	// Flipping any one of them must fail the AEAD check rather than yield a
	// half-decrypted payload.
	it.each([0, 2, 3, 4])('rejects a token whose segment %i was tampered with', async (index) => {
		const token = await sealSession({ sub: SUBJECT }, KEY)
		const parts = token.split('.')
		const original = parts[index] ?? ''
		parts[index] = original.slice(0, -3) + (original.endsWith('aaa') ? 'bbb' : 'aaa')
		expect(await readSession(parts.join('.'), KEY)).toBeNull()
	})

	it('rejects a truncated token', async () => {
		const token = await sealSession({ sub: SUBJECT }, KEY)
		expect(await readSession(token.slice(0, -3) + 'aaa', KEY)).toBeNull()
	})

	/**
	 * A JWS that is valid in every respect except that it is not wrapped in the
	 * JWE. Signed with the *derived* signing key, not the raw SESSION_KEY: with
	 * the raw key the token fails the signature check and the test passes for a
	 * reason that has nothing to do with encryption, which is how a readSession
	 * that falls back to plain jwtVerify slipped past this suite before.
	 */
	async function bareSignedToken(): Promise<string> {
		return new SignJWT({})
			.setProtectedHeader({ alg: 'HS256' })
			.setSubject(SUBJECT)
			.setIssuer('ev-web')
			.setAudience('ev-session')
			.setIssuedAt()
			.setExpirationTime('30d')
			.sign(derivedSigningKey(KEY))
	}

	it('signs the bare token with the key readSession verifies against', async () => {
		// Load-bearing for the test below: if this stops holding, "rejected" would
		// no longer mean "rejected for lacking the JWE layer". Proven by decrypting
		// a real session and verifying its inner JWS with the same derived key.
		const sealed = await sealSession({ sub: SUBJECT }, KEY)
		const { plaintext } = await compactDecrypt(sealed, derivedEncryptionKey(KEY))
		const inner = new TextDecoder().decode(plaintext)
		const { payload } = await jwtVerify(inner, derivedSigningKey(KEY), {
			issuer: 'ev-web',
			audience: 'ev-session'
		})
		expect(payload.sub).toBe(SUBJECT)
	})

	it('rejects a bare signed JWT that was never encrypted', async () => {
		// Guards against a future "optimisation" that drops the JWE layer on read
		// while leaving it on write: an attacker who learns the signing key derives
		// nothing here, but a reader that accepts unencrypted input accepts a much
		// larger class of tokens than it was designed to.
		expect(await readSession(await bareSignedToken(), KEY)).toBeNull()
	})

	it('rejects a bare signed JWT even when it is otherwise entirely valid', async () => {
		// Same token, stated as the negative of the round trip: it carries the
		// right subject, issuer, audience and signature, so nothing but the missing
		// encryption layer can be what refuses it.
		const jws = await bareSignedToken()
		const { payload } = await jwtVerify(jws, derivedSigningKey(KEY), {
			issuer: 'ev-web',
			audience: 'ev-session'
		})
		expect(payload.sub).toBe(SUBJECT)
		expect(await readSession(jws, KEY)).toBeNull()
	})

	it('rejects garbage that is not a token at all', async () => {
		expect(await readSession('not-a-token', KEY)).toBeNull()
		expect(await readSession('', KEY)).toBeNull()
	})

	// Pins the 30-day lifetime from both sides. A token sealed a minute before
	// the boundary still works; one sealed a minute after it is dead. Widening or
	// narrowing the TTL fails one of these.
	it('accepts a session sealed just inside its lifetime', async () => {
		const now = new Date(Date.now() - (SESSION_TTL_SECONDS - 60) * 1000)
		const token = await sealSession({ sub: SUBJECT }, KEY, { now })
		expect(await readSession(token, KEY)).toEqual({ sub: SUBJECT })
	})

	it('rejects a session sealed just outside its lifetime', async () => {
		const now = new Date(Date.now() - (SESSION_TTL_SECONDS + 60) * 1000)
		const token = await sealSession({ sub: SUBJECT }, KEY, { now })
		expect(await readSession(token, KEY)).toBeNull()
	})

	it('rejects an already-expired token outright', async () => {
		const token = await sealSession({ sub: SUBJECT }, KEY, { ttlSeconds: -1 })
		expect(await readSession(token, KEY)).toBeNull()
	})

	it('treats a key that is too short as a misconfiguration, not a bad token', async () => {
		// Throwing rather than returning null: null would present as an endless
		// redirect to sign-in with nothing in the logs to explain it.
		await expect(sealSession({ sub: SUBJECT }, 'short')).rejects.toThrow(/SESSION_KEY/)
		await expect(readSession('anything', '')).rejects.toThrow(/SESSION_KEY/)
	})
})

describe('session cookie attributes', () => {
	it('is named ev_session and is HttpOnly, Secure and SameSite=Lax on the whole site', () => {
		expect(SESSION_COOKIE).toBe('ev_session')
		expect(SESSION_COOKIE_OPTIONS).toEqual({
			path: '/',
			httpOnly: true,
			secure: true,
			// Lax rather than Strict: the IdP returns the browser here with a
			// top-level GET and Strict would withhold the cookie on that navigation.
			sameSite: 'lax'
		})
	})
})

/**
 * The allowlist is the entire unauthenticated surface of the app, so it is
 * tested as a closed set: both that each entry is admitted and that the set has
 * not grown.
 *
 * The `/.well-known/**` entry is the one with a non-obvious cost. Tesla's Fleet
 * API fetches the application's public key from
 * `/.well-known/appspecific/com.tesla.3p.public-key.pem` with no credentials.
 * Gate that path and the vendor gets a 302 to the IdP instead of a PEM, and the
 * vehicle un-pairs. (That explanation lives here rather than beside the list
 * itself because boundaries.test.ts greps the array for vendor names.)
 */
describe('PUBLIC_PATHS', () => {
	it('is exactly the health probes, the SSO endpoints and the well-known subtree', () => {
		expect(PUBLIC_PATHS.map((rule) => `${rule.kind}:${rule.path}`).sort()).toEqual([
			'exact:/auth/login',
			'exact:/healthz/live',
			'exact:/healthz/ready',
			'exact:/sso_callback',
			'prefix:/.well-known/'
		])
	})

	const cases: Array<[path: string, isPublic: boolean]> = [
		['/healthz/live', true],
		['/healthz/ready', true],
		['/auth/login', true],
		['/sso_callback', true],
		['/.well-known/appspecific/anything.pem', true],
		['/.well-known/', true],
		// Prefix matching applied to an exact entry is the classic bug: these three
		// must not be admitted by /auth/login, /healthz/live or /sso_callback.
		['/auth/loginbackdoor', false],
		['/healthz/livecheck', false],
		['/sso_callbackx', false],
		// `/healthz` is not itself a route and must not become a public subtree.
		['/healthz', false],
		['/healthz/metrics', false],
		// Nothing outside the subtree, however similar the string.
		['/.well-knownish', false],
		['/x/.well-known/key.pem', false],
		// Sign-out requires a session; so does everything the app actually serves.
		['/auth/logout', false],
		['/', false],
		['/api/v1/vehicles', false],
		['/sessions/1', false]
	]

	for (const [path, expected] of cases) {
		it(`${expected ? 'admits' : 'gates'} ${path}`, () => {
			expect(isPublicPath(path)).toBe(expected)
		})
	}
})

describe('safeNextPath', () => {
	// The post-sign-in destination round-trips through a cookie the browser
	// holds, so it is attacker-influenced: an open redirect out of an SSO
	// callback is a credible phishing primitive.
	it.each([
		// Ordinary destinations still work; the guard must not eat the real feature.
		['/sessions/42', '/sessions/42'],
		['/?tab=charges', '/?tab=charges'],
		['/sessions/42?tab=map#leg-3', '/sessions/42?tab=map#leg-3'],
		['/', '/'],
		// Authority smuggled past a leading slash.
		['//evil.example/path', '/'],
		['/\\evil.example', '/'],
		['/\\\\evil.example', '/'],
		['https://evil.example', '/'],
		['//evil.example', '/'],
		['javascript:alert(1)', '/'],
		['', '/'],
		[null, '/'],
		[undefined, '/']
	])('maps %s to %s', (input, expected) => {
		expect(safeNextPath(input as string | null | undefined)).toBe(expected)
	})

	/**
	 * The control characters are the vector that got through: browsers strip tab,
	 * LF and CR from a URL *before* parsing it, so a value starting `/` + control
	 * passes any `startsWith('//')` check on the server and still resolves
	 * off-origin in the browser. Asserted twice — that safeNextPath refuses the
	 * value, and that the URL parser really would have gone off-origin had it not
	 * — so the test states the threat rather than a spelling of it.
	 */
	it.each([
		['tab', '\t'],
		['newline', '\n'],
		['carriage return', '\r'],
		['NUL', '\u0000'],
		['vertical tab', '\u000b'],
		['form feed', '\u000c'],
		['SOH', '\u0001'],
		['unit separator', '\u001f'],
		['DEL', '\u007f']
	])('refuses a %s smuggled in front of an authority', (_name, control) => {
		expect(safeNextPath(`/${control}/evil.example`)).toBe('/')
		expect(safeNextPath(`/${control}${control}evil.example`)).toBe('/')
	})

	it('refuses the exact tab vector the reviewer walked end to end', () => {
		// new URL('/\t/evil.example', 'https://ev.example.com').href is
		// 'https://evil.example/'. Pinned here so the danger is visible in the test
		// rather than only in a comment.
		expect(new URL('/\t/evil.example', 'https://ev.example.com').href).toBe('https://evil.example/')
		expect(safeNextPath('/\t/evil.example')).toBe('/')
	})

	it('normalises an encoded traversal instead of passing it through', () => {
		// %2e is a dot segment to the WHATWG parser, so the browser would resolve
		// this to '/b' anyway. Agreeing with the parser is the point: what we
		// return is what the browser would have navigated to.
		expect(safeNextPath('/a/%2e%2e/b')).toBe('/b')
		expect(safeNextPath('/a/../../../etc/passwd')).toBe('/etc/passwd')
	})

	it('never returns a value carrying an origin', () => {
		for (const candidate of ['/sessions/42', '//evil.example', '/\\evil.example', '/a/../b']) {
			expect(safeNextPath(candidate).startsWith('/')).toBe(true)
			expect(safeNextPath(candidate)).not.toMatch(/^\/\//)
			expect(safeNextPath(candidate)).not.toContain('evil.example')
		}
	})

	// Dot-segment collapse - the gap the guard above missed.
	//
	// The test above asserts "never returns a value carrying an origin" but its
	// vector list contained nothing that could violate it, so it passed against a
	// function for which the property was false for 775 inputs.
	//
	// None of these is protocol-relative on the way IN; the WHATWG collapse
	// creates that property while resolving. A check on the input alone therefore
	// cannot catch them. Each of these previously returned '//evil.example',
	// which a browser resolves against our origin as https://evil.example/.
	it.each([
		'/x/..//evil.example',
		'/..//evil.example',
		'/.//evil.example',
		'/a/b/../..//evil.example',
		'/x/%2e%2e//evil.example',
		'/x/../\\evil.example',
		'/x/..//\\evil.example'
	])('collapses %s to something that stays on our origin', (raw) => {
		const out = safeNextPath(raw)
		expect(out.startsWith('//')).toBe(false)
		// The property that actually matters, stated the way a browser sees it.
		expect(new URL(out, 'https://ev.example.com').origin).toBe('https://ev.example.com')
	})

	it('never returns an off-origin path, exhaustively over four segments', () => {
		// A guard written as a fixed vector list is only as good as the
		// imagination behind it, which is precisely how the previous one passed
		// while being wrong. This one cannot be out-imagined the same way.
		const segs = ['', '..', '.', 'evil.example', 'a', '%2e%2e', '\\evil.example', '%2f']
		const escaped: string[] = []
		for (const a of segs)
			for (const b of segs)
				for (const c of segs)
					for (const d of segs) {
						const raw = `/${[a, b, c, d].join('/')}`
						const out = safeNextPath(raw)
						if (new URL(out, 'https://ev.example.com').origin !== 'https://ev.example.com') {
							escaped.push(raw)
						}
					}
		expect(escaped).toEqual([])
	})
})

/**
 * The gate itself: what hooks.server.ts does once readSession has spoken.
 *
 * These are the composition tests. A tampered or expired cookie reduces to
 * `hasSession === false` above, and this is where that becomes a refusal rather
 * than a request that quietly proceeds without a user.
 */
describe('gateDecision', () => {
	const ME = { sub: SUBJECT }

	it('lets a signed-in request through', () => {
		expect(gateDecision('/sessions/1', '', ME, SUBJECT)).toEqual({ kind: 'allow' })
	})

	it('lets a public path through with no session', () => {
		expect(gateDecision('/healthz/ready', '', null, SUBJECT)).toEqual({ kind: 'allow' })
		expect(gateDecision('/.well-known/appspecific/key.pem', '', null, SUBJECT)).toEqual({
			kind: 'allow'
		})
	})

	it('redirects an anonymous browser to sign-in, preserving where it was going', () => {
		expect(gateDecision('/sessions/1', '?tab=map', null, SUBJECT)).toEqual({
			kind: 'redirect',
			location: '/auth/login?next=%2Fsessions%2F1%3Ftab%3Dmap'
		})
	})

	it('answers an anonymous API call with 401 rather than a redirect', () => {
		expect(gateDecision('/api/v1/vehicles', '', null, SUBJECT)).toEqual({ kind: 'unauthorized' })
	})

	it('refuses a request whose cookie failed verification exactly as it refuses one with no cookie', async () => {
		const tampered = (await sealSession({ sub: SUBJECT }, KEY)).slice(0, -3) + 'aaa'
		// The cookie is present and looks plausible; verification is what decides.
		expect(await readSession(tampered, KEY)).toBeNull()
		expect(gateDecision('/', '', await readSession(tampered, KEY), SUBJECT)).toEqual(
			gateDecision('/', '', null, SUBJECT)
		)
		expect(gateDecision('/', '', null, SUBJECT).kind).toBe('redirect')
	})

	it('refuses an expired cookie on a protected path', async () => {
		const expired = await sealSession({ sub: SUBJECT }, KEY, { ttlSeconds: -1 })
		const session = await readSession(expired, KEY)
		expect(session).toBeNull()
		expect(gateDecision('/api/v1/vehicles', '', session, SUBJECT)).toEqual({
			kind: 'unauthorized'
		})
	})

	it('serves the vendor key path even to an expired session', async () => {
		// The path that must not regress: an un-authenticated fetch of the app's
		// public key has to keep working or the vehicle integration un-pairs.
		expect(
			gateDecision('/.well-known/appspecific/com.tesla.3p.public-key.pem', '', null, SUBJECT)
		).toEqual({ kind: 'allow' })
	})

	/**
	 * Revocation. The cookie is self-contained and lives 30 days, so the only
	 * thing that can evict a session mid-life is re-checking the subject on every
	 * request. Before this existed the callback checked once and the gate trusted
	 * the seal forever: changing ALLOWED_SUBJECT locked the ex-user out of new
	 * sign-ins while leaving the session they already held fully working.
	 */
	describe('subject re-check on every request', () => {
		it('refuses a validly-sealed cookie whose subject is no longer allowed', async () => {
			const sealed = await sealSession({ sub: SUBJECT }, KEY)
			const session = await readSession(sealed, KEY)
			// The cryptography is fine — this is an authorisation decision, not a
			// verification failure, and that distinction is the bug being fixed.
			expect(session).toEqual({ sub: SUBJECT })
			expect(gateDecision('/sessions/1', '', session, OTHER_SUBJECT)).toEqual({
				kind: 'redirect',
				location: '/auth/login?next=%2Fsessions%2F1'
			})
			expect(gateDecision('/api/v1/vehicles', '', session, OTHER_SUBJECT)).toEqual({
				kind: 'unauthorized'
			})
		})

		it('refuses a still-valid session once ALLOWED_SUBJECT is unset', async () => {
			// Losing the configuration must lock everyone out, never let every
			// already-issued cookie through.
			const session = await readSession(await sealSession({ sub: SUBJECT }, KEY), KEY)
			expect(gateDecision('/sessions/1', '', session, '')).toEqual({
				kind: 'redirect',
				location: '/auth/login?next=%2Fsessions%2F1'
			})
		})

		it('refuses a disallowed subject exactly as it refuses anonymity', async () => {
			const session = await readSession(await sealSession({ sub: SUBJECT }, KEY), KEY)
			expect(gateDecision('/sessions/1', '?tab=map', session, OTHER_SUBJECT)).toEqual(
				gateDecision('/sessions/1', '?tab=map', null, OTHER_SUBJECT)
			)
		})

		it('applies the same exact-match rule the callback applies', async () => {
			// No prefix, no case folding, no trimming: a revoked subject that merely
			// resembles the allowed one is still revoked.
			for (const allowed of [`${SUBJECT}x`, SUBJECT.toUpperCase(), ` ${SUBJECT} `]) {
				const session = await readSession(await sealSession({ sub: SUBJECT }, KEY), KEY)
				expect(gateDecision('/api/v1/vehicles', '', session, allowed).kind).toBe('unauthorized')
			}
		})

		it('still serves public paths to a now-disallowed session', () => {
			// Health probes and the vendor key path do not depend on who is asking,
			// and gating them on a revoked subject would un-pair the vehicle.
			expect(gateDecision('/healthz/ready', '', ME, OTHER_SUBJECT)).toEqual({ kind: 'allow' })
			expect(
				gateDecision('/.well-known/appspecific/com.tesla.3p.public-key.pem', '', ME, OTHER_SUBJECT)
			).toEqual({ kind: 'allow' })
		})
	})
})
