import { describe, expect, it } from 'vitest'
import {
  ENVELOPE_VERSION,
  RIVIAN_STREAMS,
  RIVIAN_TOPIC_ROOT,
  cleanStrings,
  readRivianEnvelope,
  rivianTopic,
} from '../src/envelope.js'

// Every fixture here is SYNTHETIC: made up for the test, never a capture from a
// real vehicle or account. The VIN below is not a real one.
const VALID = {
  v: 1,
  stream: 'state',
  vin: 'TESTVIN0000000001',
  receivedAt: '2026-10-19T17:03:11.482Z',
  body: { data: { vehicleState: { batteryLevel: { timeStamp: 'x', value: 80 } } } },
}

describe('rivianTopic', () => {
  it('lays a topic out as rivian/<vin>/<stream>', () => {
    expect(rivianTopic('VIN1', 'state')).toBe('rivian/VIN1/state')
    expect(RIVIAN_TOPIC_ROOT).toBe('rivian')
  })

  it('has a topic for every stream', () => {
    for (const stream of RIVIAN_STREAMS) {
      expect(rivianTopic('VIN1', stream)).toBe(`rivian/VIN1/${stream}`)
    }
  })

  it('names exactly the eight streams the design lists', () => {
    expect([...RIVIAN_STREAMS]).toEqual([
      'state', 'parallax', 'charging', 'cloud', 'ota', 'geofence', 'departure', 'meta',
    ])
    expect(ENVELOPE_VERSION).toBe(1)
  })
})

describe('readRivianEnvelope', () => {
  it('accepts a valid v1 envelope and hands back its fields', () => {
    expect(readRivianEnvelope(VALID)).toEqual(VALID)
  })

  it('accepts every stream', () => {
    for (const stream of RIVIAN_STREAMS) {
      expect(readRivianEnvelope({ ...VALID, stream })?.stream).toBe(stream)
    }
  })

  it('accepts a null body: absent data is the connector\'s to say, not ours to refuse', () => {
    expect(readRivianEnvelope({ ...VALID, body: null })?.body).toBeNull()
  })

  it('ignores keys it does not know rather than refusing the frame', () => {
    const read = readRivianEnvelope({ ...VALID, extra: 'x' })
    expect(read).toEqual(VALID)
    expect(read).not.toHaveProperty('extra')
  })

  it('refuses a version it does not speak', () => {
    expect(readRivianEnvelope({ ...VALID, v: 2 })).toBeNull()
    expect(readRivianEnvelope({ ...VALID, v: '1' })).toBeNull()
    const { v: _v, ...noVersion } = VALID
    expect(readRivianEnvelope(noVersion)).toBeNull()
  })

  it('refuses an envelope with no receivedAt, or one that is not a string', () => {
    const { receivedAt: _r, ...missing } = VALID
    expect(readRivianEnvelope(missing)).toBeNull()
    expect(readRivianEnvelope({ ...VALID, receivedAt: 1760893391482 })).toBeNull()
  })

  it('refuses an unknown stream', () => {
    expect(readRivianEnvelope({ ...VALID, stream: 'telemetry' })).toBeNull()
    expect(readRivianEnvelope({ ...VALID, stream: 7 })).toBeNull()
  })

  it('refuses a vin that is not a string', () => {
    expect(readRivianEnvelope({ ...VALID, vin: 12345 })).toBeNull()
    expect(readRivianEnvelope({ ...VALID, vin: null })).toBeNull()
  })

  it('refuses an envelope with no body key at all', () => {
    const { body: _b, ...missing } = VALID
    expect(readRivianEnvelope(missing)).toBeNull()
  })

  it('refuses anything that is not an object', () => {
    for (const bad of [null, undefined, 'x', 7, true, [], [VALID]]) {
      expect(readRivianEnvelope(bad)).toBeNull()
    }
  })
})

describe('cleanStrings', () => {
  it('removes NUL from strings and keys, and replaces a lone surrogate with U+FFFD', () => {
    expect(cleanStrings({ 'a\u0000b': ['x\u0000', '\uD800y', 'ok 😀'] })).toEqual({
      ab: ['x', '\uFFFDy', 'ok 😀'],
    })
  })

  it('keeps a valid surrogate pair whole', () => {
    expect(cleanStrings('😀')).toBe('😀')
    expect(cleanStrings('a😀b')).toBe('a😀b')
  })

  it('replaces a lone low surrogate and a lone high one at the end of a string', () => {
    expect(cleanStrings('\uDC00z')).toBe('\uFFFDz')
    expect(cleanStrings('z\uD83D')).toBe('z\uFFFD')
  })

  it('judges a surrogate pair by what is there, not by what removing a NUL would make', () => {
    // Removing the NUL first would splice these two into one valid character the
    // car never sent. Each is lone as it arrived, so each is replaced.
    expect(cleanStrings('\uD800\u0000\uDC00')).toBe('\uFFFD\uFFFD')
  })

  it('cleans a string held at any depth', () => {
    expect(cleanStrings({ a: { b: [{ c: 'd\u0000' }] } })).toEqual({ a: { b: [{ c: 'd' }] } })
  })

  it('leaves non-string leaves exactly as they were', () => {
    const value = { n: 1.5, z: 0, t: true, f: false, nil: null, big: [1, 2, 3] }
    expect(cleanStrings(value)).toEqual(value)
  })

  it('does not mutate its input', () => {
    const input = { 'a\u0000b': ['x\u0000', { k: '\uD800' }] }
    const before = structuredClone(input)
    const out = cleanStrings(input)
    expect(input).toEqual(before)
    expect(out).not.toBe(input)
    expect(out).toEqual({ ab: ['x', { k: '\uFFFD' }] })
  })

  it('keeps an own `__proto__` key as data instead of re-pointing the prototype', () => {
    const parsed = JSON.parse('{"__proto__": {"polluted": true}, "k": 1}')
    const out = cleanStrings(parsed) as Record<string, unknown>
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(Object.keys(out)).toEqual(['__proto__', 'k'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('does not run out of stack on nesting far deeper than a call stack can follow', () => {
    // JSON.parse takes this depth happily; a recursive clean would throw a
    // RangeError, on every delivery of the frame. Built and checked in loops,
    // because toEqual would recurse too.
    const DEPTH = 100_000
    let deep: unknown = 'leaf\u0000'
    for (let i = 0; i < DEPTH; i++) deep = i % 2 === 0 ? { 'k\u0000': deep } : [deep]

    const out = cleanStrings(deep)

    // One assertion, not a hundred thousand: count the levels that have the
    // expected shape and then check the leaf.
    let node: unknown = out
    let wellFormed = 0
    for (let i = DEPTH - 1; i >= 0; i--) {
      if (i % 2 === 0) {
        const keys = Object.keys(node as object)
        if (keys.length !== 1 || keys[0] !== 'k') break
        node = (node as Record<string, unknown>).k
      } else {
        if (!Array.isArray(node) || node.length !== 1) break
        node = node[0]
      }
      wellFormed++
    }
    expect(wellFormed).toBe(DEPTH)
    expect(node).toBe('leaf')
  })

  it('cleans every branch of a wide structure, not only the one it descends first', () => {
    const wide = { a: ['x\u0000', { b: 'y\u0000' }], c: { d: ['z\u0000'], 'e\u0000': 1 }, f: '\uD800' }
    expect(cleanStrings(wide)).toEqual({
      a: ['x', { b: 'y' }],
      c: { d: ['z'], e: 1 },
      f: '\uFFFD',
    })
  })

  it('keeps the order of array elements and of object keys', () => {
    const out = cleanStrings({ z: [3, 'a\u0000', 1], a: 2, m: { y: 1, b: 2 } })
    expect(Object.keys(out)).toEqual(['z', 'a', 'm'])
    expect(out.z).toEqual([3, 'a', 1])
    expect(Object.keys(out.m)).toEqual(['y', 'b'])
  })

  it('terminates on a cyclic structure instead of growing until memory runs out', () => {
    const cyclic: Record<string, unknown> = { name: 'a\u0000b' }
    cyclic.self = cyclic
    cyclic.list = [cyclic]
    const out = cleanStrings(cyclic) as Record<string, unknown>
    expect(out.name).toBe('ab')
    expect(out.self).toBe(out)
    expect((out.list as unknown[])[0]).toBe(out)
    expect(cyclic.name).toBe('a\u0000b')
  })

  it('returns a scalar at the top level, cleaned if it is a string', () => {
    expect(cleanStrings('a\u0000b')).toBe('ab')
    expect(cleanStrings(7)).toBe(7)
    expect(cleanStrings(null)).toBeNull()
    expect(cleanStrings(true)).toBe(true)
    expect(cleanStrings(undefined)).toBeUndefined()
  })

  it('produces a value Postgres JSONB would accept', () => {
    const dirty = { name: 'Driver\u0000One', note: '\uD83D broken' }
    expect(JSON.stringify(cleanStrings(dirty))).not.toMatch(/\\u0000|\\ud8/i)
  })
})
