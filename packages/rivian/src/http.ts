/**
 * THE HTTP HALF OF THE RIVIAN API: sign-in, and the slow reads (design §2.1,
 * §5.6). The live data does not come through here; it is the websocket's, and
 * the connector owns that.
 *
 * THIS CLIENT IS READ-ONLY TOWARD RIVIAN. The only mutations in it are the
 * three that sign in (`CreateCSRFToken`, `Login`, `LoginWithOTP`); everything
 * else is a query. There is no command, no phone-key enrolment and no schedule
 * edit here, and there is no generic "send this document" method that could
 * grow one: each call is its own method with its own constant document.
 *
 * THE GRAPHQL DOCUMENTS ARE OURS. The facts in them (operation, field and
 * argument names, and the type each field sits on) are facts about Rivian's API,
 * taken from the gateway schema snapshot the design cites (§2), from the design
 * itself (§2.4, §5.6) and from the sign-in flow it describes (§2.2). The
 * expression is ours: one field per line, one spelling for the vehicle variable
 * (`$vehicleId`, as in `catalogue.ts`), and selections ordered as we use them.
 * No code, query text or schema file was copied from the unlicensed
 * `rivian-python-client` (design §2.4); a name is a fact, and a document is only
 * as copied as its wording is.
 *
 * NOTHING SECRET LEAVES THIS FILE IN AN ERROR (design §4.4, Review Focus 5). A
 * call here carries a password, an OTP or a session token in its body or its
 * headers, and Rivian's answers may echo them. So no failure is ever built from
 * the request, the headers or the response text: `post` hands the parsed body to
 * `toRivianApiError`, which reads two fields of it, and the exception of a
 * failed `fetch` is dropped without being read. Do not put a request, a header
 * or a response in a message or a log line from this file, however convenient it
 * would be while debugging; a debugging session is exactly when a token ends up
 * in a terminal.
 */

import { randomUUID } from 'node:crypto'
import { RivianApiError, toRivianApiError } from './errors.js'

export const GATEWAY_URL = 'https://rivian.com/api/gql/gateway/graphql'
export const CHARGING_URL = 'https://rivian.com/api/gql/chrg/user/graphql'
export const SUBSCRIPTIONS_URL = 'wss://api.rivian.com/gql-consumer-subscriptions/graphql'
export const APOLLO_CLIENT_NAME = 'com.rivian.ios.consumer-apollo-ios'
export const USER_AGENT = 'RivianApp/707 CFNetwork/1237 Darwin/20.4.0'
export const CLIENT_VERSION = '1.13.0-1494'

/** What `CreateCSRFToken` returns, and what every later call is made under. */
export interface AppSession {
  csrfToken: string
  appSessionToken: string
}

/**
 * What `Login` answers: the session (no second factor), or a token to quote
 * with the one-time code. `accessToken` and `refreshToken` come back in the
 * first case and are deliberately not part of the result (design §4.2): nothing
 * uses them, and a value that is never returned is a value nobody can store.
 */
export type LoginResult =
  | { kind: 'session'; userSessionToken: string }
  | { kind: 'otp'; otpToken: string }

export interface RivianHttpOptions {
  /** Injected by tests, which never touch the network. */
  fetch?: typeof fetch
  /** Per call, covering the whole exchange including the body. Default 15000. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15_000

// ---------------------------------------------------------------------------
// The documents
// ---------------------------------------------------------------------------

/** Step one of a sign-in: an app session and the CSRF token that goes with it. */
const CSRF_DOCUMENT = `mutation CreateCSRFToken {
  createCsrfToken {
    csrfToken
    appSessionToken
  }
}`

/**
 * Step two. The answer is a union: with a second factor on the account it is
 * the MFA response (an `otpToken`, after which Rivian sends the code), without
 * one it is the login response. The selection carries both arms, which is why
 * the result is told apart by which token is present. `accessToken` and
 * `refreshToken` are selected because the app selects them and this client
 * should look like the app; `login()` drops them.
 */
const LOGIN_DOCUMENT = `mutation Login($email: String!, $password: String!) {
  login(email: $email, password: $password) {
    __typename
    ... on MobileMFALoginResponse {
      otpToken
    }
    ... on MobileLoginResponse {
      userSessionToken
      accessToken
      refreshToken
    }
  }
}`

/** Step three, when there was a second factor: the code and the token from step two. */
const LOGIN_WITH_OTP_DOCUMENT = `mutation LoginWithOTP($email: String!, $otpCode: String!, $otpToken: String!) {
  loginWithOTP(email: $email, otpCode: $otpCode, otpToken: $otpToken) {
    __typename
    ... on MobileLoginResponse {
      userSessionToken
      accessToken
      refreshToken
    }
  }
}`

/**
 * The account and its vehicles, in the selection design §2.4 gives. The nested
 * `vehicle` carries the build and delivery dates, which are why this is taped:
 * they move as the R2 goes down the line. Each field is on its own line so that
 * a field Rivian renames is one visible line to change.
 */
const USER_INFO_DOCUMENT = `query getUserInfo {
  currentUser {
    id
    vehicles {
      id
      vin
      name
      state
      roles
      createdAt
      updatedAt
      vehicle {
        id
        vin
        modelYear
        make
        model
        expectedBuildDate
        plannedBuildDate
        expectedGeneralAssemblyStartDate
        actualGeneralAssemblyDate
      }
    }
  }
}`

/**
 * One vehicle's configuration. `mobileConfiguration` is selected with the four
 * options the 2025-04 gateway schema declares on `VehicleMobileConfiguration`
 * (trim, drive system, exterior and interior colour), each as the
 * `{ optionId optionName }` pair the schema gives `VehicleMobileConfigurationOption`.
 * Design §5.6 also hopes for the battery pack here; the snapshot has no such
 * option, so none is selected. A name the snapshot is wrong about is a
 * `GRAPHQL_VALIDATION_FAILED` that costs this one slow call, not the stream.
 */
const VEHICLE_DOCUMENT = `query getVehicle($vehicleId: String!) {
  getVehicle(id: $vehicleId) {
    id
    vin
    mobileConfiguration {
      __typename
      trimOption {
        __typename
        optionId
        optionName
      }
      driveSystemOption {
        __typename
        optionId
        optionName
      }
      exteriorColorOption {
        __typename
        optionId
        optionName
      }
      interiorColorOption {
        __typename
        optionId
        optionName
      }
    }
  }
}`

/**
 * Completed charging sessions, on the charging endpoint. It is cheap ground
 * truth that the live subscription cannot give once a session is over (design
 * §2.4). The selection is the session summary's identifying, timing, energy and
 * place fields. UNVERIFIED: the gateway schema snapshot does not cover the
 * charging endpoint, so these names are from what the app is known to show, not
 * from a schema. If Rivian rejects the selection, the tape records the failure
 * and nothing else is lost.
 */
const CHARGING_SUMMARIES_DOCUMENT = `query getCompletedSessionSummaries($vehicleId: String!) {
  getCompletedSessionSummaries(vehicleId: $vehicleId) {
    transactionId
    vehicleId
    startInstant
    endInstant
    totalEnergyKwh
    rangeAddedKm
    chargerType
    isHomeCharger
    isPublic
    isRoamingNetwork
    city
    paidTotal
    currencyCode
  }
}`

/**
 * The `VehicleState` type's fields, with each field's type (and the type
 * inside a `NON_NULL` wrapper), so the connector can find the `TimeStamped*`
 * fields the catalogue has never heard of (design §5.6). It is how an R2-only
 * property reaches the tape at all.
 */
const INTROSPECT_VEHICLE_STATE_DOCUMENT = `query IntrospectVehicleState {
  __type(name: "VehicleState") {
    fields {
      name
      type {
        name
        kind
        ofType {
          name
          kind
        }
      }
    }
  }
}`

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a `fetch` rejection is the deadline firing. `AbortSignal.timeout`
 * rejects with a `TimeoutError`; a plain abort is `AbortError`. Only the
 * exception's NAME is read: its message and `cause` are the part of a failed
 * `fetch` that can carry request detail, and they are never looked at.
 */
function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

/** A request or a body read that did not complete: the deadline, or the network. */
function clientFailure(error: unknown, status: number | null, what: string): RivianApiError {
  return new RivianApiError(status, [{ code: isTimeout(error) ? 'TIMEOUT' : 'NETWORK' }], what)
}

/** A 2xx whose `data` was not what the call asked for. */
function malformed(status: number, what: string): RivianApiError {
  return new RivianApiError(status, [{ code: 'BAD_RESPONSE' }], what)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

export class RivianHttp {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(opts: RivianHttpOptions = {}) {
    // Wrapped, not stored bare: a platform `fetch` called as a method of this
    // object has the wrong `this`.
    const impl = opts.fetch ?? fetch
    this.fetchImpl = (input, init) => impl(input, init)
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** An app session. Called at every connector start, and once before it gives up on a session (design §2.2). */
  async createCsrf(): Promise<AppSession> {
    const what = 'CreateCSRFToken'
    const { status, data } = await this.post(
      GATEWAY_URL,
      this.headers(),
      { operationName: what, query: CSRF_DOCUMENT, variables: {} },
      what,
    )
    const result = isRecord(data) ? data.createCsrfToken : undefined
    if (!isRecord(result) || !nonEmptyString(result.csrfToken) || !nonEmptyString(result.appSessionToken)) {
      throw malformed(status, what)
    }
    return { csrfToken: result.csrfToken, appSessionToken: result.appSessionToken }
  }

  /**
   * Sign in. The password is in the request body for the length of this call
   * and nowhere else: not in a header, not in the result, not in an error.
   */
  async login(app: AppSession, email: string, password: string): Promise<LoginResult> {
    const what = 'Login'
    const { status, data } = await this.post(
      GATEWAY_URL,
      this.mutationHeaders(app),
      { operationName: what, query: LOGIN_DOCUMENT, variables: { email, password } },
      what,
    )
    const result = isRecord(data) ? data.login : undefined
    if (isRecord(result)) {
      if (nonEmptyString(result.userSessionToken)) {
        return { kind: 'session', userSessionToken: result.userSessionToken }
      }
      if (nonEmptyString(result.otpToken)) return { kind: 'otp', otpToken: result.otpToken }
    }
    throw malformed(status, what)
  }

  /** Finish a sign-in that asked for a one-time code. */
  async loginWithOtp(
    app: AppSession,
    email: string,
    otpCode: string,
    otpToken: string,
  ): Promise<{ userSessionToken: string }> {
    const what = 'LoginWithOTP'
    const { status, data } = await this.post(
      GATEWAY_URL,
      this.mutationHeaders(app),
      { operationName: what, query: LOGIN_WITH_OTP_DOCUMENT, variables: { email, otpCode, otpToken } },
      what,
    )
    const result = isRecord(data) ? data.loginWithOTP : undefined
    if (!isRecord(result) || !nonEmptyString(result.userSessionToken)) throw malformed(status, what)
    return { userSessionToken: result.userSessionToken }
  }

  /** `getUserInfo`, the `data` object verbatim: it is taped as `meta` and read by `findVehicle`. */
  async userInfo(app: AppSession, userSessionToken: string): Promise<unknown> {
    const what = 'getUserInfo'
    const { data } = await this.post(
      GATEWAY_URL,
      this.userHeaders(app, userSessionToken),
      { operationName: what, query: USER_INFO_DOCUMENT, variables: {} },
      what,
    )
    return data
  }

  /** `getVehicle` for one vehicle id, the `data` object verbatim. */
  async vehicle(app: AppSession, userSessionToken: string, vehicleId: string): Promise<unknown> {
    const what = 'getVehicle'
    const { data } = await this.post(
      GATEWAY_URL,
      this.userHeaders(app, userSessionToken),
      { operationName: what, query: VEHICLE_DOCUMENT, variables: { vehicleId } },
      what,
    )
    return data
  }

  /** `getCompletedSessionSummaries` on the charging endpoint, the `data` object verbatim. */
  async chargingSummaries(
    app: AppSession,
    userSessionToken: string,
    vehicleId: string,
  ): Promise<unknown> {
    const what = 'getCompletedSessionSummaries'
    const { data } = await this.post(
      CHARGING_URL,
      this.userHeaders(app, userSessionToken),
      { operationName: what, query: CHARGING_SUMMARIES_DOCUMENT, variables: { vehicleId } },
      what,
    )
    return data
  }

  /** The `VehicleState` type's fields, the `data` object verbatim. */
  async introspectVehicleState(app: AppSession, userSessionToken: string): Promise<unknown> {
    const what = 'introspectVehicleState'
    const { data } = await this.post(
      GATEWAY_URL,
      this.userHeaders(app, userSessionToken),
      { operationName: 'IntrospectVehicleState', query: INTROSPECT_VEHICLE_STATE_DOCUMENT, variables: {} },
      what,
    )
    return data
  }

  /**
   * The headers every call carries (design §2.1). The `dc-cid` is new for each
   * call, as the app's is.
   */
  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      'Apollographql-Client-Name': APOLLO_CLIENT_NAME,
      'dc-cid': `m-ios-${randomUUID()}`,
    }
  }

  /** Mutations add the CSRF token, under the app session it was issued with. */
  private mutationHeaders(app: AppSession): Record<string, string> {
    return { ...this.headers(), 'Csrf-Token': app.csrfToken, 'A-Sess': app.appSessionToken }
  }

  /** Authenticated queries add the user session beside the app session. */
  private userHeaders(app: AppSession, userSessionToken: string): Record<string, string> {
    return { ...this.headers(), 'A-Sess': app.appSessionToken, 'U-Sess': userSessionToken }
  }

  /**
   * Every call goes through here. It returns the response's `data` and its
   * status, or throws a `RivianApiError`; there is no third outcome, so a
   * caller never has to ask whether a returned value is really an error.
   *
   * What counts as a failure: the request not completing (timeout, network),
   * a non-2xx status, a body that is not JSON, a non-empty `errors` array, and
   * a missing `data`. A GraphQL response that carries both `data` and `errors`
   * is a failure too: a half-answer to a sign-in is not one to act on.
   *
   * What is never done: the request body, the headers and the response text are
   * not put in any error, and nothing here logs. `toRivianApiError` gets the
   * parsed body and reads two fields of it (see `errors.ts`).
   */
  private async post(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    what: string,
  ): Promise<{ status: number; data: unknown }> {
    let res: Response
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        // A redirect is never followed. `fetch` would send our custom headers,
        // which carry the session tokens, wherever it was told to go, and a
        // JSON API that answers a POST with a redirect is not one this client
        // knows how to talk to. The 3xx comes back as an ordinary failed status.
        redirect: 'manual',
      })
    } catch (error) {
      throw clientFailure(error, null, what)
    }
    const status = res.status

    // Read apart from the request but under the same deadline: a body that
    // fails to arrive is the same kind of failure as a request that fails to
    // complete, and it is reported with the status that did arrive.
    let text: string
    try {
      text = await res.text()
    } catch (error) {
      throw clientFailure(error, status, what)
    }

    let parsed: unknown = null
    try {
      parsed = JSON.parse(text)
    } catch {
      // Not JSON: left as null. The text is dropped unread, since a gateway's
      // HTML error page is as likely as anything to echo a header.
    }

    const ok = status >= 200 && status < 300
    if (!ok || !isRecord(parsed)) throw toRivianApiError(status, parsed, what)
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      throw toRivianApiError(status, parsed, what)
    }
    if (parsed.data === undefined || parsed.data === null) throw toRivianApiError(status, parsed, what)
    return { status, data: parsed.data }
  }
}

/**
 * The vehicle to subscribe to, found in a `getUserInfo` answer by VIN.
 *
 * Matching is by VIN and never by position or by guess: an account can hold
 * several vehicles (design §5.1). The VINs are compared case-insensitively,
 * because a VIN is upper-case by definition and a configuration value typed in
 * lower case should still find the car; the VIN returned is Rivian's spelling.
 * `userInfo` is whatever came over the wire, so every step assumes nothing:
 * garbage, a missing `currentUser`, or a vehicle with no usable `id` gives null,
 * the same answer as a car that is not listed (and that is the answer the
 * connector retries hourly, design §5.2).
 */
export function findVehicle(userInfo: unknown, vin: string): { id: string; vin: string } | null {
  if (!isRecord(userInfo) || !isRecord(userInfo.currentUser)) return null
  const vehicles = userInfo.currentUser.vehicles
  if (!Array.isArray(vehicles)) return null
  const wanted = vin.trim().toUpperCase()
  if (wanted === '') return null
  for (const entry of vehicles) {
    if (!isRecord(entry)) continue
    const { id, vin: listed } = entry
    if (nonEmptyString(id) && nonEmptyString(listed) && listed.trim().toUpperCase() === wanted) {
      return { id, vin: listed }
    }
  }
  return null
}

/**
 * The websocket's `connection_init` payload (design §2.3). The socket
 * authenticates by `u-sess` alone; the other three say which client this is.
 */
export function connectionInitPayload(userSessionToken: string): Record<string, string> {
  return {
    'client-name': APOLLO_CLIENT_NAME,
    'client-version': CLIENT_VERSION,
    'dc-cid': `m-ios-${randomUUID()}`,
    'u-sess': userSessionToken,
  }
}
