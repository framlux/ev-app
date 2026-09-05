import { describe, expect, it } from 'vitest'
import { SAMPLE_COLUMNS, TS_TYPES_FOR_SQL, type RawMessage, type SqlType } from '@ev/core'
import { TESLA_FIELDS, columnsOf, slotsOf, type TeslaField } from '../src/catalogue.js'
import {
  MILES_TO_KM,
  SQL_DECODERS,
  TESLA_OVERRIDDEN_FIELDS,
  VALUE_CONVERTERS,
  decodeTeslaConnectivity,
  decodeTeslaField,
  isKnownTeslaField,
  normaliseTeslaConnectivity,
  teslaStateToSample,
  type TeslaFieldUpdate,
} from '../src/normalise.js'

/**
 * Every fixture here is a payload as fleet-telemetry's MQTT datastore actually
 * publishes it: the JSON-encoded VALUE ALONE, one field per message, with the
 * field name coming from the topic and no timestamp anywhere. The wrapper
 * objects (`{doubleValue: 72}`, `{invalid: true}`) that the previous version of
 * these tests asserted on belong to the protobuf/Kafka transport and never
 * arrive on MQTT - a test built on them passes while production maps nothing.
 */

const TS = new Date('2026-09-04T10:00:00.000Z')
const VEHICLE = 'veh-1'

/** Decode a field and build the sample it would contribute to on its own. */
function sampleOf(state: TeslaFieldUpdate) {
  return teslaStateToSample(VEHICLE, TS, state)
}

function decoded(field: string, value: unknown): TeslaFieldUpdate {
  const update = decodeTeslaField(field, value)
  if (!update) throw new Error(`expected ${field} to decode ${JSON.stringify(value)}`)
  return update
}

describe('decodeTeslaField: numbers', () => {
  it('reads a bare JSON number', () => {
    expect(decoded('Soc', 72.5)).toEqual({ socPct: 72.5 })
    expect(decoded('InsideTemp', -3)).toEqual({ insideTempC: -3 })
  })

  it('reads a number that arrived as a string', () => {
    // Upstream warns the JSON type of a field changes between vehicle software
    // versions: speed can be 12.3 in one build and "12.3" in the next.
    expect(decoded('Soc', '72.5')).toEqual({ socPct: 72.5 })
    expect(decoded('Soc', ' 72.5 ')).toEqual({ socPct: 72.5 })
  })

  it.each([
    ['null (Value_Invalid)', null],
    ['empty string', ''],
    ['blank string', '   '],
    ['non-numeric string', 'abc'],
    ['NaN as a string', 'NaN'],
    ['Infinity as a string', 'Infinity'],
    ['a boolean', true],
    ['an object', { doubleValue: 72 }],
    ['an array', [72]],
  ])('refuses to invent a number from %s', (_label, value) => {
    // Number('') is 0 and Number(false) is 0. A 0 that means "unreadable" is
    // indistinguishable downstream from a car parked at 0 kph drawing 0 kW.
    expect(decodeTeslaField('Soc', value)).toBeNull()
    expect(decodeTeslaField('VehicleSpeed', value)).toBeNull()
  })
})

describe('decodeTeslaField: units', () => {
  it('converts miles and mph to km and kph', () => {
    expect(decoded('VehicleSpeed', 40)['speedKph']).toBeCloseTo(40 * MILES_TO_KM, 9)
    expect(decoded('Odometer', 1000)['odometerKm']).toBeCloseTo(1609.344, 6)
    expect(decoded('RatedRange', 200)['rangeKm']).toBeCloseTo(321.8688, 6)
  })

  it('passes through the fields that already arrive in our units', () => {
    expect(decoded('OutsideTemp', 18.5)).toEqual({ outsideTempC: 18.5 })
    expect(decoded('ACChargingEnergyIn', 12.25)).toEqual({ acEnergyKwh: 12.25 })
  })

  it('uses the exact international mile', () => {
    // 1.6 or the survey mile would skew every distance, efficiency and capacity
    // figure by an amount small enough to look plausible.
    expect(MILES_TO_KM).toBe(1.609344)
  })
})

describe('decodeTeslaField: unknown fields', () => {
  it('ignores a field it has no home for', () => {
    // Tesla ships new fields without warning, and one we have not catalogued
    // must never become a guess. The catalogue test is what makes this a
    // decision rather than an oversight: a proto member that is neither
    // catalogued nor excluded by name fails the build.
    expect(decodeTeslaField('SomethingShippedNextTuesday', 1)).toBeNull()
    expect(isKnownTeslaField('Soc')).toBe(true)
    expect(isKnownTeslaField('SomethingShippedNextTuesday')).toBe(false)
  })

  it('now places Gear and ChargeAmps, which were billed for and discarded', () => {
    // THE CHANGE THIS WORK EXISTS FOR. Both have been streamed since day one
    // and thrown away because there was nowhere to put them; they have columns
    // now, and the tape can be reprocessed to backfill them.
    expect(decoded('Gear', 'ShiftStateD')).toEqual({ gear: 'ShiftStateD' })
    expect(decoded('ChargeAmps', 32)).toEqual({ chargeAmps: 32 })
    expect(isKnownTeslaField('Gear')).toBe(true)
  })
})

describe('decodeTeslaField: Location', () => {
  it('takes latitude and longitude together', () => {
    expect(decoded('Location', { latitude: 52.2, longitude: 0.13 }))
      .toEqual({ lat: 52.2, lon: 0.13 })
  })

  it('takes neither when only one is readable', () => {
    // Half a fix is worse than none, because it plots - on the prime meridian.
    expect(decodeTeslaField('Location', { latitude: 52.2 })).toBeNull()
    expect(decodeTeslaField('Location', { latitude: 52.2, longitude: null })).toBeNull()
    expect(decodeTeslaField('Location', { latitude: 52.2, longitude: '' })).toBeNull()
    expect(decodeTeslaField('Location', null)).toBeNull()
  })
})

describe('decodeTeslaField: enums', () => {
  it.each([
    ['Charging', 'charging'],
    ['ChargeStateCharging', 'charging'],
    ['Complete', 'complete'],
    ['ChargeStateStopped', 'stopped'],
    ['Disconnected', 'disconnected'],
    ['ChargeStateNoPower', 'connected'],
    ['Starting', 'connected'],
  ])('maps ChargeState %s', (wire, expected) => {
    expect(decoded('ChargeState', wire)).toEqual({ chargeStateBasic: expected })
  })

  it('maps the detailed enum with its own prefix', () => {
    expect(decoded('DetailedChargeState', 'DetailedChargeStateCharging'))
      .toEqual({ chargeStateDetailed: 'charging' })
  })

  it.each([null, '', 'ChargeStateSomethingNew', 'charging', 42])(
    'refuses to guess a charge state from %s', (wire) => {
      // A guessed charge state fabricates or truncates charge sessions, and the
      // derived tables keep no record that the value was a guess.
      expect(decodeTeslaField('ChargeState', wire)).toBeNull()
      expect(decodeTeslaField('DetailedChargeState', wire)).toBeNull()
    })

  it('prefers the detailed enum when both are known', () => {
    const sample = sampleOf({ chargeStateBasic: 'connected', chargeStateDetailed: 'charging' })
    expect(sample.chargeState).toBe('charging')
    expect(sampleOf({ chargeStateBasic: 'connected' }).chargeState).toBe('connected')
  })
})

describe('decodeTeslaField: booleans and doors', () => {
  it('reads Locked as a boolean or as a stringified boolean', () => {
    expect(decoded('Locked', true)).toEqual({ locked: true })
    expect(decoded('Locked', 'false')).toEqual({ locked: false })
    expect(decodeTeslaField('Locked', 'maybe')).toBeNull()
    expect(decodeTeslaField('Locked', 1)).toBeNull()
  })

  it('reports a door open only when a door actually said so', () => {
    expect(decoded('DoorState', { DriverFront: false, PassengerFront: true }))
      .toEqual({ doorsOpen: true })
    expect(decoded('DoorState', { DriverFront: false })).toEqual({ doorsOpen: false })
    // Nothing readable is not "all doors shut": false would show a car we know
    // nothing about as secure.
    expect(decodeTeslaField('DoorState', {})).toBeNull()
    expect(decodeTeslaField('DoorState', null)).toBeNull()
  })
})

describe('teslaStateToSample: absent stays null', () => {
  it('never turns a field that was never reported into 0', () => {
    const sample = sampleOf({ socPct: 72 })
    expect(sample.socPct).toBe(72)
    expect(sample.speedKph).toBeNull()
    expect(sample.odometerKm).toBeNull()
    expect(sample.chargePowerKw).toBeNull()
    expect(sample.chargeEnergyAddedKwh).toBeNull()
    expect(sample.chargeState).toBeNull()
    expect(sample.locked).toBeNull()
    expect(sample.tpms).toBeNull()
    expect(sample.lat).toBeNull()
  })

  it('keeps a genuine zero', () => {
    expect(sampleOf({ speedKph: 0 }).speedKph).toBe(0)
  })
})

describe('teslaStateToSample: TPMS', () => {
  it('collapses the corners that are known into one record', () => {
    expect(sampleOf({ tpmsFl: 2.8, tpmsRr: 2.7 }).tpms).toEqual({ fl: 2.8, rr: 2.7 })
    expect(sampleOf({ tpmsFl: 2.8, tpmsFr: 2.9, tpmsRl: 2.7, tpmsRr: 2.75 }).tpms)
      .toEqual({ fl: 2.8, fr: 2.9, rl: 2.7, rr: 2.75 })
  })

  it('leaves tpms null when no corner is known', () => {
    expect(sampleOf({ socPct: 50 }).tpms).toBeNull()
  })
})

describe('teslaStateToSample: charging power', () => {
  it('takes the rail with the greater magnitude', () => {
    // The inactive rail reads 0 for POWER, so magnitude picks the live one.
    expect(sampleOf({ acPowerKw: 0, dcPowerKw: 50 }).chargePowerKw).toBe(50)
    expect(sampleOf({ acPowerKw: 7.4, dcPowerKw: 0 }).chargePowerKw).toBe(7.4)
  })

  it('keeps a single readable rail and a genuine zero', () => {
    expect(sampleOf({ acPowerKw: 7.4 }).chargePowerKw).toBe(7.4)
    expect(sampleOf({ acPowerKw: 0, dcPowerKw: 0 }).chargePowerKw).toBe(0)
  })

  it('stays null when neither rail was readable', () => {
    // A 0 here reads downstream as "charger delivering nothing", which ends a
    // charge session that is in fact still running.
    expect(sampleOf({ socPct: 40 }).chargePowerKw).toBeNull()
  })
})

describe('teslaStateToSample: charging energy', () => {
  it('follows the active rail, not the larger counter', () => {
    // THE BUG THIS TEST EXISTS FOR. The energy fields are CUMULATIVE COUNTERS:
    // the idle rail retains an earlier session's total instead of reading 0. A
    // magnitude rule would report the leftover 40 kWh on the AC counter for a
    // DC charge that has added 12, and would flip rails mid-session once the
    // live counter overtook the stale one.
    const state: TeslaFieldUpdate = {
      activeRail: 'dc', dcPowerKw: 50, acPowerKw: 0,
      dcEnergyKwh: 12, acEnergyKwh: 40,
    }
    expect(sampleOf(state).chargeEnergyAddedKwh).toBe(12)
    expect(sampleOf({ ...state, activeRail: 'ac' }).chargeEnergyAddedKwh).toBe(40)
  })

  it('still reports the counter once power has dropped back to zero', () => {
    // The end of a charge is when the total matters most, and by then power is
    // 0 on both rails - so the rail must be remembered, not re-derived.
    expect(sampleOf({ activeRail: 'dc', acPowerKw: 0, dcPowerKw: 0, dcEnergyKwh: 31.5 })
      .chargeEnergyAddedKwh).toBe(31.5)
  })

  it('uses the only counter it has when no rail is known', () => {
    expect(sampleOf({ acEnergyKwh: 12 }).chargeEnergyAddedKwh).toBe(12)
    expect(sampleOf({ dcEnergyKwh: 12 }).chargeEnergyAddedKwh).toBe(12)
  })

  it('reports nothing when two counters disagree and nothing says which is live', () => {
    // Better a hole in the energy series than a difference between two
    // unrelated counters, which would be written into battery health as fact.
    expect(sampleOf({ acEnergyKwh: 40, dcEnergyKwh: 12 }).chargeEnergyAddedKwh).toBeNull()
    expect(sampleOf({ socPct: 40 }).chargeEnergyAddedKwh).toBeNull()
  })
})

describe('power decoding claims the rail', () => {
  it('marks the rail active only when power is actually flowing', () => {
    expect(decoded('DCChargingPower', 50)).toEqual({ dcPowerKw: 50, activeRail: 'dc' })
    // 0 kW on AC while DC delivers must not claim the AC rail.
    expect(decoded('ACChargingPower', 0)).toEqual({ acPowerKw: 0 })
    expect(decodeTeslaField('ACChargingPower', null)).toBeNull()
  })
})

describe('connectivity', () => {
  const raw = (payload: unknown): RawMessage => ({
    vehicleId: VEHICLE, vendor: 'tesla', receivedAt: TS, source: 'telemetry', payload,
  })

  it('maps the two states and nothing else', () => {
    expect(decodeTeslaConnectivity({ status: 'CONNECTED' })).toBe('online')
    expect(decodeTeslaConnectivity({ status: 'DISCONNECTED' })).toBe('offline')
    expect(decodeTeslaConnectivity({ status: 'SOMETHING' })).toBeNull()
    expect(decodeTeslaConnectivity(null)).toBeNull()
  })

  it('prefers the createdAt the connectivity message carries', () => {
    const sample = normaliseTeslaConnectivity(
      raw({ status: 'CONNECTED', createdAt: '2026-09-04T09:59:00.000Z' }))
    expect(sample?.powerState).toBe('online')
    expect(sample?.ts.toISOString()).toBe('2026-09-04T09:59:00.000Z')
  })

  it('falls back to arrival time when createdAt is unusable', () => {
    // An Invalid Date propagates into a NULL timestamp on insert and loses the
    // row entirely.
    const sample = normaliseTeslaConnectivity(raw({ status: 'CONNECTED', createdAt: 'nope' }))
    expect(sample?.ts.toISOString()).toBe(TS.toISOString())
  })
})


/**
 * THE CATALOGUE-WIDE TESTS (§5, "Types").
 *
 * The hand-written cases above pin the fourteen fields whose decoding is a
 * judgement. These pin the other hundred and ninety, and they are written as a
 * table over the WHOLE catalogue rather than as a list of examples because the
 * failure they exist to catch is a field nobody wrote a test for: a signal we
 * pay for, receive, and then silently fail to place. A catalogue entry added
 * without a decoder fails here on the day it is added.
 *
 * The third assertion - bindability - is the one that is not about nulls. A
 * value the column REJECTS is not a hole in the data: `insertSample` binds every
 * column in one statement inside the ingest transaction, so it rolls back, is
 * never acked, and is redelivered forever (§3.4). It is checked through
 * `teslaStateToSample` rather than on the decoder's output because four fields
 * decode to a number and land in a JSONB column, and it is the value that
 * reaches the bind that has to be legal.
 */

const COLUMN = new Map(SAMPLE_COLUMNS.map((c) => [c.column, c]))

/** A payload of the shape the column's type implies. */
const REPRESENTATIVE: Record<SqlType, unknown> = {
  'REAL': 12.5,
  'DOUBLE PRECISION': 12.5,
  'INT': 7,
  'BOOLEAN': true,
  'TEXT': 'SomeEnumName',
  'TIME': { hour: 7, minute: 30, second: 0 },
  'TIMESTAMPTZ': 1757000000,
  'JSONB': { fl: 2.8 },
}

/**
 * A payload of a type the column cannot hold. Note TEXT's: on this wire a
 * payload is a number, string, boolean, object or null, and TEXT takes anything
 * stringifiable on purpose (§3.4 - an unobserved shape is stored verbatim until
 * it can be promoted), so `null` (Value_Invalid) is the only input that is
 * genuinely wrong for it.
 */
const WRONG: Record<SqlType, unknown> = {
  'REAL': 'not a number',
  'DOUBLE PRECISION': 'not a number',
  'INT': 'not a number',
  'BOOLEAN': 42,
  'TEXT': null,
  'TIME': 'half past seven',
  'TIMESTAMPTZ': 'half past seven',
  'JSONB': 'not a record',
}

/**
 * The fields whose payload shape is NOT their column's type: the pair-valued
 * locations, the two enums the engine reasons about, the door struct, and the
 * four TPMS corners, which are bare numbers that collapse into one JSONB record.
 */
const SHAPED: Record<string, { good: unknown; wrong: unknown }> = {
  Location: { good: { latitude: 52.2, longitude: 0.13 }, wrong: 'somewhere' },
  OriginLocation: { good: { latitude: 52.2, longitude: 0.13 }, wrong: 'somewhere' },
  DestinationLocation: { good: { latitude: 52.2, longitude: 0.13 }, wrong: 'somewhere' },
  ChargeState: { good: 'Charging', wrong: 'ChargeStateSomethingNew' },
  DetailedChargeState: { good: 'Charging', wrong: 'ChargeStateSomethingNew' },
  DoorState: { good: { DriverFront: false, PassengerFront: true }, wrong: 42 },
  TpmsPressureFl: { good: 2.8, wrong: 'flat' },
  TpmsPressureFr: { good: 2.9, wrong: 'flat' },
  TpmsPressureRl: { good: 2.7, wrong: 'flat' },
  TpmsPressureRr: { good: 2.75, wrong: 'flat' },
}

function sqlOf(entry: TeslaField): SqlType {
  const column = COLUMN.get(columnsOf(entry)[0]!)
  if (!column) throw new Error(`${entry.field} names a column @ev/core does not have`)
  return column.sql
}

const goodPayload = (e: TeslaField): unknown => SHAPED[e.field]?.good ?? REPRESENTATIVE[sqlOf(e)]
const wrongPayload = (e: TeslaField): unknown => SHAPED[e.field]?.wrong ?? WRONG[sqlOf(e)]

/** Does `value` inhabit the TypeScript type the column's SQL type admits? */
function isTsType(ts: string, value: unknown): boolean {
  switch (ts) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'Date':
      return value instanceof Date && !Number.isNaN(value.getTime())
    case 'TpmsMap':
      return (
        typeof value === 'object' && value !== null && !Array.isArray(value) &&
        Object.values(value).every((v) => typeof v === 'number' && Number.isFinite(v))
      )
    // 'string', and the two enum tags, all bind as text.
    default:
      return typeof value === 'string'
  }
}

const CASES = TESLA_FIELDS.map((entry) => [entry.field, entry] as const)

describe('every catalogued field decodes', () => {
  it.each(CASES)('%s fills its slots from a representative payload', (_field, entry) => {
    const update = decodeTeslaField(entry.field, goodPayload(entry)) as Record<string, unknown>
    expect(update, `${entry.field} decoded nothing`).not.toBeNull()
    for (const slot of slotsOf(entry)) {
      expect(update[slot], `${entry.field} left ${slot} empty`).not.toBe(undefined)
      expect(update[slot], `${entry.field} left ${slot} null`).not.toBeNull()
    }
  })

  it.each(CASES)('%s binds to its column\'s SQL type', (_field, entry) => {
    const update = decodeTeslaField(entry.field, goodPayload(entry))
    const sample = teslaStateToSample(VEHICLE, TS, update!) as unknown as Record<string, unknown>
    for (const name of columnsOf(entry)) {
      const column = COLUMN.get(name)!
      const value = sample[column.key]
      expect(value, `${name} was not populated`).not.toBeNull()
      expect(
        TS_TYPES_FOR_SQL[column.sql].some((ts) => isTsType(ts, value)),
        `${name} (${column.sql}) cannot bind ${JSON.stringify(value)}`,
      ).toBe(true)
      if (column.sql === 'INT') expect(Number.isInteger(value), `${name} is not an integer`).toBe(true)
    }
  })

  it.each(CASES)('%s yields null for a wrong-typed payload', (_field, entry) => {
    // Never a fabricated value: a wrong type must lose the message, not the
    // transaction, and must not overwrite a good earlier reading either.
    expect(decodeTeslaField(entry.field, wrongPayload(entry))).toBeNull()
    expect(decodeTeslaField(entry.field, null)).toBeNull()
  })
})

describe('teslaStateToSample: the whole catalogue', () => {
  it('populates every catalogued column the car can fill', () => {
    // The end-to-end shape of §1: everything we ask for, decoded, in a column.
    const state: Record<string, unknown> = {}
    for (const entry of TESLA_FIELDS) {
      Object.assign(state, decodeTeslaField(entry.field, goodPayload(entry)))
    }
    const sample = teslaStateToSample(VEHICLE, TS, state) as unknown as Record<string, unknown>
    const empty = SAMPLE_COLUMNS.filter((c) => sample[c.key] === null).map((c) => c.column)
    // power_state is the one column no metric fills: it comes from connectivity.
    expect(empty).toEqual(['power_state'])
  })

  it('still writes null, never 0, for what the car never reported', () => {
    const sample = teslaStateToSample(VEHICLE, TS, { socPct: 72 }) as unknown as Record<string, unknown>
    const populated = SAMPLE_COLUMNS.filter((c) => sample[c.key] !== null).map((c) => c.column)
    expect(populated).toEqual(['soc_pct'])
  })
})

describe('the overrides', () => {
  it('names only catalogued fields', () => {
    // An override for a field the catalogue does not carry would sit there doing
    // nothing, which is the silent-loss failure in miniature.
    const catalogued = new Set(TESLA_FIELDS.map((e) => e.field))
    expect(TESLA_OVERRIDDEN_FIELDS.filter((f) => !catalogued.has(f))).toEqual([])
  })

  it('covers every field whose slot is not its column', () => {
    // Ten fields collapse onto four columns; a generic rule keyed on the column
    // type cannot tell them apart, so each must be hand-written.
    const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase())
    const collapsed = TESLA_FIELDS.filter((e) =>
      slotsOf(e).some((slot, i) => camel(columnsOf(e)[i]!) !== slot))
    expect(collapsed.map((e) => e.field).filter((f) => !TESLA_OVERRIDDEN_FIELDS.includes(f)))
      .toEqual([])
  })
})

describe('per-type decoders (§3.4)', () => {
  it('rounds onto an INT column rather than refusing', () => {
    expect(SQL_DECODERS['INT'](3.6)).toBe(4)
    expect(SQL_DECODERS['INT']('3.4')).toBe(3)
    expect(SQL_DECODERS['INT'](-3.6)).toBe(-4)
  })

  it('refuses an INT postgres would reject', () => {
    // Out of int4 range is a BIND ERROR, and a bind error wedges ingest forever.
    expect(SQL_DECODERS['INT'](3e9)).toBeNull()
    expect(SQL_DECODERS['INT']('abc')).toBeNull()
    expect(SQL_DECODERS['INT'](true)).toBeNull()
  })

  it('stores an unobserved shape verbatim as TEXT', () => {
    // The reason a field of unknown shape is parked at TEXT: whatever the car
    // sent is kept until a migration plus reprocess can promote it.
    expect(SQL_DECODERS['TEXT']({ hour: 7, minute: 30, second: 0 }))
      .toBe('{"hour":7,"minute":30,"second":0}')
    expect(SQL_DECODERS['TEXT'](12.5)).toBe('12.5')
    expect(SQL_DECODERS['TEXT'](false)).toBe('false')
    expect(SQL_DECODERS['TEXT']('Park')).toBe('Park')
    expect(SQL_DECODERS['TEXT']('')).toBeNull()
    expect(SQL_DECODERS['TEXT'](null)).toBeNull()
  })

  it('parses a proto Time onto a TIME column', () => {
    // `message Time` is {hour, minute, second}: a wall clock, no date, no zone.
    expect(SQL_DECODERS['TIME']({ hour: 7, minute: 5, second: 9 })).toBe('07:05:09')
    expect(SQL_DECODERS['TIME']({ hour: 7, minute: 5 })).toBe('07:05:00')
    expect(SQL_DECODERS['TIME']({ hour: 25, minute: 0, second: 0 })).toBeNull()
    expect(SQL_DECODERS['TIME']({ hour: 7, minute: 61, second: 0 })).toBeNull()
    expect(SQL_DECODERS['TIME'](1757000000)).toBeNull()
  })

  it('accepts only what epochSecondsToDate produced on a TIMESTAMPTZ column', () => {
    const date = VALUE_CONVERTERS['epochSecondsToDate'](1757000000)
    expect(date).toEqual(new Date('2025-09-04T15:33:20.000Z'))
    expect(SQL_DECODERS['TIMESTAMPTZ'](date)).toEqual(date)
    // A bare epoch reaching a TIMESTAMPTZ column means the converter was not
    // named in the catalogue, and postgres would read the number as a year.
    expect(SQL_DECODERS['TIMESTAMPTZ'](1757000000)).toBeNull()
    expect(SQL_DECODERS['TIMESTAMPTZ']('2025-09-04T15:33:20Z')).toBeNull()
    expect(VALUE_CONVERTERS['epochSecondsToDate'](1e20)).toBeNull()
    expect(VALUE_CONVERTERS['epochSecondsToDate']('nope')).toBeNull()
  })

  it('takes a record of numbers onto a JSONB column and nothing else', () => {
    expect(SQL_DECODERS['JSONB']({ fl: 2.8 })).toEqual({ fl: 2.8 })
    expect(SQL_DECODERS['JSONB']({ fl: 'flat' })).toBeNull()
    expect(SQL_DECODERS['JSONB']([2.8])).toBeNull()
    expect(SQL_DECODERS['JSONB']('not a record')).toBeNull()
    // Nothing known is not a reading with nothing in it.
    expect(SQL_DECODERS['JSONB']({})).toBeNull()
  })

  it('converts distances and speeds by the exact mile', () => {
    expect(VALUE_CONVERTERS['milesToKm'](100)).toBeCloseTo(160.9344, 9)
    expect(VALUE_CONVERTERS['mphToKph']('40')).toBeCloseTo(64.37376, 9)
    expect(VALUE_CONVERTERS['milesToKm']('')).toBeNull()
  })
})


/**
 * IN-RANGE FOR THE TYPE IS NOT THE SAME AS STORABLE IN THE COLUMN.
 *
 * The §3.4 bindability tests above feed each column a value of the WRONG TYPE
 * and check it decodes to null. That misses the case that actually wedges
 * ingest: a value of the RIGHT type that the column still refuses. Postgres
 * float4 overflows above ~3.4e38 and int4 above 2^31-1, and a text parameter
 * rejects a NUL byte outright — each raises on BIND, which rolls the
 * transaction back, leaves the message unacked, and has MQTT redeliver it
 * forever. The car cannot send these today; the module header records that JSON
 * types drift between vehicle software builds, which is how one arrives.
 */
describe('decoders refuse values their column cannot hold', () => {
	const cases: Array<[SqlType, unknown, string]> = [
		['REAL', 1e39, 'float4 overflows above ~3.4e38'],
		['REAL', '1e39', 'and the same as the numeric string the wire may send'],
		['REAL', -1e39, 'in both directions'],
		['INT', 3e9, 'int4 stops at 2147483647'],
		['TEXT', 'before\u0000after', 'a NUL byte cannot be stored in text at all'],
	]

	for (const [sql, payload, why] of cases) {
		it(`${sql}: rejects ${JSON.stringify(payload)} — ${why}`, () => {
			expect(SQL_DECODERS[sql](payload)).toBeNull()
		})
	}

	it('still accepts the largest value the column CAN hold', () => {
		// The guard must not be a blanket refusal of large numbers: a real
		// lifetime-energy counter is legitimately large.
		expect(SQL_DECODERS['REAL'](3.4e38)).toBe(3.4e38)
		expect(SQL_DECODERS['INT'](2_147_483_647)).toBe(2_147_483_647)
		expect(SQL_DECODERS['DOUBLE PRECISION'](1e39)).toBe(1e39)
	})
})
