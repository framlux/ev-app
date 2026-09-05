/**
 * Contract tests for the Tesla telemetry normaliser.
 *
 * We have no live capture yet, so these fixtures ARE the specification: they
 * pin the wire shapes we expect, the units we convert, and - most importantly -
 * the places where the answer must be null rather than a plausible-looking
 * zero. Each test is written so that a mutation of the implementation (dropping
 * a guard, flipping a coalesce, changing the mile factor) fails a named test.
 */

import { describe, expect, it } from 'vitest'
import type { RawMessage } from '@ev/core'
import {
  MILES_TO_KM,
  normaliseTeslaConnectivity,
  normaliseTeslaMessage,
  TESLA_FIELD_MAP,
} from '../src/normalise.js'

const RECEIVED_AT = new Date('2026-09-04T10:00:05Z')
const CREATED_AT = '2026-09-04T10:00:00Z'

type Entry = { key: string; value: unknown }

function raw(payload: unknown): RawMessage {
  return {
    vehicleId: 'v1',
    vendor: 'tesla',
    receivedAt: RECEIVED_AT,
    source: 'telemetry',
    payload,
  }
}

/** A "V" record carrying the given field entries. */
function record(...data: Entry[]): RawMessage {
  return raw({ vin: '5YJ3E1EA7KF000001', createdAt: CREATED_AT, data })
}

const d = (n: number) => ({ doubleValue: n })

/** A realistic mid-drive record with every configured field present. */
const FULL_DRIVE_RECORD: Entry[] = [
  { key: 'Soc', value: d(72.5) },
  { key: 'VehicleSpeed', value: d(48.3) },
  { key: 'Gear', value: { shiftStateValue: 'ShiftStateD' } },
  { key: 'Location', value: { locationValue: { latitude: 51.5074, longitude: -0.1278 } } },
  { key: 'Odometer', value: d(41234.7) },
  { key: 'RatedRange', value: d(210.4) },
  { key: 'ChargeState', value: { chargingValue: 'ChargeStateDisconnected' } },
  { key: 'DetailedChargeState', value: { stringValue: 'DetailedChargeStateDisconnected' } },
  { key: 'ChargeAmps', value: { intValue: 0 } },
  { key: 'InsideTemp', value: d(21.5) },
  { key: 'OutsideTemp', value: d(12.0) },
  { key: 'Locked', value: { booleanValue: true } },
  {
    key: 'DoorState',
    value: {
      doorValue: {
        DriverFront: false,
        DriverRear: false,
        PassengerFront: false,
        PassengerRear: false,
        TrunkFront: false,
        TrunkRear: false,
      },
    },
  },
  { key: 'TpmsPressureFl', value: d(2.9) },
  { key: 'TpmsPressureFr', value: d(2.95) },
  { key: 'TpmsPressureRl', value: d(3.0) },
  { key: 'TpmsPressureRr', value: d(3.05) },
]

describe('normaliseTeslaMessage - field mapping', () => {
  const s = normaliseTeslaMessage(record(...FULL_DRIVE_RECORD))

  it('produces a sample carrying the vehicle id and the car-supplied timestamp', () => {
    expect(s?.vehicleId).toBe('v1')
    // createdAt from the record wins over receivedAt.
    expect(s?.ts.toISOString()).toBe('2026-09-04T10:00:00.000Z')
  })

  it('maps the unit-free scalars straight through', () => {
    expect(s?.socPct).toBe(72.5)
    expect(s?.insideTempC).toBe(21.5)
    expect(s?.outsideTempC).toBe(12.0)
  })

  it('maps location as a pair', () => {
    expect(s?.lat).toBe(51.5074)
    expect(s?.lon).toBe(-0.1278)
  })

  it('maps lock and door state', () => {
    expect(s?.locked).toBe(true)
    expect(s?.doorsOpen).toBe(false)
  })

  it('collapses the four TPMS corners into one record', () => {
    expect(s?.tpms).toEqual({ fl: 2.9, fr: 2.95, rl: 3.0, rr: 3.05 })
  })

  it('maps a disconnected charge state and leaves charging figures null while driving', () => {
    expect(s?.chargeState).toBe('disconnected')
    expect(s?.chargePowerKw).toBeNull()
    expect(s?.chargeEnergyAddedKwh).toBeNull()
  })

  it('does not invent a power state from a telemetry record', () => {
    // Only connectivity records carry sleep state.
    expect(s?.powerState).toBeNull()
  })

  it('falls back to receivedAt when createdAt is missing or unparseable', () => {
    const noDate = normaliseTeslaMessage(raw({ data: [{ key: 'Soc', value: d(50) }] }))
    expect(noDate?.ts).toEqual(RECEIVED_AT)

    const badDate = normaliseTeslaMessage(
      raw({ createdAt: 'not-a-date', data: [{ key: 'Soc', value: d(50) }] }),
    )
    expect(badDate?.ts).toEqual(RECEIVED_AT)
    expect(Number.isNaN(badDate?.ts.getTime())).toBe(false)
  })

  it('accepts a raw JSON string body as well as a parsed object', () => {
    const asString = normaliseTeslaMessage(
      raw(JSON.stringify({ createdAt: CREATED_AT, data: [{ key: 'Soc', value: d(41) }] })),
    )
    expect(asString?.socPct).toBe(41)
  })
})

describe('unit conversion', () => {
  it('uses the exact international mile', () => {
    // A boundary in the literal sense: 1.6 or the US survey mile both fail here.
    expect(MILES_TO_KM).toBe(1.609344)
  })

  const cases: { miles: number; km: number }[] = [
    { miles: 0, km: 0 },
    { miles: 1, km: 1.609344 },
    { miles: 100, km: 160.9344 },
    { miles: -5, km: -8.04672 },
    { miles: 0.5, km: 0.804672 },
  ]

  for (const { miles, km } of cases) {
    it(`converts ${miles} mi -> ${km} km for speed, odometer and range`, () => {
      const s = normaliseTeslaMessage(
        record(
          { key: 'VehicleSpeed', value: d(miles) },
          { key: 'Odometer', value: d(miles) },
          { key: 'RatedRange', value: d(miles) },
        ),
      )
      expect(s?.speedKph).toBeCloseTo(km, 9)
      expect(s?.odometerKm).toBeCloseTo(km, 9)
      expect(s?.rangeKm).toBeCloseTo(km, 9)
    })
  }

  it('does not convert temperatures, SOC, power, energy or tyre pressure', () => {
    const s = normaliseTeslaMessage(
      record(
        { key: 'InsideTemp', value: d(20) },
        { key: 'OutsideTemp', value: d(20) },
        { key: 'Soc', value: d(20) },
        { key: 'ACChargingPower', value: d(20) },
        { key: 'ACChargingEnergyIn', value: d(20) },
        { key: 'TpmsPressureFl', value: d(20) },
      ),
    )
    expect(s?.insideTempC).toBe(20)
    expect(s?.outsideTempC).toBe(20)
    expect(s?.socPct).toBe(20)
    expect(s?.chargePowerKw).toBe(20)
    expect(s?.chargeEnergyAddedKwh).toBe(20)
    expect(s?.tpms).toEqual({ fl: 20 })
  })

  it('converts a zero speed to exactly zero, not null', () => {
    const s = normaliseTeslaMessage(record({ key: 'VehicleSpeed', value: d(0) }))
    expect(s?.speedKph).toBe(0)
  })
})

describe('AC/DC charging coalescing', () => {
  it('takes AC power when only AC is present', () => {
    const s = normaliseTeslaMessage(record({ key: 'ACChargingPower', value: d(7.4) }))
    expect(s?.chargePowerKw).toBe(7.4)
  })

  it('takes DC power when only DC is present', () => {
    const s = normaliseTeslaMessage(record({ key: 'DCChargingPower', value: d(148.2) }))
    expect(s?.chargePowerKw).toBe(148.2)
  })

  it('takes DC power when it is present and AC reports the idle zero', () => {
    const s = normaliseTeslaMessage(
      record(
        { key: 'ACChargingPower', value: d(0) },
        { key: 'DCChargingPower', value: d(148.2) },
      ),
    )
    expect(s?.chargePowerKw).toBe(148.2)
  })

  it('takes AC power when it is present and DC reports the idle zero', () => {
    // Entry order reversed on purpose: a later idle zero must not clobber an
    // earlier real reading.
    const s = normaliseTeslaMessage(
      record(
        { key: 'ACChargingPower', value: d(11.0) },
        { key: 'DCChargingPower', value: d(0) },
      ),
    )
    expect(s?.chargePowerKw).toBe(11.0)
  })

  it('yields zero when both are genuinely zero', () => {
    const s = normaliseTeslaMessage(
      record({ key: 'ACChargingPower', value: d(0) }, { key: 'DCChargingPower', value: d(0) }),
    )
    expect(s?.chargePowerKw).toBe(0)
  })

  it('yields null - never zero - when neither power field is present', () => {
    const s = normaliseTeslaMessage(record({ key: 'Soc', value: d(60) }))
    expect(s?.chargePowerKw).toBeNull()
  })

  it('yields null when both power fields are present but unreadable', () => {
    const s = normaliseTeslaMessage(
      record(
        { key: 'Soc', value: d(60) },
        { key: 'ACChargingPower', value: { invalid: true } },
        { key: 'DCChargingPower', value: { invalid: true } },
      ),
    )
    expect(s?.chargePowerKw).toBeNull()
  })

  it('coalesces AC/DC energy the same way, and stays null when both are absent', () => {
    expect(
      normaliseTeslaMessage(record({ key: 'DCChargingEnergyIn', value: d(31.8) }))
        ?.chargeEnergyAddedKwh,
    ).toBe(31.8)
    expect(
      normaliseTeslaMessage(
        record(
          { key: 'ACChargingEnergyIn', value: d(12.25) },
          { key: 'DCChargingEnergyIn', value: d(0) },
        ),
      )?.chargeEnergyAddedKwh,
    ).toBe(12.25)
    expect(
      normaliseTeslaMessage(record({ key: 'Soc', value: d(60) }))?.chargeEnergyAddedKwh,
    ).toBeNull()
  })
})

describe('charge state enums', () => {
  const known: [string, string][] = [
    ['Charging', 'charging'],
    ['ChargeStateCharging', 'charging'],
    ['DetailedChargeStateCharging', 'charging'],
    ['Complete', 'complete'],
    ['ChargeStateComplete', 'complete'],
    ['Stopped', 'stopped'],
    ['ChargeStateStopped', 'stopped'],
    ['Disconnected', 'disconnected'],
    ['ChargeStateDisconnected', 'disconnected'],
    ['Connected', 'connected'],
    ['ChargeStateNoPower', 'connected'],
    ['ChargeStateStarting', 'connected'],
  ]

  for (const [wire, expected] of known) {
    it(`maps ${wire} -> ${expected}`, () => {
      const s = normaliseTeslaMessage(record({ key: 'ChargeState', value: { stringValue: wire } }))
      expect(s?.chargeState).toBe(expected)
    })
  }

  const unknown = ['ChargeStateUnknown', 'Unknown', '', 'charging', 'CHARGING', 'Chargin']
  for (const wire of unknown) {
    it(`maps the unrecognised enum ${JSON.stringify(wire)} -> null, never a guess`, () => {
      const s = normaliseTeslaMessage(
        record({ key: 'Soc', value: d(50) }, { key: 'ChargeState', value: { stringValue: wire } }),
      )
      expect(s?.chargeState).toBeNull()
    })
  }

  it('prefers DetailedChargeState over ChargeState when both are recognised', () => {
    const s = normaliseTeslaMessage(
      record(
        { key: 'ChargeState', value: { stringValue: 'ChargeStateCharging' } },
        { key: 'DetailedChargeState', value: { stringValue: 'DetailedChargeStateStopped' } },
      ),
    )
    expect(s?.chargeState).toBe('stopped')
  })

  it('falls back to ChargeState when DetailedChargeState is unrecognised', () => {
    const s = normaliseTeslaMessage(
      record(
        { key: 'ChargeState', value: { stringValue: 'ChargeStateCharging' } },
        { key: 'DetailedChargeState', value: { stringValue: 'DetailedChargeStateSomethingNew' } },
      ),
    )
    expect(s?.chargeState).toBe('charging')
  })

  it('accepts the dedicated enum arm as well as stringValue', () => {
    expect(
      normaliseTeslaMessage(record({ key: 'ChargeState', value: { chargingValue: 'Charging' } }))
        ?.chargeState,
    ).toBe('charging')
    expect(
      normaliseTeslaMessage(
        record({
          key: 'DetailedChargeState',
          value: { detailedChargeStateValue: 'DetailedChargeStateComplete' },
        }),
      )?.chargeState,
    ).toBe('complete')
  })
})

describe('location is all-or-nothing', () => {
  it('lands both coordinates together', () => {
    const s = normaliseTeslaMessage(
      record({ key: 'Location', value: { locationValue: { latitude: 51.5, longitude: -0.12 } } }),
    )
    expect(s?.lat).toBe(51.5)
    expect(s?.lon).toBe(-0.12)
  })

  it('lands neither when the longitude is missing', () => {
    const s = normaliseTeslaMessage(
      record({ key: 'Soc', value: d(50) }, { key: 'Location', value: { locationValue: { latitude: 51.5 } } }),
    )
    expect(s?.lat).toBeNull()
    expect(s?.lon).toBeNull()
  })

  it('lands neither when the latitude is missing', () => {
    const s = normaliseTeslaMessage(
      record({ key: 'Soc', value: d(50) }, { key: 'Location', value: { locationValue: { longitude: -0.12 } } }),
    )
    expect(s?.lat).toBeNull()
    expect(s?.lon).toBeNull()
  })

  it('keeps a genuine 0,0 rather than discarding it as falsy', () => {
    const s = normaliseTeslaMessage(
      record({ key: 'Location', value: { locationValue: { latitude: 0, longitude: 0 } } }),
    )
    expect(s?.lat).toBe(0)
    expect(s?.lon).toBe(0)
  })

  it('does not count an unreadable location as mappable content', () => {
    expect(normaliseTeslaMessage(record({ key: 'Location', value: { invalid: true } }))).toBeNull()
  })
})

describe('doors and locks', () => {
  it('reports doorsOpen true when any single door is open', () => {
    const s = normaliseTeslaMessage(
      record({
        key: 'DoorState',
        value: { doorValue: { DriverFront: false, PassengerRear: true, TrunkFront: false } },
      }),
    )
    expect(s?.doorsOpen).toBe(true)
  })

  it('leaves doorsOpen null when no door flags are readable, rather than claiming shut', () => {
    const s = normaliseTeslaMessage(
      record({ key: 'Soc', value: d(50) }, { key: 'DoorState', value: { doorValue: {} } }),
    )
    expect(s?.doorsOpen).toBeNull()
  })

  it('reads locked false as false, not as absent', () => {
    const s = normaliseTeslaMessage(record({ key: 'Locked', value: { booleanValue: false } }))
    expect(s?.locked).toBe(false)
  })

  it('leaves locked null when the value is not boolean-shaped', () => {
    const s = normaliseTeslaMessage(
      record({ key: 'Soc', value: d(50) }, { key: 'Locked', value: { stringValue: 'maybe' } }),
    )
    expect(s?.locked).toBeNull()
  })
})

describe('tolerating the unknown', () => {
  it('ignores unknown keys without throwing and keeps the rest of the message', () => {
    const s = normaliseTeslaMessage(
      record(
        { key: 'SomeFutureFieldTeslaAdded', value: { stringValue: 'x' } },
        { key: 'Soc', value: d(64) },
        { key: 'AnotherOne', value: { weirdWrapper: { nested: [1, 2, 3] } } },
      ),
    )
    expect(s?.socPct).toBe(64)
  })

  it('ignores unknown value wrappers on known keys without throwing', () => {
    const s = normaliseTeslaMessage(
      record(
        { key: 'Soc', value: d(64) },
        { key: 'Odometer', value: { someNewTypedWrapper: { magnitude: 12 } } },
      ),
    )
    expect(s?.socPct).toBe(64)
    expect(s?.odometerKm).toBeNull()
  })

  it('ignores malformed entries', () => {
    const s = normaliseTeslaMessage(
      raw({
        createdAt: CREATED_AT,
        data: [null, 'nonsense', 42, { novalue: 1 }, { key: 7 }, { key: 'Soc', value: d(30) }],
      }),
    )
    expect(s?.socPct).toBe(30)
  })

  it('reads the fields we stream but cannot store as unmapped, not as errors', () => {
    // Gear and ChargeAmps have no VehicleSample counterpart. They must not
    // appear in the map, and a record made only of them carries nothing.
    expect(TESLA_FIELD_MAP['Gear']).toBeUndefined()
    expect(TESLA_FIELD_MAP['ChargeAmps']).toBeUndefined()
    expect(
      normaliseTeslaMessage(
        record(
          { key: 'Gear', value: { shiftStateValue: 'ShiftStateD' } },
          { key: 'ChargeAmps', value: { intValue: 32 } },
        ),
      ),
    ).toBeNull()
  })
})

describe('nothing mappable yields null', () => {
  const empties: [string, unknown][] = [
    ['an empty data array', { createdAt: CREATED_AT, data: [] }],
    ['no data array at all', { createdAt: CREATED_AT, vin: 'X' }],
    ['a data field that is not an array', { data: { key: 'Soc' } }],
    ['a null payload', null],
    ['a non-object payload', 42],
    ['unparseable JSON', '{not json'],
  ]

  for (const [label, payload] of empties) {
    it(`returns null for ${label}`, () => {
      expect(normaliseTeslaMessage(raw(payload))).toBeNull()
    })
  }

  it('returns null when every recognised field is explicitly invalid', () => {
    expect(
      normaliseTeslaMessage(
        record(
          { key: 'Soc', value: { invalid: true } },
          { key: 'VehicleSpeed', value: { invalid: true } },
        ),
      ),
    ).toBeNull()
  })

  it('honours the invalid flag even when a zero-default arm sits beside it', () => {
    // Protobuf JSON renders the sibling arm's default next to the flag, so this
    // is the realistic unavailable-reading shape. Reading the 0 would tell the
    // segmenter the car had parked.
    expect(
      normaliseTeslaMessage(record({ key: 'VehicleSpeed', value: { invalid: true, doubleValue: 0 } })),
    ).toBeNull()

    const s = normaliseTeslaMessage(
      record(
        { key: 'Soc', value: d(50) },
        { key: 'VehicleSpeed', value: { invalid: true, doubleValue: 0 } },
        { key: 'Locked', value: { invalid: true, booleanValue: false } },
        { key: 'ChargeState', value: { invalid: true, stringValue: 'Charging' } },
        {
          key: 'Location',
          value: { invalid: true, locationValue: { latitude: 0, longitude: 0 } },
        },
        {
          key: 'DoorState',
          value: { invalid: true, doorValue: { DriverFront: false } },
        },
      ),
    )
    expect(s?.speedKph).toBeNull()
    expect(s?.locked).toBeNull()
    expect(s?.chargeState).toBeNull()
    expect(s?.lat).toBeNull()
    expect(s?.lon).toBeNull()
    expect(s?.doorsOpen).toBeNull()
  })

  it('returns null when every recognised field carries an empty numeric string', () => {
    // Number('') is 0. Turning that into a 0 kph sample would tell the
    // segmenter the car had parked.
    expect(normaliseTeslaMessage(record({ key: 'VehicleSpeed', value: { intValue: '' } }))).toBeNull()
  })

  it('returns null when a numeric field is NaN or Infinity rather than coercing', () => {
    expect(
      normaliseTeslaMessage(record({ key: 'VehicleSpeed', value: { doubleValue: 'NaN' } })),
    ).toBeNull()
    expect(
      normaliseTeslaMessage(record({ key: 'VehicleSpeed', value: { doubleValue: Infinity } })),
    ).toBeNull()
  })
})

describe('missing means null, never zero', () => {
  it('leaves every unmentioned field null on a single-field record', () => {
    const s = normaliseTeslaMessage(record({ key: 'Soc', value: d(50) }))
    expect(s).not.toBeNull()
    expect(s?.socPct).toBe(50)
    for (const key of [
      'rangeKm',
      'odometerKm',
      'lat',
      'lon',
      'speedKph',
      'powerState',
      'chargeState',
      'chargePowerKw',
      'chargeEnergyAddedKwh',
      'insideTempC',
      'outsideTempC',
      'locked',
      'doorsOpen',
      'tpms',
    ] as const) {
      expect(s?.[key], `${key} should be null, not a default`).toBeNull()
    }
  })

  it('keeps tpms null when no corner is readable, and partial when some are', () => {
    expect(
      normaliseTeslaMessage(
        record({ key: 'Soc', value: d(50) }, { key: 'TpmsPressureFl', value: { invalid: true } }),
      )?.tpms,
    ).toBeNull()

    expect(
      normaliseTeslaMessage(
        record(
          { key: 'TpmsPressureFl', value: d(2.8) },
          { key: 'TpmsPressureRr', value: { invalid: true } },
        ),
      )?.tpms,
    ).toEqual({ fl: 2.8 })
  })
})

describe('numeric wrapper arms', () => {
  const arms: [string, unknown, number][] = [
    ['doubleValue', { doubleValue: 55.5 }, 55.5],
    ['floatValue', { floatValue: 55.5 }, 55.5],
    ['intValue', { intValue: 55 }, 55],
    ['longValue as a protojson string', { longValue: '55' }, 55],
    ['snake_case double_value', { double_value: 55.5 }, 55.5],
    ['a bare number', 55.5, 55.5],
  ]

  for (const [label, value, expected] of arms) {
    it(`reads ${label}`, () => {
      expect(normaliseTeslaMessage(record({ key: 'Soc', value }))?.socPct).toBe(expected)
    })
  }

  it('reads a zero intValue as zero rather than treating it as absent', () => {
    const s = normaliseTeslaMessage(record({ key: 'Soc', value: { intValue: 0 } }))
    expect(s?.socPct).toBe(0)
  })
})

describe('normaliseTeslaConnectivity', () => {
  it('maps CONNECTED to online and DISCONNECTED to offline', () => {
    expect(
      normaliseTeslaConnectivity(raw({ status: 'CONNECTED', createdAt: CREATED_AT }))?.powerState,
    ).toBe('online')
    expect(normaliseTeslaConnectivity(raw({ status: 'DISCONNECTED' }))?.powerState).toBe('offline')
  })

  it('returns null for an unknown or missing status', () => {
    expect(normaliseTeslaConnectivity(raw({ status: 'FLAPPING' }))).toBeNull()
    expect(normaliseTeslaConnectivity(raw({}))).toBeNull()
    expect(normaliseTeslaConnectivity(raw(null))).toBeNull()
  })

  it('leaves everything but powerState null', () => {
    const s = normaliseTeslaConnectivity(raw({ status: 'CONNECTED' }))
    expect(s?.socPct).toBeNull()
    expect(s?.speedKph).toBeNull()
    expect(s?.ts).toEqual(RECEIVED_AT)
  })

  it('is not confused by a telemetry record, and vice versa', () => {
    expect(normaliseTeslaConnectivity(record({ key: 'Soc', value: d(50) }))).toBeNull()
    expect(normaliseTeslaMessage(raw({ status: 'CONNECTED' }))).toBeNull()
  })
})
