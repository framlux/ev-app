import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  makeSample, SAMPLE_COLUMNS,
  type SampleColumn, type SessionSummary, type VehicleSample,
} from '@ev/core'
import { closePool, getPool } from '../src/pool.js'
import { runMigrationsUnderGate } from '../src/migrate.js'
import { withTransaction } from '../src/repo/types.js'
import { insertRaw, streamRaw } from '../src/repo/raw.js'
import { ensurePartitions, insertSample } from '../src/repo/samples.js'
import { ensureVehicle } from '../src/repo/vehicles.js'
import { appendPoint, closeSession, findOpenSession, openSession } from '../src/repo/sessions.js'
import { upsertBatteryHealth } from '../src/repo/battery.js'
import { advanceCursor, readCursor } from '../src/repo/cursor.js'
import { notifyVehicleChanged, VEHICLE_CHANGED_CHANNEL } from '../src/repo/notify.js'

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

/**
 * A representative value for one column, picked so that what Postgres hands
 * back is comparable to what went in. 1.5 is exact in a `REAL`; 0.1 is not, and
 * would come back as 0.10000000149011612 and fail a round-trip that is in fact
 * fine. `INT` gets a whole number for the same reason.
 */
function sampleValue(c: SampleColumn): unknown {
  switch (c.ts) {
    case 'number': return c.sql === 'INT' ? 7 : 1.5
    case 'string': return `v:${c.column}`
    case 'boolean': return true
    case 'PowerState': return 'online'
    case 'ChargeState': return 'charging'
    case 'TpmsMap': return { fl: 2.5, fr: 2.5, rl: 2.5, rr: 2.5 }
    case 'Date': return new Date('2026-09-04T09:00:00.000Z')
  }
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


/**
 * Serialises runMigrations() across test FILES, using the database itself.
 *
 * vitest runs this file and its sibling (migrate.test.ts) in separate worker
 * PROCESSES, concurrently, and on a fresh CI database both of them have
 * migrations to apply. node-pg-migrate guards itself with
 * `pg_try_advisory_lock` — a TRY, not a wait — so the loser does not queue, it
 * throws "Another migration is already running" straight away. That throw
 * lands in beforeAll, and vitest reports a file whose beforeAll threw as
 * SKIPPED tests plus a failed suite: the job goes red while the test list
 * looks merely un-run, which is a confusing way to lose the SQL coverage.
 *
 * The gate below is duplicated in the sibling file on purpose. A shared
 * TypeScript helper could not fix this: the two workers are separate
 * processes with separate module graphs, so the only thing they can both see
 * is the database. Hence a Postgres advisory lock.
 *
 * The key must NOT be node-pg-migrate's own (7241865325823964). The two locks
 * are taken on different connections, so reusing the key would make us wait
 * on ourselves forever. `pg_advisory_lock` BLOCKS rather than failing, so the
 * second worker waits, then finds every migration already applied and does
 * nothing.
 */


describe.skipIf(!hasDb)('repositories', () => {
  // Generous timeout: this hook may spend most of it waiting on the gate
  // while the sibling file migrates.
  beforeAll(async () => {
    await runMigrationsUnderGate()
    await withTransaction(getPool(), async (c) => {
      await ensurePartitions(c, TS)
      await ensureVehicle(c, {
        id: VEHICLE, vendor: 'tesla', vendorVehicleId: 'VIN-REPO', displayName: 'Repo',
      })
    })
  }, 60_000)

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

  /**
   * Every column at once. `insertSample` binds all of them in a single
   * statement inside the ingest transaction, so ONE column whose declared SQL
   * type rejects what the decoder produces rolls the whole transaction back —
   * the message is never acked and is redelivered forever (spec §3.4's wedge).
   * A per-column unit test cannot see that; only a full-width insert against a
   * real Postgres can.
   */
  it('round-trips a sample with every catalogued column populated', async () => {
    const ts = new Date('2026-09-04T10:05:00.000Z')
    const populated = Object.fromEntries(
      SAMPLE_COLUMNS.map((c) => [c.key, sampleValue(c)]),
    ) as Partial<VehicleSample>
    const full = makeSample({ vehicleId: VEHICLE, ts, ...populated })

    await withTransaction(getPool(), (c) => insertSample(c, full))

    const { rows } = await getPool().query(
      'SELECT * FROM sample WHERE vehicle_id=$1 AND ts=$2', [VEHICLE, ts])
    expect(rows).toHaveLength(1)
    for (const c of SAMPLE_COLUMNS) {
      expect(`${c.column}=${JSON.stringify(rows[0]?.[c.column])}`)
        .toBe(`${c.column}=${JSON.stringify(sampleValue(c))}`)
    }

    // The replay. Same key, every value different: DO NOTHING must leave the
    // first write standing, at two hundred columns exactly as at seventeen.
    await withTransaction(getPool(), (c) =>
      insertSample(c, makeSample({ vehicleId: VEHICLE, ts, socPct: 1 })))
    const after = await getPool().query(
      'SELECT soc_pct, gear FROM sample WHERE vehicle_id=$1 AND ts=$2', [VEHICLE, ts])
    expect(after.rows).toHaveLength(1)
    expect(after.rows[0]?.soc_pct).toBe(sampleValue(SAMPLE_COLUMNS[0]!))
    expect(after.rows[0]?.gear).not.toBeNull()
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

  it('files a charge under the UTC day, whatever timezone the writing process runs in', async () => {
    // 02:30Z on the 5th is still the 4th in Honolulu (UTC-10). node-postgres
    // serialises a Date using the NODE process's local offset
    // ("2026-09-04T16:30:00.000-10:00"), and a bare `$2::date` parses that
    // string as a date by keeping its leading calendar day — so the day a
    // charge is filed under would follow the writer's TZ setting, not the
    // charge. The same charge would land on 2026-09-04 from a machine in
    // Honolulu and 2026-09-05 from one in UTC: a duplicated or missing point
    // in the battery-health series at every timezone boundary.
    const instant = new Date('2026-09-05T02:30:00.000Z')
    const tzBefore = process.env['TZ']
    process.env['TZ'] = 'Pacific/Honolulu'
    try {
      await withTransaction(getPool(), async (c) => {
        // And the server's zone must not decide it either.
        await c.query("SET LOCAL TimeZone = 'Pacific/Kiritimati'")
        await upsertBatteryHealth(c, {
          vehicleId: VEHICLE, observedOn: instant, ratedRangeAt100Km: null,
          estimatedCapacityKwh: 71, sampleConfidence: 0.5,
        })
      })
    } finally {
      if (tzBefore === undefined) delete process.env['TZ']
      else process.env['TZ'] = tzBefore
    }
    // to_char, not the driver's date parsing: pg turns a `date` into a JS Date
    // built in the node process's local zone, which would re-introduce the very
    // ambiguity this test is about.
    const { rows } = await getPool().query(
      `SELECT to_char(observed_on,'YYYY-MM-DD') AS day
         FROM battery_health_sample
        WHERE vehicle_id=$1 AND estimated_capacity_kwh=71`, [VEHICLE])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.day).toBe('2026-09-05')
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

  it('delivers a notification only after the transaction commits', async () => {
    const pool = getPool()
    const listener = await pool.connect()
    const received: string[] = []
    listener.on('notification', (msg) => received.push(msg.payload ?? ''))
    await listener.query(`LISTEN ${VEHICLE_CHANGED_CHANNEL}`)

    const change = { vehicleId: VEHICLE, ts: TS.toISOString(), kind: 'sample' as const }

    // A transaction that rolls back must deliver nothing.
    await withTransaction(pool, async (c) => {
      await notifyVehicleChanged(c, change)
      throw new Error('rollback')
    }).catch(() => undefined)
    await new Promise((r) => setTimeout(r, 200))
    expect(received).toEqual([])

    // A transaction that commits must deliver exactly once.
    await withTransaction(pool, (c) => notifyVehicleChanged(c, change))
    await new Promise((r) => setTimeout(r, 200))
    expect(received).toEqual([JSON.stringify(change)])

    // UNLISTEN before the connection goes back to the pool: a subscription
    // that followed it back would deliver into a later test's client.
    await listener.query('UNLISTEN *')
    listener.release()
  })
})
