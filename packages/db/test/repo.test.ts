import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  makeSample, SAMPLE_COLUMNS,
  type SampleColumn, type SessionSummary, type VehicleSample,
} from '@ev/core'
import { closePool, getPool } from '../src/pool.js'
import { runMigrationsUnderGate } from '../src/migrate.js'
import { withTransaction } from '../src/repo/types.js'
import { insertRaw, streamRaw } from '../src/repo/raw.js'
import { ensurePartitions, insertSample, upsertSample } from '../src/repo/samples.js'
import { ensureVehicle } from '../src/repo/vehicles.js'
import {
  appendPoint, closeSession, deleteDerived, findOpenSession, openSession,
} from '../src/repo/sessions.js'
import { recordMeasuredCapacity, upsertBatteryHealth } from '../src/repo/battery.js'
import { advanceCursor, readCursor } from '../src/repo/cursor.js'
import { notifyVehicleChanged, VEHICLE_CHANGED_CHANNEL } from '../src/repo/notify.js'
import {
  readTelemetryStatus, recordTelemetryCheck, recordTelemetryPush,
  type TelemetryCheck,
} from '../src/repo/telemetry-status.js'

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
/**
 * A second car that never gets checked, only pushed to. It exists because the
 * telemetry-status tests below must not depend on the order vitest happens to
 * run them in: "a push creates the row" is only a test of anything on a
 * vehicle whose row does not already exist.
 */
const VEHICLE_UNCHECKED = 'repo-test-v2'
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
      await ensureVehicle(c, {
        id: VEHICLE_UNCHECKED, vendor: 'tesla',
        vendorVehicleId: 'VIN-REPO-2', displayName: 'Repo 2',
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
    await p.query('DELETE FROM telemetry_status WHERE vehicle_id = ANY($1)',
      [[VEHICLE, VEHICLE_UNCHECKED]])
    await p.query('DELETE FROM vehicle WHERE id = ANY($1)', [[VEHICLE, VEHICLE_UNCHECKED]])
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

  /**
   * The reprocess write path (spec §4's last row, §6 step 4).
   *
   * `gear` and `charge_amps` have been taped since day one and had nowhere to
   * go, so the rows they belong on already exist — and `insertSample` cannot
   * write them, by design. The backfill therefore gets its OWN statement rather
   * than a relaxation of that one: the live path's DO NOTHING is what makes an
   * MQTT redelivery a no-op, and it stays exactly as it was.
   */
  describe('the reprocess upsert', () => {
    const REPLAY_TS = new Date('2026-09-20T10:00:00.000Z')
    const WINDOW_FROM = new Date('2026-09-20T00:00:00.000Z')
    const WINDOW_TO = new Date('2026-09-21T00:00:00.000Z')

    it('writes the columns an existing row lacks', async () => {
      // The row as the live worker wrote it before those columns existed: the
      // car was reporting gear and charge amps, and both were discarded.
      await withTransaction(getPool(), (c) =>
        insertSample(c, makeSample({ vehicleId: VEHICLE, ts: REPLAY_TS, socPct: 80 })))

      await withTransaction(getPool(), (c) =>
        upsertSample(c, makeSample({
          vehicleId: VEHICLE, ts: REPLAY_TS, socPct: 80, gear: 'D', chargeAmps: 16,
        })))

      const { rows } = await getPool().query(
        'SELECT soc_pct, gear, charge_amps FROM sample WHERE vehicle_id=$1 AND ts=$2',
        [VEHICLE, REPLAY_TS])
      expect(rows).toHaveLength(1)
      expect(rows[0]?.gear).toBe('D')
      expect(rows[0]?.charge_amps).toBe(16)
      expect(rows[0]?.soc_pct).toBe(80)
    })

    it('does not blank a populated column with a sparser replay', async () => {
      // The reason DO NOTHING was chosen, kept intact where it still applies. A
      // replay starting mid-history begins with a cold accumulator, so its first
      // samples know LESS than the rows already on disk; a straight EXCLUDED
      // assignment would write those nulls over real values, and nothing would
      // report it. A value still wins over a value — the tape is authoritative
      // when it has something to say.
      await withTransaction(getPool(), (c) =>
        upsertSample(c, makeSample({ vehicleId: VEHICLE, ts: REPLAY_TS, gear: 'P' })))

      const { rows } = await getPool().query(
        'SELECT soc_pct, gear, charge_amps FROM sample WHERE vehicle_id=$1 AND ts=$2',
        [VEHICLE, REPLAY_TS])
      expect(rows).toHaveLength(1)
      expect(rows[0]?.gear).toBe('P')
      expect(rows[0]?.soc_pct).toBe(80)
      expect(rows[0]?.charge_amps).toBe(16)
    })

    it('does not resurrect a row the rebuild deleted', async () => {
      const gone = new Date('2026-09-20T11:00:00.000Z')
      await withTransaction(getPool(), (c) =>
        insertSample(c, makeSample({ vehicleId: VEHICLE, ts: gone, socPct: 40 })))

      // What `reprocess` does, in the order it does it: delete the window, then
      // replay the tape into it. The upsert must write only what the replay
      // produced — a row whose messages are no longer on the tape stays gone,
      // or a rebuild would be a merge onto history rather than a rebuild of it.
      await withTransaction(getPool(), async (c) => {
        await deleteDerived(c, VEHICLE, WINDOW_FROM, WINDOW_TO)
        await upsertSample(c, makeSample({
          vehicleId: VEHICLE, ts: REPLAY_TS, socPct: 80, gear: 'D',
        }))
      })

      const { rows } = await getPool().query(
        'SELECT ts, gear FROM sample WHERE vehicle_id=$1 AND ts >= $2 AND ts < $3 ORDER BY ts',
        [VEHICLE, WINDOW_FROM, WINDOW_TO])
      expect(rows.map((r: { ts: Date }) => r.ts.toISOString()))
        .toEqual([REPLAY_TS.toISOString()])
      // And the row it did write is the replay's, not a survivor of it.
      expect(rows[0]?.gear).toBe('D')
    })
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

  /**
   * The measurement and the estimate share a row and must not shout each other
   * down. Both directions are silent when they go wrong — a losing
   * `DO UPDATE … WHERE` writes nothing and raises nothing — so both are
   * checked here against a real Postgres rather than reasoned about.
   */
  it('records a measured capacity on a day an estimate already holds', async () => {
    const day = new Date('2026-09-06T12:00:00.000Z')
    await withTransaction(getPool(), async (c) => {
      await upsertBatteryHealth(c, {
        vehicleId: VEHICLE, observedOn: day, estimatedCapacityKwh: 74,
        ratedRangeAt100Km: null, sampleConfidence: 0.9,
      })
      // A measurement has no confidence on the estimator's scale, so routing it
      // through upsertBatteryHealth would lose to that 0.9 and vanish.
      await recordMeasuredCapacity(c, {
        vehicleId: VEHICLE, observedOn: day,
        measuredCapacityKwh: 71.2, ratedRangeAt100Km: 402.5,
      })
    })
    const { rows } = await getPool().query(
      `SELECT measured_capacity_kwh AS measured, estimated_capacity_kwh AS estimated,
              rated_range_at_100_km AS rated, sample_confidence AS conf
         FROM battery_health_sample
        WHERE vehicle_id=$1 AND observed_on='2026-09-06'`, [VEHICLE])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.measured).toBeCloseTo(71.2, 3)
    expect(rows[0]?.rated).toBeCloseTo(402.5, 1)
    // And it left the estimate alone: they are two different claims.
    expect(rows[0]?.estimated).toBeCloseTo(74, 3)
    expect(rows[0]?.conf).toBeCloseTo(0.9, 3)
  })

  it('files a day that has a measurement and no qualifying charge', async () => {
    // 23:30Z: the day is counted in UTC, not in the writer's zone.
    const day = new Date('2026-09-07T23:30:00.000Z')
    await withTransaction(getPool(), (c) => recordMeasuredCapacity(c, {
      vehicleId: VEHICLE, observedOn: day,
      measuredCapacityKwh: 70.5, ratedRangeAt100Km: null,
    }))
    const { rows } = await getPool().query(
      `SELECT to_char(observed_on,'YYYY-MM-DD') AS day,
              measured_capacity_kwh AS measured, estimated_capacity_kwh AS estimated,
              sample_confidence AS conf
         FROM battery_health_sample
        WHERE vehicle_id=$1 AND measured_capacity_kwh=70.5`, [VEHICLE])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.day).toBe('2026-09-07')
    // The whole point of dropping the two NOT NULLs: most days have a
    // measurement and no charge wide enough to estimate from.
    expect(rows[0]?.estimated).toBeNull()
    expect(rows[0]?.conf).toBeNull()
  })

  it('lets the estimator write onto a day the measurement created', async () => {
    const day = new Date('2026-09-08T01:00:00.000Z')
    await withTransaction(getPool(), async (c) => {
      await recordMeasuredCapacity(c, {
        vehicleId: VEHICLE, observedOn: day,
        measuredCapacityKwh: 71, ratedRangeAt100Km: 405,
      })
      // The mirror of the case above, and the one the spec does not mention:
      // `NULL < 0.4` is NULL rather than true, so an unguarded confidence
      // comparison makes every estimate a no-op once a measurement exists —
      // which, written daily, is every day.
      await upsertBatteryHealth(c, {
        vehicleId: VEHICLE, observedOn: day, estimatedCapacityKwh: 73,
        ratedRangeAt100Km: null, sampleConfidence: 0.4,
      })
    })
    const { rows } = await getPool().query(
      `SELECT measured_capacity_kwh AS measured, estimated_capacity_kwh AS estimated,
              rated_range_at_100_km AS rated, sample_confidence AS conf
         FROM battery_health_sample
        WHERE vehicle_id=$1 AND observed_on='2026-09-08'`, [VEHICLE])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.estimated).toBeCloseTo(73, 3)
    expect(rows[0]?.conf).toBeCloseTo(0.4, 3)
    expect(rows[0]?.measured).toBeCloseTo(71, 3)
    // The estimator has nothing to say about rated range and passes null; that
    // must not erase the measurement's.
    expect(rows[0]?.rated).toBeCloseTo(405, 1)
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

  /**
   * Spec §3.7's cached status. It is written by two different callers with two
   * different sets of facts — a check knows what the car has applied, a push
   * knows only that it sent something — and read by a page that runs with no
   * Tesla session at all. So the three things worth proving against a real
   * Postgres are that a write survives the round trip, that the two writers do
   * not erase each other, and that day one reads as "nothing known" rather
   * than throwing.
   */
  describe('the cached telemetry status', () => {
    const CHECKED = new Date('2026-09-05T12:00:00.000Z')
    const LATER = new Date('2026-09-05T13:00:00.000Z')
    const PUSHED = new Date('2026-09-05T12:30:00.000Z')

    const check = (over: Partial<TelemetryCheck> = {}): TelemetryCheck => ({
      vehicleId: VEHICLE, synced: false, fieldCount: 7, caPresent: true,
      firmware: '2026.8.1', keyPaired: true, streamingEnabled: true,
      checkedAt: CHECKED, ...over,
    })

    // Day one, and every day after a `vehicle` row is created by ingestion
    // before anyone opens the settings page. The page renders "never checked"
    // from this; a throw here would be an error page instead.
    it('reads null for a vehicle that has never been checked', async () => {
      const row = await withTransaction(getPool(), (c) =>
        readTelemetryStatus(c, 'repo-test-never-checked'))
      expect(row).toBeNull()
    })

    it('round-trips a check and overwrites it with the next one', async () => {
      await withTransaction(getPool(), (c) => recordTelemetryCheck(c, check()))
      const first = await withTransaction(getPool(), (c) =>
        readTelemetryStatus(c, VEHICLE))
      expect(first).toEqual({
        vehicleId: VEHICLE, synced: false, fieldCount: 7, caPresent: true,
        firmware: '2026.8.1', keyPaired: true, streamingEnabled: true,
        checkedAt: CHECKED, pushedAt: null,
      })

      // The car applied the config an hour later. One row per vehicle, so the
      // second check must replace the first rather than accumulate: the page
      // shows "the" status and its age, not a history.
      await withTransaction(getPool(), (c) => recordTelemetryCheck(c, check({
        synced: true, fieldCount: 9, firmware: '2026.8.2', checkedAt: LATER,
      })))
      const { rows } = await getPool().query(
        'SELECT * FROM telemetry_status WHERE vehicle_id=$1', [VEHICLE])
      expect(rows).toHaveLength(1)
      const second = await withTransaction(getPool(), (c) =>
        readTelemetryStatus(c, VEHICLE))
      expect(second?.synced).toBe(true)
      expect(second?.fieldCount).toBe(9)
      expect(second?.firmware).toBe('2026.8.2')
      expect(second?.checkedAt?.toISOString()).toBe(LATER.toISOString())
    })

    // The two writers, interleaved. `synced` staying false after a push is the
    // normal case (§5: the car applies on its own schedule), and the page can
    // only say so if `pushed_at` and the check facts survive each other.
    it('keeps the check facts and the push time out of each other\'s way', async () => {
      await withTransaction(getPool(), async (c) => {
        await recordTelemetryCheck(c, check())
        await recordTelemetryPush(c, VEHICLE, PUSHED)
      })
      const afterPush = await withTransaction(getPool(), (c) =>
        readTelemetryStatus(c, VEHICLE))
      expect(afterPush?.pushedAt?.toISOString()).toBe(PUSHED.toISOString())
      expect(afterPush?.fieldCount).toBe(7)
      expect(afterPush?.checkedAt?.toISOString()).toBe(CHECKED.toISOString())

      // And the check that follows a push must not forget that a push happened
      // — losing `pushed_at` here would make the page offer the same push again.
      await withTransaction(getPool(), (c) => recordTelemetryCheck(c, check({
        synced: true, checkedAt: LATER,
      })))
      const afterCheck = await withTransaction(getPool(), (c) =>
        readTelemetryStatus(c, VEHICLE))
      expect(afterCheck?.pushedAt?.toISOString()).toBe(PUSHED.toISOString())
      expect(afterCheck?.synced).toBe(true)
    })

    // Push first, check never: the row has to come into existence from the
    // push alone, with everything it cannot know left null rather than
    // defaulted into a claim about the car.
    it('creates the row from a push alone, with the unobserved facts null', async () => {
      await withTransaction(getPool(), (c) =>
        recordTelemetryPush(c, VEHICLE_UNCHECKED, PUSHED))
      const row = await withTransaction(getPool(), (c) =>
        readTelemetryStatus(c, VEHICLE_UNCHECKED))
      expect(row).toEqual({
        vehicleId: VEHICLE_UNCHECKED, synced: null, fieldCount: null,
        caPresent: null, firmware: null, keyPaired: null,
        streamingEnabled: null, checkedAt: null, pushedAt: PUSHED,
      })
    })
  })
})
