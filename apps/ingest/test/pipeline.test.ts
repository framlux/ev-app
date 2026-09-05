import { describe, expect, it } from 'vitest'
import { makeSample } from '@ev/core'
import { Pipeline } from '../src/pipeline.js'
import { FakeDb, openSessions } from './support/fake-db.js'
import { num, str, teslaRaw } from './support/fixtures.js'

const OPTS = { usableCapacityKwh: 75 }
/** 40 mph. The segmenter's moving threshold is 1 kph and Tesla streams mph. */
const MOVING = 40
const t = (iso: string) => new Date(iso)

describe('Pipeline.handle', () => {
  it('writes the raw message and the derived sample in one commit', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)

    await pipeline.handle(teslaRaw('2026-09-04T10:00:00.000Z', { Soc: num(80) }))

    expect(db.state.raw).toHaveLength(1)
    expect(db.state.samples).toHaveLength(1)
    expect(db.state.samples[0]?.socPct).toBe(80)
    // One transaction, not two: raw and sample must never be separable.
    expect(db.log).toEqual(['commit'])
  })

  it('writes the raw message even when normalisation yields nothing', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)

    // A record whose only value is explicitly invalid: nothing mappable, but
    // the tape must still keep it or a later normaliser fix has nothing to
    // reprocess.
    await pipeline.handle(teslaRaw('2026-09-04T10:00:00.000Z', {
      Soc: { invalid: true, doubleValue: 0 },
    }))

    expect(db.state.raw).toHaveLength(1)
    expect(db.state.samples).toHaveLength(0)
  })

  it('creates the month partition before inserting into a partitioned table', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)

    await pipeline.handle(teslaRaw('2026-09-04T10:00:00.000Z', { Soc: num(80) }))
    expect(db.state.partitions).toContain('2026-8')

    // Second message, same month: the cache means no repeated DDL.
    const before = db.state.partitions.length
    await pipeline.handle(teslaRaw('2026-09-04T10:01:00.000Z', { Soc: num(79) }))
    expect(db.state.partitions.length).toBe(before)

    // A different month must still be created.
    await pipeline.handle(teslaRaw('2026-10-01T00:00:00.000Z', { Soc: num(79) }))
    expect(db.state.partitions).toContain('2026-9')
  })

  it('advances the ingest cursor and never rewinds it', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)

    await pipeline.handle(teslaRaw('2026-09-04T10:05:00.000Z', { Soc: num(80) }))
    expect(db.state.cursor?.toISOString()).toBe('2026-09-04T10:05:00.000Z')

    // A redelivered older message must not drag the watermark backwards.
    await pipeline.handle(teslaRaw('2026-09-04T10:00:00.000Z', { Soc: num(81) }))
    expect(db.state.cursor?.toISOString()).toBe('2026-09-04T10:05:00.000Z')
  })
})

describe('Pipeline session handling', () => {
  it('opens a drive session when the car starts moving', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)

    await pipeline.handleSample(makeSample({
      vehicleId: 'veh-1',
      ts: t('2026-09-04T10:00:00.000Z'),
      speedKph: 40,
      odometerKm: 1000,
      socPct: 80,
      chargeState: 'disconnected',
    }))

    expect(openSessions(db).map((s) => s.kind)).toEqual(['drive'])
    expect(db.state.points).toHaveLength(1)
  })

  it('closes a drive once parked and summarises it from the collected points', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)

    await pipeline.handle(teslaRaw('2026-09-04T10:00:00.000Z',
      { VehicleSpeed: num(MOVING), Odometer: num(1000), Soc: num(80) }))
    await pipeline.handle(teslaRaw('2026-09-04T10:05:00.000Z',
      { VehicleSpeed: num(MOVING), Odometer: num(1010), Soc: num(75) }))
    await pipeline.handle(teslaRaw('2026-09-04T10:10:00.000Z',
      { VehicleSpeed: num(0), Odometer: num(1015), Soc: num(74) }))
    // Six minutes stationary: past the five-minute drive-end threshold.
    await pipeline.handle(teslaRaw('2026-09-04T10:16:00.000Z',
      { VehicleSpeed: num(0), Odometer: num(1015), Soc: num(74) }))

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

    await pipeline.handle(teslaRaw('2026-09-04T20:00:00.000Z', {
      DetailedChargeState: str('DetailedChargeStateCharging'),
      Soc: num(30),
      ACChargingEnergyIn: num(0),
    }))
    await pipeline.handle(teslaRaw('2026-09-04T20:45:00.000Z', {
      DetailedChargeState: str('DetailedChargeStateCharging'),
      Soc: num(60),
      ACChargingEnergyIn: num(25),
    }))
    await pipeline.handle(teslaRaw('2026-09-04T20:50:00.000Z', {
      DetailedChargeState: str('DetailedChargeStateDisconnected'),
      Soc: num(60),
    }))

    expect(openSessions(db)).toHaveLength(0)
    expect(db.state.sessions[0]?.summary?.energyKwh).toBeCloseTo(25, 3)
    const health = db.state.battery[0]
    // 25 kWh over a 30-point span.
    expect(health?.estimatedCapacityKwh).toBeCloseTo(83.33, 2)
    expect(health?.sampleConfidence).toBeCloseTo(0.375, 3)
    expect(health?.observedOn.toISOString()).toBe('2026-09-04T20:45:00.000Z')
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
      await pipeline.handle(teslaRaw(at, { VehicleSpeed: num(speed), Soc: num(soc) }))
    }

    expect(db.state.sessions[0]?.isOpen).toBe(false)
    expect(db.state.battery).toHaveLength(0)
  })
})

describe('Pipeline idempotency', () => {
  it('leaves one row when the same message is processed twice', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)
    const raw = teslaRaw('2026-09-04T10:00:00.000Z',
      { VehicleSpeed: num(MOVING), Odometer: num(1000), Soc: num(80) })

    await pipeline.handle(raw)
    await pipeline.handle(raw)

    // The raw tape is append-only by design: a redelivery is a second row there
    // and reprocess handles the duplicate. Everything derived is deduplicated.
    expect(db.state.samples).toHaveLength(1)
    expect(db.state.sessions).toHaveLength(1)
    expect(db.state.points).toHaveLength(1)
  })

  it('adopts the open session instead of opening a second one', async () => {
    const db = new FakeDb()
    const first = new Pipeline(db, OPTS)
    await first.handle(teslaRaw('2026-09-04T10:00:00.000Z',
      { VehicleSpeed: num(MOVING), Odometer: num(1000) }))

    // A worker that restarted without recovering state: fresh segmenter, same
    // database. The partial unique index must stop a duplicate open session.
    const second = new Pipeline(db, OPTS)
    await second.handle(teslaRaw('2026-09-04T10:02:00.000Z',
      { VehicleSpeed: num(MOVING), Odometer: num(1002) }))

    expect(db.state.sessions).toHaveLength(1)
  })
})

describe('Pipeline transaction failure', () => {
  it('rolls the segmenter back with the transaction', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)
    const raw = teslaRaw('2026-09-04T10:00:00.000Z',
      { VehicleSpeed: num(MOVING), Odometer: num(1000), Soc: num(80) })

    db.failNextCommit = new Error('connection terminated')
    await expect(pipeline.handle(raw)).rejects.toThrow('connection terminated')

    // Nothing persisted, and — the part that matters — the in-memory segmenter
    // must not be holding the id of a session that the rollback erased. If it
    // were, the redelivery below would append a point to a session that does
    // not exist.
    expect(db.state.raw).toHaveLength(0)
    expect(db.state.sessions).toHaveLength(0)
    expect(db.log).toEqual(['rollback'])

    await pipeline.handle(raw)
    expect(db.state.raw).toHaveLength(1)
    expect(db.state.sessions).toHaveLength(1)
    expect(db.state.points).toHaveLength(1)
  })

  it('re-creates the month partition after a rolled-back transaction', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)
    const raw = teslaRaw('2026-09-04T10:00:00.000Z', { Soc: num(80) })

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

describe('Pipeline.recoverOpenSession', () => {
  it('resumes a session that was still running, keeping its points', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)

    // Two samples already on disk from before the crash.
    const samples = [
      makeSample({ vehicleId: 'veh-1', ts: t('2026-09-04T10:00:00.000Z'), speedKph: 60, odometerKm: 1000, socPct: 80 }),
      makeSample({ vehicleId: 'veh-1', ts: t('2026-09-04T10:05:00.000Z'), speedKph: 60, odometerKm: 1010, socPct: 75 }),
    ]
    db.state.sessions.push({
      id: 's-old', vehicleId: 'veh-1', kind: 'drive',
      startedAt: t('2026-09-04T10:00:00.000Z'), isOpen: true, summary: null,
    })

    await pipeline.recoverOpenSession('s-old', 'drive', samples)

    // Now park it. The summary must span the whole drive, not just what
    // arrived after the restart.
    await pipeline.handleSample(makeSample({
      vehicleId: 'veh-1', ts: t('2026-09-04T10:10:00.000Z'), speedKph: 0, odometerKm: 1020, socPct: 74 }))
    await pipeline.handleSample(makeSample({
      vehicleId: 'veh-1', ts: t('2026-09-04T10:16:00.000Z'), speedKph: 0, odometerKm: 1020, socPct: 74 }))

    const drive = db.state.sessions[0]
    expect(drive?.isOpen).toBe(false)
    expect(drive?.summary?.startOdometerKm).toBe(1000)
    expect(drive?.summary?.distanceKm).toBe(20)
    expect(db.state.sessions).toHaveLength(1)
  })

  it('closes a session whose samples show it had already finished', async () => {
    const db = new FakeDb()
    const pipeline = new Pipeline(db, OPTS)
    db.state.sessions.push({
      id: 's-old', vehicleId: 'veh-1', kind: 'drive',
      startedAt: t('2026-09-04T10:00:00.000Z'), isOpen: true, summary: null,
    })

    // The car parked before the crash but the close never committed. Left
    // alone this session stays open forever and blocks the next drive.
    await pipeline.recoverOpenSession('s-old', 'drive', [
      makeSample({ vehicleId: 'veh-1', ts: t('2026-09-04T10:00:00.000Z'), speedKph: 60, odometerKm: 1000 }),
      makeSample({ vehicleId: 'veh-1', ts: t('2026-09-04T10:05:00.000Z'), speedKph: 0, odometerKm: 1010 }),
      makeSample({ vehicleId: 'veh-1', ts: t('2026-09-04T10:12:00.000Z'), speedKph: 0, odometerKm: 1010 }),
    ])

    expect(openSessions(db)).toHaveLength(0)
    expect(db.state.sessions[0]?.summary?.endOdometerKm).toBe(1010)
  })
})
