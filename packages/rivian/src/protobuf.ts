/**
 * A SCHEMA-LESS PROTOBUF READER, for Parallax payloads.
 *
 * Parallax messages are base64 protobuf, and Rivian publishes no schema for
 * them. We do not guess at one: ingest tapes the raw payload, and this reads it
 * into a generic tree (field number, wire type, value) that is good enough to
 * LOOK AT, to diff across a tape, and to decide which topics are worth a proper
 * decoder later. It never says what a field means.
 *
 * WRITTEN FROM THE PUBLIC PROTOBUF ENCODING DOCUMENTATION, and from nothing
 * else. A message is a sequence of fields; each starts with a varint TAG whose
 * low three bits are the wire type and whose remaining bits are the field
 * number. The wire types that exist in a message are 0 (varint), 1 (eight fixed
 * bytes), 2 (a varint length, then that many bytes) and 5 (four fixed bytes).
 * Types 3 and 4 delimit the long-deprecated group encoding, and 6 and 7 are not
 * defined; none of them can appear in a message we can read, so meeting one
 * means the bytes are not a message.
 *
 * THE HARD PART IS THAT A LENGTH-DELIMITED FIELD IS THREE THINGS. The wire does
 * not say whether its bytes are a string, raw bytes, or a nested message, so
 * the reader decides by trying, in this order:
 * 1. A nested message, if the bytes parse COMPLETELY as one and yield at least
 *    one field. This goes first because it is the strictest test: random text
 *    almost never survives it, and a real nested message always does.
 * 2. Otherwise text, if the bytes are valid UTF-8 with no control characters
 *    other than newline, tab and carriage return.
 * 3. Otherwise hex.
 * The order has a cost, which is honest to state: a short string that happens
 * to be a valid message is read as one (the two bytes of 'hi' are a complete
 * field). The tape keeps the original bytes, so a wrong guess costs a glance,
 * not data.
 *
 * VARINTS ARE BIGINTS and surface as decimal STRINGS, because a varint is up to
 * 64 bits and a JavaScript number is exact only to 2^53. A fixed-width value
 * surfaces as hex in wire order (little-endian, as sent), because whether it
 * is a float, a fixed integer or a signed one is exactly what we do not know.
 *
 * RECURSION IS BOUNDED at `MAX_DEPTH` levels, so a hostile or merely unlucky
 * payload cannot cost more than a fixed multiple of its own length. Past the
 * bound a length-delimited value is left as text or hex.
 */

export type WireNode =
  | { field: number; wire: 'varint'; value: string } // decimal string: a varint can exceed 2^53
  | { field: number; wire: 'i64'; value: string } // hex, little-endian as on the wire
  | { field: number; wire: 'i32'; value: string }
  | { field: number; wire: 'len'; value: WireNode[] | { utf8: string } | { hex: string } }

/** Levels of nested message the reader will descend: depths 0 to 15. */
const MAX_DEPTH = 16

/** The highest field number protobuf allows: 2^29 - 1. */
const MAX_FIELD_NUMBER = 0x1fffffff

/**
 * Text we are willing to call a string: no control character except newline,
 * tab and carriage return. NUL is one of them, which matters twice over, since
 * JSONB would refuse it anyway.
 */
const CONTROL_CHARACTER = /(?![\n\t\r])\p{Cc}/u

/**
 * `fatal`, so invalid UTF-8 throws and falls through to hex instead of being
 * quietly repaired into replacement characters. `ignoreBOM`, so a leading BOM
 * stays in the text rather than being stripped without a trace.
 */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Read one varint from `pos`: its value and the position after it, or null if
 * the bytes run out, or the varint is longer than a 64-bit value can be.
 *
 * Ten bytes is the most a 64-bit value needs (seven bits each), and the tenth
 * may carry only the single top bit. An encoder never writes more, so a longer
 * one means these bytes are not a message, which matters because the same
 * reader is how we decide that.
 */
function readVarint(bytes: Uint8Array, pos: number): { value: bigint; next: number } | null {
  let value = 0n
  for (let i = 0; i < 10; i++) {
    const byte = bytes[pos + i]
    if (byte === undefined) return null
    if (i === 9 && byte > 1) return null
    value |= BigInt(byte & 0x7f) << BigInt(7 * i)
    if ((byte & 0x80) === 0) return { value, next: pos + i + 1 }
  }
  return null
}

/**
 * What a length-delimited payload is: a message, else text, else bytes.
 * `depth` is the depth of the message CONTAINING the field.
 */
function readLen(sub: Uint8Array, depth: number): Extract<WireNode, { wire: 'len' }>['value'] {
  if (depth + 1 < MAX_DEPTH) {
    const nested = decodeWire(sub, depth + 1)
    if (nested !== null && nested.length > 0) return nested
  }
  try {
    const text = UTF8.decode(sub)
    if (!CONTROL_CHARACTER.test(text)) return { utf8: text }
  } catch {
    // Not UTF-8; it is bytes.
  }
  return { hex: toHex(sub) }
}

/**
 * Read `bytes` as one protobuf message, or null if they are not a complete one.
 *
 * "Complete" is strict, on purpose: every byte must belong to a field, no field
 * may be cut short, and no tag may be impossible (field 0, a field number past
 * 2^29 - 1, an undefined or group wire type). The nested-message test in
 * `readLen` leans on that strictness, so loosening it here would turn text into
 * phantom messages. An empty buffer is a complete, empty message.
 *
 * `depth` is the depth of this message; the top level is 0. Callers outside
 * this file leave it alone.
 */
export function decodeWire(bytes: Uint8Array, depth = 0): WireNode[] | null {
  const nodes: WireNode[] = []
  let pos = 0
  while (pos < bytes.length) {
    const tag = readVarint(bytes, pos)
    if (tag === null) return null
    pos = tag.next

    const fieldNumber = tag.value >> 3n
    if (fieldNumber === 0n || fieldNumber > BigInt(MAX_FIELD_NUMBER)) return null
    const field = Number(fieldNumber)

    switch (Number(tag.value & 7n)) {
      case 0: {
        const varint = readVarint(bytes, pos)
        if (varint === null) return null
        pos = varint.next
        nodes.push({ field, wire: 'varint', value: varint.value.toString() })
        break
      }
      case 1: {
        if (pos + 8 > bytes.length) return null
        nodes.push({ field, wire: 'i64', value: toHex(bytes.subarray(pos, pos + 8)) })
        pos += 8
        break
      }
      case 5: {
        if (pos + 4 > bytes.length) return null
        nodes.push({ field, wire: 'i32', value: toHex(bytes.subarray(pos, pos + 4)) })
        pos += 4
        break
      }
      case 2: {
        const length = readVarint(bytes, pos)
        if (length === null) return null
        pos = length.next
        // Compared as a bigint: a 64-bit length is not safe to turn into a
        // number before it has been checked against the buffer.
        if (length.value > BigInt(bytes.length - pos)) return null
        const end = pos + Number(length.value)
        nodes.push({ field, wire: 'len', value: readLen(bytes.subarray(pos, end), depth) })
        pos = end
        break
      }
      default:
        // 3 and 4 (groups), 6 and 7 (undefined): not a message.
        return null
    }
  }
  return nodes
}
