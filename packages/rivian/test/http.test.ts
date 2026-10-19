import { inspect } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RivianApiError } from '../src/errors.js'
import {
  APOLLO_CLIENT_NAME,
  CHARGING_URL,
  CLIENT_VERSION,
  GATEWAY_URL,
  RivianHttp,
  SUBSCRIPTIONS_URL,
  USER_AGENT,
  connectionInitPayload,
  findVehicle,
  type AppSession,
} from '../src/http.js'

/** One request as the injected `fetch` saw it. */
interface Recorded {
  url: string
  method: string | undefined
  redirect: string | undefined
  headers: Record<string, string>
  body: { operationName: string; query: string; variables: Record<string, unknown> }
}

type Reply = { status?: number; body?: unknown; text?: string }

/**
 * A `fetch` that records what it was asked and answers from `reply`. The tests
 * never touch the network: `RivianHttp` takes its `fetch` as an option, and this
 * is the only one it is ever given here.
 */
function stub(reply: (req: Recorded, n: number) => Reply) {
  const requests: Recorded[] = []
  const impl: typeof fetch = async (input, init) => {
    const req: Recorded = {
      url: String(input),
      method: init?.method,
      redirect: init?.redirect,
      headers: { ...(init?.headers as Record<string, string>) },
      body: JSON.parse(String(init?.body)),
    }
    requests.push(req)
    const r = reply(req, requests.length - 1)
    const text = r.text ?? JSON.stringify(r.body ?? {})
    return new Response(text, { status: r.status ?? 200 })
  }
  return { impl, requests }
}

const APP: AppSession = { csrfToken: 'CSRF-1', appSessionToken: 'APP-1' }
const NORMALISE = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * Every string form a thrown error can take, including what `console.log(err)`
 * prints: `showHidden` adds the non-enumerable own properties (`stack`,
 * `message`) and any `[cause]`, which is where a wrapped exception would show.
 */
function allForms(err: unknown): string {
  return [
    String(err),
    (err as Error).message,
    JSON.stringify(err),
    (err as Error).stack ?? '',
    inspect(err, { showHidden: true, depth: 5 }),
  ].join('\n')
}

/** The one request a single call made. */
function only(requests: Recorded[]): Recorded {
  expect(requests).toHaveLength(1)
  return requests[0] as Recorded
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('constants', () => {
  it('are the endpoints and client identity the design records', () => {
    expect(GATEWAY_URL).toBe('https://rivian.com/api/gql/gateway/graphql')
    expect(CHARGING_URL).toBe('https://rivian.com/api/gql/chrg/user/graphql')
    expect(SUBSCRIPTIONS_URL).toBe('wss://api.rivian.com/gql-consumer-subscriptions/graphql')
    expect(APOLLO_CLIENT_NAME).toBe('com.rivian.ios.consumer-apollo-ios')
    expect(USER_AGENT).toBe('RivianApp/707 CFNetwork/1237 Darwin/20.4.0')
    expect(CLIENT_VERSION).toBe('1.13.0-1494')
  })
})

describe('createCsrf', () => {
  const answer = { data: { createCsrfToken: { csrfToken: 'CSRF-1', appSessionToken: 'APP-1' } } }

  it('POSTs CreateCSRFToken to the gateway under the client identity', async () => {
    const { impl, requests } = stub(() => ({ body: answer }))
    await new RivianHttp({ fetch: impl }).createCsrf()
    const req = only(requests)
    expect(req.url).toBe(GATEWAY_URL)
    expect(req.method).toBe('POST')
    expect(req.body.operationName).toBe('CreateCSRFToken')
    expect(req.body.query).toMatch(/^mutation CreateCSRFToken/)
    expect(req.headers['Apollographql-Client-Name']).toBe(APOLLO_CLIENT_NAME)
    expect(req.headers['User-Agent']).toBe(USER_AGENT)
    expect(req.headers['Content-Type']).toBe('application/json')
    expect(req.headers['Accept']).toBe('application/json')
    expect(req.headers['dc-cid']).toMatch(/^m-ios-[0-9a-f-]{36}$/)
  })

  it('sends no session header, since there is no session yet', async () => {
    const { impl, requests } = stub(() => ({ body: answer }))
    await new RivianHttp({ fetch: impl }).createCsrf()
    const names = Object.keys(only(requests).headers).map((h) => h.toLowerCase())
    expect(names).not.toContain('csrf-token')
    expect(names).not.toContain('a-sess')
    expect(names).not.toContain('u-sess')
  })

  it('returns the tokens', async () => {
    const { impl } = stub(() => ({ body: answer }))
    await expect(new RivianHttp({ fetch: impl }).createCsrf()).resolves.toEqual({
      csrfToken: 'CSRF-1',
      appSessionToken: 'APP-1',
    })
  })

  it('sends a fresh dc-cid with every call', async () => {
    const { impl, requests } = stub(() => ({ body: answer }))
    const http = new RivianHttp({ fetch: impl })
    await http.createCsrf()
    await http.createCsrf()
    expect(requests[0]?.headers['dc-cid']).not.toBe(requests[1]?.headers['dc-cid'])
  })

  it('rejects an answer without both tokens, without echoing it', async () => {
    for (const data of [{ createCsrfToken: { csrfToken: 'only-one-LEAKY' } }, { createCsrfToken: null }, {}]) {
      const { impl } = stub(() => ({ body: { data } }))
      const err = await new RivianHttp({ fetch: impl }).createCsrf().catch((e: unknown) => e)
      expect(err).toBeInstanceOf(RivianApiError)
      expect((err as RivianApiError).redacted()).toBe('Rivian HTTP 200: BAD_RESPONSE')
      expect(JSON.stringify(err)).not.toContain('LEAKY')
    }
  })
})

describe('login', () => {
  it('sends Csrf-Token and A-Sess, and the credentials as variables', async () => {
    const { impl, requests } = stub(() => ({
      body: { data: { login: { __typename: 'MobileLoginResponse', userSessionToken: 'U' } } },
    }))
    await new RivianHttp({ fetch: impl }).login(APP, 'a@b.c', 'pw')
    const req = only(requests)
    expect(req.url).toBe(GATEWAY_URL)
    expect(req.headers['Csrf-Token']).toBe('CSRF-1')
    expect(req.headers['A-Sess']).toBe('APP-1')
    expect(Object.keys(req.headers).map((h) => h.toLowerCase())).not.toContain('u-sess')
    expect(req.body.operationName).toBe('Login')
    expect(req.body.variables).toEqual({ email: 'a@b.c', password: 'pw' })
  })

  it('keeps the password out of the query text and the headers', async () => {
    const { impl, requests } = stub(() => ({
      body: { data: { login: { userSessionToken: 'U' } } },
    }))
    await new RivianHttp({ fetch: impl }).login(APP, 'a@b.c', 'hunter2')
    const req = only(requests)
    expect(req.body.query).not.toContain('hunter2')
    expect(JSON.stringify(req.headers)).not.toContain('hunter2')
  })

  it('returns the session for a MobileLoginResponse, and drops the access and refresh tokens', async () => {
    const { impl } = stub(() => ({
      body: {
        data: {
          login: {
            __typename: 'MobileLoginResponse',
            accessToken: 'AT-secret',
            refreshToken: 'RT-secret',
            userSessionToken: 'U-1',
          },
        },
      },
    }))
    const result = await new RivianHttp({ fetch: impl }).login(APP, 'a@b.c', 'pw')
    expect(result).toEqual({ kind: 'session', userSessionToken: 'U-1' })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('returns the otp token for a MobileMFALoginResponse', async () => {
    const { impl } = stub(() => ({
      body: { data: { login: { __typename: 'MobileMFALoginResponse', otpToken: 'OTP-1' } } },
    }))
    await expect(new RivianHttp({ fetch: impl }).login(APP, 'a@b.c', 'pw')).resolves.toEqual({
      kind: 'otp',
      otpToken: 'OTP-1',
    })
  })

  it('rejects an answer that is neither, without echoing it', async () => {
    const { impl } = stub(() => ({ body: { data: { login: { __typename: 'Other', note: 'LEAKY' } } } }))
    const err = await new RivianHttp({ fetch: impl }).login(APP, 'a@b.c', 'pw').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RivianApiError)
    expect(JSON.stringify(err)).not.toContain('LEAKY')
  })

  it('selects both arms of the union, including the tokens the result drops', async () => {
    const { impl, requests } = stub(() => ({ body: { data: { login: { otpToken: 'O' } } } }))
    await new RivianHttp({ fetch: impl }).login(APP, 'a@b.c', 'pw')
    const query = NORMALISE(only(requests).body.query)
    expect(query).toContain('... on MobileMFALoginResponse { otpToken }')
    expect(query).toContain('... on MobileLoginResponse { userSessionToken accessToken refreshToken }')
  })
})

describe('loginWithOtp', () => {
  it('sends the email, code and token as variables, under the sign-in headers', async () => {
    const { impl, requests } = stub(() => ({
      body: { data: { loginWithOTP: { __typename: 'MobileLoginResponse', userSessionToken: 'U-2' } } },
    }))
    const result = await new RivianHttp({ fetch: impl }).loginWithOtp(APP, 'a@b.c', '123456', 'OTP-1')
    const req = only(requests)
    expect(req.url).toBe(GATEWAY_URL)
    expect(req.body.operationName).toBe('LoginWithOTP')
    expect(req.body.variables).toEqual({ email: 'a@b.c', otpCode: '123456', otpToken: 'OTP-1' })
    expect(req.headers['Csrf-Token']).toBe('CSRF-1')
    expect(req.headers['A-Sess']).toBe('APP-1')
    expect(result).toEqual({ userSessionToken: 'U-2' })
  })

  it('returns only the session token', async () => {
    const { impl } = stub(() => ({
      body: {
        data: { loginWithOTP: { userSessionToken: 'U-2', accessToken: 'AT-x', refreshToken: 'RT-x' } },
      },
    }))
    const result = await new RivianHttp({ fetch: impl }).loginWithOtp(APP, 'a@b.c', '1', 'O')
    expect(Object.keys(result)).toEqual(['userSessionToken'])
  })

  it('rejects an answer with no session token', async () => {
    const { impl } = stub(() => ({ body: { data: { loginWithOTP: {} } } }))
    await expect(new RivianHttp({ fetch: impl }).loginWithOtp(APP, 'a@b.c', '1', 'O')).rejects.toBeInstanceOf(
      RivianApiError,
    )
  })
})

describe('authenticated calls', () => {
  it('userInfo sends A-Sess and U-Sess, no CSRF token, and selects the design selection', async () => {
    const data = { currentUser: { id: 'u', vehicles: [] } }
    const { impl, requests } = stub(() => ({ body: { data } }))
    const result = await new RivianHttp({ fetch: impl }).userInfo(APP, 'U-1')
    const req = only(requests)
    expect(req.url).toBe(GATEWAY_URL)
    expect(req.headers['A-Sess']).toBe('APP-1')
    expect(req.headers['U-Sess']).toBe('U-1')
    expect(Object.keys(req.headers).map((h) => h.toLowerCase())).not.toContain('csrf-token')
    expect(req.body.operationName).toBe('getUserInfo')
    expect(NORMALISE(req.body.query)).toContain(
      'currentUser { id vehicles { id vin name state roles createdAt updatedAt vehicle { id vin modelYear make model expectedBuildDate plannedBuildDate expectedGeneralAssemblyStartDate actualGeneralAssemblyDate } } }',
    )
    // The data object, verbatim.
    expect(result).toEqual(data)
  })

  it('chargingSummaries POSTs getCompletedSessionSummaries to the charging endpoint', async () => {
    const data = { getCompletedSessionSummaries: [{ transactionId: 't' }] }
    const { impl, requests } = stub(() => ({ body: { data } }))
    const result = await new RivianHttp({ fetch: impl }).chargingSummaries(APP, 'U-1', 'veh-1')
    const req = only(requests)
    expect(req.url).toBe(CHARGING_URL)
    expect(req.headers['A-Sess']).toBe('APP-1')
    expect(req.headers['U-Sess']).toBe('U-1')
    expect(req.body.operationName).toBe('getCompletedSessionSummaries')
    expect(req.body.query).toContain('getCompletedSessionSummaries(vehicleId: $vehicleId)')
    expect(req.body.variables).toEqual({ vehicleId: 'veh-1' })
    expect(result).toEqual(data)
  })

  it('introspectVehicleState asks for the fields of VehicleState and their types', async () => {
    const data = { __type: { fields: [{ name: 'batteryLevel' }] } }
    const { impl, requests } = stub(() => ({ body: { data } }))
    const result = await new RivianHttp({ fetch: impl }).introspectVehicleState(APP, 'U-1')
    const req = only(requests)
    expect(req.url).toBe(GATEWAY_URL)
    expect(req.headers['A-Sess']).toBe('APP-1')
    expect(req.headers['U-Sess']).toBe('U-1')
    expect(NORMALISE(req.body.query)).toContain(
      '__type(name: "VehicleState") { fields { name type { name kind ofType { name kind } } } }',
    )
    expect(result).toEqual(data)
  })

  it('vehicle asks getVehicle for the id, vin and mobile configuration', async () => {
    const data = { getVehicle: { id: 'veh-1', vin: 'V' } }
    const { impl, requests } = stub(() => ({ body: { data } }))
    const result = await new RivianHttp({ fetch: impl }).vehicle(APP, 'U-1', 'veh-1')
    const req = only(requests)
    expect(req.url).toBe(GATEWAY_URL)
    expect(req.headers['U-Sess']).toBe('U-1')
    expect(req.body.operationName).toBe('getVehicle')
    expect(req.body.variables).toEqual({ vehicleId: 'veh-1' })
    const query = NORMALISE(req.body.query)
    expect(query).toContain('getVehicle(id: $vehicleId) { id vin mobileConfiguration {')
    expect(query).toContain('trimOption { __typename optionId optionName }')
    expect(query).toContain('driveSystemOption { __typename optionId optionName }')
    expect(result).toEqual(data)
  })

  it('never splices the vehicle id into the query text', async () => {
    const { impl, requests } = stub(() => ({ body: { data: { getVehicle: {} } } }))
    const http = new RivianHttp({ fetch: impl })
    await http.vehicle(APP, 'U-1', 'veh-SPLICE')
    await http.chargingSummaries(APP, 'U-1', 'veh-SPLICE')
    for (const req of requests) expect(req.body.query).not.toContain('veh-SPLICE')
  })

  it('is read-only: the only mutations are the three that sign in', async () => {
    const { impl, requests } = stub(() => ({
      body: {
        data: {
          createCsrfToken: { csrfToken: 'c', appSessionToken: 'a' },
          login: { userSessionToken: 'u' },
          loginWithOTP: { userSessionToken: 'u' },
        },
      },
    }))
    const http = new RivianHttp({ fetch: impl })
    await http.createCsrf()
    await http.login(APP, 'e', 'p')
    await http.loginWithOtp(APP, 'e', 'c', 't')
    await http.userInfo(APP, 'U')
    await http.vehicle(APP, 'U', 'v')
    await http.chargingSummaries(APP, 'U', 'v')
    await http.introspectVehicleState(APP, 'U')
    expect(requests).toHaveLength(7)
    const mutations = requests.filter((r) => /^\s*mutation\b/.test(r.body.query))
    expect(mutations.map((r) => r.body.operationName)).toEqual(['CreateCSRFToken', 'Login', 'LoginWithOTP'])
    for (const req of requests) {
      expect(req.method).toBe('POST')
      expect(req.body.query).not.toMatch(/\bsubscription\b/)
    }
  })

  it('names each operation as its document does', async () => {
    const { impl, requests } = stub(() => ({ body: { data: { x: 1 } } }))
    const http = new RivianHttp({ fetch: impl })
    await http.userInfo(APP, 'U')
    await http.vehicle(APP, 'U', 'v')
    await http.chargingSummaries(APP, 'U', 'v')
    await http.introspectVehicleState(APP, 'U')
    for (const req of requests) {
      expect(req.body.query).toMatch(new RegExp(`^query ${req.body.operationName}\\b`))
    }
  })
})

describe('errors', () => {
  it('throws RivianApiError, unauthenticated, for a 400 with an UNAUTHENTICATED error', async () => {
    const { impl } = stub(() => ({
      status: 400,
      body: { errors: [{ extensions: { code: 'UNAUTHENTICATED' } }], data: null },
    }))
    const err = await new RivianHttp({ fetch: impl }).userInfo(APP, 'U').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RivianApiError)
    expect((err as RivianApiError).unauthenticated).toBe(true)
    expect((err as RivianApiError).httpStatus).toBe(400)
    expect((err as RivianApiError).what).toBe('getUserInfo')
    expect((err as RivianApiError).redacted()).toBe('Rivian HTTP 400: UNAUTHENTICATED')
  })

  it('throws for an errors array on a 200, even beside data', async () => {
    const { impl } = stub(() => ({
      body: { data: { currentUser: {} }, errors: [{ extensions: { code: 'RATE_LIMIT' } }] },
    }))
    const err = await new RivianHttp({ fetch: impl }).userInfo(APP, 'U').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RivianApiError)
    expect((err as RivianApiError).rateLimited).toBe(true)
    expect((err as RivianApiError).httpStatus).toBe(200)
  })

  it('throws for a 200 with no data', async () => {
    for (const body of [{}, { data: null }]) {
      const { impl } = stub(() => ({ body }))
      const err = await new RivianHttp({ fetch: impl }).userInfo(APP, 'U').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(RivianApiError)
      expect((err as RivianApiError).redacted()).toBe('Rivian HTTP 200: NO_DATA')
    }
  })

  it('throws for a response that is not JSON, and does not read its text', async () => {
    const { impl } = stub(() => ({
      status: 502,
      text: '<html>upstream said: U-Sess: U-SECRET-1 password=hunter2</html>',
    }))
    const err = await new RivianHttp({ fetch: impl }).userInfo(APP, 'U-SECRET-1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RivianApiError)
    expect((err as RivianApiError).httpStatus).toBe(502)
    expect((err as RivianApiError).redacted()).toBe('Rivian HTTP 502')
    expect(allForms(err)).not.toContain('SECRET')
    expect(allForms(err)).not.toContain('hunter2')
  })

  it('throws for a 2xx that is not JSON as a bad response', async () => {
    const { impl } = stub(() => ({ text: 'OK' }))
    const err = await new RivianHttp({ fetch: impl }).userInfo(APP, 'U').catch((e: unknown) => e)
    expect((err as RivianApiError).redacted()).toBe('Rivian HTTP 200: BAD_RESPONSE')
  })

  it('reads HTTP 429 as rate limiting', async () => {
    const { impl } = stub(() => ({ status: 429, text: 'slow down' }))
    const err = await new RivianHttp({ fetch: impl }).userInfo(APP, 'U').catch((e: unknown) => e)
    expect((err as RivianApiError).rateLimited).toBe(true)
  })

  it('does not follow a redirect, and reports it as a failed status', async () => {
    // `fetch` would carry the session headers to wherever it was sent.
    const { impl, requests } = stub(() => ({ status: 302, text: '' }))
    const err = await new RivianHttp({ fetch: impl }).userInfo(APP, 'U').catch((e: unknown) => e)
    expect(only(requests).redirect).toBe('manual')
    expect((err as RivianApiError).httpStatus).toBe(302)
  })

  it('throws a RivianApiError with a null status when the call times out', async () => {
    // A fetch that honours its signal and otherwise never answers.
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    const err = await new RivianHttp({ fetch: hang, timeoutMs: 20 })
      .userInfo(APP, 'U')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RivianApiError)
    expect((err as RivianApiError).httpStatus).toBeNull()
    expect((err as RivianApiError).redacted()).toBe('Rivian request failed: TIMEOUT')
  })

  it('times out a body that never finishes arriving', async () => {
    const slowBody: typeof fetch = async (_input, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason))
        },
      })
      return new Response(stream, { status: 200 })
    }
    const err = await new RivianHttp({ fetch: slowBody, timeoutMs: 20 })
      .userInfo(APP, 'U')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RivianApiError)
    expect((err as RivianApiError).httpStatus).toBe(200)
    expect((err as RivianApiError).redacted()).toBe('Rivian HTTP 200: TIMEOUT')
  })

  it('passes a deadline of 15 s to every call by default, and honours timeoutMs', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const { impl } = stub(() => ({ body: { data: { x: 1 } } }))
    await new RivianHttp({ fetch: impl }).userInfo(APP, 'U')
    expect(timeout).toHaveBeenLastCalledWith(15000)
    await new RivianHttp({ fetch: impl, timeoutMs: 1234 }).userInfo(APP, 'U')
    expect(timeout).toHaveBeenLastCalledWith(1234)
  })

  it('reports a failed request as a network error, without the exception that came with it', async () => {
    const boom: typeof fetch = async () => {
      throw new TypeError('fetch failed: POST with U-Sess: U-SECRET-2 and password=hunter2', {
        cause: new Error('connect ECONNREFUSED, headers: A-Sess APP-SECRET'),
      })
    }
    const err = await new RivianHttp({ fetch: boom }).userInfo(APP, 'U-SECRET-2').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RivianApiError)
    expect((err as RivianApiError).httpStatus).toBeNull()
    expect((err as RivianApiError).redacted()).toBe('Rivian request failed: NETWORK')
    const everything = allForms(err)
    expect(everything).not.toContain('SECRET')
    expect(everything).not.toContain('hunter2')
    expect(everything).not.toContain('ECONNREFUSED')
    expect((err as Error).cause).toBeUndefined()
  })

  it('carries no credential, token or response text out of a failed sign-in', async () => {
    // The password and the app session go IN to Login; the response echoes them
    // and adds tokens of its own. None of it may come back out in an error.
    const { impl } = stub(() => ({
      status: 400,
      body: {
        data: { login: { accessToken: 'AT-SECRET', refreshToken: 'RT-SECRET', userSessionToken: 'US-SECRET' } },
        errors: [
          {
            message: 'bad credentials for pw-SECRET with Csrf-Token CSRF-SECRET',
            extensions: { code: 'BAD_USER_INPUT', reason: 'bad', accessToken: 'AT-SECRET' },
          },
        ],
      },
    }))
    const app: AppSession = { csrfToken: 'CSRF-SECRET', appSessionToken: 'APP-SECRET' }
    const err = await new RivianHttp({ fetch: impl })
      .login(app, 'someone@example.com', 'pw-SECRET')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RivianApiError)
    expect((err as RivianApiError).badCredentials).toBe(true)
    const everything = [allForms(err), (err as RivianApiError).redacted()].join('\n')
    expect(everything).not.toContain('SECRET')
    expect(everything).not.toContain('someone@example.com')
  })
})

describe('findVehicle', () => {
  const userInfo = {
    currentUser: {
      id: 'user-1',
      vehicles: [
        { id: 'rivian-id-1', vin: '7FCTGAAA1NN000001', name: 'First' },
        { id: 'rivian-id-2', vin: '7FCTGAAA1NN000002', name: 'Second' },
        { id: 'rivian-id-3', vin: '7FCTGAAA1NN000003', name: 'Third' },
      ],
    },
  }

  it('finds the VIN among several vehicles', () => {
    expect(findVehicle(userInfo, '7FCTGAAA1NN000002')).toEqual({ id: 'rivian-id-2', vin: '7FCTGAAA1NN000002' })
  })

  it('returns null when the VIN is absent', () => {
    expect(findVehicle(userInfo, '7FCTGAAA1NN999999')).toBeNull()
    expect(findVehicle({ currentUser: { vehicles: [] } }, '7FCTGAAA1NN000001')).toBeNull()
  })

  it('matches without regard to case or surrounding space, and returns Rivian\'s spelling', () => {
    expect(findVehicle(userInfo, ' 7fctgaaa1nn000003 ')).toEqual({ id: 'rivian-id-3', vin: '7FCTGAAA1NN000003' })
  })

  it('never matches an empty VIN', () => {
    expect(findVehicle({ currentUser: { vehicles: [{ id: 'x', vin: '' }] } }, '')).toBeNull()
    expect(findVehicle(userInfo, '   ')).toBeNull()
  })

  it('returns null for garbage input', () => {
    const garbage: unknown[] = [
      null,
      undefined,
      'a string',
      42,
      [],
      {},
      { currentUser: null },
      { currentUser: 'x' },
      { currentUser: {} },
      { currentUser: { vehicles: 'no' } },
      { currentUser: { vehicles: [null, 1, 'x', [], {}] } },
      { currentUser: { vehicles: [{ vin: '7FCTGAAA1NN000001' }] } },
      { currentUser: { vehicles: [{ id: 5, vin: '7FCTGAAA1NN000001' }] } },
      { currentUser: { vehicles: [{ id: '', vin: '7FCTGAAA1NN000001' }] } },
      { currentUser: { vehicles: [{ id: 'x', vin: 5 }] } },
    ]
    for (const input of garbage) expect(findVehicle(input, '7FCTGAAA1NN000001')).toBeNull()
  })

  it('skips an entry that is not a vehicle and finds the one after it', () => {
    const mixed = { currentUser: { vehicles: [null, { id: 'x' }, { id: 'ok', vin: 'V1' }] } }
    expect(findVehicle(mixed, 'V1')).toEqual({ id: 'ok', vin: 'V1' })
  })
})

describe('connectionInitPayload', () => {
  it('carries the user session and the client identity, and nothing else', () => {
    const payload = connectionInitPayload('S')
    expect(Object.keys(payload).sort()).toEqual(['client-name', 'client-version', 'dc-cid', 'u-sess'])
    expect(payload['u-sess']).toBe('S')
    expect(payload['client-name']).toBe(APOLLO_CLIENT_NAME)
    expect(payload['client-version']).toBe(CLIENT_VERSION)
    expect(payload['dc-cid']).toMatch(/^m-ios-[0-9a-f-]{36}$/)
  })

  it('does not carry the app session', () => {
    // The socket authenticates by u-sess alone (design §2.3).
    expect(Object.keys(connectionInitPayload('S')).map((k) => k.toLowerCase())).not.toContain('a-sess')
  })
})
