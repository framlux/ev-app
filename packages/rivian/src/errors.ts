/**
 * ERRORS FROM RIVIAN, REDUCED TO WHAT IS SAFE TO KEEP (design §4.4).
 *
 * A failed call to Rivian tends to be full of things that must never reach a
 * log line, a database row or a browser. The request that failed carried the
 * account password, an OTP, or a session token in a header; the response may
 * echo any of those back in its `message`, or carry the tokens of a half-made
 * sign-in; and the upstream Python client had to remove request headers and
 * bodies from its exception text after exactly that leaked (design §2.4, PR
 * #220). The one rule here is that an error is built from TWO fields of the
 * response, `extensions.code` and `extensions.reason`, and from nothing else:
 * not the `message`, not `data`, not a header, not the request, not the
 * underlying exception of a failed `fetch`.
 *
 * That is enforced by construction rather than by scrubbing. A scrubber has to
 * recognise every secret in every shape Rivian might put one in; this file only
 * has to refuse to look. Even the two fields it does read are filtered to the
 * SHAPE of a code (a short identifier) and of a reason (a short token), and a
 * value shaped like a secret (a run of digits, a hex run, a long opaque run) is
 * refused whatever its length, because both fields are remote text and a
 * response that put a token or a one-time code in either would otherwise carry
 * it straight into `message`, `stack` and the `rivian_status.last_error`
 * column. The filter is a second line of defence, not the first: it recognises
 * the SHAPES secrets usually have, and it cannot tell a short secret that looks
 * like a word from the word, which is why the response body is never read for
 * anything else.
 *
 * Every string an error exposes (`message`, `stack`, `redacted()`, the JSON
 * form) is therefore built from those filtered codes, a status number and the
 * call's own label, so any of them is safe to log. `redacted()` is still the
 * form callers should reach for, because it says in its name what it is.
 */

/** One entry of Rivian's `errors[]`, reduced to the two fields we keep. */
export interface RivianErrorCode {
  code: string
  reason?: string
}

/**
 * What `extensions.code` must look like to be kept: an identifier, as GraphQL
 * servers spell them (`UNAUTHENTICATED`, `GRAPHQL_VALIDATION_FAILED`). Case is
 * not enforced, because a code Rivian spelled differently would otherwise
 * vanish and take its classification with it; the length cap is far above any
 * real code and far below a token.
 */
const CODE_SHAPE = /^[A-Za-z][A-Za-z0-9_]{0,47}$/

/**
 * What `extensions.reason` must look like: one short token with no spaces.
 * Rivian's reasons are words and identifiers (`INVALID_OTP`, `OTP_TOKEN_EXPIRED`,
 * `expired`), in either case, so the shape is wider than a code's, and the cap
 * is the only thing that keeps a session token out. A reason that is longer, or
 * has a space or any other character, is dropped (the code beside it is kept).
 */
const REASON_SHAPE = /^[A-Za-z0-9_.-]{1,40}$/

/**
 * The shapes of a secret, which a code or a reason must not have however short
 * it is. A length cap alone lets an OTP (`123456`), a UUID or a 20-character
 * token through, because all of those are shorter than any cap that would still
 * admit `OTP_TOKEN_EXPIRED`. Each rule is something no genuine code or reason
 * has: they are identifiers made of words, and the longest run of letters or
 * digits in `GRAPHQL_VALIDATION_FAILED` is ten characters, none of them digits.
 * - all digits, any length: a one-time code, a numeric id;
 * - six or more digits in a row: the same, inside a longer string;
 * - eight or more hex digits in a row: a hex token, or any group of a UUID;
 * - twenty or more letters and digits in a row: an opaque token, base64 or the
 *   segment of a JWT.
 * A run is broken by `_`, `-` and `.`, which is how real identifiers are written
 * and how the words of one are told apart.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /^[0-9]+$/,
  /[0-9]{6,}/,
  /[0-9a-fA-F]{8,}/,
  /[A-Za-z0-9]{20,}/,
]

function looksLikeSecret(value: string): boolean {
  return SECRET_SHAPES.some((shape) => shape.test(value))
}

/**
 * More distinct codes than this are cut. Rivian reports a rejected selection as
 * one `GRAPHQL_VALIDATION_FAILED` per bad field, and a group of sixteen can
 * produce sixteen; the cap keeps the redacted line a line. Equal entries are
 * collapsed first, so the cap only bites on genuinely different codes.
 */
const MAX_CODES = 8

/**
 * Codes that this client makes up for failures that are not Rivian answering.
 * They are spelled like Rivian's so that one `Rivian error <code>` message
 * covers both, and none is a code Rivian is known to send, so a classification
 * getter never mistakes one for a Rivian verdict.
 * - `TIMEOUT`: the call outlived its deadline.
 * - `NETWORK`: the request, or the reading of its response, failed.
 * - `BAD_RESPONSE`: a 2xx that was not a JSON object, or whose `data` was not
 *   the shape the call asked for.
 * - `NO_DATA`: a 2xx JSON object with neither errors nor `data`.
 * - `UNCODED_ERROR`: a 2xx whose `errors` carried nothing we may keep.
 */
export type ClientErrorCode = 'TIMEOUT' | 'NETWORK' | 'BAD_RESPONSE' | 'NO_DATA' | 'UNCODED_ERROR'

/** The `reason` values that mark a one-time-code problem rather than a password one. */
const OTP_REASONS: ReadonlySet<string> = new Set(['INVALID_OTP', 'OTP_TOKEN_EXPIRED'])

/**
 * The codes an error may hold: each entry reduced to `code` and `reason`, an
 * entry whose code has not the shape of one, or has the shape of a secret,
 * dropped whole (a reason with no code beside it means nothing), a reason that
 * has not the shape of one, or has the shape of a secret, dropped alone, equal
 * entries collapsed, and the list cut at `MAX_CODES`.
 *
 * It runs in the CONSTRUCTOR, not only in `toRivianApiError`, so that the
 * guarantee belongs to the type: no caller, however it builds the list, can
 * make a `RivianApiError` hold a third field or a string that is not shaped
 * like a code. Entries are copied field by field for the same reason, so a
 * caller that passes a whole `errors[]` entry still stores two fields of it.
 */
function keepCodes(input: readonly RivianErrorCode[]): RivianErrorCode[] {
  const kept: RivianErrorCode[] = []
  for (const entry of input) {
    if (kept.length >= MAX_CODES) break
    const { code, reason } = entry
    if (typeof code !== 'string' || !CODE_SHAPE.test(code) || looksLikeSecret(code)) continue
    const next: RivianErrorCode =
      typeof reason === 'string' && REASON_SHAPE.test(reason) && !looksLikeSecret(reason)
        ? { code, reason }
        : { code }
    if (kept.some((c) => c.code === next.code && c.reason === next.reason)) continue
    kept.push(next)
  }
  return kept
}

/**
 * `Rivian HTTP 400: UNAUTHENTICATED/expired`, or `Rivian request failed:
 * TIMEOUT` when no response arrived, with the codes joined by `, `. With no
 * codes (a bare 502 from a proxy) it is just the status.
 */
function redactedForm(httpStatus: number | null, codes: readonly RivianErrorCode[]): string {
  const head = httpStatus === null ? 'Rivian request failed' : `Rivian HTTP ${httpStatus}`
  if (codes.length === 0) return head
  const list = codes.map((c) => (c.reason === undefined ? c.code : `${c.code}/${c.reason}`))
  return `${head}: ${list.join(', ')}`
}

export class RivianApiError extends Error {
  /** The HTTP status, or null when no response arrived (timeout, network). */
  readonly httpStatus: number | null
  readonly codes: readonly RivianErrorCode[]
  /**
   * The label of the call that failed (`Login`, `getUserInfo`), for the caller
   * to put next to `redacted()` in a log line. It is a constant chosen by our
   * own code, never text from the request or the response.
   */
  readonly what: string

  constructor(httpStatus: number | null, codes: readonly RivianErrorCode[], what: string) {
    const kept = keepCodes(codes)
    // The message is the redacted form, so that anything which logs
    // `err.message`, or an uncaught error's `stack`, is already safe: there is
    // no second, richer string for a careless `console.error` to find.
    super(redactedForm(httpStatus, kept))
    this.name = 'RivianApiError'
    this.httpStatus = httpStatus
    this.codes = kept
    this.what = what
  }

  /**
   * The session is not welcome: `UNAUTHENTICATED` anywhere in codes, or an
   * HTTP 401 that has no code this class recognises.
   *
   * The second clause is for a gateway in front of the GraphQL server, which
   * answers an expired or revoked session with a bare 401 and no GraphQL body,
   * so there is no code to read. The connector treats `unauthenticated` as the
   * dead-session rule (one retry, then stop and wait for a new credential), and
   * missing it would turn a dead session into an ordinary failure, which is
   * retried, and retrying a dead session is how accounts get flagged. A 401
   * that DOES carry a code of ours is something else and is read as that
   * (`BAD_CURRENT_PASSWORD` is a wrong password, not a dead session), so the
   * status only counts when nothing else claims the response.
   */
  get unauthenticated(): boolean {
    if (this.codes.some((c) => c.code === 'UNAUTHENTICATED')) return true
    return (
      this.httpStatus === 401 &&
      !this.rateLimited &&
      !this.validationFailed &&
      !this.badCredentials &&
      !this.badOtp &&
      !this.locked
    )
  }

  /** `RATE_LIMIT`, or HTTP 429 from a gateway that answers before GraphQL does. */
  get rateLimited(): boolean {
    return this.httpStatus === 429 || this.codes.some((c) => c.code === 'RATE_LIMIT')
  }

  /**
   * The server rejected the query's text. It does not name the field (design
   * §2.3), so the connector's answer is to bisect the group, not to read this.
   */
  get validationFailed(): boolean {
    return this.codes.some((c) => c.code === 'GRAPHQL_VALIDATION_FAILED')
  }

  /**
   * The email or password was wrong: `BAD_CURRENT_PASSWORD`, or a
   * `BAD_USER_INPUT` that is not about the one-time code. The second clause is
   * deliberately the wider one, because Rivian's reason for a wrong email is
   * not documented; what it must NOT take is the OTP case, which would tell the
   * user their password is wrong when it is the code.
   */
  get badCredentials(): boolean {
    return this.codes.some(
      (c) =>
        c.code === 'BAD_CURRENT_PASSWORD' ||
        (c.code === 'BAD_USER_INPUT' && !(c.reason !== undefined && OTP_REASONS.has(c.reason))),
    )
  }

  /** The one-time code was wrong or has expired. */
  get badOtp(): boolean {
    return this.codes.some(
      (c) =>
        (c.code === 'BAD_USER_INPUT' && c.reason === 'INVALID_OTP') ||
        (c.code === 'UNAUTHENTICATED' && c.reason === 'OTP_TOKEN_EXPIRED'),
    )
  }

  /** `SESSION_MANAGER_ERROR`: Rivian has locked the account for now. */
  get locked(): boolean {
    return this.codes.some((c) => c.code === 'SESSION_MANAGER_ERROR')
  }

  /**
   * The only form that may be logged, stored or shown (spec §4.4), e.g.
   * `Rivian HTTP 400: UNAUTHENTICATED/expired`.
   */
  redacted(): string {
    return redactedForm(this.httpStatus, this.codes)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Build the error for a failed call from its status and its parsed body
 * (`null` when the body was not JSON).
 *
 * `body` is untrusted in every way: it may be anything JSON can be, and every
 * string in it may be a secret. Only `errors[].extensions.code` and
 * `errors[].extensions.reason` are read, and the constructor keeps them only
 * when they have the shape of one (see `keepCodes`).
 */
export function toRivianApiError(
  httpStatus: number | null,
  body: unknown,
  what: string,
): RivianApiError {
  const found: RivianErrorCode[] = []
  const errors = isRecord(body) ? body.errors : undefined
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      const extensions = isRecord(entry) ? entry.extensions : undefined
      if (!isRecord(extensions)) continue
      const { code, reason } = extensions
      if (typeof code !== 'string') continue
      found.push(typeof reason === 'string' ? { code, reason } : { code })
    }
  }
  // Filtered here as well as in the constructor, because the 2xx case below
  // must know whether anything usable survived.
  const codes = keepCodes(found)
  if (codes.length === 0 && httpStatus !== null && httpStatus >= 200 && httpStatus < 300) {
    // A 2xx is the one case where a bare status says nothing: "Rivian HTTP 200"
    // would read as success. Say what was wrong with it instead. A non-2xx
    // with nothing usable in it is described well enough by its status.
    const synthetic: ClientErrorCode = !isRecord(body)
      ? 'BAD_RESPONSE'
      : Array.isArray(body.errors) && body.errors.length > 0
        ? 'UNCODED_ERROR'
        : 'NO_DATA'
    codes.push({ code: synthetic })
  }
  return new RivianApiError(httpStatus, codes, what)
}
