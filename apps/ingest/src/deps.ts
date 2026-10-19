/**
 * The seam between the worker and its vendors.
 *
 * Re-exporting `@ev/core` from here keeps every other module importing from one
 * path, and `profileFor` below is where a vendor is chosen, so adding Rivian
 * touches this file and the profile it returns and nothing else.
 *
 * The Rivian transport parsing lives here too, for the same reason: `mqtt.ts`
 * and `metrics.ts` may not import `@ev/rivian` (boundaries.test.ts), so what
 * they need from it - the stream names, how to read a topic, how to tape a
 * body - reaches them through this file.
 */
export * from '@ev/core'
export { RIVIAN_STREAMS } from '@ev/rivian'

import type { Vendor } from '@ev/core'
import {
  RIVIAN_STREAMS,
  RIVIAN_TOPIC_ROOT,
  cleanStrings,
  readRivianEnvelope,
} from '@ev/rivian'
import type { VendorProfile } from './profile.js'
import { teslaProfile } from './profiles/tesla.js'

/**
 * The one place the worker chooses a vendor. EV_VENDOR picks the profile at
 * startup (config.ts), and every vendor-specific decision - decode, staleness,
 * the charge refresh, sample construction - lives behind it.
 */
export function profileFor(vendor: Vendor): VendorProfile {
  switch (vendor) {
    case 'tesla': return teslaProfile
    case 'rivian': throw new Error('no profile for vendor rivian yet')
  }
}

/** The `record` label for a Rivian stream that is not in `RIVIAN_STREAMS`. */
export const OTHER_STREAM = 'other'

const KNOWN_STREAMS: ReadonlySet<string> = new Set(RIVIAN_STREAMS)

/**
 * The label a Rivian message is counted under: its stream if the stream is one
 * we list, else `other`.
 *
 * Bounded on purpose. The topic's last segment is whatever the publisher chose,
 * `parseRivianTopic` accepts any non-empty one so that no frame is dropped for
 * its name, and the label becomes a Prometheus series, so spelling it through
 * would let one misbehaving publisher mint series without bound. `metrics.ts`
 * seeds exactly `RIVIAN_STREAMS` and `other`.
 */
export function rivianRecordLabel(stream: string): string {
  return KNOWN_STREAMS.has(stream) ? stream : OTHER_STREAM
}

/** What a Rivian topic said. */
export interface RivianTopic {
  vin: string
  /** Whatever the last segment was: the envelope, not the topic, says which streams exist. */
  stream: string
}

/**
 * Read `rivian/<VIN>/<stream>`, or null if the topic is any other shape.
 *
 * Exactly three non-empty segments, the first being the Rivian root. The stream
 * is NOT checked against the known list: a topic for a stream this build has
 * never heard of is still a message that can be taped, and a connector deployed
 * ahead of ingest must not have its frames dropped, because nothing can re-send
 * them. What it refuses is only what could never be attributed: a different
 * root, a missing VIN, a missing stream, or a longer path whose extra segments
 * we would have to guess the meaning of.
 *
 * Splitting is strict, with no filtering of empty segments as the Tesla parser
 * does, so `rivian//state` is a shape we do not know and not a VIN we do.
 */
export function parseRivianTopic(topic: string): RivianTopic | null {
  const parts = topic.split('/')
  const [root, vin, stream] = parts
  if (parts.length !== 3 || root !== RIVIAN_TOPIC_ROOT || !vin || !stream) return null
  return { vin, stream }
}

/** What `tapeRivianBody` made of a body that parsed as JSON. */
export interface RivianTape {
  /** The cleaned JSON, whole: the thing that goes on the tape. */
  payload: unknown
  /** The connector's stamp, or `arrival` when there is no usable one. */
  receivedAt: Date
  /** False when the body was not a readable v1 envelope or its stamp was unusable: count it. */
  envelopeOk: boolean
}

/**
 * Turn a Rivian message body into what ingest tapes, or say it is not JSON.
 *
 * ORDER MATTERS. The body is parsed, then CLEANED, then looked at as an envelope:
 * cleaning is what makes the result safe for Postgres JSONB (which refuses
 * `\u0000` and unpaired surrogates, and a frame whose insert fails is never
 * acked and wedges everything behind it), so nothing downstream may see the
 * uncleaned value. The connector cleans too (spec §5.5); ingest does not trust
 * that it did.
 *
 * EVERY body that parses is taped, including one that is not a v1 envelope. That
 * is a decision about what is recoverable: a frame we cannot read today is one a
 * later reader can, and only if it is on the tape. So an unknown version, a
 * missing field or a bare `null` comes back as a result with `envelopeOk` false
 * and the parsed body as the payload, for the caller to count and tape, and
 * `decode` returns null for it. Only text that is not JSON at all is an error,
 * because there is nothing to tape.
 *
 * The payload is the cleaned body and not `readRivianEnvelope`'s result, which
 * keeps only the five v1 fields: the tape should hold what was sent, so a key a
 * newer connector adds is preserved even though this reader ignores it.
 *
 * `receivedAt` is the connector's clock (spec §6.2) because that is when the
 * frame arrived; ours is when it got through the broker, which after a backlog
 * is hours later. A stamp that does not parse falls back to `arrival`: taping at
 * a slightly wrong time beats not taping.
 */
export function tapeRivianBody(text: string, arrival: Date): RivianTape | { error: 'json' } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { error: 'json' }
  }

  const payload = cleanStrings(parsed)
  const envelope = readRivianEnvelope(payload)
  if (envelope === null) return { payload, receivedAt: arrival, envelopeOk: false }

  const stamp = new Date(envelope.receivedAt)
  if (Number.isNaN(stamp.getTime())) return { payload, receivedAt: arrival, envelopeOk: false }
  return { payload, receivedAt: stamp, envelopeOk: true }
}
