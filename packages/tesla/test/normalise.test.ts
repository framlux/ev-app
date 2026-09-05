import { describe, expect, it } from 'vitest'
import type { RawMessage } from '@ev/core'
import {
  MILES_TO_KM,
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
    // Gear and ChargeAmps are streamed but have no VehicleSample counterpart,
    // and Tesla ships new fields without warning. Neither may become a guess.
    expect(decodeTeslaField('Gear', 'D')).toBeNull()
    expect(decodeTeslaField('ChargeAmps', 32)).toBeNull()
    expect(decodeTeslaField('SomethingShippedNextTuesday', 1)).toBeNull()
    expect(isKnownTeslaField('Soc')).toBe(true)
    expect(isKnownTeslaField('Gear')).toBe(false)
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

