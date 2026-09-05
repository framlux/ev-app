import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeSample, type SessionSummary } from '@ev/core'
import { closePool, getPool } from '../src/pool.js'
import { runMigrations } from '../src/migrate.js'
import { withTransaction } from '../src/repo/types.js'
import { insertRaw, streamRaw } from '../src/repo/raw.js'
import { ensurePartitions, insertSample } from '../src/repo/samples.js'
import { ensureVehicle } from '../src/repo/vehicles.js'
import { appendPoint, closeSession, findOpenSession, openSession } from '../src/repo/sessions.js'
import { upsertBatteryHealth } from '../src/repo/battery.js'
import { advanceCursor, readCursor } from '../src/repo/cursor.js'

/**
 * The repository layer against a real Postgres. These exist because the ingest
 * worker's idempotency lives in SQL, not in TypeScript: ON CONFLICT DO NOTHING,
 * a PARTIAL unique index that cannot be named as a conflict target, and a
 * GREATEST guard on the watermark. A unit test with a fake store can only
 * restate those rules; only this file checks that the database agrees.
 *
 * See migrate.test.ts for how to run a throwaway Postgres locally.
 */
const hasDb = Boolean(process.env['PGHOST'])

if (!hasDb && process.env['CI']) {
  throw new Error(
    'PGHOST is unset in CI: the repository tests must run against a real Postgres. ' +
      'See the postgres service in .github/workflows/test.yml.',
  )
}

const VEHICLE = 'repo-test-v1'
const TS = new Date('2026-09-04T10:00:00.000Z')

const summary = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  startedAt: TS, endedAt: new Date(TS.getTime() + 60_000),
  distanceKm: 10, energyKwh: 2, efficiencyWhPerKm: 200, avgSpeedKph: 30,
  maxChargePowerKw: null, startSocPct: 80, endSocPct: 77,
  startOdometerKm: 1000, endOdometerKm: 1010,
  startLat: 51.5, startLon: -0.1, endLat: 51.6, endLon: -0.2,
  ...over,
})

describe.skipIf(!hasDb)('repositories', () => {
  beforeAll(async () => {
    await runMigrations()
    await withTransaction(getPool(), async (c) => {
      await ensurePartitions(c, TS)
      await ensureVehicle(c, {
        id: VEHICLE, vendor: 'tesla', vendorVehicleId: 'VIN-REPO', displayName: 'Repo',
      })
    })
  })

  afterAll(async () => {
    const p = getPool()
    await p.query('DELETE FROM session WHERE vehicle_id=$1', [VEHICLE])
    await p.query('DELETE FROM sample WHERE vehicle_id=$1', [VEHICLE])
    await p.query('DELETE FROM raw_message WHERE vehicle_id=$1', [VEHICLE])
    await p.query('DELETE FROM battery_health_sample WHERE vehicle_id=$1', [VEHICLE])
    await p.query('DELETE FROM ingest_cursor WHERE source=$1', ['repo-test'])
    await p.query('DELETE FROM vehicle WHERE id=$1', [VEHICLE])
    await closePool()
  })

  it('inserting the same sample twice leaves one row', async () => {
    const sample = makeSample({ vehicleId: VEHICLE, ts: TS, socPct: 80, speedKph: 0 })
    await withTransaction(getPool(), async (c) => {
      await insertSample(c, sample)
      // The redelivery. It must not raise, and must not duplicate.
      await insertSample(c, { ...sample, socPct: 81 })
    })

    const { rows } = await getPool().query(
      'SELECT soc_pct FROM sample WHERE vehicle_id=$1 AND ts=$2', [VEHICLE, TS])
    expect(rows).toHaveLength(1)
    // DO NOTHING, not an upsert: the first write wins.
    expect(rows[0]?.soc_pct).toBe(80)
  })

  it('opening a session twice adopts the one that is already open', async () => {
    const first = await withTransaction(getPool(), (c) =>
      openSession(c, VEHICLE, 'drive', TS))
    // A restarted worker with no memory. The partial unique index rejects the
    // second insert, and openSession must return the live id rather than the
    // UUID it just made up.
    const second = await withTransaction(getPool(), (c) =>
      openSession(c, VEHICLE, 'drive', TS))
    expect(second).toBe(first)

    // The id it returns must be usable as a foreign key.
    await withTransaction(getPool(), (c) =>
      appendPoint(c, second, makeSample({ vehicleId: VEHICLE, ts: TS, socPct: 80 })))

    const open = await withTransaction(getPool(), (c) => findOpenSession(c, VEHICLE, 'drive'))
    expect(open?.id).toBe(first)

    await withTransaction(getPool(), (c) => closeSession(c, first, summary()))
    expect(await withTransaction(getPool(), (c) => findOpenSession(c, VEHICLE, 'drive')))
      .toBeNull()

    // Closed, so a new drive is allowed again and gets a new id.
    const third = await withTransaction(getPool(), (c) =>
      openSession(c, VEHICLE, 'drive', new Date(TS.getTime() + 3_600_000)))
    expect(third).not.toBe(first)
    await getPool().query('DELETE FROM session WHERE id=$1', [third])
  })

  it('appending the same session point twice leaves one row', async () => {
    const id = await withTransaction(getPool(), (c) =>
      openSession(c, VEHICLE, 'charge', TS))
    const point = makeSample({ vehicleId: VEHICLE, ts: TS, socPct: 50 })
    await withTransaction(getPool(), async (c) => {
      await appendPoint(c, id, point)
      await appendPoint(c, id, point)
    })
    const { rows } = await getPool().query(
      'SELECT count(*)::int AS n FROM session_point WHERE session_id=$1', [id])
    expect(rows[0]?.n).toBe(1)
    await withTransaction(getPool(), (c) => closeSession(c, id, summary()))
  })

  it('keeps the more confident battery estimate for a day', async () => {
    const day = new Date('2026-09-04T00:00:00.000Z')
    const base = {
      vehicleId: VEHICLE, observedOn: day, ratedRangeAt100Km: null,
    }
    await withTransaction(getPool(), async (c) => {
      await upsertBatteryHealth(c, { ...base, estimatedCapacityKwh: 70, sampleConfidence: 0.25 })
      await upsertBatteryHealth(c, { ...base, estimatedCapacityKwh: 74, sampleConfidence: 0.75 })
      // Lower confidence must not overwrite the better measurement.
      await upsertBatteryHealth(c, { ...base, estimatedCapacityKwh: 60, sampleConfidence: 0.30 })
    })
    const { rows } = await getPool().query(
      `SELECT estimated_capacity_kwh AS kwh, sample_confidence AS conf
         FROM battery_health_sample WHERE vehicle_id=$1`, [VEHICLE])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kwh).toBeCloseTo(74, 3)
    expect(rows[0]?.conf).toBeCloseTo(0.75, 3)
  })

  it('never moves the ingest cursor backwards', async () => {
    const later = new Date('2026-09-04T12:00:00.000Z')
    const earlier = new Date('2026-09-04T11:00:00.000Z')
    await withTransaction(getPool(), async (c) => {
      await advanceCursor(c, 'repo-test', later, 'm2')
      // Redelivery after a crash replays messages we already committed.
      await advanceCursor(c, 'repo-test', earlier, 'm1')
    })
    const cursor = await withTransaction(getPool(), (c) => readCursor(c, 'repo-test'))
    expect(cursor?.lastProcessedAt.toISOString()).toBe(later.toISOString())
    expect(cursor?.lastMessageId).toBe('m2')
  })

  it('streams the raw tape in order and excludes the upper bound', async () => {
    const at = (m: number) => new Date(TS.getTime() + m * 60_000)
    await withTransaction(getPool(), async (c) => {
      for (const m of [2, 0, 1]) {
        await insertRaw(c, {
          vehicleId: VEHICLE, vendor: 'tesla', source: 'telemetry',
          receivedAt: at(m), payload: { seq: m },
        })
      }
    })

    const seen = await withTransaction(getPool(), async (c) => {
      const out: number[] = []
      // batchSize 1 exercises the keyset pagination rather than one big page.
      for await (const row of streamRaw(c, at(0), at(2), 1)) {
        out.push((row.payload as { seq: number }).seq)
      }
      return out
    })
    // Ordered, and `to` is exclusive so adjacent windows neither overlap nor
    // leave a hole.
    expect(seen).toEqual([0, 1])
  })
})
