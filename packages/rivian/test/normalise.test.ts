import { describe, expect, it } from 'vitest'
import { SAMPLE_COLUMNS } from '@ev/core'
import { RIVIAN_PROPERTIES } from '../src/catalogue.js'
import {
  CLOSED_PROPERTIES,
  GPS_SPEED_NOISE_FLOOR_MS,
  LOCK_PROPERTIES,
  RIVIAN_CHARGE_STATE_SLOTS,
  RIVIAN_CHARGING_ENERGY_SLOTS,
  RIVIAN_CHARGING_POWER_SLOTS,
  RIVIAN_DECODED_PROPERTIES,
  RIVIAN_VOLATILE_SLOTS,
  decodeRivian,
  rivianStateToSample,
  type RivianNamedSlot,
} from '../src/normalise.js'
import { stateEnvelope, tv } from './fixtures/state.js'

// Every fixture is SYNTHETIC (see fixtures/state.ts): hand-written from the R1
// shapes in spec §2.5, not captured from a car. The R2 is a different platform,
// so each value here is a hypothesis until the tape confirms it (spec §8.4).

const RECEIVED = new Date('2026-10-19T12:00:00.000Z')
const SPEED_WINDOW_MS = 300_000
const VALUE_WINDOW_MS = 21_600_000
/** The accumulator's windows as the Rivian profile will give them (spec §7.6). */
const W = (s: string) =>
  s === 'speedKph' || s === 'gpsHeading' || s === 'chargePowerKw'
    ? SPEED_WINDOW_MS
    : VALUE_WINDOW_MS

const PLACEHOLDERS = ['signal_not_available', 'fault', 'undefined']

/** An ISO timestamp `offsetMs` away from the frame's arrival. */
const at = (offsetMs: number) => new Date(RECEIVED.getTime() + offsetMs).toISOString()
/** A timestamp a second before the frame: fresh enough for every slot. */
const TS = at(-1000)

function decodeState(props: Record<string, unknown>) {
  return decodeRivian(stateEnvelope(RECEIVED.toISOString(), props), RECEIVED, W)
}

function mustDecode(props: Record<string, unknown>) {
  const decoded = decodeState(props)
  if (!decoded) throw new Error('expected the frame to decode')
  return decoded
}

const slotsOf = (props: Record<string, unknown>) => mustDecode(props).slots

function envelope(stream: string, body: unknown, extra: Record<string, unknown> = {}) {
  return { v: 1, stream, vin: 'VIN1', receivedAt: RECEIVED.toISOString(), body, ...extra }
}

describe('decodeRivian: units and conversions', () => {
  it('reads batteryLevel as a percentage, as is', () => {
    expect(slotsOf({ batteryLevel: tv(TS, 81.5) })).toEqual({ socPct: 81.5 })
  })

  it('converts the odometer from metres to kilometres', () => {
    expect(slotsOf({ vehicleMileage: tv(TS, 12345678) })).toEqual({ odometerKm: 12345.678 })
  })

  it('converts GPS speed from m/s to kph', () => {
    expect(slotsOf({ gnssSpeed: tv(TS, 10) })).toEqual({ speedKph: 36 })
  })

  it('reads the noise floor as stationary: 0.4 m/s is 0, 0.5 m/s is moving', () => {
    expect(GPS_SPEED_NOISE_FLOOR_MS).toBe(0.5)
    expect(slotsOf({ gnssSpeed: tv(TS, 0.4) })).toEqual({ speedKph: 0 })
    expect(slotsOf({ gnssSpeed: tv(TS, 0) })).toEqual({ speedKph: 0 })
    expect(slotsOf({ gnssSpeed: tv(TS, 0.5) }).speedKph).toBeCloseTo(1.8, 10)
  })

  it('refuses a negative speed rather than calling it zero', () => {
    // A speed is a magnitude, so a negative one is not a reading we can vouch
    // for. Collapsing it into the noise floor would turn garbage into a claim
    // that the car is stationary.
    expect(slotsOf({ gnssSpeed: tv(TS, -10) })).toEqual({})
    expect(slotsOf({ gnssSpeed: tv(TS, -0.1) })).toEqual({})
  })

  it('converts the charge-time estimate from minutes to hours', () => {
    expect(slotsOf({ timeToEndOfCharge: tv(TS, 90) })).toEqual({ timeToFullChargeHours: 1.5 })
  })

  it('carries the properties that are already in our units', () => {
    expect(
      slotsOf({
        distanceToEmpty: tv(TS, 312.5),
        gnssBearing: tv(TS, 271),
        cabinClimateInteriorTemperature: tv(TS, 21.5),
        batteryLimit: tv(TS, 80),
        batteryCapacity: tv(TS, 131.4),
        otaCurrentVersion: tv(TS, '2026.38.1'),
        tirePressureFrontLeft: tv(TS, 2.9),
        tirePressureFrontRight: tv(TS, 2.8),
        tirePressureRearLeft: tv(TS, 2.7),
        tirePressureRearRight: tv(TS, 2.6),
      }),
    ).toEqual({
      rangeKm: 312.5,
      gpsHeading: 271,
      insideTempC: 21.5,
      chargeLimitSoc: 80,
      nominalFullPackEnergyKwh: 131.4,
      version: '2026.38.1',
      tpmsFl: 2.9,
      tpmsFr: 2.8,
      tpmsRl: 2.7,
      tpmsRr: 2.6,
    })
  })

  it('accepts a numeric string, as the Tesla decoder does', () => {
    expect(slotsOf({ batteryLevel: tv(TS, '81.5') })).toEqual({ socPct: 81.5 })
    expect(slotsOf({ batteryLevel: tv(TS, ' 81.5 ') })).toEqual({ socPct: 81.5 })
  })

  it.each([
    ['an empty string', ''],
    ['a blank string', '   '],
    ['a non-numeric string', 'abc'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['the string Infinity', 'Infinity'],
    ['a boolean', true],
    ['an object', { a: 1 }],
  ])('decodes %s to nothing, never to zero', (_label, value) => {
    expect(slotsOf({ batteryLevel: tv(TS, value) })).toEqual({})
    expect(slotsOf({ vehicleMileage: tv(TS, value) })).toEqual({})
    expect(slotsOf({ gnssSpeed: tv(TS, value) })).toEqual({})
  })

  it('refuses a number its REAL column cannot hold, which would wedge the insert', () => {
    // float4 overflows rather than saturating, and a rejected bind rolls the
    // ingest transaction back for ever (Tesla's decoder has the same guard).
    expect(slotsOf({ batteryLevel: tv(TS, 1e39) })).toEqual({})
    expect(slotsOf({ batteryLevel: tv(TS, '-1e39') })).toEqual({})
    // The conversion happens before the check: 3e38 m/s is under float4 but its
    // kph is not.
    expect(slotsOf({ gnssSpeed: tv(TS, 3e38) })).toEqual({})
    // Likewise minutes to hours: 1e39 minutes is 1.7e37 hours and fits, 1e41 does not.
    expect(slotsOf({ timeToEndOfCharge: tv(TS, 1e39) })).toEqual({
      timeToFullChargeHours: 1e39 / 60,
    })
    expect(slotsOf({ timeToEndOfCharge: tv(TS, 1e41) })).toEqual({})
    // A DOUBLE PRECISION column spans everything finite.
    expect(slotsOf({ vehicleMileage: tv(TS, 1e39) })).toEqual({ odometerKm: 1e39 / 1000 })
  })

  it('refuses a number its REAL column would UNDERFLOW, which wedges the insert too', () => {
    // '1e-50'::real is "out of range for type real" in Postgres, just as '1e39'
    // is: float4 refuses a non-zero value that rounds to zero.
    expect(slotsOf({ batteryLevel: tv(TS, 1e-50) })).toEqual({})
    expect(slotsOf({ batteryLevel: tv(TS, '-1e-50') })).toEqual({})
    expect(slotsOf({ batteryLevel: tv(TS, 1e-46) })).toEqual({})
    // The conversion happens before the check here too: 1e-44 minutes is a
    // float4 denormal, but the hours it converts to (1.7e-46) are not.
    expect(slotsOf({ timeToEndOfCharge: tv(TS, 1e-44) })).toEqual({})
    // A DOUBLE PRECISION column holds the same tiny number without complaint.
    expect(slotsOf({ vehicleMileage: tv(TS, 1e-50) })).toEqual({ odometerKm: 1e-50 / 1000 })
  })

  it('keeps what a REAL column CAN hold at both ends: zero, denormals, the largest', () => {
    // Zero is a reading, and it is the one value Math.fround(n) === 0 must not refuse.
    expect(slotsOf({ batteryLevel: tv(TS, 0) })).toEqual({ socPct: 0 })
    expect(slotsOf({ batteryLevel: tv(TS, '-0') })).toEqual({ socPct: -0 })
    // 1e-40 and 1e-45 are float4 denormals, which Postgres accepts.
    expect(slotsOf({ batteryLevel: tv(TS, 1e-40) })).toEqual({ socPct: 1e-40 })
    expect(slotsOf({ batteryLevel: tv(TS, 1e-45) })).toEqual({ socPct: 1e-45 })
    // 3.4028235e38 is above the exact largest float4 but rounds down to it, and
    // Postgres accepts it; the next decimal digit up rounds to infinity and is refused.
    expect(slotsOf({ batteryLevel: tv(TS, 3.4028235e38) })).toEqual({ socPct: 3.4028235e38 })
    expect(slotsOf({ batteryLevel: tv(TS, 3.4028236e38) })).toEqual({})
    expect(slotsOf({ batteryLevel: tv(TS, 3.4e38) })).toEqual({ socPct: 3.4e38 })
  })

  it('refuses a version that is not a plain string', () => {
    expect(slotsOf({ otaCurrentVersion: tv(TS, 2026) })).toEqual({})
    expect(slotsOf({ otaCurrentVersion: tv(TS, '') })).toEqual({})
    // Postgres TEXT cannot hold a NUL; the same wedge as a numeric overflow.
    expect(slotsOf({ otaCurrentVersion: tv(TS, 'a\u0000b') })).toEqual({})
  })
})

describe('decodeRivian: location', () => {
  it('reads latitude and longitude together', () => {
    expect(
      slotsOf({ gnssLocation: { latitude: 47.6, longitude: -122.3, timeStamp: TS } }),
    ).toEqual({ lat: 47.6, lon: -122.3 })
  })

  it('reads neither when only one of the pair is there', () => {
    // A latitude with no longitude would be plotted on the prime meridian.
    expect(slotsOf({ gnssLocation: { latitude: 47.6, timeStamp: TS } })).toEqual({})
    expect(slotsOf({ gnssLocation: { longitude: -122.3, timeStamp: TS } })).toEqual({})
    expect(
      slotsOf({ gnssLocation: { latitude: 47.6, longitude: null, timeStamp: TS } }),
    ).toEqual({})
    expect(
      slotsOf({ gnssLocation: { latitude: 'abc', longitude: -122.3, timeStamp: TS } }),
    ).toEqual({})
  })

  it('is stamped with the location\'s own timeStamp, once, for both coordinates', () => {
    const decoded = mustDecode({
      gnssLocation: { latitude: 47.6, longitude: -122.3, timeStamp: at(-5000) },
    })
    const observed = RECEIVED.getTime() - 5000
    expect(decoded.observedAt).toEqual({ lat: observed, lon: observed })
  })

  it('drops the whole location when it is too old, not one coordinate of it', () => {
    const decoded = mustDecode({
      gnssLocation: { latitude: 47.6, longitude: -122.3, timeStamp: at(-VALUE_WINDOW_MS) },
    })
    expect(decoded.slots).toEqual({})
    expect(decoded.observedAt).toEqual({})
  })
})

describe('decodeRivian: nulls and placeholders', () => {
  it('contributes nothing for a property that is null', () => {
    expect(slotsOf({ batteryLevel: null })).toEqual({})
  })

  it('contributes nothing for a property that is not an object', () => {
    expect(slotsOf({ batteryLevel: 80, gnssSpeed: 'fast', gearStatus: [] })).toEqual({})
  })

  it('contributes nothing for a null or missing value', () => {
    expect(slotsOf({ batteryLevel: tv(TS, null) })).toEqual({})
    expect(slotsOf({ batteryLevel: { timeStamp: TS } })).toEqual({})
    expect(slotsOf({ gearStatus: tv(TS, undefined) })).toEqual({})
  })

  /**
   * A property object with `placeholder` where THAT property keeps its value.
   * Most keep a `value`; `gnssLocation` keeps its pair in `latitude` and
   * `longitude`, and `cloudConnection` has no `value` at all, only `isOnline`.
   * Handing those two a `{timeStamp, value}` object would pass for the wrong
   * reason: they read neither field, so they would decode nothing whatever the
   * placeholder handling did.
   */
  const placeholderProp = (name: string, placeholder: string) => {
    if (name === 'gnssLocation') {
      return { timeStamp: TS, latitude: placeholder, longitude: placeholder }
    }
    if (name === 'cloudConnection') return { isOnline: placeholder, lastSync: placeholder }
    return tv(TS, placeholder)
  }

  it.each(PLACEHOLDERS)(
    'contributes nothing for the placeholder %s, whatever the property but gearStatus',
    (placeholder) => {
      for (const name of RIVIAN_DECODED_PROPERTIES) {
        if (name === 'gearStatus') continue
        expect(slotsOf({ [name]: placeholderProp(name, placeholder) }), name).toEqual({})
      }
    },
  )

  it.each(PLACEHOLDERS)('reads the placeholder %s on gearStatus as an explicit null gear', (p) => {
    expect(slotsOf({ gearStatus: placeholderProp('gearStatus', p) })).toEqual({ gear: null })
  })

  it('reads the structured properties\' own fields, so the cases above are not vacuous', () => {
    // The same two shapes, with real values in the fields the placeholders
    // occupied above, DO decode.
    expect(
      slotsOf({ gnssLocation: { timeStamp: TS, latitude: 47.6, longitude: -122.3 } }),
    ).toEqual({ lat: 47.6, lon: -122.3 })
    expect(slotsOf({ cloudConnection: { isOnline: true, lastSync: TS } })).toEqual({
      cloudOnline: true,
    })
  })

  it.each(PLACEHOLDERS)('refuses the placeholder %s in a location field, and the pair', (p) => {
    const at47 = { timeStamp: TS, latitude: 47.6, longitude: -122.3 }
    expect(slotsOf({ gnssLocation: { ...at47, latitude: p } })).toEqual({})
    expect(slotsOf({ gnssLocation: { ...at47, longitude: p } })).toEqual({})
    expect(slotsOf({ gnssLocation: { ...at47, latitude: p, longitude: p } })).toEqual({})
  })

  it.each(PLACEHOLDERS)('refuses the placeholder %s as isOnline, on property and stream', (p) => {
    expect(slotsOf({ cloudConnection: { isOnline: p, lastSync: TS } })).toEqual({})
    const cloud = decodeRivian(
      envelope('cloud', { data: { vehicleCloudConnection: { isOnline: p } } }),
      RECEIVED,
      W,
    )
    expect(cloud?.slots).toEqual({})
  })

  it('leaves a placeholder in one property from touching its neighbours', () => {
    expect(
      slotsOf({ batteryLevel: tv(TS, 'fault'), distanceToEmpty: tv(TS, 200) }),
    ).toEqual({ rangeKm: 200 })
  })

  it('does not count a property that decoded to nothing as untimed', () => {
    expect(mustDecode({ batteryLevel: tv('garbage', null) }).untimed).toBe(0)
    expect(mustDecode({ batteryLevel: tv('garbage', 'fault') }).untimed).toBe(0)
  })
})

describe('decodeRivian: clocks', () => {
  it('stamps a slot with the property\'s timeStamp, in ms', () => {
    const decoded = mustDecode({ batteryLevel: tv(at(-5000), 50) })
    expect(decoded.observedAt).toEqual({ socPct: RECEIVED.getTime() - 5000 })
    expect(decoded.untimed).toBe(0)
  })

  it('clamps a timeStamp from the future to the frame\'s arrival', () => {
    // A vehicle clock ahead of ours must not make a value look fresher than the
    // frame that carried it (spec §6.4).
    const decoded = mustDecode({ batteryLevel: tv(at(10_000), 50) })
    expect(decoded.observedAt).toEqual({ socPct: RECEIVED.getTime() })
    expect(decoded.slots).toEqual({ socPct: 50 })
  })

  it('applies nothing for a volatile slot older than its window', () => {
    const decoded = mustDecode({ gnssSpeed: tv(at(-3 * 3_600_000), 20) })
    expect(decoded.slots).toEqual({})
    expect(decoded.observedAt).toEqual({})
  })

  it('applies a slow slot at the same age, stamped with that age', () => {
    const decoded = mustDecode({ batteryLevel: tv(at(-3 * 3_600_000), 70) })
    expect(decoded.slots).toEqual({ socPct: 70 })
    expect(decoded.observedAt).toEqual({ socPct: RECEIVED.getTime() - 3 * 3_600_000 })
  })

  it('drops a value exactly one window old, and keeps one a millisecond younger', () => {
    // The accumulator drops at `age >= window`, so the decoder agrees: a value
    // that would expire at the next emit is not applied just to be expired.
    expect(slotsOf({ gnssSpeed: tv(at(-SPEED_WINDOW_MS), 20) })).toEqual({})
    expect(slotsOf({ gnssSpeed: tv(at(-SPEED_WINDOW_MS + 1), 20) }).speedKph).toBeCloseTo(72, 10)
    expect(slotsOf({ batteryLevel: tv(at(-VALUE_WINDOW_MS), 70) })).toEqual({})
    expect(slotsOf({ batteryLevel: tv(at(-VALUE_WINDOW_MS + 1), 70) })).toEqual({ socPct: 70 })
  })

  it('asks the profile for each slot\'s window, not a constant of its own', () => {
    const decoded = decodeRivian(
      stateEnvelope(RECEIVED.toISOString(), { batteryLevel: tv(at(-1000), 70) }),
      RECEIVED,
      () => 500,
    )
    expect(decoded?.slots).toEqual({})
  })

  it('applies an untimed value with no observedAt, and counts it', () => {
    const decoded = mustDecode({ batteryLevel: tv('garbage', 50) })
    expect(decoded.slots).toEqual({ socPct: 50 })
    expect(decoded.observedAt).not.toHaveProperty('socPct')
    expect(decoded.untimed).toBe(1)
  })

  it('counts a missing or non-string timeStamp as untimed too', () => {
    const decoded = mustDecode({
      batteryLevel: { value: 50 },
      distanceToEmpty: { timeStamp: 1760000000000, value: 200 },
      batteryLimit: tv(TS, 80),
    })
    expect(decoded.slots).toEqual({ socPct: 50, rangeKm: 200, chargeLimitSoc: 80 })
    expect(Object.keys(decoded.observedAt)).toEqual(['chargeLimitSoc'])
    expect(decoded.untimed).toBe(2)
  })

  it('applies an untimed volatile value at arrival, since it has no age to judge', () => {
    // There is no timestamp to measure against, so it falls back to arrival
    // (spec §6.4) and is counted, rather than being guessed stale.
    const decoded = mustDecode({ gnssSpeed: tv('garbage', 10) })
    expect(decoded.slots).toEqual({ speedKph: 36 })
    expect(decoded.untimed).toBe(1)
  })
})

/**
 * `arrivalStamped` names the slots whose `observedAt` the decoder made up from
 * the frame's arrival, because Rivian gave no observation time for them. The
 * accumulator needs the distinction: an arrival stamp is strictly newer on every
 * snapshot, so without it an UNCHANGED value is indistinguishable from news and
 * every per-minute resubscribe would land (spec §7.6).
 */
describe('decodeRivian: slots stamped with their arrival', () => {
  it('names cloudOnline from the cloudConnection property', () => {
    const decoded = mustDecode({ cloudConnection: { isOnline: true, lastSync: TS } })
    expect([...decoded.arrivalStamped]).toEqual(['cloudOnline'])
  })

  it('names the cloud stream\'s cloudOnline', () => {
    const decoded = decodeRivian(
      envelope('cloud', { data: { vehicleCloudConnection: { isOnline: false } } }), RECEIVED, W)
    expect([...decoded!.arrivalStamped]).toEqual(['cloudOnline'])
  })

  it('names every slot the charging stream filled, and only those', () => {
    const decoded = decodeRivian(
      envelope('charging', {
        data: { chargingSession: { liveData: { powerKW: 7.2, totalChargedEnergy: 'abc', vehicleChargerState: 'charging_active' } } },
      }),
      RECEIVED,
      W,
    )
    expect([...decoded!.arrivalStamped].sort()).toEqual(['chargePowerKw', 'chargerState'])
  })

  it('does not name a property that carried its own timeStamp', () => {
    const decoded = mustDecode({
      batteryLevel: tv(TS, 50),
      cloudConnection: { isOnline: true },
    })
    expect([...decoded.arrivalStamped]).toEqual(['cloudOnline'])
    expect(decoded.slots).toHaveProperty('socPct')
  })

  it('does not name an untimed property, which has no observedAt to be suspicious of', () => {
    // It falls back to arrival with NO observedAt key and is counted untimed
    // (spec §6.4); the accumulator already lands it every time.
    const decoded = mustDecode({ batteryLevel: tv('garbage', 50) })
    expect(decoded.slots).toEqual({ socPct: 50 })
    expect([...decoded.arrivalStamped]).toEqual([])
  })

  it('is empty for a frame of timed properties only', () => {
    expect([...mustDecode({ batteryLevel: tv(TS, 50), gearStatus: tv(TS, 'park') }).arrivalStamped])
      .toEqual([])
  })
})

describe('decodeRivian: gear', () => {
  it('reads gearStatus as a canonical letter', () => {
    expect(slotsOf({ gearStatus: tv(TS, 'drive') })).toEqual({ gear: 'D' })
    expect(slotsOf({ gearStatus: tv(TS, 'park') })).toEqual({ gear: 'P' })
    expect(slotsOf({ gearStatus: tv(TS, 'reverse') })).toEqual({ gear: 'R' })
    expect(slotsOf({ gearStatus: tv(TS, 'neutral') })).toEqual({ gear: 'N' })
  })

  it('writes an EXPLICIT null for a gear it cannot name, so a carried D is overwritten', () => {
    const slots = slotsOf({ gearStatus: tv(TS, 'sport') })
    expect(slots).toEqual({ gear: null })
    expect(Object.hasOwn(slots, 'gear')).toBe(true)
  })

  it('writes nothing for a gear that is not a string', () => {
    for (const value of [4, true, {}, [], null, undefined]) {
      expect(slotsOf({ gearStatus: tv(TS, value) }), String(value)).toEqual({})
    }
  })

  it.each(PLACEHOLDERS)(
    'lets the placeholder %s overwrite a carried D, as an explicit null gear',
    (placeholder) => {
      // The car was in Drive, then the selector stopped vouching for itself. The
      // accumulator overwrites a slot only with a key that is PRESENT, so the
      // null must be a key: nothing would carry the D and hold the drive open.
      const carried = mustDecode({ gearStatus: tv(at(-60_000), 'drive') })
      const cleared = mustDecode({ gearStatus: tv(TS, placeholder) })
      expect(Object.hasOwn(cleared.slots, 'gear')).toBe(true)
      expect(cleared.slots['gear']).toBeNull()
      // Stamped like any gear, and newer than the D it clears.
      expect(cleared.observedAt['gear']).toBe(RECEIVED.getTime() - 1000)
      expect(cleared.observedAt['gear']).toBeGreaterThan(carried.observedAt['gear']!)
      // The accumulator's overwrite, in miniature: later keys replace earlier ones.
      expect({ ...carried.slots, ...cleared.slots }['gear']).toBeNull()
      // Control: the same placeholder on any other property leaves the D alone.
      const other = mustDecode({ batteryLevel: tv(TS, placeholder) })
      expect({ ...carried.slots, ...other.slots }['gear']).toBe('D')
    },
  )

  it('does not apply a placeholder gear that is already too old, as with any gear', () => {
    expect(slotsOf({ gearStatus: tv(at(-VALUE_WINDOW_MS), 'fault') })).toEqual({})
  })

  it('treats a sleeping car as in Park, as Tesla\'s null gear is', () => {
    expect(slotsOf({ powerState: tv(TS, 'sleep') })).toEqual({ powerStateRaw: 'sleep', gear: 'P' })
    expect(slotsOf({ powerState: tv(TS, 'standby') })).toEqual({
      powerStateRaw: 'standby',
      gear: 'P',
    })
  })

  it('leaves gear alone for a powerState that does not power the drive system down', () => {
    expect(slotsOf({ powerState: tv(TS, 'go') })).toEqual({ powerStateRaw: 'go' })
    expect(slotsOf({ powerState: tv(TS, 'ready') })).toEqual({ powerStateRaw: 'ready' })
    expect(slotsOf({ powerState: tv(TS, 'vehicle_reset') })).toEqual({
      powerStateRaw: 'vehicle_reset',
    })
  })

  it('stamps the gear it infers with the powerState\'s own time', () => {
    const decoded = mustDecode({ powerState: tv(at(-7000), 'sleep') })
    const observed = RECEIVED.getTime() - 7000
    expect(decoded.observedAt).toEqual({ powerStateRaw: observed, gear: observed })
  })

  it('lets the newer of gearStatus and a sleeping powerState win within one frame', () => {
    // Both write `gear`, and the accumulator resolves a conflict between FRAMES,
    // not inside one `slots` record, so a re-sent snapshot carrying both must be
    // settled here. The car said `drive`, then went to sleep a minute later.
    const sleptLater = mustDecode({
      gearStatus: tv(at(-120_000), 'drive'),
      powerState: tv(at(-60_000), 'sleep'),
    })
    expect(sleptLater.slots['gear']).toBe('P')
    expect(sleptLater.observedAt['gear']).toBe(RECEIVED.getTime() - 60_000)

    // The reverse order of the properties in the frame must not matter.
    const sleptLaterReordered = mustDecode({
      powerState: tv(at(-60_000), 'sleep'),
      gearStatus: tv(at(-120_000), 'drive'),
    })
    expect(sleptLaterReordered.slots['gear']).toBe('P')

    // And a drive selected after waking is a drive.
    const droveLater = mustDecode({
      powerState: tv(at(-120_000), 'sleep'),
      gearStatus: tv(at(-60_000), 'drive'),
    })
    expect(droveLater.slots['gear']).toBe('D')
    expect(droveLater.observedAt['gear']).toBe(RECEIVED.getTime() - 60_000)
  })

  it('prefers the gear the car reported to the one it inferred, when both are as old', () => {
    for (const props of [
      { powerState: tv(TS, 'sleep'), gearStatus: tv(TS, 'drive') },
      { gearStatus: tv(TS, 'drive'), powerState: tv(TS, 'sleep') },
    ]) {
      expect(mustDecode(props).slots['gear']).toBe('D')
    }
  })

  it.each(PLACEHOLDERS)(
    'resolves a same-timestamp sleeping powerState and gearStatus %s to gear null',
    (placeholder) => {
      // The inferred P and the placeholder are equally old, so the tie goes to
      // gearStatus, the car's own report, whichever order the frame lists them
      // in. Its explicit null is the more cautious answer: it clears a carried D
      // and claims no Park the car did not report.
      for (const props of [
        { powerState: tv(TS, 'sleep'), gearStatus: tv(TS, placeholder) },
        { gearStatus: tv(TS, placeholder), powerState: tv(TS, 'sleep') },
      ]) {
        const decoded = mustDecode(props)
        expect(Object.hasOwn(decoded.slots, 'gear')).toBe(true)
        expect(decoded.slots['gear']).toBeNull()
        expect(decoded.slots['powerStateRaw']).toBe('sleep')
      }
    },
  )

  it('still lets a newer sleeping powerState win over an older placeholder gear', () => {
    const decoded = mustDecode({
      gearStatus: tv(at(-120_000), 'fault'),
      powerState: tv(at(-60_000), 'sleep'),
    })
    expect(decoded.slots['gear']).toBe('P')
  })

  it('treats an untimed property as the newest candidate for a slot, as arrival is', () => {
    // An untimed value falls back to arrival, the newest moment there is, so it
    // is treated as the newest candidate.
    const decoded = mustDecode({
      gearStatus: tv('garbage', 'drive'),
      powerState: tv(at(-60_000), 'sleep'),
    })
    expect(decoded.slots['gear']).toBe('D')
  })
})

describe('decodeRivian: locks and doors', () => {
  it('keeps one slot per property, named for it', () => {
    expect(
      slotsOf({
        doorFrontLeftLocked: tv(TS, 'locked'),
        closureFrunkLocked: tv(TS, 'unlocked'),
        doorRearRightClosed: tv(TS, 'open'),
        closureTonneauClosed: tv(TS, 'closed'),
      }),
    ).toEqual({
      doorFrontLeftLocked: 'locked',
      closureFrunkLocked: 'unlocked',
      doorRearRightClosed: 'open',
      closureTonneauClosed: 'closed',
    })
  })

  it('refuses a word outside the vocabulary rather than guessing at it', () => {
    expect(slotsOf({ doorFrontLeftLocked: tv(TS, 'ajar') })).toEqual({})
    expect(slotsOf({ doorFrontLeftLocked: tv(TS, 'open') })).toEqual({})
    expect(slotsOf({ doorFrontLeftClosed: tv(TS, 'locked') })).toEqual({})
    expect(slotsOf({ doorFrontLeftClosed: tv(TS, 'OPEN') })).toEqual({})
    expect(slotsOf({ doorFrontLeftLocked: tv(TS, true) })).toEqual({})
  })
})

describe('decodeRivian: the other slots', () => {
  it('reads the cloud connection from the property, stamped with arrival and not untimed', () => {
    const decoded = mustDecode({
      cloudConnection: { isOnline: false, lastSync: '2026-10-19T11:00:00.000Z' },
    })
    expect(decoded.slots).toEqual({ cloudOnline: false })
    // It has no timeStamp of its own, so the frame's arrival is its observation
    // time. Giving it one is what lets the accumulator's newer-wins guard apply,
    // so an old replay cannot overwrite a newer report.
    expect(decoded.observedAt).toEqual({ cloudOnline: RECEIVED.getTime() })
    expect(decoded.untimed).toBe(0)
  })

  it('reads isOnline only when it is a boolean', () => {
    expect(slotsOf({ cloudConnection: { isOnline: true } })).toEqual({ cloudOnline: true })
    expect(slotsOf({ cloudConnection: { isOnline: 'false' } })).toEqual({})
    expect(slotsOf({ cloudConnection: { isOnline: null } })).toEqual({})
    expect(slotsOf({ cloudConnection: { lastSync: '2026-10-19T11:00:00.000Z' } })).toEqual({})
  })

  it('reads the charger state and status as the strings the car sent', () => {
    expect(
      slotsOf({
        chargerState: tv(TS, 'charging_active'),
        chargerStatus: tv(TS, 'chrgr_sts_connected_charging'),
      }),
    ).toEqual({ chargerState: 'charging_active', chargerStatus: 'chrgr_sts_connected_charging' })
    expect(slotsOf({ chargerState: tv(TS, '') })).toEqual({})
    expect(slotsOf({ chargerState: tv(TS, 5) })).toEqual({})
  })

  it('reads the charging stream\'s live data, stamped with arrival', () => {
    const decoded = decodeRivian(
      envelope('charging', {
        data: {
          chargingSession: {
            liveData: {
              powerKW: 7.2,
              totalChargedEnergy: 3.4,
              vehicleChargerState: 'charging_active',
              timeElapsed: '1800',
              price: null,
            },
            chartData: { soc: [1, 2, 3] },
          },
        },
      }),
      RECEIVED,
      W,
    )
    expect(decoded?.slots).toEqual({
      chargePowerKw: 7.2,
      chargeEnergyAddedKwh: 3.4,
      chargerState: 'charging_active',
    })
    // No per-field timestamps (spec §6.4): arrival is the observation, so a
    // subscribe snapshot's older chargerState cannot overwrite it.
    expect(decoded?.observedAt).toEqual({
      chargePowerKw: RECEIVED.getTime(),
      chargeEnergyAddedKwh: RECEIVED.getTime(),
      chargerState: RECEIVED.getTime(),
    })
    expect(decoded?.untimed).toBe(0)
  })

  it('reads only what is readable from the charging stream, and never zero for the rest', () => {
    const decoded = decodeRivian(
      envelope('charging', {
        data: {
          chargingSession: {
            liveData: { powerKW: null, totalChargedEnergy: 'abc', vehicleChargerState: 'fault' },
          },
        },
      }),
      RECEIVED,
      W,
    )
    expect(decoded?.slots).toEqual({})
  })

  it('reads the cloud stream\'s isOnline', () => {
    const decoded = decodeRivian(
      envelope('cloud', { data: { vehicleCloudConnection: { isOnline: true } } }),
      RECEIVED,
      W,
    )
    expect(decoded?.slots).toEqual({ cloudOnline: true })
    expect(decoded?.observedAt).toEqual({ cloudOnline: RECEIVED.getTime() })
    expect(decoded?.untimed).toBe(0)
  })

  it('answers null for a stream it does not decode', () => {
    for (const stream of ['parallax', 'meta', 'ota', 'geofence', 'departure']) {
      expect(decodeRivian(envelope(stream, { data: {} }), RECEIVED, W)).toBeNull()
    }
  })

  it('answers null for an unknown envelope version or no envelope at all', () => {
    expect(decodeRivian(envelope('state', { data: {} }, { v: 2 }), RECEIVED, W)).toBeNull()
    for (const garbage of [null, undefined, 42, 'state', [], {}, { v: 1 }]) {
      expect(decodeRivian(garbage, RECEIVED, W)).toBeNull()
    }
  })

  it('answers null for a body that has nowhere to look for properties', () => {
    for (const body of [
      null,
      'x',
      [],
      {},
      { errors: [{ message: 'boom' }] },
      { data: null },
      { data: { vehicleState: null } },
      { data: { vehicleState: [] } },
    ]) {
      expect(decodeRivian(envelope('state', body), RECEIVED, W)).toBeNull()
    }
    const read = (stream: string, data: unknown) =>
      decodeRivian(envelope(stream, { data }), RECEIVED, W)
    expect(read('charging', { chargingSession: null })).toBeNull()
    expect(read('charging', { chargingSession: { liveData: null } })).toBeNull()
    expect(read('cloud', { vehicleCloudConnection: null })).toBeNull()
  })

  it('answers an empty fragment, not null, for properties it does not know', () => {
    const decoded = mustDecode({ someFutureThing: tv(TS, 1) })
    expect(decoded.slots).toEqual({})
    expect(decoded.observedAt).toEqual({})
    expect(decoded.untimed).toBe(0)
  })

  it('ignores a property named like an Object property', () => {
    const body = JSON.parse(
      `{"data":{"vehicleState":{"constructor":{"timeStamp":"${TS}","value":1},` +
        `"__proto__":{"timeStamp":"${TS}","value":2},"toString":{"timeStamp":"${TS}","value":3}}}}`,
    )
    expect(decodeRivian(envelope('state', body), RECEIVED, W)?.slots).toEqual({})
  })

  it('takes every property of a frame in one pass', () => {
    const decoded = mustDecode({
      batteryLevel: tv(TS, 81.5),
      gnssSpeed: tv(TS, 10),
      gnssLocation: { latitude: 47.6, longitude: -122.3, timeStamp: TS },
      someFutureThing: tv(TS, 1),
    })
    expect(decoded.slots).toEqual({ socPct: 81.5, speedKph: 36, lat: 47.6, lon: -122.3 })
    expect(Object.keys(decoded.observedAt).sort()).toEqual(['lat', 'lon', 'socPct', 'speedKph'])
  })
})

describe('the property table and the catalogue', () => {
  it('decodes only properties the connector subscribes to, in the shape it asks for', () => {
    // A property decoded here but absent from the catalogue would never reach
    // the tape: a decoder for nothing, and no error to say so.
    const shapes = new Map(RIVIAN_PROPERTIES.map((p) => [p.name, p.shape]))
    for (const name of RIVIAN_DECODED_PROPERTIES) {
      expect(shapes.has(name), `${name} is not in the catalogue`).toBe(true)
    }
    expect(shapes.get('gnssLocation')).toBe('location')
    expect(shapes.get('cloudConnection')).toBe('cloudConnection')
    for (const name of RIVIAN_DECODED_PROPERTIES) {
      if (name !== 'gnssLocation' && name !== 'cloudConnection') {
        expect(shapes.get(name), `${name} must be a plain timeStamp/value property`).toBe('value')
      }
    }
  })

  it('has ten locks and the ten matching closures', () => {
    expect(LOCK_PROPERTIES).toHaveLength(10)
    expect(CLOSED_PROPERTIES).toHaveLength(10)
    expect(new Set(LOCK_PROPERTIES).size).toBe(10)
    expect(CLOSED_PROPERTIES).toEqual(LOCK_PROPERTIES.map((n) => n.replace(/Locked$/, 'Closed')))
    expect(LOCK_PROPERTIES[0]).toBe('doorFrontLeftLocked')
    expect(LOCK_PROPERTIES[9]).toBe('closureSideBinRightLocked')
    for (const name of [...LOCK_PROPERTIES, ...CLOSED_PROPERTIES]) {
      expect(RIVIAN_DECODED_PROPERTIES).toContain(name)
    }
  })

  it('names the slots the profile hands the accumulator', () => {
    expect(RIVIAN_VOLATILE_SLOTS).toEqual(['speedKph', 'gpsHeading', 'chargePowerKw'])
    expect(RIVIAN_CHARGE_STATE_SLOTS).toEqual(['chargerState', 'chargerStatus'])
    expect(RIVIAN_CHARGING_POWER_SLOTS).toEqual(['chargePowerKw'])
    expect(RIVIAN_CHARGING_ENERGY_SLOTS).toEqual(['chargeEnergyAddedKwh'])
  })

  it('holds the exported slot lists to named slots, so a misspelling cannot compile', () => {
    // The first assignment is the real declarations' constraint: each exported
    // list must be assignable to `readonly RivianNamedSlot[]`. `typecheck`
    // compiles this file (tsconfig.test.json), so loosening an export back to
    // `readonly string[]`, or putting a non-slot in a list, fails it here as
    // well as at the declaration.
    const lists: ReadonlyArray<readonly RivianNamedSlot[]> = [
      RIVIAN_VOLATILE_SLOTS,
      RIVIAN_CHARGE_STATE_SLOTS,
      RIVIAN_CHARGING_POWER_SLOTS,
      RIVIAN_CHARGING_ENERGY_SLOTS,
    ]
    expect(lists.every((list) => list.length > 0)).toBe(true)

    // The control: the same annotation does refuse a misspelling. Without it the
    // assignment above proves nothing, since a type that accepts everything
    // would pass it too.
    // @ts-expect-error 'gpsHeadng' is not a slot
    const misspelt: readonly RivianNamedSlot[] = ['speedKph', 'gpsHeadng']
    expect(misspelt).toHaveLength(2)
  })
})

const VEHICLE = 'r2'
const TS_OUT = new Date('2026-10-19T12:00:00.000Z')
const sampleOf = (state: Record<string, unknown>) => rivianStateToSample(VEHICLE, TS_OUT, state)

describe('rivianStateToSample: power state', () => {
  it('reads a car the cloud calls offline as offline, whatever its last power state', () => {
    expect(sampleOf({ cloudOnline: false, powerStateRaw: 'go' }).powerState).toBe('offline')
    expect(sampleOf({ cloudOnline: false }).powerState).toBe('offline')
  })

  it('reads sleep as asleep', () => {
    expect(sampleOf({ powerStateRaw: 'sleep' }).powerState).toBe('asleep')
    expect(sampleOf({ powerStateRaw: 'sleep', cloudOnline: true }).powerState).toBe('asleep')
  })

  it.each(['go', 'ready', 'standby', 'vehicle_reset'])('reads %s as online', (raw) => {
    expect(sampleOf({ powerStateRaw: raw }).powerState).toBe('online')
  })

  it('reads an unknown or absent power state as null, not as a guess', () => {
    expect(sampleOf({ powerStateRaw: 'hibernating' }).powerState).toBeNull()
    expect(sampleOf({ powerStateRaw: 'constructor' }).powerState).toBeNull()
    expect(sampleOf({ powerStateRaw: 7 }).powerState).toBeNull()
    expect(sampleOf({}).powerState).toBeNull()
    expect(sampleOf({ cloudOnline: true }).powerState).toBeNull()
  })
})

describe('rivianStateToSample: charge state (spec §7.3)', () => {
  const chargeOf = (chargerState: unknown, chargerStatus?: unknown) =>
    sampleOf({
      ...(chargerState === undefined ? {} : { chargerState }),
      ...(chargerStatus === undefined ? {} : { chargerStatus }),
    }).chargeState

  it('lets not_connected win over everything, charging_active included', () => {
    expect(chargeOf('charging_active', 'chrgr_sts_not_connected')).toBe('disconnected')
    expect(chargeOf('charging_complete', 'chrgr_sts_not_connected')).toBe('disconnected')
    expect(chargeOf(undefined, 'chrgr_sts_not_connected')).toBe('disconnected')
  })

  it('reads charging_active as charging, connected status or none', () => {
    expect(chargeOf('charging_active', 'chrgr_sts_connected_charging')).toBe('charging')
    expect(chargeOf('charging_active')).toBe('charging')
  })

  it('reads charging_complete as complete', () => {
    expect(chargeOf('charging_complete', 'chrgr_sts_connected_no_chrg')).toBe('complete')
    expect(chargeOf('charging_complete')).toBe('complete')
  })

  it('does not call charging_connecting charging: no energy flows on a handshake', () => {
    expect(chargeOf('charging_connecting', 'chrgr_sts_connected_no_chrg')).toBe('connected')
    expect(chargeOf('charging_connecting')).toBeNull()
  })

  it('reads any other state with a connected status as connected', () => {
    expect(chargeOf('charging_ready', 'chrgr_sts_connected_no_chrg')).toBe('connected')
    expect(chargeOf('some_future_state', 'chrgr_sts_connected_future')).toBe('connected')
    // A connected status is the evidence; the state need not be reported.
    expect(chargeOf(undefined, 'chrgr_sts_connected_no_chrg')).toBe('connected')
  })

  it('reads an unknown state with no status, or an unknown status, as null', () => {
    expect(chargeOf('some_future_state')).toBeNull()
    expect(chargeOf('some_future_state', 'chrgr_sts_something_else')).toBeNull()
    expect(chargeOf(undefined, 'chrgr_sts_something_else')).toBeNull()
    expect(chargeOf(undefined)).toBeNull()
    expect(chargeOf(5, 6)).toBeNull()
  })
})

describe('rivianStateToSample: locks and doors', () => {
  it('reads locked as true only when every reported lock is locked', () => {
    expect(
      sampleOf({ doorFrontLeftLocked: 'locked', closureFrunkLocked: 'locked' }).locked,
    ).toBe(true)
    expect(sampleOf({ doorFrontLeftLocked: 'locked' }).locked).toBe(true)
  })

  it('reads one unlocked lock as false', () => {
    expect(
      sampleOf({
        doorFrontLeftLocked: 'locked',
        doorRearLeftLocked: 'locked',
        closureTailgateLocked: 'unlocked',
      }).locked,
    ).toBe(false)
  })

  it('reads no lock at all as null, never as unlocked', () => {
    expect(sampleOf({}).locked).toBeNull()
    expect(sampleOf({ doorFrontLeftClosed: 'closed' }).locked).toBeNull()
  })

  it('reads doorsOpen as true when any closure is open', () => {
    expect(
      sampleOf({ doorFrontLeftClosed: 'closed', closureLiftgateClosed: 'open' }).doorsOpen,
    ).toBe(true)
  })

  it('reads doorsOpen as false when everything reported is closed', () => {
    expect(
      sampleOf({ doorFrontLeftClosed: 'closed', closureFrunkClosed: 'closed' }).doorsOpen,
    ).toBe(false)
  })

  it('reads no closure at all as null, never as closed', () => {
    expect(sampleOf({}).doorsOpen).toBeNull()
    expect(sampleOf({ doorFrontLeftLocked: 'locked' }).doorsOpen).toBeNull()
  })

  it('reads every lock and every closure the table names', () => {
    for (const name of LOCK_PROPERTIES) {
      expect(sampleOf({ [name]: 'unlocked' }).locked, name).toBe(false)
    }
    for (const name of CLOSED_PROPERTIES) {
      expect(sampleOf({ [name]: 'open' }).doorsOpen, name).toBe(true)
    }
  })

  it('ignores a value outside the vocabulary', () => {
    expect(sampleOf({ doorFrontLeftLocked: 'ajar' }).locked).toBeNull()
    expect(sampleOf({ doorFrontLeftClosed: 7 }).doorsOpen).toBeNull()
  })
})

describe('rivianStateToSample: tyres, gear and the rest', () => {
  it('collects the corners that were reported into the tpms record', () => {
    expect(sampleOf({ tpmsFl: 2.9, tpmsRr: 2.8 }).tpms).toEqual({ fl: 2.9, rr: 2.8 })
    expect(sampleOf({ tpmsFl: 2.9, tpmsFr: 2.8, tpmsRl: 2.7, tpmsRr: 2.6 }).tpms).toEqual({
      fl: 2.9,
      fr: 2.8,
      rl: 2.7,
      rr: 2.6,
    })
  })

  it('reads no corner at all as null, not an empty record', () => {
    expect(sampleOf({}).tpms).toBeNull()
    expect(sampleOf({ tpmsFl: null }).tpms).toBeNull()
  })

  it('forces a car in Park to speed 0, because GPS speed there is noise', () => {
    expect(sampleOf({ gear: 'P', speedKph: 3 }).speedKph).toBe(0)
    expect(sampleOf({ gear: 'D', speedKph: 3 }).speedKph).toBe(3)
    expect(sampleOf({ gear: 'R', speedKph: 3 }).speedKph).toBe(3)
    expect(sampleOf({ gear: null, speedKph: 3 }).speedKph).toBe(3)
    expect(sampleOf({ speedKph: 3 }).speedKph).toBe(3)
  })

  it('does not invent a speed for a car in Park that reported none', () => {
    expect(sampleOf({ gear: 'P' }).speedKph).toBeNull()
    expect(sampleOf({ gear: 'P' }).gear).toBe('P')
  })

  it('passes the charging power and energy through', () => {
    const sample = sampleOf({ chargePowerKw: 7.2, chargeEnergyAddedKwh: 3.4 })
    expect(sample.chargePowerKw).toBe(7.2)
    expect(sample.chargeEnergyAddedKwh).toBe(3.4)
  })

  it('leaves everything it was not told about null, never zero', () => {
    const sample = sampleOf({})
    expect(sample.vehicleId).toBe(VEHICLE)
    expect(sample.ts).toBe(TS_OUT)
    for (const column of SAMPLE_COLUMNS) {
      expect(sample[column.key as keyof typeof sample], column.key).toBeNull()
    }
  })

  it('keeps a reported zero, which is a reading', () => {
    const sample = sampleOf({ socPct: 0, speedKph: 0, chargePowerKw: 0, odometerKm: 0 })
    expect(sample.socPct).toBe(0)
    expect(sample.speedKph).toBe(0)
    expect(sample.chargePowerKw).toBe(0)
    expect(sample.odometerKm).toBe(0)
  })

  it('carries an explicit null gear as null', () => {
    expect(sampleOf({ gear: null }).gear).toBeNull()
  })

  it('refuses a slot holding the wrong type, which would be a bind error', () => {
    const sample = sampleOf({
      socPct: '80',
      odometerKm: Number.NaN,
      lat: null,
      gear: 'Z',
      version: 5,
      chargePowerKw: { kw: 7 },
      tpmsFl: 'x',
    })
    expect(sample.socPct).toBeNull()
    expect(sample.odometerKm).toBeNull()
    expect(sample.lat).toBeNull()
    expect(sample.gear).toBeNull()
    expect(sample.version).toBeNull()
    expect(sample.chargePowerKw).toBeNull()
    expect(sample.tpms).toBeNull()
  })

  it('fills only real columns, from a fully populated state', () => {
    const sample = sampleOf({
      socPct: 80,
      rangeKm: 300,
      odometerKm: 1000,
      lat: 47.6,
      lon: -122.3,
      speedKph: 50,
      gpsHeading: 90,
      powerStateRaw: 'go',
      cloudOnline: true,
      chargerState: 'charging_active',
      chargerStatus: 'chrgr_sts_connected_charging',
      insideTempC: 20,
      tpmsFl: 2.9,
      tpmsFr: 2.8,
      tpmsRl: 2.7,
      tpmsRr: 2.6,
      gear: 'D',
      chargeLimitSoc: 80,
      nominalFullPackEnergyKwh: 131.4,
      timeToFullChargeHours: 1.5,
      version: '2026.38.1',
      chargePowerKw: 7.2,
      chargeEnergyAddedKwh: 3.4,
      doorFrontLeftLocked: 'locked',
      doorFrontLeftClosed: 'closed',
    })
    const columns = new Set<string>(SAMPLE_COLUMNS.map((c) => c.key))
    const filled = Object.entries(sample)
      .filter(([, value]) => value !== null)
      .map(([key]) => key)
    for (const key of filled) {
      if (key === 'vehicleId' || key === 'ts') continue
      expect(columns.has(key), `${key} is not a SAMPLE_COLUMNS key`).toBe(true)
    }
    expect(filled.filter((k) => k !== 'vehicleId' && k !== 'ts').sort()).toEqual(
      [
        'socPct', 'rangeKm', 'odometerKm', 'lat', 'lon', 'speedKph', 'gpsHeading',
        'powerState', 'chargeState', 'insideTempC', 'locked', 'doorsOpen', 'tpms', 'gear',
        'chargeLimitSoc', 'nominalFullPackEnergyKwh', 'timeToFullChargeHours', 'version',
        'chargePowerKw', 'chargeEnergyAddedKwh',
      ].sort(),
    )
    expect(sample.powerState).toBe('online')
    expect(sample.chargeState).toBe('charging')
    expect(sample.locked).toBe(true)
    expect(sample.doorsOpen).toBe(false)
    expect(sample.tpms).toEqual({ fl: 2.9, fr: 2.8, rl: 2.7, rr: 2.6 })
  })
})
