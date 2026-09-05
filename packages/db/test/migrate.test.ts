import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePool, getPool } from '../src/pool.js'
import { runMigrationsUnderGate } from '../src/migrate.js'

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


/**
 * Serialises runMigrations() across test FILES, using the database itself.
 *
 * vitest runs this file and its sibling (repo.test.ts) in separate worker
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


describe.skipIf(!hasDb)('migrations', () => {
  // Generous timeout: this hook may spend most of it waiting on the gate
  // while the sibling file migrates.
  beforeAll(async () => { await runMigrationsUnderGate() }, 60_000)
  afterAll(async () => {
    // Leave no rows behind. The one-open-session check below inserts a live
    // session and, unlike CI, a developer's throwaway database survives between
    // runs — a leftover 's1' makes the SECOND run fail on a duplicate key and
    // look like the index is broken.
    const p = getPool()
    await p.query("DELETE FROM session WHERE vehicle_id='v1'")
    await p.query("DELETE FROM vehicle WHERE id='v1'")
    await closePool()
  })

  it('creates the sample table partitioned by ts', async () => {
    const { rows } = await getPool().query(
      `SELECT partstrat FROM pg_partitioned_table
       JOIN pg_class c ON c.oid = partrelid WHERE c.relname = 'sample'`)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.partstrat).toBe('r')
  })

  it('permits only one open session per vehicle per kind', async () => {
    const p = getPool()
    await p.query("DELETE FROM session WHERE vehicle_id='v1'")
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
