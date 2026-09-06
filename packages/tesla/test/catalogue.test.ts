import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SAMPLE_COLUMNS } from '@ev/core'
import {
  API_FIELD_RULES,
  COLLAPSED_COLUMNS,
  CONVERTERS,
  EXCLUDED_FIELDS,
  TESLA_FIELDS,
  TIER_INTERVAL_SECONDS,
  WITHHELD_FIELDS,
  WITHHELD_NAMES,
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

/**
 * The withheld block is the one place the catalogue and the pushed config
 * disagree, so it gets the same by-name treatment as an exclusion: it may only
 * name real proto members, it may only name fields we DO still catalogue (the
 * column and the decoder stay), and it may never overlap the exclusions, which
 * mean the opposite thing - we never want those at all.
 */
describe('withheld fields', () => {
  it('names only real proto members', () => {
    const members = new Set(PROTO_FIELDS)
    expect(WITHHELD_NAMES.filter((f) => !members.has(f))).toEqual([])
  })

  it('names only fields the catalogue still captures', () => {
    const catalogued = new Set(CATALOGUED_NAMES)
    expect(WITHHELD_NAMES.filter((f) => !catalogued.has(f))).toEqual([])
  })

  it('never names something already excluded outright', () => {
    const excluded = new Set(EXCLUDED_NAMES)
    expect(WITHHELD_NAMES.filter((f) => excluded.has(f))).toEqual([])
  })

  it('holds back 12 names in two groups, each with a reason', () => {
    expect(WITHHELD_NAMES).toHaveLength(12)
    expect(new Set(WITHHELD_NAMES).size).toBe(12)
    for (const group of WITHHELD_FIELDS) {
      expect(group.fields.length, group.reason).toBeGreaterThan(0)
      expect(group.reason.length).toBeGreaterThan(20)
    }
  })

  /**
   * The reason this is a test and not a comment. The proto's own availability
   * comment is the boundary the API lags behind, so the withheld set must be
   * exactly the members declared after it - no more (we would be dropping
   * signals the API accepts) and no fewer (one unknown name 400s everything).
   */
  it('is exactly the members the proto gates behind device client 1.3.0', () => {
    const src = readFileSync(
      new URL('../protos/vehicle_data.proto', import.meta.url), 'utf8')
    // Within `enum Field` only: the same availability comment style appears
    // nowhere else, but the enums that follow would otherwise be swept in.
    const block = /enum Field \{([\s\S]*?)\n\}/.exec(src)![1]!
    const tail = block.slice(block.indexOf('device client version 1.3.0'))
    const gated = [...tail.matchAll(/^\s+([A-Za-z_0-9]+)\s*=\s*\d+;/gm)].map((m) => m[1]!)
    expect(gated.length).toBeGreaterThan(0)
    expect([...WITHHELD_FIELDS[0]!.fields].sort()).toEqual([...gated].sort())
  })
})

/**
 * The rules are the SECOND source this catalogue answers to. The proto says
 * what exists; Tesla's field reference says what the API will accept, and the
 * two disagree in ways only a rejected push revealed. Keeping the rules honest
 * matters as much as keeping the field names honest.
 */
/**
 * Tesla's published field table, vendored at `reference/tesla-available-data.json`
 * and refreshed by `scripts/fetch-tesla-fields.mjs`.
 *
 * This is the SECOND authority the catalogue answers to, and the more important
 * one for the push: the proto says what a signal is named, this says what the
 * API will accept. Read separately from the catalogue, like the proto is, for
 * the same reason - a drift test that derives both sides from one source
 * detects nothing.
 */
const DOCUMENTED: readonly { field: string; type: string; description: string }[] =
  JSON.parse(readFileSync(
    new URL('../reference/tesla-available-data.json', import.meta.url), 'utf8')).fields

const DOCUMENTED_NAMES = new Set(DOCUMENTED.map((f) => f.field))

describe("Tesla's published field table", () => {
  it('is vendored whole, not truncated', () => {
    expect(DOCUMENTED.length).toBeGreaterThan(200)
    expect(new Set(DOCUMENTED.map((f) => f.field)).size).toBe(DOCUMENTED.length)
  })

  /**
   * THE TEST THAT WOULD HAVE PREVENTED BOTH 400s. Everything we ask the car for
   * must be a name Tesla publishes, because a name it does not publish is a name
   * the API has refused every time we have tried one - and it fails the whole
   * configuration, not the field.
   */
  it('documents every field we push', () => {
    const withheld = new Set<string>(WITHHELD_NAMES)
    const asked = CATALOGUED_NAMES.filter((f) => !withheld.has(f))
    expect(asked.filter((f) => !DOCUMENTED_NAMES.has(f))).toEqual([])
  })

  /**
   * The other direction, and the reason the withheld list is not just a
   * denylist that grows forever: a withheld field that Tesla has since
   * published is one the API has probably started accepting, and this failing
   * is the prompt to try it again rather than leave a signal unasked-for.
   */
  it('does not yet document anything we withhold', () => {
    const nowDocumented = WITHHELD_NAMES.filter((f) => DOCUMENTED_NAMES.has(f))
    expect(nowDocumented, 'withheld but now documented: try re-enabling these')
      .toEqual([])
  })

  /**
   * The correspondence the withheld decision rests on: every proto member the
   * table omits is either a placeholder we exclude outright or a name we
   * withhold. If a real signal ever falls outside both, the assumption that
   * "undocumented means refused" needs re-checking before the next push.
   */
  it('omits nothing except placeholders we exclude and names we withhold', () => {
    const accountedFor = new Set([...EXCLUDED_NAMES, ...WITHHELD_NAMES])
    const undocumented = PROTO_FIELDS.filter((f) => !DOCUMENTED_NAMES.has(f))
    expect(undocumented.filter((f) => !accountedFor.has(f))).toEqual([])
  })
})

/**
 * WHAT TYPE THE CAR ACTUALLY SENDS, checked against the column we put it in.
 *
 * §3.4 of the spec says the types are OUR determination, because the MQTT
 * transport unwraps the protobuf `oneof` and the proto therefore gives no
 * field->type mapping. That was true when it was written; it is not true any
 * more. Tesla's field table types every signal, so the determination can be
 * checked instead of asserted - and a column that cannot hold what the car
 * sends is a value silently dropped at insert, which nothing else here detects.
 */
const SQL_FOR_DOC_TYPE: Record<string, readonly string[]> = {
  real: ['REAL', 'DOUBLE PRECISION'],
  integer: ['INT', 'INTEGER', 'BIGINT', 'REAL', 'DOUBLE PRECISION'],
  boolean: ['BOOLEAN'],
  enum: ['TEXT'],
  string: ['TEXT'],
  // Every time-shaped column is parked at TEXT until the wire shape is seen
  // (§3.4), and the doc now says why that was right: "Timestamp fields report
  // incorrectly. Treating the reported value as Pacific Time will yield the
  // date and time in the vehicle's timezone."
  timestamp: ['TEXT', 'TIMESTAMPTZ', 'TIME'],
  // The proto's `Time` is a wall clock - {hour, minute, second}, no date and no
  // zone - so a TEXT column is the honest home for one until the wire shape is
  // seen (§3.4).
  time: ['TEXT', 'TIME'],
  Location: ['DOUBLE PRECISION'],
}

/**
 * Columns that deliberately do not match the documented type, and why.
 *
 * Each is a decision, not an accident, which is the only reason it is allowed
 * to differ - and naming them here means a SIXTH deviation appearing is a test
 * failure rather than a silent drop.
 */
const SANCTIONED_TYPE_DEVIATIONS: Record<string, string> = {
  // TEXT is a superset of the boolean the doc promises: it takes `true` and it
  // takes whatever enum the car turns out to send. Promoting these is a
  // migration, worth doing once real values have been seen.
  DriveRail: 'shape unobserved; TEXT takes either a flag or an enum',
  BrakePedal: 'shape unobserved; TEXT takes either a flag or a position',
  GpsState: 'shape unobserved; TEXT takes either a flag or an enum',
  DriverSeatBelt: 'BuckleStatus or bool; TEXT takes either',
  // The legacy `doors_open` column predates the full signal set and answers a
  // narrower question than the signal carries: `anyDoorOpen` collapses the
  // per-door record to "is any door open". Which doors is discarded on purpose.
  DoorState: 'collapsed to a boolean by anyDoorOpen; the legacy column asks only "any"',
  // Catalogued as "level or state name" when nobody knew which. The doc says
  // integer, and `text()` stores a number as its digits, so nothing is lost -
  // but the column is wider than it needs to be until a migration narrows it.
  HvacFanStatus: 'catalogued before the shape was known; doc says integer, TEXT holds the digits',
}

describe('the values we store', () => {
  it('puts every signal in a column that can hold what the doc says it is', () => {
    const withheld = new Set<string>(WITHHELD_NAMES)
    const problems: string[] = []
    for (const entry of TESLA_FIELDS) {
      if (withheld.has(entry.field)) continue
      if (entry.field in SANCTIONED_TYPE_DEVIATIONS) continue
      const documented = DOCUMENTED.find((f) => f.field === entry.field)
      if (!documented) continue
      const allowed = SQL_FOR_DOC_TYPE[documented.type]
      if (!allowed) { problems.push(`${entry.field}: undocumented doc type ${documented.type}`); continue }
      for (const column of columnsOf(entry)) {
        const sql = COLUMN_SQL.get(column)
        // The four TPMS corners are numbers on the wire and JSONB only after
        // they collapse into one record, which `delta` already relies on.
        if (!sql || column === 'tpms') continue
        if (!allowed.includes(sql)) {
          problems.push(`${entry.field}: doc says ${documented.type}, ${column} is ${sql}`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  it('states a reason for every sanctioned deviation, and sanctions no more', () => {
    for (const [field, why] of Object.entries(SANCTIONED_TYPE_DEVIATIONS)) {
      expect(why.length, field).toBeGreaterThan(20)
      expect(CATALOGUED_NAMES, field).toContain(field)
    }
    expect(Object.keys(SANCTIONED_TYPE_DEVIATIONS)).toHaveLength(6)
  })

  /**
   * §2: a column claiming km or kph is a LIE unless something converts, because
   * Tesla streams miles and mph whatever the touchscreen shows. That was an
   * assertion about the wire; the doc now lets it be checked from the other
   * end - if the description says miles, the entry must convert.
   */
  it('converts every field the doc describes in miles or mph', () => {
    const withheld = new Set<string>(WITHHELD_NAMES)
    for (const entry of TESLA_FIELDS) {
      if (withheld.has(entry.field)) continue
      const documented = DOCUMENTED.find((f) => f.field === entry.field)
      if (!documented) continue
      const mph = /\bmph\b|miles per hour/i.test(documented.description)
      const miles = !mph && /\bmiles\b/i.test(documented.description)
      if (!mph && !miles) continue
      expect(`${entry.field}=${entry.convert}`)
        .toBe(`${entry.field}=${mph ? 'mphToKph' : 'milesToKm'}`)
    }
  })

  /**
   * The display-unit settings are exactly that - what the touchscreen shows -
   * so they must never be read as saying what is on the wire. Capturing them is
   * what makes the miles-always assumption checkable against real data later.
   */
  it('captures the display-unit settings without converting them', () => {
    for (const name of ['SettingDistanceUnit', 'SettingChargeUnit', 'SettingTemperatureUnit']) {
      const entry = TESLA_FIELDS.find((e) => e.field === name)
      expect(entry?.convert, name).toBeNull()
    }
  })
})

describe('the Fleet API field rules', () => {
  it('names only real proto members', () => {
    const members = new Set(PROTO_FIELDS)
    expect(API_FIELD_RULES.map((r) => r.field).filter((f) => !members.has(f))).toEqual([])
  })

  it('names each field at most once', () => {
    const names = API_FIELD_RULES.map((r) => r.field)
    expect(new Set(names).size).toBe(names.length)
  })

  it('states a non-negative minimum and quotes its source', () => {
    for (const rule of API_FIELD_RULES) {
      expect(Number.isFinite(rule.minimumDelta) && rule.minimumDelta >= 0, rule.field).toBe(true)
      expect(rule.source.length, rule.field).toBeGreaterThan(20)
    }
  })

  /**
   * A mandatory rule on a field we capture must be satisfied by the CATALOGUE,
   * not merely by the builder: the builder throwing is the last line, and a
   * catalogue that can only be built by luck is one edit from a failed push.
   */
  it('is satisfied by every catalogued field it binds', () => {
    for (const rule of API_FIELD_RULES) {
      if (rule.minimumDelta === 0) continue
      const entry = TESLA_FIELDS.find((e) => e.field === rule.field)
      if (!entry) continue
      expect(`${rule.field}=${(entry.delta ?? 0) >= rule.minimumDelta}`)
        .toBe(`${rule.field}=true`)
    }
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
