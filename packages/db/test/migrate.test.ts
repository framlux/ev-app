import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePool, getPool } from '../src/pool.js'
import { runMigrations } from '../src/migrate.js'

// Skipped when no Postgres is pointed at, so CI without Docker stays green.
const hasDb = Boolean(process.env['PGHOST'])

describe.skipIf(!hasDb)('migrations', () => {
  beforeAll(async () => { await runMigrations() })
  afterAll(async () => { await closePool() })

  it('creates the sample table partitioned by ts', async () => {
    const { rows } = await getPool().query(
      `SELECT partstrat FROM pg_partitioned_table
       JOIN pg_class c ON c.oid = partrelid WHERE c.relname = 'sample'`)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.partstrat).toBe('r')
  })

  it('permits only one open session per vehicle per kind', async () => {
    const p = getPool()
    await p.query(`INSERT INTO vehicle (id, vendor, vendor_vehicle_id, display_name)
                   VALUES ('v1','tesla','VIN1','Y') ON CONFLICT DO NOTHING`)
    await p.query(`INSERT INTO session (id, vehicle_id, kind, started_at, is_open)
                   VALUES ('s1','v1','drive', now(), true)`)
    await expect(
      p.query(`INSERT INTO session (id, vehicle_id, kind, started_at, is_open)
               VALUES ('s2','v1','drive', now(), true)`),
    ).rejects.toThrow(/session_one_open_per_kind/)
  })

  it('creates the current month partitions', async () => {
    const { rows } = await getPool().query(
      `SELECT to_regclass('sample_' || to_char(CURRENT_DATE,'YYYY_MM')) AS t`)
    expect(rows[0]?.t).not.toBeNull()
  })
})
