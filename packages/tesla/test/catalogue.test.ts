import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SAMPLE_COLUMNS } from '@ev/core'
import {
  COLLAPSED_COLUMNS,
  CONVERTERS,
  EXCLUDED_FIELDS,
  TESLA_FIELDS,
  TIER_INTERVAL_SECONDS,
  columnsOf,
  projectMonthlySignals,
  slotsOf,
  type Tier,
} from '../src/catalogue.js'

/**
 * The vendored proto, parsed independently of the catalogue.
 *
 * Reading the file rather than importing a generated enum is the point: this is
 * the drift test, and it only detects drift if the two sides are derived
 * separately. A proto update that adds a signal changes this list and nothing
 * else, which is what turns "a new signal exists" into a failing build.
 */
const PROTO_FIELDS: readonly string[] = (() => {
  const src = readFileSync(new URL('../protos/vehicle_data.proto', import.meta.url), 'utf8')
  const block = /enum Field \{([\s\S]*?)\n\}/.exec(src)
  if (!block) throw new Error('no `enum Field` in the vendored proto')
  return [...block[1]!.matchAll(/^\s+([A-Za-z_0-9]+)\s*=\s*\d+;/gm)].map((m) => m[1]!)
})()

const EXCLUDED_NAMES = EXCLUDED_FIELDS.flatMap((g) => g.fields)
const CATALOGUED_NAMES = TESLA_FIELDS.map((e) => e.field)
const COLUMN_SQL = new Map(SAMPLE_COLUMNS.map((c) => [c.column, c.sql]))

describe('the vendored proto', () => {
  // §3.2. These are the numbers the whole design is sized against; if the proto
  // disagrees, the proto is right and the spec is stale.
  it('has 270 Field members', () => {
    expect(PROTO_FIELDS).toHaveLength(270)
  })

  it('has no duplicate member names', () => {
    expect(new Set(PROTO_FIELDS).size).toBe(PROTO_FIELDS.length)
  })
})

describe('TESLA_FIELDS', () => {
  // §4: the car silently ignores a config entry it does not recognise, so a
  // misspelled field name is one signal that never arrives, with no error
  // anywhere. This is the only place that catches it.
  it('names only real proto members', () => {
    const members = new Set(PROTO_FIELDS)
    expect(CATALOGUED_NAMES.filter((f) => !members.has(f))).toEqual([])
  })

  it('names each proto member at most once', () => {
    expect(new Set(CATALOGUED_NAMES).size).toBe(CATALOGUED_NAMES.length)
  })

  it('captures 204 signals', () => {
    expect(TESLA_FIELDS).toHaveLength(204)
  })

  it('fills every accumulator slot from exactly one field', () => {
    const slots = TESLA_FIELDS.flatMap(slotsOf)
    expect(new Set(slots).size).toBe(slots.length)
  })

  // Several Tesla fields collapse into one canonical column (both charging
  // rails, both charge-state enums, the four TPMS corners). That is allowed,
  // but only where it is declared: an undeclared duplicate means two signals
  // are silently overwriting each other in the same column.
  it('writes one column per field except where a collapse is declared', () => {
    const counts = new Map<string, number>()
    for (const c of TESLA_FIELDS.flatMap(columnsOf)) {
      counts.set(c, (counts.get(c) ?? 0) + 1)
    }
    const shared = [...counts].filter(([, n]) => n > 1).map(([c]) => c).sort()
    expect(shared).toEqual(Object.keys(COLLAPSED_COLUMNS).sort())
  })

  it('declares a reason for every collapsed column', () => {
    for (const [column, why] of Object.entries(COLLAPSED_COLUMNS)) {
      expect(why.length, `${column} has no reason`).toBeGreaterThan(20)
    }
  })
})

describe('exclusions', () => {
  it('names only real proto members', () => {
    const members = new Set(PROTO_FIELDS)
    expect(EXCLUDED_NAMES.filter((f) => !members.has(f))).toEqual([])
  })

  it('excludes 66 members across four groups with a reason each', () => {
    expect(EXCLUDED_NAMES).toHaveLength(66)
    expect(new Set(EXCLUDED_NAMES).size).toBe(66)
    for (const group of EXCLUDED_FIELDS) {
      expect(group.fields.length, group.reason).toBeGreaterThan(0)
      expect(group.reason.length).toBeGreaterThan(20)
    }
  })

  it('never excludes a field that is also catalogued', () => {
    const catalogued = new Set(CATALOGUED_NAMES)
    expect(EXCLUDED_NAMES.filter((f) => catalogued.has(f))).toEqual([])
  })

  /**
   * The reason this file exists. A proto update that adds a signal lands here
   * as a failure, and someone has to decide about it, rather than the signal
   * being quietly unasked-for and a year of it lost.
   */
  it('accounts for every proto member', () => {
    const accounted = new Set([...CATALOGUED_NAMES, ...EXCLUDED_NAMES])
    expect(PROTO_FIELDS.filter((f) => !accounted.has(f))).toEqual([])
  })
})

describe('columns', () => {
  it('names a column that exists in the core catalogue', () => {
    const known = new Set(SAMPLE_COLUMNS.map((c) => c.column))
    const missing = TESLA_FIELDS
      .flatMap((e) => columnsOf(e).map((c) => [e.field, c] as const))
      .filter(([, c]) => !known.has(c))
    expect(missing).toEqual([])
  })

  // The other direction, which is the one that catches a column nobody fills.
  // `power_state` is the sanctioned exception: it comes from connectivity
  // messages, which are not metrics and have no Field member.
  it('fills every core column except the one no metric can fill', () => {
    const filled = new Set(TESLA_FIELDS.flatMap(columnsOf))
    const unfilled = SAMPLE_COLUMNS.map((c) => c.column).filter((c) => !filled.has(c))
    expect(unfilled).toEqual(['power_state'])
  })
})

describe('convert', () => {
  it('names a real converter', () => {
    for (const e of TESLA_FIELDS) {
      if (e.convert === null) continue
      expect(CONVERTERS, e.field).toContain(e.convert)
    }
  })

  /**
   * §2: converted columns carry the real unit in the name. Read the other way
   * round, a column claiming km or kph that is not converted is a lie about
   * what is stored — Tesla streams miles and mph whatever the touchscreen says.
   */
  it('converts exactly the columns whose names claim metric units', () => {
    for (const e of TESLA_FIELDS) {
      const tokens = columnsOf(e).flatMap((c) => c.split('_'))
      if (tokens.includes('km')) expect(e.convert, e.field).toBe('milesToKm')
      else if (tokens.includes('kph')) expect(e.convert, e.field).toBe('mphToKph')
      else expect(e.convert, e.field).not.toBe('milesToKm')
    }
  })

  it('lands each converter on a column its output can bind to', () => {
    const numeric = new Set(['REAL', 'DOUBLE PRECISION'])
    for (const e of TESLA_FIELDS) {
      if (e.convert === null) continue
      const want = e.convert === 'epochSecondsToDate' ? 'TIMESTAMPTZ' : numeric
      for (const c of columnsOf(e)) {
        const sql = COLUMN_SQL.get(c)!
        expect(typeof want === 'string' ? sql === want : want.has(sql), `${e.field} -> ${c}`)
          .toBe(true)
      }
    }
  })
})

describe('delta', () => {
  it('is a positive finite number when set', () => {
    for (const e of TESLA_FIELDS) {
      if (e.delta === null) continue
      expect(Number.isFinite(e.delta) && e.delta > 0, e.field).toBe(true)
    }
  })

  /**
   * `minimum_delta` is arithmetic the car does on the value it is about to
   * send, so it is only meaningful for a numeric payload. On an enum or a
   * boolean the car would either ignore it or, worse, suppress a real
   * transition. The TPMS corners are the exception that proves it: numbers on
   * the wire, JSONB only after the four collapse into one record.
   */
  it('is set only on fields that are numbers on the wire', () => {
    for (const e of TESLA_FIELDS) {
      if (e.delta === null) continue
      for (const c of columnsOf(e)) {
        const sql = COLUMN_SQL.get(c)!
        const numericOnTheWire = sql === 'REAL' || sql === 'DOUBLE PRECISION' || c === 'tpms'
        expect(numericOnTheWire, `${e.field} -> ${c} (${sql})`).toBe(true)
      }
    }
  })

  // §3.5 names these as the fields the 24h-awake row is actually made of.
  it('covers the continuously-varying fields the budget depends on', () => {
    const needed = [
      'PackVoltage', 'PackCurrent', 'ChargerVoltage', 'Soc', 'EnergyRemaining',
      'ACChargingEnergyIn', 'DCChargingEnergyIn', 'InsideTemp', 'OutsideTemp',
      'Location',
    ]
    for (const name of needed) {
      const entry = TESLA_FIELDS.find((e) => e.field === name)
      expect(entry?.delta, name).not.toBeNull()
    }
  })
})

describe('tiers', () => {
  it('splits 204 signals the way §3.5 sizes the budget on', () => {
    const counts: Record<Tier, number> = { drive: 0, charge: 0, status: 0, static: 0 }
    for (const e of TESLA_FIELDS) counts[e.tier] += 1
    expect(counts).toEqual({ drive: 20, charge: 27, status: 60, static: 97 })
  })

  it('puts the pack rails on the charge tier, not the drive tier', () => {
    for (const name of ['PackVoltage', 'PackCurrent']) {
      expect(TESLA_FIELDS.find((e) => e.field === name)?.tier, name).toBe('charge')
    }
  })
})

/**
 * §5's budget test. The point is not the exact arithmetic — it is that adding
 * twenty drive-tier signals fails the build rather than the bill.
 */
describe('the signal budget', () => {
  it('reproduces the §3.5 table', () => {
    expect(TIER_INTERVAL_SECONDS).toEqual({ drive: 10, charge: 60, status: 300, static: 3600 })
    expect(projectMonthlySignals(6)).toEqual({
      drive: 324_000, charge: 291_600, status: 129_600, static: 17_460, total: 762_660,
    })
    expect(projectMonthlySignals(12).total).toBe(1_201_320)
    expect(projectMonthlySignals(24).total).toBe(2_078_640)
  })

  it('stays under the 1.2M alert threshold at six awake hours a day', () => {
    expect(projectMonthlySignals(6).total).toBeLessThanOrEqual(1_200_000)
  })
})
