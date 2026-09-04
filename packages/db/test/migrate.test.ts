import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePool, getPool } from '../src/pool.js'
import { runMigrations } from '../src/migrate.js'

/**
 * These tests need a real Postgres. Locally, point them at a throwaway one:
 *
 *   docker run --rm -d -e POSTGRES_PASSWORD=ev -e POSTGRES_USER=ev \
 *     -e POSTGRES_DB=ev -p 55432:5432 postgres:17-alpine
 *   PGHOST=localhost PGPORT=55432 PGUSER=ev PGPASSWORD=ev PGDATABASE=ev \
 *     pnpm vitest run packages/db/test/migrate.test.ts
 *
 * They may be skipped on a developer machine with no Docker, but never in CI:
 * a permanently-skipped schema test is a test that reports green while the
 * partitioning and the one-open-session index rot.
 */
const hasDb = Boolean(process.env['PGHOST'])

if (!hasDb && process.env['CI']) {
  throw new Error(
    'PGHOST is unset in CI: the schema tests must run against a real Postgres. ' +
      'See the postgres service in .github/workflows/test.yml.',
  )
}

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
