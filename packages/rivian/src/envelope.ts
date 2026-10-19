/**
 * THE ENVELOPE: the one shape every Rivian frame travels in between the
 * connector (which holds the websocket) and ingest (which tapes and decodes it).
 *
 * The connector publishes to MQTT at `rivian/<VIN>/<stream>`, and the body is
 * this envelope. It is deliberately thin: the connector does not decode, so what
 * Rivian sent is carried VERBATIM in `body`, and every decision about meaning is
 * made later, by code that can be fixed and re-run over the tape. The one thing
 * the envelope adds is `receivedAt`, the connector's clock at the moment the
 * frame arrived. That is the only honest answer to "when did we learn this",
 * because a subscribe snapshot re-sends values that may be hours old and the
 * frame says nothing of its own about that (design §5.5, §6.4).
 *
 * It is versioned (`v`) so that the day the shape changes, a reader built for v1
 * refuses a v2 frame instead of misreading it. `readRivianEnvelope` is that
 * refusal: it returns null for anything that is not exactly what v1 promises,
 * and the caller decides what to do with a frame it cannot read.
 */

export const ENVELOPE_VERSION = 1

/**
 * The streams, one per subscription kind plus `meta` for everything the
 * connector learns over plain HTTP (design §5.3, §5.6). They are also the last
 * segment of the MQTT topic, so adding one is a topic-space change and belongs
 * in a new envelope version.
 */
export const RIVIAN_STREAMS = [
  'state',
  'parallax',
  'charging',
  'cloud',
  'ota',
  'geofence',
  'departure',
  'meta',
] as const

export type RivianStream = (typeof RIVIAN_STREAMS)[number]

export interface RivianEnvelope {
  v: 1
  stream: RivianStream
  vin: string
  /** ISO 8601, from the connector's clock, when the frame arrived. */
  receivedAt: string
  /**
   * Subscription streams: the frame's WHOLE payload (`{data, errors?}`),
   * verbatim. `meta`: `{ kind, data }`. Unknown here on purpose; the normaliser
   * is what looks inside.
   */
  body: unknown
}

/** The first segment of every Rivian topic, which is what keeps them apart from any other vendor's. */
export const RIVIAN_TOPIC_ROOT = 'rivian'

/** `rivian/<VIN>/<stream>`. */
export function rivianTopic(vin: string, stream: RivianStream): string {
  return `${RIVIAN_TOPIC_ROOT}/${vin}/${stream}`
}

const STREAMS: ReadonlySet<string> = new Set(RIVIAN_STREAMS)

/**
 * Read a payload as a v1 envelope, or null if it is not exactly one.
 *
 * "Exactly" is about the five fields v1 promises: the right version, a known
 * stream, a string `vin` and `receivedAt`, and a `body` key that is present
 * (its value may be anything, null included, because absence of data is the
 * connector's to report and the normaliser's to interpret). A key v1 does not
 * mention is ignored, and left out of the result, so a connector that gains an
 * annotation does not get its frames refused by an ingest that predates it.
 *
 * It takes `unknown` because it is called on the output of `JSON.parse`, which
 * is whatever anyone published to the topic.
 */
export function readRivianEnvelope(payload: unknown): RivianEnvelope | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const p = payload as Record<string, unknown>
  if (p.v !== ENVELOPE_VERSION) return null
  if (typeof p.stream !== 'string' || !STREAMS.has(p.stream)) return null
  if (typeof p.vin !== 'string') return null
  if (typeof p.receivedAt !== 'string') return null
  if (!('body' in p)) return null
  return {
    v: ENVELOPE_VERSION,
    stream: p.stream as RivianStream,
    vin: p.vin,
    receivedAt: p.receivedAt,
    body: p.body,
  }
}

/**
 * Lone surrogates: a high surrogate not followed by a low one, or a low one not
 * preceded by a high one. No `u` flag, so the pattern runs over UTF-16 code
 * units, which is the level a surrogate exists at.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

function cleanString(s: string): string {
  // Surrogates first, then NUL. The other order would let removing a NUL splice
  // the two halves either side of it into a valid pair, a character the car
  // never sent; each half is lone as it arrived and is replaced as such.
  return s.replace(LONE_SURROGATE, '\uFFFD').replace(/\u0000/g, '')
}

/**
 * Deep-clean every string in a JSON value, object keys included.
 *
 * Postgres JSONB rejects `\u0000` and unpaired surrogates. The strings that
 * reach us include ones a person typed (the active driver's name, the
 * vehicle's name), so a `\u0000` is not hypothetical, and a taped frame that
 * JSONB refuses rolls its transaction back, is never acknowledged, and is
 * redelivered for ever, wedging everything behind it. The connector cleans
 * before it publishes and ingest cleans again before it tapes, so neither side
 * can be the one that wedges the other (design §5.5, §6.2).
 *
 * The replacement for a lone surrogate is U+FFFD, which says "something was
 * here" and keeps the surrounding text readable; a NUL carries no text and is
 * dropped. A valid pair (an emoji) is untouched.
 *
 * It returns a NEW value and never mutates its input, since the input is often
 * the object the caller is about to log or compare. Numbers, booleans and null
 * pass through as they are. Two keys that clean to the same string collide and
 * the later one wins, which is as good an answer as any for a key that was
 * already malformed. Keys are set as own data properties, so a JSON `__proto__`
 * key stays a key rather than re-pointing the result's prototype.
 *
 * It is for JSON-shaped values: plain objects, arrays and scalars. That is all
 * `JSON.parse` can produce, and all the connector sends.
 */
export function cleanStrings<T>(value: T): T {
  return clean(value) as T
}

function clean(value: unknown): unknown {
  if (typeof value === 'string') return cleanString(value)
  if (Array.isArray(value)) return value.map(clean)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [cleanString(key), clean(inner)]),
    )
  }
  return value
}
