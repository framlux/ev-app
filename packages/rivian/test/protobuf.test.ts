import { describe, expect, it } from 'vitest'
import { decodeWire, type WireNode } from '../src/protobuf.js'

// Every byte string below is hand-encoded from the public protobuf encoding
// rules, so these tests say what the wire format is rather than what a
// particular vehicle sends. None is a capture.
const bytes = (...b: number[]) => Uint8Array.from(b)

type LenNode = Extract<WireNode, { wire: 'len' }>

describe('decodeWire', () => {
  it('reads a varint as a decimal string', () => {
    expect(decodeWire(bytes(0x08, 0x96, 0x01))).toEqual([{ field: 1, wire: 'varint', value: '150' }])
  })

  it('reads a varint of 2^63 without losing a bit to a double', () => {
    // Nine continuation bytes carrying nothing, then the tenth carrying bit 63.
    const nine = Array(9).fill(0x80)
    expect(decodeWire(bytes(0x08, ...nine, 0x01))).toEqual([
      { field: 1, wire: 'varint', value: '9223372036854775808' },
    ])
  })

  it('reads the largest 64-bit varint', () => {
    const nine = Array(9).fill(0xff)
    expect(decodeWire(bytes(0x08, ...nine, 0x01))).toEqual([
      { field: 1, wire: 'varint', value: '18446744073709551615' },
    ])
  })

  it('reads a negative int32 as its ten-byte two\'s-complement varint', () => {
    // -1 as int32 is sign-extended to 64 bits, which is how encoders write it.
    const nine = Array(9).fill(0xff)
    expect(decodeWire(bytes(0x10, ...nine, 0x01))?.[0]).toEqual({
      field: 2, wire: 'varint', value: '18446744073709551615',
    })
  })

  it('reads a length-delimited payload that is text as utf8', () => {
    // 0x6f is wire type 7, so these two bytes cannot be a message and the text
    // reading is what is left. ('hi' would NOT do: 0x68 0x69 is a valid
    // one-field message, and the message reading wins.)
    expect(decodeWire(bytes(0x12, 0x02, 0x6f, 0x6b))).toEqual([
      { field: 2, wire: 'len', value: { utf8: 'ok' } },
    ])
  })

  it('reads a length-delimited payload that parses as a message as a message', () => {
    expect(decodeWire(bytes(0x1a, 0x03, 0x08, 0x96, 0x01))).toEqual([
      { field: 3, wire: 'len', value: [{ field: 1, wire: 'varint', value: '150' }] },
    ])
  })

  it('prefers the message reading over the text one when both fit', () => {
    // 0x68 is field 13, wire type 0 (a varint), and 0x69 is its value, 105: so
    // the two bytes that spell 'hi' are also a complete one-field message.
    expect(decodeWire(bytes(0x12, 0x02, 0x68, 0x69))).toEqual([
      { field: 2, wire: 'len', value: [{ field: 13, wire: 'varint', value: '105' }] },
    ])
  })

  it('falls back to hex for a payload that is neither a message nor text', () => {
    expect(decodeWire(bytes(0x1a, 0x02, 0xff, 0xfe))).toEqual([
      { field: 3, wire: 'len', value: { hex: 'fffe' } },
    ])
  })

  it('does not call text with control characters text', () => {
    // 0x07 is a bell: valid UTF-8, but not something a person wrote. (0x07 as a
    // tag is field 0, wire type 7, so it is not a message either.)
    expect(decodeWire(bytes(0x12, 0x02, 0x07, 0x07))).toEqual([
      { field: 2, wire: 'len', value: { hex: '0707' } },
    ])
  })

  it('allows newline, tab and carriage return in text', () => {
    // 0x0a 0x09 would parse as field 1 len 9 (overrunning), 0x0d is field 1 wire
    // type 5 (needs four bytes): neither is a message.
    expect(decodeWire(bytes(0x12, 0x03, 0x0d, 0x0a, 0x09))).toEqual([
      { field: 2, wire: 'len', value: { utf8: '\r\n\t' } },
    ])
  })

  it('reads an empty length-delimited payload as empty text, not as an empty message', () => {
    expect(decodeWire(bytes(0x12, 0x00))).toEqual([{ field: 2, wire: 'len', value: { utf8: '' } }])
  })

  it('reads a fixed32 as hex in wire order', () => {
    expect(decodeWire(bytes(0x25, 0x00, 0x00, 0x80, 0x3f))).toEqual([
      { field: 4, wire: 'i32', value: '0000803f' },
    ])
  })

  it('reads a fixed64 as hex in wire order', () => {
    expect(decodeWire(bytes(0x09, 1, 2, 3, 4, 5, 6, 7, 8))).toEqual([
      { field: 1, wire: 'i64', value: '0102030405060708' },
    ])
  })

  it('reads several fields in order, a repeated field once per occurrence', () => {
    expect(decodeWire(bytes(0x08, 0x01, 0x08, 0x02, 0x10, 0x03))).toEqual([
      { field: 1, wire: 'varint', value: '1' },
      { field: 1, wire: 'varint', value: '2' },
      { field: 2, wire: 'varint', value: '3' },
    ])
  })

  it('reads an empty buffer as an empty message', () => {
    expect(decodeWire(bytes())).toEqual([])
  })

  describe('is null for bytes that are not a complete message', () => {
    it('a truncated tag or varint', () => {
      expect(decodeWire(bytes(0x08))).toBeNull()
      expect(decodeWire(bytes(0x08, 0x96))).toBeNull()
      expect(decodeWire(bytes(0x88))).toBeNull()
    })

    it('a varint that runs past ten bytes, or past 64 bits within them', () => {
      expect(decodeWire(bytes(0x08, ...Array(10).fill(0x80), 0x01))).toBeNull()
      expect(decodeWire(bytes(0x08, ...Array(9).fill(0x80), 0x02))).toBeNull()
    })

    it('a length that overruns the buffer', () => {
      expect(decodeWire(bytes(0x12, 0x05, 0x6f))).toBeNull()
    })

    it('a fixed-width field that is cut short', () => {
      expect(decodeWire(bytes(0x25, 0x00, 0x00))).toBeNull()
      expect(decodeWire(bytes(0x09, 1, 2, 3))).toBeNull()
    })

    it('a start-group or end-group wire type, or one that does not exist', () => {
      expect(decodeWire(bytes(0x0b))).toBeNull() // field 1, wire 3
      expect(decodeWire(bytes(0x0c))).toBeNull() // field 1, wire 4
      expect(decodeWire(bytes(0x0e, 0x00))).toBeNull() // field 1, wire 6
      expect(decodeWire(bytes(0x0f, 0x00))).toBeNull() // field 1, wire 7
    })

    it('field number 0', () => {
      expect(decodeWire(bytes(0x00, 0x01))).toBeNull()
    })

    it('a field number past 2^29 - 1', () => {
      // Tag = (2^29 << 3) | 0 = 2^32: five bytes of varint.
      expect(decodeWire(bytes(0x80, 0x80, 0x80, 0x80, 0x10, 0x01))).toBeNull()
    })
  })

  it('accepts the largest field number there is', () => {
    // Tag = ((2^29 - 1) << 3) | 0.
    expect(decodeWire(bytes(0xf8, 0xff, 0xff, 0xff, 0x0f, 0x01))).toEqual([
      { field: 536870911, wire: 'varint', value: '1' },
    ])
  })

  it('bounds its own recursion at sixteen levels', () => {
    // Twenty single-field wrappers around [0x08 0x96 0x01]. Each wrapper is
    // `0a <length> <inner>`, and the outermost message is 43 bytes, so every
    // length is a single-byte varint.
    let inner: number[] = [0x08, 0x96, 0x01]
    for (let i = 0; i < 20; i++) inner = [0x0a, inner.length, ...inner]
    const decoded = decodeWire(Uint8Array.from(inner))
    expect(decoded).not.toBeNull()

    // Depth 0 is the top level. Walk down the single field of each message.
    let level: WireNode[] = decoded!
    for (let depth = 0; depth < 15; depth++) {
      expect(level).toHaveLength(1)
      const node = level[0] as LenNode
      expect(node).toMatchObject({ field: 1, wire: 'len' })
      expect(Array.isArray(node.value)).toBe(true)
      level = node.value as WireNode[]
    }

    // Level 15 is still a message, but the length-delimited value inside it is
    // past the bound, so it is left as bytes.
    expect(level).toHaveLength(1)
    const last = level[0] as LenNode
    expect(last.field).toBe(1)
    expect(last.value).toEqual({ hex: expect.stringMatching(/^[0-9a-f]+$/) })
    expect((last.value as { hex: string }).hex.startsWith('0a09')).toBe(true)
  })
})
