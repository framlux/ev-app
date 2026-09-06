import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TESLA_ENUM_PREFIXES, teslaEnumLabel } from '../src/enum-labels.js'

/**
 * The prefixes, recomputed from the vendored proto exactly as they were
 * derived, and compared against the committed list.
 *
 * Derived separately here for the same reason `catalogue.test.ts` parses the
 * proto rather than importing a generated enum: a drift test that reads one
 * source detects no drift. A proto update that adds an enum, or renames a
 * value, fails HERE - rather than shipping a tile that quietly keeps a 35
 * character prefix nobody reads.
 */
const PROTO = readFileSync(
  new URL('../protos/vehicle_data.proto', import.meta.url), 'utf8')

const ENUMS: readonly { name: string; values: string[] }[] =
  [...PROTO.matchAll(/^enum (\w+) \{([\s\S]*?)\n\}/gm)]
    .filter((m) => m[1] !== 'Field')
    .map((m) => ({
      name: m[1]!,
      values: [...m[2]!.matchAll(/^\s+(\w+)\s*=\s*\d+;/gm)].map((v) => v[1]!),
    }))

function longestCommonPrefix(values: readonly string[]): string {
  const first = [...values].sort()[0]!
  const last = [...values].sort()[values.length - 1]!
  let i = 0
  while (i < first.length && i < last.length && first[i] === last[i]) i += 1
  return first.slice(0, i)
}

function derivePrefix(values: readonly string[]): string {
  let prefix = longestCommonPrefix(values)
  // Cut back to a capital boundary: a prefix must never eat into a word, or
  // `Off` becomes `ff` and nothing downstream can tell.
  while (prefix !== '' &&
    !values.every((v) => v.length > prefix.length && /[A-Z]/.test(v[prefix.length]!))) {
    prefix = prefix.slice(0, -1)
  }
  return prefix
}

describe('the enum prefixes', () => {
  it('finds enums to check, so a passing run means something', () => {
    expect(ENUMS.length).toBeGreaterThan(30)
  })

  it('is exactly what the vendored proto yields', () => {
    const derived = new Set<string>()
    for (const e of ENUMS) {
      if (e.values.length < 2) continue
      const p = derivePrefix(e.values)
      if (p !== '') derived.add(p)
    }
    expect([...TESLA_ENUM_PREFIXES].sort()).toEqual([...derived].sort())
  })

  /**
   * The property that matters more than the list: every value in the proto
   * must come out SHORTER and non-empty. A prefix one character too long
   * silently truncates a real value, and this is what would catch it.
   */
  it('shortens every proto enum value without emptying one', () => {
    for (const e of ENUMS) {
      for (const value of e.values) {
        const label = teslaEnumLabel(value)
        expect(label.trim(), `${e.name}.${value}`).not.toBe('')
        expect(label.length, `${e.name}.${value}`).toBeLessThanOrEqual(value.length)
      }
    }
  })
})

describe('the labels themselves', () => {
  it('drops the type name from the values that were overflowing the tiles', () => {
    expect(teslaEnumLabel('HvacPowerStateOff')).toBe('Off')
    expect(teslaEnumLabel('SentryModeStateOff')).toBe('Off')
    expect(teslaEnumLabel('CabinOverheatProtectionModeStateOff')).toBe('Off')
  })

  it('reads a multi-word value as words', () => {
    expect(teslaEnumLabel('HvacPowerStateOverheatProtect')).toBe('Overheat protect')
    expect(teslaEnumLabel('CabinOverheatProtectionModeStateFanOnly')).toBe('Fan only')
    expect(teslaEnumLabel('SentryModeStateArmed')).toBe('Armed')
  })

  it('leaves an acronym as an acronym', () => {
    expect(teslaEnumLabel('BMSStateSNA')).toBe('SNA')
  })

  /**
   * The safety property. An enum this list does not know - a proto that moved
   * on, a value from a vehicle we have never seen - is shown EXACTLY as the car
   * sent it. Long and honest beats short and wrong: a mangled value would be
   * indistinguishable from a real one, which is the failure `format.ts` refuses
   * to risk and this must not reintroduce.
   */
  it('returns anything it does not recognise unchanged', () => {
    expect(teslaEnumLabel('ACSingleWireCAN')).toBe('ACSingleWireCAN')
    expect(teslaEnumLabel('SomethingTeslaAddedYesterday'))
      .toBe('SomethingTeslaAddedYesterday')
    expect(teslaEnumLabel('')).toBe('')
  })
})

/**
 * `formatText` sends EVERY text column through this - vehicle names,
 * destination names, software versions - not just the enum ones. A prefix that
 * matches free text would rename something a person chose, which is exactly the
 * invention this whole approach claims not to do.
 */
describe('free text is not an enum', () => {
  it('leaves anything containing whitespace alone', () => {
    // `Follow` is a real prefix (FollowDistance), so this is the case that
    // motivated the guard rather than a hypothetical one.
    expect(teslaEnumLabel('Followers Cafe')).toBe('Followers Cafe')
    expect(teslaEnumLabel('Charge Point Reading')).toBe('Charge Point Reading')
    expect(teslaEnumLabel("Mum's house")).toBe("Mum's house")
  })

  it('leaves a name that merely starts with the same letters alone', () => {
    // Lowercase after the prefix: a proto value always continues with a capital.
    expect(teslaEnumLabel('Followers')).toBe('Followers')
    expect(teslaEnumLabel('CarTypeface')).toBe('CarTypeface')
  })

  it('still labels the real enum values', () => {
    expect(teslaEnumLabel('SentryModeStateArmed')).toBe('Armed')
    expect(teslaEnumLabel('CarTypeModelY')).toBe('Model Y')
  })
})
