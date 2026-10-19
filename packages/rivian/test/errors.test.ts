import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { RivianApiError, toRivianApiError } from '../src/errors.js'

/**
 * Review Focus 5: an error from Rivian that echoes tokens or the request body
 * must be redacted everywhere it surfaces. These tests build the worst response
 * a hostile or merely careless gateway could send, and look for its secrets in
 * every string an error can produce.
 */

const SECRETS = {
  accessToken: 'AT-a1b2c3d4e5f6a7b8c9d0',
  refreshToken: 'RT-0f9e8d7c6b5a4f3e2d1c',
  userSessionToken: 'US-5a5a5a5a6b6b6b6b7c7c',
  otpToken: 'OT-9d8c7b6a5f4e3d2c1b0a',
  csrfToken: 'CS-1122334455667788aabb',
  appSessionToken: 'AS-ccddeeff00112233445566',
}
const PASSWORD_ECHO = 'password=hunter2'

/** A body with every secret in every place Rivian might put one. */
function hostileBody(): unknown {
  return {
    data: { login: { __typename: 'MobileLoginResponse', ...SECRETS } },
    errors: [
      {
        message: `bad login: ${PASSWORD_ECHO}`,
        path: ['login'],
        locations: [{ line: 2, column: 3 }],
        extensions: {
          code: 'UNAUTHENTICATED',
          reason: 'expired',
          // Present in the entry, and must not be kept.
          ...SECRETS,
          message: PASSWORD_ECHO,
        },
      },
    ],
  }
}

/**
 * Every string form an error can take, as one list. The last is what
 * `console.log(err)` and a test runner's diff print: `showHidden` adds the
 * non-enumerable own properties (`stack`, `message`) and any `[cause]`, so it
 * is the form that would show a wrapped exception, or a property added later.
 */
function surfaces(err: RivianApiError): string[] {
  return [
    String(err),
    err.message,
    err.redacted(),
    JSON.stringify(err),
    err.stack ?? '',
    inspect(err, { showHidden: true, depth: 5 }),
  ]
}

function expectNoSecrets(err: RivianApiError): void {
  const needles = [...Object.values(SECRETS), 'hunter2', PASSWORD_ECHO]
  for (const text of surfaces(err)) {
    for (const needle of needles) expect(text, needle).not.toContain(needle)
  }
}

describe('toRivianApiError redaction', () => {
  it('keeps no token, password or message in any string an error produces', () => {
    const err = toRivianApiError(400, hostileBody(), 'Login')
    expectNoSecrets(err)
    // And the point of the exercise survived: the useful part is still there.
    expect(err.redacted()).toBe('Rivian HTTP 400: UNAUTHENTICATED/expired')
  })

  it('holds only code and reason in codes', () => {
    const err = toRivianApiError(400, hostileBody(), 'Login')
    expect(err.codes).toEqual([{ code: 'UNAUTHENTICATED', reason: 'expired' }])
    for (const c of err.codes) {
      expect(Object.keys(c).sort()).toEqual(['code', 'reason'])
    }
  })

  it('exposes only the status, the codes and the call label as properties', () => {
    const err = toRivianApiError(400, hostileBody(), 'Login')
    expect(JSON.parse(JSON.stringify(err))).toEqual({
      name: 'RivianApiError',
      httpStatus: 400,
      codes: [{ code: 'UNAUTHENTICATED', reason: 'expired' }],
      what: 'Login',
    })
    // `cause` is where a wrapped exception, and whatever it quotes, would hide.
    expect(err.cause).toBeUndefined()
  })

  it('applies the same filter when the constructor is called directly', () => {
    // The guarantee belongs to the type, not to one way of building it.
    const rich = { code: 'UNAUTHENTICATED', reason: 'expired', accessToken: SECRETS.accessToken }
    const err = new RivianApiError(
      401,
      [rich, { code: PASSWORD_ECHO }, { code: SECRETS.csrfToken }, { code: SECRETS.appSessionToken }],
      'getUserInfo',
    )
    expect(err.codes).toEqual([{ code: 'UNAUTHENTICATED', reason: 'expired' }])
    expect(Object.keys(err.codes[0] ?? {}).sort()).toEqual(['code', 'reason'])
    expectNoSecrets(err)
  })

  describe('the shape filter', () => {
    /** A code or reason in the second position beside a genuine code, as Rivian sends them. */
    const asReason = (reason: string) =>
      toRivianApiError(400, { errors: [{ extensions: { code: 'BAD_USER_INPUT', reason } }] }, 'Login')
    const asCode = (code: string) => toRivianApiError(400, { errors: [{ extensions: { code } }] }, 'Login')

    it.each(Object.entries(SECRETS))(
      'refuses the %s sentinel, on its own, as a reason and as a code',
      (_name, sentinel) => {
        // Each sentinel is 23 or more characters, so it is UNDER the length caps
        // (40 for a reason, 48 for a code): it is the secret SHAPE that stops it,
        // not its length. Tried alone, not concatenated with another to make
        // it long enough to trip a cap.
        expect(sentinel.length).toBeLessThanOrEqual(40)
        expect(asReason(sentinel).codes).toEqual([{ code: 'BAD_USER_INPUT' }])
        expectNoSecrets(asReason(sentinel))
        // As a code it is dropped whole, with and without the dash that the
        // code shape alone would already refuse.
        for (const form of [sentinel, sentinel.replace(/-/g, '')]) {
          expect(asCode(form).codes, form).toEqual([])
          expect(asCode(form).redacted(), form).toBe('Rivian HTTP 400')
        }
      },
    )

    it('refuses a one-time code, however short, as a reason and inside a code', () => {
      for (const otp of ['123456', '000000', '48291', '7', '1234567890']) {
        expect(asReason(otp).codes, otp).toEqual([{ code: 'BAD_USER_INPUT' }])
      }
      // Six digits inside a longer string; five do not make one.
      expect(asReason('otp-123456').codes).toEqual([{ code: 'BAD_USER_INPUT' }])
      expect(asReason('otp-12345').codes).toEqual([{ code: 'BAD_USER_INPUT', reason: 'otp-12345' }])
      expect(asCode('A123456').codes).toEqual([])
    })

    it('refuses a UUID, with its dashes or without', () => {
      const uuid = '3f2504e0-4f89-41d3-a716-446655440000'
      expect(asReason(uuid).codes).toEqual([{ code: 'BAD_USER_INPUT' }])
      expect(asReason(uuid.toUpperCase()).codes).toEqual([{ code: 'BAD_USER_INPUT' }])
      expect(asCode(uuid.replace(/-/g, '')).codes).toEqual([])
      expect(asCode('x' + uuid.replace(/-/g, '')).codes).toEqual([])
    })

    it('refuses a long hex run and a long opaque run', () => {
      expect(asReason('deadbeef').codes).toEqual([{ code: 'BAD_USER_INPUT' }])
      expect(asReason('session-0123abcd').codes).toEqual([{ code: 'BAD_USER_INPUT' }])
      // Seven hex digits are not eight.
      expect(asReason('abcdef0').codes).toEqual([{ code: 'BAD_USER_INPUT', reason: 'abcdef0' }])
      // Twenty letters and digits in a row: a JWT segment, base64.
      const jwtHeader = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
      expect(asReason(jwtHeader).codes).toEqual([{ code: 'BAD_USER_INPUT' }])
      expect(asReason(`${jwtHeader}.eyJzdWIiOiJ4In0.sig`).codes).toEqual([{ code: 'BAD_USER_INPUT' }])
      expect(asCode('QWxhZGRpbjpvcGVuIHNlc2FtZQ').codes).toEqual([])
    })

    it('refuses what is not shaped like a code or a reason at all', () => {
      // An echoed password has a character no identifier has; two words have a space.
      expect(asCode(PASSWORD_ECHO).codes).toEqual([])
      expect(asReason(PASSWORD_ECHO).codes).toEqual([{ code: 'BAD_USER_INPUT' }])
      expect(asReason('two words').codes).toEqual([{ code: 'BAD_USER_INPUT' }])
      expect(asReason('x'.repeat(41)).codes).toEqual([{ code: 'BAD_USER_INPUT' }])
      expect(asCode('A' + 'B'.repeat(48)).codes).toEqual([])
    })

    it('still passes the codes and reasons Rivian actually sends', () => {
      const codes = [
        'BAD_USER_INPUT',
        'UNAUTHENTICATED',
        'GRAPHQL_VALIDATION_FAILED',
        'SESSION_MANAGER_ERROR',
        'RATE_LIMIT',
        'BAD_CURRENT_PASSWORD',
        'INTERNAL_SERVER_ERROR',
      ]
      for (const code of codes) expect(asCode(code).codes, code).toEqual([{ code }])
      // Reasons are identifiers or single words, in either case, and not only
      // the two the classification reads. A reason with a space in it is not
      // one of these: it is dropped, and the code beside it kept.
      const reasons = [
        'INVALID_OTP',
        'OTP_TOKEN_EXPIRED',
        'expired',
        'Expired',
        'rate_limited',
        'RateLimited',
        'session-expired',
        'v2.expired',
      ]
      for (const reason of reasons) {
        expect(asReason(reason).codes, reason).toEqual([{ code: 'BAD_USER_INPUT', reason }])
      }
    })

    it('cannot tell a short secret that looks like a word from a word', () => {
      // The honest limit of the filter, pinned so nobody mistakes it for a
      // guarantee: `hunter` has the shape of a reason and none of a secret.
      // This is why the response body, where such a value would actually be,
      // is never read, and why the filter is only the second line of defence.
      expect(asReason('hunter').codes).toEqual([{ code: 'BAD_USER_INPUT', reason: 'hunter' }])
    })
  })

  it('reads nothing from a body that is not an errors array', () => {
    for (const body of [null, 'a string', 42, [], { errors: 'nope' }, { errors: [null, 1, 'x', []] }]) {
      const err = toRivianApiError(502, body, 'Login')
      expect(err.codes).toEqual([])
      expect(err.redacted()).toBe('Rivian HTTP 502')
    }
  })

  it('collapses equal entries and caps the list, so a rejected group stays one line', () => {
    const many = Array.from({ length: 16 }, () => ({
      extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
    }))
    const same = toRivianApiError(400, { errors: many }, 'x')
    expect(same.codes).toEqual([{ code: 'GRAPHQL_VALIDATION_FAILED' }])

    const distinct = Array.from({ length: 20 }, (_, i) => ({ extensions: { code: `CODE_${i}` } }))
    expect(toRivianApiError(400, { errors: distinct }, 'x').codes).toHaveLength(8)
  })

  it('says what is wrong with a 2xx that is not a success, instead of only its status', () => {
    expect(toRivianApiError(200, null, 'x').redacted()).toBe('Rivian HTTP 200: BAD_RESPONSE')
    expect(toRivianApiError(200, {}, 'x').redacted()).toBe('Rivian HTTP 200: NO_DATA')
    expect(toRivianApiError(200, { data: null }, 'x').redacted()).toBe('Rivian HTTP 200: NO_DATA')
    expect(toRivianApiError(200, { errors: [{ message: 'only a message' }] }, 'x').redacted()).toBe(
      'Rivian HTTP 200: UNCODED_ERROR',
    )
    // A coded 2xx error is reported as itself.
    expect(
      toRivianApiError(200, { errors: [{ extensions: { code: 'RATE_LIMIT' } }] }, 'x').redacted(),
    ).toBe('Rivian HTTP 200: RATE_LIMIT')
  })
})

describe('RivianApiError', () => {
  it('formats the redacted line with the status, each code and its reason', () => {
    expect(new RivianApiError(400, [{ code: 'UNAUTHENTICATED', reason: 'expired' }], 'x').redacted()).toBe(
      'Rivian HTTP 400: UNAUTHENTICATED/expired',
    )
    expect(
      new RivianApiError(400, [{ code: 'BAD_USER_INPUT' }, { code: 'RATE_LIMIT' }], 'x').redacted(),
    ).toBe('Rivian HTTP 400: BAD_USER_INPUT, RATE_LIMIT')
    expect(new RivianApiError(null, [{ code: 'TIMEOUT' }], 'x').redacted()).toBe(
      'Rivian request failed: TIMEOUT',
    )
    expect(new RivianApiError(503, [], 'x').redacted()).toBe('Rivian HTTP 503')
  })

  it('makes its message the redacted form, so anything that logs the message is safe', () => {
    const err = new RivianApiError(400, [{ code: 'UNAUTHENTICATED', reason: 'expired' }], 'Login')
    expect(err.message).toBe(err.redacted())
    expect(err.name).toBe('RivianApiError')
    expect(err).toBeInstanceOf(Error)
  })

  describe('classification', () => {
    const flags = (err: RivianApiError) => ({
      unauthenticated: err.unauthenticated,
      rateLimited: err.rateLimited,
      validationFailed: err.validationFailed,
      badCredentials: err.badCredentials,
      badOtp: err.badOtp,
      locked: err.locked,
    })
    const none = {
      unauthenticated: false,
      rateLimited: false,
      validationFailed: false,
      badCredentials: false,
      badOtp: false,
      locked: false,
    }
    const make = (status: number | null, ...codes: Array<[string, string?]>) =>
      new RivianApiError(
        status,
        codes.map(([code, reason]) => (reason === undefined ? { code } : { code, reason })),
        'x',
      )

    it('reads UNAUTHENTICATED anywhere in the codes', () => {
      expect(flags(make(400, ['UNAUTHENTICATED']))).toEqual({ ...none, unauthenticated: true })
      expect(flags(make(400, ['BAD_USER_INPUT', 'INVALID_OTP'], ['UNAUTHENTICATED']))).toMatchObject({
        unauthenticated: true,
      })
    })

    it('reads RATE_LIMIT, or HTTP 429 with no code at all', () => {
      expect(flags(make(200, ['RATE_LIMIT']))).toEqual({ ...none, rateLimited: true })
      expect(flags(make(429))).toEqual({ ...none, rateLimited: true })
      expect(flags(make(500))).toEqual(none)
    })

    it('reads GRAPHQL_VALIDATION_FAILED', () => {
      expect(flags(make(400, ['GRAPHQL_VALIDATION_FAILED']))).toEqual({
        ...none,
        validationFailed: true,
      })
    })

    it('reads BAD_CURRENT_PASSWORD, and BAD_USER_INPUT that is not about the code, as bad credentials', () => {
      expect(flags(make(400, ['BAD_CURRENT_PASSWORD']))).toEqual({ ...none, badCredentials: true })
      expect(flags(make(400, ['BAD_USER_INPUT']))).toEqual({ ...none, badCredentials: true })
      expect(flags(make(400, ['BAD_USER_INPUT', 'some_other_reason']))).toEqual({
        ...none,
        badCredentials: true,
      })
    })

    it('does not call a wrong one-time code a wrong password', () => {
      expect(flags(make(400, ['BAD_USER_INPUT', 'INVALID_OTP']))).toEqual({ ...none, badOtp: true })
    })

    it('reads an expired one-time-code token as a bad code, and as unauthenticated', () => {
      // UNAUTHENTICATED means "anywhere in codes", so the OTP expiry is both,
      // and a caller that wants the better message tests badOtp first.
      expect(flags(make(400, ['UNAUTHENTICATED', 'OTP_TOKEN_EXPIRED']))).toEqual({
        ...none,
        unauthenticated: true,
        badOtp: true,
      })
      // Without that reason it is only the session.
      expect(flags(make(400, ['UNAUTHENTICATED', 'expired']))).toEqual({
        ...none,
        unauthenticated: true,
      })
    })

    it('reads SESSION_MANAGER_ERROR as a locked account', () => {
      expect(flags(make(400, ['SESSION_MANAGER_ERROR']))).toEqual({ ...none, locked: true })
    })

    it('reads nothing into a client-side failure', () => {
      for (const code of ['TIMEOUT', 'NETWORK', 'BAD_RESPONSE', 'NO_DATA', 'UNCODED_ERROR']) {
        expect(flags(make(null, [code])), code).toEqual(none)
      }
    })
  })
})
