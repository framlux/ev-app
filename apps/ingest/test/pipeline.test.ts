import { describe, expect, it } from 'vitest'
import { DEFAULT_SEGMENTER_OPTIONS, makeSample, type RawMessage } from '@ev/core'
import { TESLA_FIELDS, slotsOf, teslaStateToSample } from '@ev/tesla'
import {
  FieldAccumulator,
  MAX_SAMPLE_INTERVAL_MS,
  Pipeline,
  QUIET_PERIOD_MS,
  STALE_VALUE_MS,
  VOLATILE_FIELDS,
  VOLATILE_STALE_MS,
  staleWindowFor,
} from '../src/pipeline.js'
import { FakeDb, openSessions } from './support/fake-db.js'

const OPTS = { usableCapacityKwh: 75 }
const VIN = '5YJ3E1EA1JF000001'
/** 40 mph. The segmenter's moving threshold is 1 kph and Tesla streams mph. */
const MOVING = 40
const t = (iso: string) => new Date(iso)
/** The driveway, 100 m across. Seattle, hence the negative longitude. */
const HOME = { lat: 47.6062, lon: -122.3321, radiusKm: 0.1 }
const OLD_RATE = {
  id: 'r-old', effectiveFrom: t('2026-01-01T00:00:00.000Z'), pricePerKwh: 0.1,
  currency: 'USD', source: 'urdb' as const, urdbLabel: 'PSE Schedule 7',
  fetchedAt: t('2026-01-01T00:00:00.000Z'),
}
const NEW_RATE = { ...OLD_RATE, id: 'r-new', effectiveFrom: t('2026-09-05T00:00:00.000Z'), pricePerKwh: 0.2 }

/**
 * One fleet-telemetry MQTT message: ONE FIELD of one vehicle, the value alone,
 * with the field name folded in from the topic by `mqtt.ts`. There is no record
 * envelope and no `data` array on this transport, so there is no such thing as a
 * message that carries a whole sample.
 */
function field(at: Date | string, name: string, value: unknown): RawMessage {
  return {
    vehicleId: 'veh-1',
    vendor: 'tesla',
    receivedAt: typeof at === 'string' ? t(at) : at,
    source: 'telemetry',
    payload: { kind: 'metrics', vin: VIN, field: name, value },
  }
}

function connectivity(at: string, status: string): RawMessage {
  return {
    vehicleId: 'veh-1',
    vendor: 'tesla',
    receivedAt: t(at),
    source: 'telemetry',
    payload: { kind: 'connectivity', vin: VIN, field: null, value: { status } },
  }
}

/** A burst of fields published at the same instant, as the car does. */
async function burst(
  pipeline: Pipeline, at: string, fields: Record<string, unknown>,
): Promise<void> {
  for (const [name, value] of Object.entries(fields)) {
    await pipeline.handle(field(at, name, value))
  }
}

describe('Pipeline.handle: the tape', () => {
  it('writes every field message to the tape, mappable or not', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)

    await pipeline.handle(field('2026-09-04T10:00:00.000Z', 'Soc', 80))
    // An unknown field and an unreadable value: counted, taped, never a crash
    // and never a guess.
    // Not `Gear`: that one is catalogued and decoded now. This is a name the
    // car could start sending tomorrow and that we have not decided about yet.
    const unknown = await pipeline.handle(
      field('2026-09-04T10:00:00.000Z', 'SomethingShippedNextTuesday', 'D'))
    const invalid = await pipeline.handle(field('2026-09-04T10:00:00.000Z', 'Soc', null))

    expect(db.state.raw).toHaveLength(3)
    expect(unknown.unmapped).toBe(1)
    expect(invalid.unmapped).toBe(1)
    expect(unknown.fieldsApplied).toBe(0)
    // The tape is what makes a normaliser fix reprocessable, so it keeps
    // everything - including what this build could not read.
    expect(db.log).toEqual(['commit', 'commit', 'commit'])
  })

  it('creates the month partition before inserting into a partitioned table', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)

    await pipeline.handle(field('2026-09-04T10:00:00.000Z', 'Soc', 80))
    expect(db.state.partitions).toContain('2026-8')

    const before = db.state.partitions.length
    await pipeline.handle(field('2026-09-04T10:00:01.000Z', 'Soc', 79))
    expect(db.state.partitions.length).toBe(before)

    await pipeline.handle(field('2026-10-01T00:00:00.000Z', 'Soc', 79))
    expect(db.state.partitions).toContain('2026-9')
  })

  it('advances the ingest cursor and never rewinds it', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)

    await pipeline.handle(field('2026-09-04T10:05:00.000Z', 'Soc', 80))
    expect(db.state.cursor?.toISOString()).toBe('2026-09-04T10:05:00.000Z')

    await pipeline.handle(field('2026-09-04T10:00:00.000Z', 'Soc', 81))
    expect(db.state.cursor?.toISOString()).toBe('2026-09-04T10:05:00.000Z')
  })
})

describe('Pipeline accumulation', () => {
  it('emits ONE sample carrying the whole burst, not one per field', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)

    await burst(pipeline, '2026-09-04T10:00:00.000Z',
      { Soc: 80, VehicleSpeed: MOVING, Odometer: 1000, TpmsPressureFl: 2.8 })
    expect(db.state.samples).toHaveLength(0)

    // The quiet gap in front of this message is what proves the burst finished.
    await pipeline.handle(field('2026-09-04T10:00:05.000Z', 'Soc', 79))

    expect(db.state.samples).toHaveLength(1)
    const sample = db.state.samples[0]
    expect(sample?.socPct).toBe(80)
    expect(sample?.speedKph).toBeCloseTo(64.37, 2)
    expect(sample?.odometerKm).toBeCloseTo(1609.34, 2)
    expect(sample?.tpms).toEqual({ fl: 2.8 })
    // Stamped at the observation, not at the emit: the sample is what the car
    // reported at 10:00:00.
    expect(sample?.ts.toISOString()).toBe('2026-09-04T10:00:00.000Z')
  })

  it('leaves a field that was never reported null, never 0', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)

    await pipeline.handle(field('2026-09-04T10:00:00.000Z', 'Soc', 80))
    await pipeline.handle(field('2026-09-04T10:00:05.000Z', 'Soc', 79))

    const sample = db.state.samples[0]
    expect(sample?.socPct).toBe(80)
    // A 0 here would tell the segmenter the car is parked, drawing nothing.
    expect(sample?.speedKph).toBeNull()
    expect(sample?.chargePowerKw).toBeNull()
    expect(sample?.chargeEnergyAddedKwh).toBeNull()
    expect(sample?.odometerKm).toBeNull()
  })

  it('carries the latest known value of a field into later samples', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)

    // Odometer is published far less often than speed. Dropping it between
    // samples would make almost every sample all-null, which is what wrecks
    // segmentation.
    await burst(pipeline, '2026-09-04T10:00:00.000Z', { Odometer: 1000, VehicleSpeed: MOVING })
    await burst(pipeline, '2026-09-04T10:00:10.000Z', { VehicleSpeed: MOVING })
    await pipeline.handle(field('2026-09-04T10:00:20.000Z', 'VehicleSpeed', MOVING))

    expect(db.state.samples).toHaveLength(2)
    expect(db.state.samples[1]?.odometerKm).toBeCloseTo(1609.34, 2)
  })

  it('stops carrying a value once it is stale', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)

    await pipeline.handle(field('2026-09-04T10:00:00.000Z', 'VehicleSpeed', MOVING))
    await pipeline.handle(field('2026-09-04T10:00:05.000Z', 'Soc', 80))
    expect(db.state.samples[0]?.speedKph).toBeCloseTo(64.37, 2)

    // Sixteen minutes later the car speaks again. A speed from before the
    // silence must not be repeated as if it were current - that is what would
    // hold a drive open all night on a car parked in an underground garage.
    const late = new Date(t('2026-09-04T10:00:00.000Z').getTime() + STALE_VALUE_MS + 60_000)
    await pipeline.handle(field(late, 'Soc', 79))
    await pipeline.handle(field(new Date(late.getTime() + 5_000), 'Soc', 78))

    const last = db.state.samples[db.state.samples.length - 1]
    expect(last?.socPct).toBe(79)
    expect(last?.speedKph).toBeNull()
  })

  it('waits exactly QUIET_PERIOD_MS before treating a burst as finished', async () => {
    const start = t('2026-09-04T10:00:00.000Z')
    const at = (ms: number) => new Date(start.getTime() + ms)

    const early = new FakeDb()
    const a = new Pipeline(early, OPTS)
    await a.handle(field(start, 'Soc', 80))
    await a.handle(field(at(QUIET_PERIOD_MS - 1), 'VehicleSpeed', 0))
    expect(early.state.samples).toHaveLength(0)

    const onTime = new FakeDb()
    const b = new Pipeline(onTime, OPTS)
    await b.handle(field(start, 'Soc', 80))
    await b.handle(field(at(QUIET_PERIOD_MS), 'VehicleSpeed', 0))
    expect(onTime.state.samples).toHaveLength(1)
    expect(onTime.state.samples[0]?.socPct).toBe(80)
  })

  it('emits at MAX_SAMPLE_INTERVAL_MS even if the car never goes quiet', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)
    const start = t('2026-09-04T10:00:00.000Z')
    const step = 1_000

    // A car fast-charging publishes without pause, so the quiet rule never
    // fires. Without the ceiling this accumulates forever and the worker looks
    // healthy while writing nothing at all.
    for (let ms = 0; ms + step <= MAX_SAMPLE_INTERVAL_MS; ms += step) {
      await pipeline.handle(field(new Date(start.getTime() + ms), 'Soc', 80))
      expect(db.state.samples).toHaveLength(0)
    }
    await pipeline.handle(
      field(new Date(start.getTime() + MAX_SAMPLE_INTERVAL_MS), 'Soc', 80))

    expect(db.state.samples).toHaveLength(1)
  })

  it('keeps a burst that follows a quiet spell whole, rather than emit its first field alone', async () => {
    // The 30 s ceiling is for a car that never goes quiet. Measured from the
    // last emit instead of from the burst's own start, any gap over 30 s made
    // the next burst's SECOND message look overdue, splitting it in two.
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)
    await burst(pipeline, '2026-09-04T10:00:00.000Z', { Soc: 80 })
    await pipeline.flush(t('2026-09-04T10:00:05.000Z'))
    expect(db.state.samples).toHaveLength(1)

    await pipeline.handle(field('2026-09-04T10:01:00.000Z', 'DetailedChargeState', 'DetailedChargeStateComplete'))
    await pipeline.handle(field('2026-09-04T10:01:00.003Z', 'ACChargingPower', 0))
    await pipeline.handle(field('2026-09-04T10:01:00.007Z', 'Soc', 81))
    await pipeline.flush(t('2026-09-04T10:01:05.000Z'))

    expect(db.state.samples.map((x) => x.ts.toISOString()))
      .toEqual(['2026-09-04T10:00:00.000Z', '2026-09-04T10:01:00.007Z'])
    expect(db.state.samples[1]).toMatchObject({ socPct: 81, chargeState: 'complete', chargePowerKw: 0 })
  })

  it('does not lose a burst whose fields share one instant to the half it split off', async () => {
    // The re-timed backlog gave every field of a record one timestamp. The
    // split-off first field took that instant, and the whole burst, stamped
    // the same, was then dropped by the sample table's ON CONFLICT DO NOTHING.
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)
    await burst(pipeline, '2026-09-04T10:00:00.000Z', { Soc: 80, ACChargingPower: 1.2 })
    await pipeline.flush(t('2026-09-04T10:00:05.000Z'))

    await burst(pipeline, '2026-09-04T10:01:00.000Z', {
      Soc: 81, DetailedChargeState: 'DetailedChargeStateComplete', ACChargingPower: 0,
    })
    await pipeline.flush(t('2026-09-04T10:01:05.000Z'))

    expect(db.state.samples.at(-1)).toMatchObject({ socPct: 81, chargeState: 'complete', chargePowerKw: 0 })
  })

  it('flushes what is pending on shutdown', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)

    await burst(pipeline, '2026-09-04T10:00:00.000Z', { Soc: 80, VehicleSpeed: 0 })
    // A restart without this drops the last burst: no further message will ever
    // arrive to trigger the emit.
    const result = await pipeline.flush(t('2026-09-04T10:00:00.500Z'), true)

    expect(result.samples).toBe(1)
    expect(db.state.samples).toHaveLength(1)
    expect(db.state.samples[0]?.socPct).toBe(80)

    // Nothing pending: a second flush must not write the same state again.
    expect((await pipeline.flush(t('2026-09-04T10:01:00.000Z'), true)).samples).toBe(0)
  })

  it('takes power state from connectivity messages', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)

    await pipeline.handle(connectivity('2026-09-04T10:00:00.000Z', 'CONNECTED'))
    await pipeline.handle(field('2026-09-04T10:00:00.000Z', 'Soc', 80))
    await pipeline.flush(t('2026-09-04T10:00:05.000Z'))

    expect(db.state.samples[0]?.powerState).toBe('online')
  })

  it('ignores alerts and errors', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)

    const result = await pipeline.handle({
      vehicleId: 'veh-1', vendor: 'tesla', receivedAt: t('2026-09-04T10:00:00.000Z'),
      source: 'telemetry',
      payload: { kind: 'alert', vin: VIN, field: 'Charge_Cable_Fault', value: {} },
    })

    expect(result.unmapped).toBe(1)
    expect(db.state.raw).toHaveLength(1)
    await pipeline.flush(t('2026-09-04T10:01:00.000Z'), true)
    expect(db.state.samples).toHaveLength(0)
  })
})

describe('Pipeline session handling', () => {
  it('opens a drive session when the car starts moving', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)

    await burst(pipeline, '2026-09-04T10:00:00.000Z',
      { VehicleSpeed: MOVING, Odometer: 1000, Soc: 80, ChargeState: 'Disconnected' })
    await pipeline.flush(t('2026-09-04T10:00:05.000Z'))

    expect(openSessions(db).map((s) => s.kind)).toEqual(['drive'])
    expect(db.state.points).toHaveLength(1)
  })

  it('ends a charge on the Complete sample, with the final counter and SoC it carries', async () => {
    // The segmenter ends a charge on the sample that says it stopped, because
    // that sample carries the final reading. The summary is built from the
    // points, and that sample was never one: 2026-09-22's charge came out a
    // minute short and 0.2 kWh light.
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)
    await burst(pipeline, '2026-09-22T11:56:00.000Z', {
      DetailedChargeState: 'DetailedChargeStateCharging', ACChargingPower: 11, ACChargingEnergyIn: 0.1, Soc: 37.6,
    })
    await burst(pipeline, '2026-09-22T12:43:33.000Z', { ACChargingEnergyIn: 8.855, Soc: 49.8 })
    await burst(pipeline, '2026-09-22T12:44:33.000Z', {
      ACChargingEnergyIn: 9.056, Soc: 49.96, DetailedChargeState: 'DetailedChargeStateComplete', ACChargingPower: 0,
    })
    await pipeline.flush(t('2026-09-22T12:44:40.000Z'))

    const [charge] = db.state.sessions
    expect(charge?.isOpen).toBe(false)
    expect(charge?.summary).toMatchObject({
      endedAt: t('2026-09-22T12:44:33.000Z'), endSocPct: 49.96,
    })
    expect(charge?.summary?.energyKwh).toBeCloseTo(8.956, 3)
    expect(db.state.points.at(-1)?.ts).toEqual(t('2026-09-22T12:44:33.000Z'))
  })

  it('closes a drive once parked and summarises it from the collected points', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)

    await burst(pipeline, '2026-09-04T10:00:00.000Z',
      { VehicleSpeed: MOVING, Odometer: 1000, Soc: 80 })
    await burst(pipeline, '2026-09-04T10:05:00.000Z',
      { VehicleSpeed: MOVING, Odometer: 1010, Soc: 75 })
    await burst(pipeline, '2026-09-04T10:10:00.000Z',
      { VehicleSpeed: 0, Odometer: 1015, Soc: 74 })
    // Six minutes stationary: past the five-minute drive-end threshold.
    await burst(pipeline, '2026-09-04T10:16:00.000Z',
      { VehicleSpeed: 0, Odometer: 1015, Soc: 74 })
    await pipeline.flush(t('2026-09-04T10:16:05.000Z'))

    expect(openSessions(db)).toHaveLength(0)
    const drive = db.state.sessions[0]
    expect(drive?.kind).toBe('drive')
    // 15 miles, in km. Wrong unit handling shows up here as ~15.
    expect(drive?.summary?.distanceKm).toBeCloseTo(24.14, 2)
    expect(drive?.summary?.startSocPct).toBe(80)
    expect(drive?.summary?.endSocPct).toBe(74)
    // Energy for a drive comes from the SoC delta and configured capacity.
    expect(drive?.summary?.energyKwh).toBeCloseTo(4.5, 3)
  })

  it('records a battery health estimate when a charge session closes', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)

    await burst(pipeline, '2026-09-04T20:00:00.000Z', {
      DetailedChargeState: 'DetailedChargeStateCharging',
      Soc: 30, ACChargingPower: 7.4, ACChargingEnergyIn: 0,
    })
    await burst(pipeline, '2026-09-04T20:45:00.000Z', {
      DetailedChargeState: 'DetailedChargeStateCharging',
      Soc: 60, ACChargingPower: 7.4, ACChargingEnergyIn: 25,
    })
    await burst(pipeline, '2026-09-04T20:50:00.000Z', {
      DetailedChargeState: 'DetailedChargeStateDisconnected', Soc: 60,
    })
    await pipeline.flush(t('2026-09-04T20:50:05.000Z'))

    expect(openSessions(db)).toHaveLength(0)
    expect(db.state.sessions[0]?.summary?.energyKwh).toBeCloseTo(25, 3)
    const health = db.state.battery[0]
    // 25 kWh over a 30-point span.
    expect(health?.estimatedCapacityKwh).toBeCloseTo(83.33, 2)
    expect(health?.sampleConfidence).toBeCloseTo(0.375, 3)
  })

  it('measures a DC charge against the DC counter, not the stale AC one', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)

    // The AC counter still holds 40 kWh from last night's charge at home: these
    // fields are cumulative, so the idle rail does not read 0. Taking the larger
    // magnitude - correct for power - would credit this charge with 40 kWh and
    // write a fabricated capacity into battery_health.
    await burst(pipeline, '2026-09-04T20:00:00.000Z', {
      DetailedChargeState: 'DetailedChargeStateCharging',
      Soc: 30, DCChargingPower: 120, DCChargingEnergyIn: 0, ACChargingEnergyIn: 40,
    })
    await burst(pipeline, '2026-09-04T20:20:00.000Z', {
      DetailedChargeState: 'DetailedChargeStateCharging',
      Soc: 60, DCChargingPower: 120, DCChargingEnergyIn: 25, ACChargingEnergyIn: 40,
    })
    await burst(pipeline, '2026-09-04T20:25:00.000Z', {
      DetailedChargeState: 'DetailedChargeStateDisconnected', Soc: 60,
    })
    await pipeline.flush(t('2026-09-04T20:25:05.000Z'))

    expect(db.state.sessions[0]?.summary?.energyKwh).toBeCloseTo(25, 3)
    expect(db.state.battery[0]?.estimatedCapacityKwh).toBeCloseTo(83.33, 2)
  })

  it('does not record battery health for a drive', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)

    // A drive's energy is inferred FROM the nameplate capacity, so feeding it
    // back into a capacity estimate would just restate the configured number.
    for (const [at, speed, soc] of [
      ['2026-09-04T10:00:00.000Z', MOVING, 90],
      ['2026-09-04T10:05:00.000Z', MOVING, 60],
      ['2026-09-04T10:10:00.000Z', 0, 60],
      ['2026-09-04T10:16:00.000Z', 0, 60],
    ] as const) {
      await burst(pipeline, at, { VehicleSpeed: speed, Soc: soc })
    }
    await pipeline.flush(t('2026-09-04T10:16:05.000Z'))

    expect(db.state.sessions[0]?.isOpen).toBe(false)
    expect(db.state.battery).toHaveLength(0)
  })
})

/**
 * The car's own pack energy, written from the sample path (spec §3.7).
 *
 * Not from the session path, which is where the estimate comes from: a
 * measurement has no session behind it, it is a field on a sample. The two
 * series share a daily row and neither may overwrite the other.
 */
describe('Pipeline: measured battery capacity', () => {
  it("records the car's measured pack energy once per UTC day", async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)

    await burst(pipeline, '2026-09-04T22:00:00.000Z',
      { NominalFullPackEnergyKwh: 72.4, Soc: 60 })
    await pipeline.flush(t('2026-09-04T22:00:05.000Z'))
    // Same day, and the accumulator still carries the pack energy: one write a
    // day, not one per sample, or a daily row becomes a per-sample UPDATE.
    await burst(pipeline, '2026-09-04T23:00:00.000Z', { Soc: 61 })
    await pipeline.flush(t('2026-09-04T23:00:05.000Z'))
    // Past midnight UTC: a new day, so a new measurement.
    await burst(pipeline, '2026-09-05T00:10:00.000Z', { Soc: 62 })
    await pipeline.flush(t('2026-09-05T00:10:05.000Z'))

    expect(db.state.measured.map((m) => m.observedOn.toISOString())).toEqual([
      '2026-09-04T22:00:00.000Z',
      '2026-09-05T00:10:00.000Z',
    ])
    expect(db.state.measured[0]?.measuredCapacityKwh).toBeCloseTo(72.4, 3)
    // Nothing here went through the estimator, which needs a charge session.
    expect(db.state.battery).toHaveLength(0)
  })

  it('records nothing on a day the car never reported its pack energy', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)

    await burst(pipeline, '2026-09-04T10:00:00.000Z', { Soc: 60, VehicleSpeed: 0 })
    await pipeline.flush(t('2026-09-04T10:00:05.000Z'))

    expect(db.state.measured).toHaveLength(0)
  })

  it('derives rated range at 100% when the pack is full enough to extrapolate', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)

    // 200 miles of rated range on 50 of 72.4 kWh: 69% of the pack, so the
    // extrapolation to 100% is a short one. Tesla streams miles.
    await burst(pipeline, '2026-09-04T22:00:00.000Z', {
      NominalFullPackEnergyKwh: 72.4, EnergyRemaining: 50, RatedRange: 200, Soc: 69,
    })
    await pipeline.flush(t('2026-09-04T22:00:05.000Z'))

    expect(db.state.measured).toHaveLength(1)
    // 200 mi -> 321.87 km, divided by 50/72.4.
    expect(db.state.measured[0]?.ratedRangeAt100Km).toBeCloseTo(466.1, 1)
  })

  it('leaves rated range null when the pack is too empty to extrapolate from', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)

    // 15 of 72.4 kWh. Multiplying a near-empty pack's rated range by five
    // invents precision the car never claimed - no row beats a bad row, and
    // the measurement itself is still written.
    await burst(pipeline, '2026-09-04T22:00:00.000Z', {
      NominalFullPackEnergyKwh: 72.4, EnergyRemaining: 15, RatedRange: 60, Soc: 21,
    })
    await pipeline.flush(t('2026-09-04T22:00:05.000Z'))

    expect(db.state.measured).toHaveLength(1)
    expect(db.state.measured[0]?.measuredCapacityKwh).toBeCloseTo(72.4, 3)
    expect(db.state.measured[0]?.ratedRangeAt100Km).toBeNull()
  })

  it('unwrites the measurement when its transaction rolls back', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)

    // The day-written memory lives in the pipeline, not in the database, so a
    // rollback that keeps it would skip the retry's write and lose the day's
    // measurement entirely - the same reasoning as `ensuredMonths`.
    await burst(pipeline, '2026-09-04T22:00:00.000Z',
      { NominalFullPackEnergyKwh: 72.4, Soc: 60 })
    db.failNextCommit = new Error('deadlock detected')
    await expect(pipeline.flush(t('2026-09-04T22:00:05.000Z'))).rejects.toThrow('deadlock')
    expect(db.state.measured).toHaveLength(0)

    await pipeline.flush(t('2026-09-04T22:00:06.000Z'), true)
    expect(db.state.measured).toHaveLength(1)
  })
})

describe('Pipeline idempotency', () => {
  it('leaves one row when the same messages are replayed', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)
    const messages = [
      field('2026-09-04T10:00:00.000Z', 'VehicleSpeed', MOVING),
      field('2026-09-04T10:00:00.000Z', 'Odometer', 1000),
      field('2026-09-04T10:00:05.000Z', 'VehicleSpeed', MOVING),
    ]

    for (const m of messages) await pipeline.handle(m)
    for (const m of messages) await pipeline.handle(m)

    // The raw tape is append-only by design: a redelivery is a second row there
    // and reprocess handles the duplicate. Everything derived is deduplicated.
    expect(db.state.raw).toHaveLength(6)
    expect(db.state.samples).toHaveLength(1)
    expect(db.state.sessions).toHaveLength(1)
    expect(db.state.points).toHaveLength(1)
  })

  it('adopts the open session instead of opening a second one', async () => {
    const db = new FakeDb()
    const first = new Pipeline(db, OPTS)
    await burst(first, '2026-09-04T10:00:00.000Z', { VehicleSpeed: MOVING, Odometer: 1000 })
    await first.flush(t('2026-09-04T10:00:05.000Z'))

    // A worker that restarted without recovering state: fresh segmenter, same
    // database. The partial unique index must stop a duplicate open session.
    const second = new Pipeline(db, OPTS)
    await burst(second, '2026-09-04T10:02:00.000Z', { VehicleSpeed: MOVING, Odometer: 1002 })
    await second.flush(t('2026-09-04T10:02:05.000Z'))

    expect(db.state.sessions).toHaveLength(1)
  })
})

describe('Pipeline transaction failure', () => {
  it('rolls the segmenter back with the transaction', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)

    await burst(pipeline, '2026-09-04T10:00:00.000Z', { VehicleSpeed: MOVING, Odometer: 1000 })
    const trigger = field('2026-09-04T10:00:05.000Z', 'VehicleSpeed', MOVING)

    db.failNextCommit = new Error('connection terminated')
    await expect(pipeline.handle(trigger)).rejects.toThrow('connection terminated')

    // Nothing persisted, and — the part that matters — the in-memory segmenter
    // must not be holding the id of a session that the rollback erased, and the
    // accumulator must still be holding the burst whose emit was rolled back.
    // If it were not, that burst is gone: the redelivery below is the only copy
    // left.
    expect(db.state.samples).toHaveLength(0)
    expect(db.state.sessions).toHaveLength(0)
    expect(db.log).toEqual(['commit', 'commit', 'rollback'])

    await pipeline.handle(trigger)
    expect(db.state.samples).toHaveLength(1)
    expect(db.state.samples[0]?.odometerKm).toBeCloseTo(1609.34, 2)
    expect(db.state.sessions).toHaveLength(1)
    expect(db.state.points).toHaveLength(1)
  })

  it('re-creates the month partition after a rolled-back transaction', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)
    const raw = field('2026-09-04T10:00:00.000Z', 'Soc', 80)

    db.failNextCommit = new Error('deadlock detected')
    await expect(pipeline.handle(raw)).rejects.toThrow('deadlock detected')
    expect(db.state.partitions).toEqual([])

    // ensure_month_partitions is DDL inside the transaction, so the rollback
    // undid it. A cache that survived would skip the CREATE and every later
    // insert for this month would fail forever.
    await pipeline.handle(raw)
    expect(db.state.partitions).toContain('2026-8')
  })
})

describe('Pipeline.resume', () => {
  const iso = (ms: number) => new Date(ms).toISOString()
  const at = (hhmm: string) => t(`2026-09-26T${hhmm}:00.000Z`).getTime()
  const openRows = (db: FakeDb) =>
    openSessions(db).map(({ id, kind, startedAt }) => ({ id, kind, startedAt }))
  /** The tape a worker would stream back: what `insertRaw` wrote, in order. */
  const tape = (db: FakeDb) => db.state.raw.slice()

  /**
   * Charging, a minute at a time, as the car reports it: the energy counter
   * rises (its delta is 0.1 kWh) while a steady power is never re-sent.
   */
  async function charging(p: Pipeline, from: number, to: number, soc: number): Promise<void> {
    for (let ms = from; ms <= to; ms += 60_000) {
      const kwh = (ms - at('16:00')) / 60_000 * 0.12
      await burst(p, iso(ms), { ACChargingEnergyIn: kwh, Soc: soc + ((ms - from) / 60_000) * 0.05 })
    }
  }

  /** Driving, a minute at a time, the odometer counting. */
  async function driving(p: Pipeline, from: number, to: number, odo: number): Promise<void> {
    for (let ms = from; ms <= to; ms += 60_000) {
      await burst(p, iso(ms), { VehicleSpeed: MOVING, Odometer: odo + (ms - from) / 60_000 })
    }
  }

  it('resumes a charge across two cold restarts and closes it once, whole', async () => {
    // 2026-09-26: the charge state arrived once, at 16:00:43. The v0.5.9
    // rollout restarted the worker at 21:24 and the repair did again at 21:32,
    // and the worker in between had no charge state, so it wrote samples and
    // no session.
    const db = new FakeDb()
    const first = new Pipeline(db, OPTS)
    const started = at('16:00') + 43_000
    await burst(first, iso(started), {
      DetailedChargeState: 'DetailedChargeStateCharging', ACChargingPower: 7.2, Soc: 60,
    })
    await charging(first, at('16:01'), at('21:23'), 60)
    await first.flush(new Date(at('21:23') + 30_000), true)
    const [charge] = openSessions(db)
    expect(charge?.kind).toBe('charge')

    const cold = new Pipeline(db, OPTS)
    await charging(cold, at('21:24'), at('21:32'), 76)
    await cold.flush(new Date(at('21:32') + 30_000), true)

    const resumed = new Pipeline(db, OPTS)
    await resumed.resume(tape(db), openRows(db), new Date(at('21:33')))
    await charging(resumed, at('21:33'), at('23:30'), 77)
    await burst(resumed, iso(at('23:31')), {
      DetailedChargeState: 'DetailedChargeStateComplete', ACChargingPower: 0,
    })
    await resumed.flush(new Date(at('23:32')), true)

    const charges = db.state.sessions.filter((s) => s.kind === 'charge')
    expect(charges.map((s) => s.id)).toEqual([charge!.id])
    expect(charges[0]?.isOpen).toBe(false)
    expect(charges[0]?.summary?.startedAt).toEqual(new Date(started))
    // On the Complete sample, which carries the final reading.
    expect(charges[0]?.summary?.endedAt).toEqual(new Date(at('23:31')))
    // No hole where the cold worker ran, and priced exactly once.
    const points = db.state.points.filter((p) => p.sessionId === charge!.id)
    expect(points.map((p) => p.ts.getTime())).toContain(at('21:28'))
    expect(db.state.costs.filter((c) => c.sessionId === charge!.id)).toHaveLength(1)
  })

  /**
   * An afternoon, a burst a minute: a drive, parked, a charge that pauses and
   * resumes inside its window, unplugged, a second drive, a coverage gap longer
   * than the segmenter's reset, and a charge still running at the end.
   */
  function afternoon(): Array<[number, Record<string, unknown>]> {
    const out: Array<[number, Record<string, unknown>]> = []
    let ms = at('12:00')
    const push = (fields: Record<string, unknown>, gapMinutes = 1) => {
      out.push([ms, fields])
      ms += gapMinutes * 60_000
    }
    for (let i = 0; i < 12; i++) push({ VehicleSpeed: MOVING, Odometer: 1000 + i, Soc: 80 - i * 0.2 })
    for (let i = 0; i < 7; i++) push({ VehicleSpeed: 0, Soc: 77.5 })
    push({ DetailedChargeState: 'DetailedChargeStateCharging', ACChargingPower: 7.2, Soc: 77.5 })
    for (let i = 1; i <= 15; i++) push({ ACChargingPower: 7.2 + (i % 3) * 0.1, Soc: 77.5 + i * 0.1 })
    push({ DetailedChargeState: 'DetailedChargeStateStopped', ACChargingPower: 0 }, 6)
    push({ DetailedChargeState: 'DetailedChargeStateCharging', ACChargingPower: 7.1 })
    for (let i = 1; i <= 8; i++) push({ ACChargingPower: 7.1 + (i % 3) * 0.1, Soc: 79 + i * 0.1 })
    push({ DetailedChargeState: 'DetailedChargeStateDisconnected', ACChargingPower: 0 }, 3)
    for (let i = 0; i < 10; i++) push({ VehicleSpeed: MOVING, Odometer: 1012 + i })
    for (let i = 0; i < 6; i++) push({ VehicleSpeed: 0 }, i === 5 ? 90 : 1)
    push({ DetailedChargeState: 'DetailedChargeStateCharging', ACChargingPower: 11, Soc: 75 })
    for (let i = 1; i <= 10; i++) push({ ACChargingPower: 11 + (i % 3) * 0.1, Soc: 75 + i * 0.2 })
    return out
  }

  /** What a viewer can see of the sessions, without the ids a restart may change. */
  function sessionsOf(db: FakeDb) {
    return db.state.sessions.map((s) => ({
      kind: s.kind, startedAt: s.startedAt, isOpen: s.isOpen, summary: s.summary,
      points: db.state.points.filter((p) => p.sessionId === s.id).length,
    }))
  }

  async function straightThrough(): Promise<FakeDb> {
    const db = new FakeDb()
    const p = new Pipeline(db, OPTS)
    const bursts = afternoon()
    for (const [ms, fields] of bursts) await burst(p, iso(ms), fields)
    await p.flush(new Date(bursts.at(-1)![0] + 60_000), true)
    return db
  }

  async function restartedAt(cut: number, graceful: boolean): Promise<FakeDb> {
    const db = new FakeDb()
    const bursts = afternoon()
    const before = new Pipeline(db, OPTS)
    for (const [ms, fields] of bursts.slice(0, cut)) await burst(before, iso(ms), fields)
    const stoppedAt = bursts[cut - 1]![0] + 30_000
    if (graceful) await before.flush(new Date(stoppedAt), true)

    const after = new Pipeline(db, OPTS)
    await after.resume(tape(db), openRows(db), new Date(stoppedAt))
    for (const [ms, fields] of bursts.slice(cut)) await burst(after, iso(ms), fields)
    await after.flush(new Date(bursts.at(-1)![0] + 60_000), true)
    return db
  }

  it('makes a restart after any burst invisible, whether it shut down or crashed', async () => {
    const expected = sessionsOf(await straightThrough())
    expect(expected.map((s) => s.kind)).toEqual(['drive', 'charge', 'drive', 'charge'])
    for (let cut = 1; cut < afternoon().length; cut++) {
      for (const graceful of [true, false]) {
        expect({ cut, graceful, sessions: sessionsOf(await restartedAt(cut, graceful)) })
          .toEqual({ cut, graceful, sessions: expected })
      }
    }
  }, 60_000)

  it('splits a row that absorbed a second charge, closing it where the first one ended', async () => {
    const scratch = new FakeDb()
    const s = new Pipeline(scratch, OPTS)
    const first = at('16:00')
    await burst(s, iso(first), { DetailedChargeState: 'DetailedChargeStateCharging', ACChargingPower: 7.2, Soc: 40 })
    await charging(s, at('16:01'), at('16:40'), 40)
    await burst(s, iso(at('16:41')), { DetailedChargeState: 'DetailedChargeStateDisconnected', ACChargingPower: 0 })
    await burst(s, iso(at('18:00')), { DetailedChargeState: 'DetailedChargeStateCharging', ACChargingPower: 7.2, Soc: 45 })
    await charging(s, at('18:01'), at('18:20'), 45)

    // What a cold worker leaves: the first charge never closed, so the second
    // was adopted into it.
    const db = new FakeDb()
    db.state.raw = tape(scratch)
    db.state.sessions.push({
      id: 'merged', vehicleId: 'veh-1', kind: 'charge', startedAt: new Date(first), isOpen: true, summary: null,
    })
    await new Pipeline(db, OPTS).resume(tape(db), openRows(db), new Date(at('18:21')))

    const merged = db.state.sessions.find((x) => x.id === 'merged')
    expect(merged?.isOpen).toBe(false)
    expect(merged?.summary?.endedAt).toEqual(new Date(at('16:41')))
    expect(openRows(db).map((r) => [r.kind, r.startedAt])).toEqual([['charge', new Date(at('18:00'))]])
  })

  it('gives each row exactly the replay\'s points: no hole, and none of the charge it absorbed', async () => {
    const scratch = new FakeDb()
    const s = new Pipeline(scratch, OPTS)
    const first = at('16:00')
    await burst(s, iso(first), { DetailedChargeState: 'DetailedChargeStateCharging', ACChargingPower: 7.2, Soc: 40 })
    await charging(s, at('16:01'), at('16:40'), 40)
    await burst(s, iso(at('16:41')), { DetailedChargeState: 'DetailedChargeStateDisconnected', ACChargingPower: 0 })
    await burst(s, iso(at('18:00')), { DetailedChargeState: 'DetailedChargeStateCharging', ACChargingPower: 7.2, Soc: 45 })
    await charging(s, at('18:01'), at('18:20'), 45)
    // The stopped worker's shutdown flush, which the resume stands in for.
    await s.flush(new Date(at('18:21')), true)
    const [one, two] = scratch.state.sessions
    const pointsOf = (db: FakeDb, id: string) =>
      db.state.points.filter((p) => p.sessionId === id).map((p) => p.ts.getTime())

    // What the cold workers left: the first charge's points stop at 16:20,
    // where the first restart forgot it, and the second charge's were written
    // onto the same row when it was adopted.
    const db = new FakeDb()
    db.state.raw = tape(scratch)
    db.state.sessions.push({
      id: 'merged', vehicleId: 'veh-1', kind: 'charge', startedAt: new Date(first), isOpen: true, summary: null,
    })
    db.state.points = scratch.state.points
      .filter((p) => p.sessionId === two!.id || p.ts.getTime() <= at('16:20'))
      .map((p) => ({ sessionId: 'merged', ts: p.ts }))
    await new Pipeline(db, OPTS).resume(tape(db), openRows(db), new Date(at('18:21')))

    expect(pointsOf(db, 'merged')).toEqual(pointsOf(scratch, one!.id))
    const [second] = openRows(db)
    expect(pointsOf(db, second!.id)).toEqual(pointsOf(scratch, two!.id))
  })

  it('moves a row that started late back to where the replay says its session began', async () => {
    // A cold worker opens a charge only once the car says it is charging again,
    // and a row can be dated after the first point the replay gives it.
    const scratch = new FakeDb()
    const s = new Pipeline(scratch, OPTS)
    await burst(s, iso(at('16:00')), { DetailedChargeState: 'DetailedChargeStateCharging', ACChargingPower: 7.2, Soc: 40 })
    await charging(s, at('16:01'), at('16:30'), 40)
    await s.flush(new Date(at('16:31')), true)
    const [replayed] = scratch.state.sessions

    const db = new FakeDb()
    db.state.raw = tape(scratch)
    db.state.sessions.push({
      id: 'late', vehicleId: 'veh-1', kind: 'charge', startedAt: new Date(at('16:05')), isOpen: true, summary: null,
    })
    await new Pipeline(db, OPTS).resume(tape(db), openRows(db), new Date(at('16:31')))

    expect(openRows(db)).toEqual([{ id: 'late', kind: 'charge', startedAt: replayed!.startedAt }])
    expect(db.state.points.filter((p) => p.sessionId === 'late').map((p) => p.ts.getTime()))
      .toEqual(scratch.state.points.map((p) => p.ts.getTime()))
  })

  it('matches a row stamped just before its replayed session, rather than duplicate it', async () => {
    // The live worker and the replay can disagree on a start by a flush: the
    // live timer races the database near the quiet boundary. Here the row
    // falls between two charges, 10 s before the second began.
    const scratch = new FakeDb()
    const s = new Pipeline(scratch, OPTS)
    await burst(s, iso(at('16:00')), { DetailedChargeState: 'DetailedChargeStateCharging', ACChargingPower: 7.2, Soc: 40 })
    await charging(s, at('16:01'), at('16:40'), 40)
    await burst(s, iso(at('16:41')), { DetailedChargeState: 'DetailedChargeStateDisconnected', ACChargingPower: 0 })
    await burst(s, iso(at('18:00')), { DetailedChargeState: 'DetailedChargeStateCharging', ACChargingPower: 7.2, Soc: 45 })
    await charging(s, at('18:01'), at('18:20'), 45)

    const db = new FakeDb()
    db.state.raw = tape(scratch)
    db.state.sessions.push({
      id: 'early', vehicleId: 'veh-1', kind: 'charge', startedAt: new Date(at('18:00') - 10_000), isOpen: true, summary: null,
    })
    const report = await new Pipeline(db, OPTS).resume(tape(db), openRows(db), new Date(at('18:21')))

    expect(report.abandoned).toEqual([])
    expect(db.state.sessions.map((x) => x.id)).toEqual(['early'])
    expect(openRows(db)).toEqual([{ id: 'early', kind: 'charge', startedAt: new Date(at('18:00')) }])
  })

  it('does not stretch the match to a row a whole sample interval before any session', async () => {
    const scratch = new FakeDb()
    const s = new Pipeline(scratch, OPTS)
    await burst(s, iso(at('18:00')), { DetailedChargeState: 'DetailedChargeStateCharging', ACChargingPower: 7.2, Soc: 45 })
    await charging(s, at('18:01'), at('18:20'), 45)

    const db = new FakeDb()
    db.state.raw = tape(scratch)
    db.state.sessions.push({
      id: 'stale', vehicleId: 'veh-1', kind: 'charge',
      startedAt: new Date(at('18:00') - MAX_SAMPLE_INTERVAL_MS - 1), isOpen: true, summary: null,
    })
    const report = await new Pipeline(db, OPTS).resume(tape(db), openRows(db), new Date(at('18:21')))

    expect(report.abandoned.map((r) => r.id)).toEqual(['stale'])
  })

  it('closes an open charge with its own summary and resumes the open drive', async () => {
    const scratch = new FakeDb()
    const s = new Pipeline(scratch, OPTS)
    await burst(s, iso(at('16:00')), { DetailedChargeState: 'DetailedChargeStateCharging', ACChargingPower: 7.2, Soc: 40 })
    await charging(s, at('16:01'), at('16:30'), 40)
    await burst(s, iso(at('16:31')), { DetailedChargeState: 'DetailedChargeStateDisconnected', ACChargingPower: 0 })
    await driving(s, at('16:35'), at('16:50'), 1000)

    const db = new FakeDb()
    db.state.raw = tape(scratch)
    db.state.sessions.push(
      { id: 'c', vehicleId: 'veh-1', kind: 'charge', startedAt: new Date(at('16:00')), isOpen: true, summary: null },
      { id: 'd', vehicleId: 'veh-1', kind: 'drive', startedAt: new Date(at('16:35')), isOpen: true, summary: null },
    )
    const p = new Pipeline(db, OPTS)
    await p.resume(tape(db), openRows(db), new Date(at('16:51')))
    await driving(p, at('16:52'), at('16:53'), 1017)
    await p.flush(new Date(at('16:54')))

    const charge = db.state.sessions.find((x) => x.id === 'c')
    expect(charge?.isOpen).toBe(false)
    expect(charge?.summary?.endedAt).toEqual(new Date(at('16:31')))
    expect(charge?.summary?.distanceKm).toBeNull()
    expect(openRows(db).map((r) => r.id)).toEqual(['d'])
    expect(db.state.points.some((pt) => pt.sessionId === 'd' && pt.ts.getTime() === at('16:53'))).toBe(true)
  })

  it('abandons an open row the tape cannot account for, rather than let it absorb the next one', async () => {
    const db = new FakeDb()
    db.state.sessions.push({
      id: 'orphan', vehicleId: 'veh-1', kind: 'drive', startedAt: new Date(at('09:00')), isOpen: true, summary: null,
    })
    await new Pipeline(db, OPTS).resume([], openRows(db), new Date(at('12:00')))
    expect(db.state.sessions[0]).toMatchObject({ id: 'orphan', isOpen: false, summary: null })
  })

  it('writes nothing while it replays', async () => {
    const db = new FakeDb()
    const p = new Pipeline(db, OPTS)
    await driving(p, at('10:00'), at('10:10'), 1000)
    await p.flush(new Date(at('10:10') + 30_000), true)
    const before = structuredClone(db.state)

    await new Pipeline(db, OPTS).resume(tape(db), openRows(db), new Date(at('10:11')))

    expect(db.state.raw).toEqual(before.raw)
    expect(db.state.samples).toEqual(before.samples)
    expect(db.state.cursor).toEqual(before.cursor)
    expect(db.state.sessions).toEqual(before.sessions)
    expect(db.state.points).toEqual(before.points)
  })

  it('prices a charge that ended while it was down at the rate its own start was under', async () => {
    // `rateAt(new Date())` would pass every other test here: the lookup must
    // be by the session's start, so a restart that straddles a rate change
    // cannot make last week's charge cost this week's money.
    const scratch = new FakeDb()
    const s = new Pipeline(scratch, OPTS, HOME)
    await burst(s, '2026-09-04T20:00:00.000Z', {
      DetailedChargeState: 'DetailedChargeStateCharging', ACChargingPower: 7.2,
      ACChargingEnergyIn: 0, Soc: 30, LocatedAtHome: true,
    })
    await burst(s, '2026-09-04T20:45:00.000Z', { ACChargingPower: 7.3, ACChargingEnergyIn: 20, Soc: 60 })
    await burst(s, '2026-09-04T20:50:00.000Z', { DetailedChargeState: 'DetailedChargeStateDisconnected', ACChargingPower: 0 })

    const db = new FakeDb()
    db.state.rates = [OLD_RATE, NEW_RATE]
    db.state.raw = tape(scratch)
    db.state.sessions.push({
      id: 'c', vehicleId: 'veh-1', kind: 'charge',
      startedAt: t('2026-09-04T20:00:00.000Z'), isOpen: true, summary: null,
    })
    await new Pipeline(db, OPTS, HOME).resume(tape(db), openRows(db), t('2026-09-05T08:00:00.000Z'))

    expect(openSessions(db)).toHaveLength(0)
    expect(db.state.rateLookups).toEqual([t('2026-09-04T20:00:00.000Z')])
    expect(db.state.costs).toEqual([{
      sessionId: 'c', cost: 2, costCurrency: 'USD', costRatePerKwh: 0.1,
      costBasis: 'home', costSource: 'urdb',
    }])
  })
})

describe('Pipeline: a charge longer than the six-hour level window', () => {
  it('stays one session until the car says Complete, on the energy counter alone', async () => {
    // The 2026-09-26 charge's shape: the charge state once at 16:00:43, no
    // power report for eight hours, and Complete at 00:39:45. The counter here
    // comes every twenty minutes (one gap of 34), sparser than the tape's
    // 4 min 18 s, so the hold does not depend on the counter being frequent.
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)
    const start = t('2026-09-26T16:00:43.000Z').getTime()
    const iso = (ms: number) => new Date(ms).toISOString()

    await burst(pipeline, iso(start), {
      DetailedChargeState: 'DetailedChargeStateCharging', ChargeState: 'Enable', Soc: 40,
    })
    let ms = start
    let energy = 0
    const reports: number[] = []
    for (const gap of [20, 20, 34, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20]) {
      ms += gap * 60_000
      energy += gap * 0.12
      reports.push(ms)
      await burst(pipeline, iso(ms), { ACChargingEnergyIn: energy, Soc: 40 + energy / 0.75 })
    }
    const complete = t('2026-09-27T00:39:45.000Z').getTime()
    expect(ms).toBeLessThan(complete)
    await burst(pipeline, iso(complete), {
      DetailedChargeState: 'DetailedChargeStateComplete', ACChargingPower: 0,
    })
    await pipeline.flush(new Date(complete + 60_000), true)

    const charges = db.state.sessions.filter((s) => s.kind === 'charge')
    expect(charges).toHaveLength(1)
    expect(charges[0]?.isOpen).toBe(false)
    // At the Complete, not six hours and ten minutes in. The Complete sample
    // carries the final reading, so the charge ends on it.
    expect(reports.at(-1)!).toBeLessThan(complete)
    expect(charges[0]?.summary?.endedAt).toEqual(new Date(complete))
  })

  it('measures the whole charge on the AC counter, though both counters rise and power spoke once', async () => {
    // The 2026-09-26 charge as the tape has it: 1.2 kW reported once, 47 s
    // before the charge state, and never again; the AC counter up 0.1 kWh
    // every 4 min 18 s; the DC counter rising too, every 6 min 40 s. Power
    // is what claims the AC rail, and it is six hours old long before the end.
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)
    const iso = (ms: number) => new Date(ms).toISOString()
    const at = (s: string) => t(`2026-09-26T${s}Z`).getTime()
    const complete = t('2026-09-27T00:39:45.000Z').getTime()

    const bursts: Array<[number, Record<string, unknown>]> = [
      [at('15:59:43.000'), { ACChargingEnergyIn: 0, Soc: 71.4 }],
      [at('15:59:56.000'), { ACChargingPower: 1.2 }],
      [at('16:00:43.000'), { DetailedChargeState: 'DetailedChargeStateCharging', ChargeState: 'Enable' }],
    ]
    for (let n = 1, ms = at('16:04:20.000'); ms < complete; n++, ms += 258_000) {
      bursts.push([ms, { ACChargingEnergyIn: n * 0.1, Soc: 71.4 + n * 0.1 }])
    }
    for (let n = 1, ms = at('16:05:00.000'); ms < complete; n++, ms += 400_000) {
      bursts.push([ms, { DCChargingEnergyIn: n * 0.12 }])
    }
    bursts.sort((x, y) => x[0] - y[0])
    for (const [ms, fields] of bursts) await burst(pipeline, iso(ms), fields)
    const lastAc = bursts.filter(([, f]) => 'ACChargingEnergyIn' in f).at(-1)![1]['ACChargingEnergyIn'] as number
    await burst(pipeline, iso(complete), {
      DetailedChargeState: 'DetailedChargeStateComplete', ACChargingPower: 0,
    })
    await pipeline.flush(new Date(complete + 60_000), true)

    const charges = db.state.sessions.filter((s) => s.kind === 'charge')
    expect(charges).toHaveLength(1)
    expect(charges[0]?.summary?.energyKwh).toBeCloseTo(lastAc, 3)
  })
})

describe('Pipeline: pricing a charge as it closes', () => {
  /** A charge from 30% to 60%, ending disconnected, with `over` on every burst. */
  async function chargeAt(
    pipeline: Pipeline, over: Record<string, unknown> = {},
  ): Promise<void> {
    await burst(pipeline, '2026-09-04T20:00:00.000Z', {
      DetailedChargeState: 'DetailedChargeStateCharging',
      Soc: 30, ACChargingPower: 7.4, ACChargingEnergyIn: 0, ...over,
    })
    await burst(pipeline, '2026-09-04T20:45:00.000Z', {
      DetailedChargeState: 'DetailedChargeStateCharging',
      Soc: 60, ACChargingPower: 7.4, ACChargingEnergyIn: 25, ...over,
    })
    await burst(pipeline, '2026-09-04T20:50:00.000Z', {
      DetailedChargeState: 'DetailedChargeStateDisconnected', Soc: 60,
    })
    await pipeline.flush(t('2026-09-04T20:50:05.000Z'))
  }

  it('prices a charge at home from the rate in force when it started', async () => {
    const db = new FakeDb()
    db.state.rates = [OLD_RATE, NEW_RATE]
    const pipeline = new Pipeline(db, OPTS, HOME)

    await chargeAt(pipeline, { LocatedAtHome: true })

    // 25 kWh x $0.10. The rate is stored beside the figure, so the charge page
    // can print the arithmetic and a later PSE increase cannot re-price history.
    expect(db.state.costs).toEqual([{
      sessionId: 's1', cost: 2.5, costCurrency: 'USD', costRatePerKwh: 0.1,
      costBasis: 'home', costSource: 'urdb',
    }])
  })

  it('leaves a charge unpriced, but still at home, when no rate covers it', async () => {
    const db = new FakeDb()
    db.state.rates = [NEW_RATE]
    const pipeline = new Pipeline(db, OPTS, HOME)

    await chargeAt(pipeline, { LocatedAtHome: true })

    // The charge predates every row in `energy_rate`. Reaching for the newest
    // one would price a year of charging at today's money and call it a
    // measurement; the basis survives so the page can say "no rate for this
    // date" rather than showing a blank that reads as free.
    expect(db.state.costs).toEqual([{
      sessionId: 's1', cost: null, costCurrency: null, costRatePerKwh: null,
      costBasis: 'home', costSource: null,
    }])
  })

  it('files a Supercharger stop as pending without looking a rate up', async () => {
    const db = new FakeDb()
    db.state.rates = [OLD_RATE]
    const pipeline = new Pipeline(db, OPTS, HOME)

    await chargeAt(pipeline, { FastChargerPresent: true })

    expect(db.state.costs).toEqual([{
      sessionId: 's1', cost: null, costCurrency: null, costRatePerKwh: null,
      costBasis: 'pending', costSource: null,
    }])
    // The domestic rate has nothing to say about a Supercharger, and `rateAt`
    // is a SELECT inside the message transaction — the one read through a seam
    // that is otherwise write-only. It runs only when it can change an answer.
    expect(db.state.rateLookups).toEqual([])
  })

  it('files an unidentifiable charger as unknown, never as free', async () => {
    const db = new FakeDb()
    db.state.rates = [OLD_RATE]
    const pipeline = new Pipeline(db, OPTS, HOME)

    await chargeAt(pipeline)

    expect(db.state.costs[0]?.costBasis).toBe('unknown')
    expect(db.state.costs[0]?.cost).toBeNull()
  })

  it('prices a charge and records its battery health in the same close', async () => {
    // Both hang off `kind === 'charge'`, and the battery block used to own the
    // early return that guard sits on. Appending pricing after it would have
    // put every price behind an unconditional `return` — and, worse, a charge
    // too narrow for a capacity estimate returns early from that block too, so
    // the failure would only show on some sessions.
    const db = new FakeDb()
    db.state.rates = [OLD_RATE]
    const pipeline = new Pipeline(db, OPTS, HOME)

    await chargeAt(pipeline, { LocatedAtHome: true })

    expect(db.state.battery).toHaveLength(1)
    expect(db.state.costs).toHaveLength(1)
  })

  it('never prices a drive', async () => {
    // `cost_basis` is null on drives and idles, and the read API promises it.
    // A price on a drive would be derived from a nameplate capacity rather than
    // from a meter — an invented number wearing a measured one's clothes.
    const db = new FakeDb()
    db.state.rates = [OLD_RATE]
    const pipeline = new Pipeline(db, OPTS, HOME)

    await burst(pipeline, '2026-09-04T09:00:00.000Z',
      { VehicleSpeed: MOVING, Location: { latitude: 47.6062, longitude: -122.3321 }, Soc: 80 })
    await burst(pipeline, '2026-09-04T09:20:00.000Z', { VehicleSpeed: 0, Soc: 74 })
    await burst(pipeline, '2026-09-04T09:30:00.000Z', { VehicleSpeed: 0, Soc: 74 })
    await pipeline.flush(t('2026-09-04T09:30:05.000Z'))

    expect(db.state.sessions[0]?.kind).toBe('drive')
    expect(db.state.costs).toEqual([])
    expect(db.state.rateLookups).toEqual([])
  })

  it('places a charge at home by coordinate when the car never says so', async () => {
    // Old sessions predate the `locatedAtHome` field, and a car that has not
    // pushed the hourly `static` tier yet reports nothing either. The start
    // coordinate is the fallback, and without a configured home there is none.
    const db = new FakeDb()
    db.state.rates = [OLD_RATE]
    const pipeline = new Pipeline(db, OPTS, HOME)

    await chargeAt(pipeline, { Location: { latitude: 47.60665, longitude: -122.3321 } })

    expect(db.state.costs[0]?.costBasis).toBe('home')
    expect(db.state.costs[0]?.cost).toBeCloseTo(2.5, 5)
  })
})


/**
 * The staleness windows, pinned against the intervals we actually ask the car
 * for.
 *
 * These constants decide whether a parked car keeps looking like it is driving,
 * and whether a current tyre pressure is written to the database as null. A
 * previous version used one 15-minute window for every field and was wrong in
 * both directions at once; nothing failed, because nothing asserted the
 * relationship between the windows and the push intervals.
 *
 * The intervals below are the ones in scripts/push-telemetry-config.sh. If that
 * file changes, these tests are the thing that should notice.
 */
describe('staleness windows match the telemetry configuration we push', () => {
  const PUSHED_INTERVAL_MS = {
    VehicleSpeed: 10_000,
    Location: 10_000,
    Soc: 60_000,
    Odometer: 60_000,
    RatedRange: 300_000,
    Locked: 300_000,
    DoorState: 300_000,
    TpmsPressure: 3_600_000
  }

  it('keeps a level field alive well past the longest interval we request', () => {
    // TPMS is requested every 3600s and only sent on change, so an unchanged
    // pressure can legitimately go hours without being resent. A window shorter
    // than this writes null into the sample table for a value that is current.
    expect(STALE_VALUE_MS).toBeGreaterThan(PUSHED_INTERVAL_MS.TpmsPressure)
  })

  it('expires a volatile field long before a level one', () => {
    expect(VOLATILE_STALE_MS).toBeLessThan(STALE_VALUE_MS)
  })

  it('keeps a volatile field alive across several of its own intervals', () => {
    // Short enough to matter, but not so short that one missed burst blanks it.
    expect(VOLATILE_STALE_MS).toBeGreaterThan(PUSHED_INTERVAL_MS.VehicleSpeed * 10)
  })

  it('expires a stale speed no later than the segmenter would have parked the car', () => {
    // The upper bound, and the reason it is a relationship rather than a number.
    //
    // The segmenter ends a drive after driveEndParkedMs of being STATIONARY. It
    // cannot reach that state while a stale speed keeps reporting motion, and a
    // null speed reads as 'unknown', which does not start the parked clock
    // either - so the drive only ends once the stale value expires AND a
    // genuine stationary reading arrives. If this window were longer than
    // driveEndParkedMs, the accumulator would be the thing deciding when drives
    // end, silently overriding the segmenter's own threshold.
    expect(VOLATILE_STALE_MS).toBeLessThanOrEqual(DEFAULT_SEGMENTER_OPTIONS.driveEndParkedMs)
  })

  it('treats speed as volatile, because a stale speed wedges a drive open', () => {
    // The segmenter reads a null speed as 'unknown' motion, which does not start
    // the parked clock. So a speed that persists after the car stops reporting
    // holds the drive open indefinitely. This is the single most important
    // entry in the set.
    expect(VOLATILE_FIELDS.has('speedKph')).toBe(true)
    expect(staleWindowFor('speedKph')).toBe(VOLATILE_STALE_MS)
  })

  it('treats levels as levels', () => {
    for (const field of ['socPct', 'odometerKm', 'rangeKm', 'locked', 'tpms', 'chargeState']) {
      expect(staleWindowFor(field)).toBe(STALE_VALUE_MS)
    }
  })

  it('names only slots the accumulator can actually hold', () => {
    // THE TEST THAT WOULD HAVE CAUGHT THE LIVE BUG. `staleWindowFor` is only
    // ever called with accumulator slot keys, so a member of this set that is
    // not a slot is not a mistake anyone can see: it simply never matches, and
    // the field it was meant to expire is carried for six hours instead of
    // five minutes. `chargePowerKw` sat here doing exactly that - it is a
    // COLUMN, produced by `teslaStateToSample` collapsing the two rails, and it
    // never exists in the accumulator at all.
    const slots = new Set(TESLA_FIELDS.flatMap(slotsOf))
    // Not from the field catalogue: connectivity messages fill it, and the
    // accumulator derives it from power flow. Neither is volatile, but both are
    // real slots, so listing them here keeps this test about reality rather
    // than about the catalogue.
    slots.add('powerState')
    slots.add('activeRail')
    expect([...VOLATILE_FIELDS].filter((f) => !slots.has(f))).toEqual([])
  })

  it('treats every drive-tier slot except location and gear as volatile', () => {
    // A drive-tier field is one that pins to a constant in Park, so carrying
    // its last driving value into a parked sample describes motion that ended
    // hours ago. The two exceptions are levels wearing a drive tier's clothes:
    // a parked car's position is still where it is, and a car left in P is
    // still in P.
    const carried = new Set(['Location', 'Gear'])
    for (const entry of TESLA_FIELDS.filter((e) => e.tier === 'drive')) {
      for (const slot of slotsOf(entry)) {
        expect(staleWindowFor(slot)).toBe(
          carried.has(entry.field) ? STALE_VALUE_MS : VOLATILE_STALE_MS,
        )
      }
    }
  })
})

describe('FieldAccumulator staleness, at the boundaries', () => {
  const at = (ms: number): Date => new Date(ms)

  it('carries a tyre pressure that is older than the volatile window', () => {
    // The regression the two-class split exists to prevent: under one 15-minute
    // window this returned undefined and the sample recorded null.
    const acc = new FieldAccumulator()
    acc.apply({ tpms: { fl: 2.9 } }, at(0))
    acc.apply({ socPct: 71 }, at(40 * 60_000))
    const taken = acc.take()
    expect(taken?.state.tpms).toEqual({ fl: 2.9 })
  })

  it('drops a speed that is older than the volatile window', () => {
    const acc = new FieldAccumulator()
    acc.apply({ speedKph: 96 }, at(0))
    acc.apply({ socPct: 71 }, at(VOLATILE_STALE_MS))
    expect(acc.take()?.state.speedKph).toBeUndefined()
  })

  it('keeps a speed one millisecond inside the window', () => {
    const acc = new FieldAccumulator()
    acc.apply({ speedKph: 96 }, at(0))
    acc.apply({ socPct: 71 }, at(VOLATILE_STALE_MS - 1))
    expect(acc.take()?.state.speedKph).toBe(96)
  })

  it('drops a level exactly at its window and keeps it one millisecond inside', () => {
    const stale = new FieldAccumulator()
    stale.apply({ socPct: 55 }, at(0))
    stale.apply({ speedKph: 0 }, at(STALE_VALUE_MS))
    expect(stale.take()?.state.socPct).toBeUndefined()

    const fresh = new FieldAccumulator()
    fresh.apply({ socPct: 55 }, at(0))
    fresh.apply({ speedKph: 0 }, at(STALE_VALUE_MS - 1))
    expect(fresh.take()?.state.socPct).toBe(55)
  })

  it('expires a stale charge power instead of carrying it for six hours', () => {
    // THE LIVE BUG, end to end. The accumulator holds the two RAILS, and only
    // `teslaStateToSample` collapses them into `chargePowerKw` - so listing the
    // collapsed name as volatile expired nothing. A charge that stops being
    // reported must go null, not keep claiming 11 kW: a non-zero power holds a
    // charge session open exactly as a non-zero speed holds a drive open.
    const acc = new FieldAccumulator()
    acc.apply({ acPowerKw: 11, activeRail: 'ac' }, at(0))
    acc.apply({ socPct: 71 }, at(VOLATILE_STALE_MS))
    const taken = acc.take()
    expect(taken?.state.acPowerKw).toBeUndefined()
    expect(teslaStateToSample('veh-1', taken!.ts, taken!.state).chargePowerKw).toBeNull()
  })

  it('keeps a charge power one millisecond inside the volatile window', () => {
    const acc = new FieldAccumulator()
    acc.apply({ dcPowerKw: 48, activeRail: 'dc' }, at(0))
    acc.apply({ socPct: 71 }, at(VOLATILE_STALE_MS - 1))
    const taken = acc.take()
    expect(teslaStateToSample('veh-1', taken!.ts, taken!.state).chargePowerKw).toBe(48)
  })

  /**
   * The car sends a field only when it changes, so a steady charge reports
   * `DetailedChargeState` once, at the start, and its power only when it moves
   * by 0.5 kW - the 2026-09-26 charge sent none for eight hours. Expiring the
   * state like any other level closed every charge longer than six hours with
   * energy still flowing. So the state is refreshed by signs of charging:
   * positive power, or an energy counter that rises. It still expires six
   * hours after the last one, so a lost `Complete` cannot hold a charge open.
   */
  it('keeps the charge state past its window when charging power is reported', () => {
    const acc = new FieldAccumulator()
    acc.apply({ chargeStateDetailed: 'charging' }, at(0))
    acc.apply({ acPowerKw: 7.2, activeRail: 'ac' }, at(STALE_VALUE_MS + 60_000))
    expect(acc.take()?.state.chargeStateDetailed).toBe('charging')
  })

  it('keeps the charge state while the energy counter rises, with no power reported', () => {
    const acc = new FieldAccumulator()
    acc.apply({ chargeStateDetailed: 'charging' }, at(0))
    acc.apply({ acEnergyKwh: 10 }, at(60 * 60_000))
    acc.apply({ acEnergyKwh: 10.5 }, at(5 * 60 * 60_000))
    acc.apply({ socPct: 80 }, at(STALE_VALUE_MS + 30 * 60_000))
    expect(acc.take()?.state.chargeStateDetailed).toBe('charging')
  })

  it('does not count a zero power or a counter that stays put as charging', () => {
    const acc = new FieldAccumulator()
    acc.apply({ chargeStateDetailed: 'charging' }, at(0))
    acc.apply({ acEnergyKwh: 10 }, at(60 * 60_000))
    acc.apply({ acEnergyKwh: 10, acPowerKw: 0 }, at(5 * 60 * 60_000))
    acc.apply({ socPct: 80 }, at(STALE_VALUE_MS))
    expect(acc.take()?.state.chargeStateDetailed).toBeUndefined()
  })

  it('drops the charge state six hours after the last sign of charging', () => {
    const acc = new FieldAccumulator()
    acc.apply({ chargeStateDetailed: 'charging' }, at(0))
    acc.apply({ acPowerKw: 7.2, activeRail: 'ac' }, at(60 * 60_000))
    acc.apply({ socPct: 80 }, at(60 * 60_000 + STALE_VALUE_MS))
    expect(acc.take()?.state.chargeStateDetailed).toBeUndefined()
  })

  it('never invents a value for a field that was never reported', () => {
    // Absent must stay absent so teslaStateToSample writes null, not 0.
    const acc = new FieldAccumulator()
    acc.apply({ socPct: 55 }, at(0))
    const taken = acc.take()
    expect(taken?.state.speedKph).toBeUndefined()
    expect('speedKph' in (taken?.state ?? {})).toBe(false)
  })
})
