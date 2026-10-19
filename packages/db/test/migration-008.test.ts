import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import migrate from 'node-pg-migrate'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * 008_canonical_gear.sql, run against data.
 *
 * It is a data migration, so reading its text proves nothing: the claims that
 * matter are what it does to rows that already exist - ShiftStateD becomes D, an
 * unnameable position becomes NULL, a Rivian's D is left alone on the way back
 * down - and those need a database that is at 007 with rows in it. The shared
 * `ev` database cannot be that. Every other test file migrates it to head and
 * writes to it concurrently, and this test has to take a schema DOWN a step, so
 * it gets a database of its own for the length of the file.
 *
 * It needs a real Postgres, like `migrate.test.ts`, and is skipped without one
 * on a developer machine but never in CI: a migration test that silently never
 * runs is the one that lets a backfill ship wrong.
 */
const hasDb = Boolean(process.env['PGHOST'])

if (!hasDb && process.env['CI']) {
  throw new Error(
    'PGHOST is unset in CI: the migration tests must run against a real Postgres. ' +
      'See the postgres service in .github/workflows/test.yml.',
  )
}

const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

/** How many migrations exist before the one under test. */
const BEFORE_008 = 7

/**
 * Hex only, so the name is safe to splice into `CREATE DATABASE`, which takes an
 * identifier and cannot be parameterised. Random, so two runs of this file (a
 * watch-mode rerun, two CI jobs sharing a server) never fight over a name.
 */
const DB_NAME = `ev_mig008_${randomBytes(6).toString('hex')}`

const AT = {
  t1: '2026-09-20T10:00:01.000Z',
  t2: '2026-09-20T10:00:02.000Z',
  t3: '2026-09-20T10:00:03.000Z',
  t4: '2026-09-20T10:00:04.000Z',
}

describe.skipIf(!hasDb)('008_canonical_gear.sql', () => {
  let admin: pg.Client | undefined
  let client: pg.Client | undefined

  /**
   * node-pg-migrate's runner, with the options `src/migrate.ts` passes, but on
   * this file's own client and for a bounded number of steps. The runner leaves
   * a `dbClient` open, which is what lets one connection walk up and down.
   */
  async function run(direction: 'up' | 'down', count: number): Promise<void> {
    await migrate({
      dbClient: client!,
      dir: migrationsDir,
      direction,
      count,
      migrationsTable: 'pgmigrations',
      log: () => {},
    })
  }

  /** `gear` by sample time, so an assertion reads as "t1 was this". */
  async function gears(): Promise<Record<string, string | null>> {
    const { rows } = await client!.query<{ ts: Date, gear: string | null }>(
      'SELECT ts, gear FROM sample ORDER BY ts')
    return Object.fromEntries(rows.map((r) => [r.ts.toISOString(), r.gear]))
  }

  beforeAll(async () => {
    // The default config reads PGHOST and friends, so this lands on the same
    // server the rest of the suite uses; only the database name differs.
    admin = new pg.Client()
    await admin.connect()
    await admin.query(`CREATE DATABASE ${DB_NAME}`)

    client = new pg.Client({ database: DB_NAME })
    await client.connect()

    await run('up', BEFORE_008)

    // `002_partitions.sql` makes this month's and next month's partitions as of
    // the day it runs, so a sample at a fixed past instant has nowhere to go
    // until its month exists.
    await client.query("SELECT ensure_month_partitions('2026-09-20')")
    await client.query(
      `INSERT INTO vehicle (id, vendor, vendor_vehicle_id, display_name) VALUES
         ('v-t', 'tesla',  'VIN-T', 'T'),
         ('v-r', 'rivian', 'VIN-R', 'R')`)
    // What each vendor's last image wrote: Tesla's own words (the unnameable
    // ShiftStateSNA among them), and a Rivian's already-bare letter.
    await client.query(
      `INSERT INTO sample (vehicle_id, ts, gear) VALUES
         ('v-t', $1, 'ShiftStateD'),
         ('v-t', $2, 'ShiftStateSNA'),
         ('v-t', $3, 'ShiftStateP'),
         ('v-r', $4, 'D')`,
      [AT.t1, AT.t2, AT.t3, AT.t4])
  }, 60_000)

  afterAll(async () => {
    // Close first: a database cannot be dropped from under an open connection,
    // and FORCE is a backstop for one a failed beforeAll left behind.
    await client?.end().catch(() => {})
    await admin?.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {})
    await admin?.end().catch(() => {})
  })

  // One test rather than two: the second half runs on the schema the first
  // leaves behind, and a `-t` filter that ran only the second would take 007
  // down instead of 008 and fail for a reason that has nothing to do with gear.
  it('rewrites Tesla history to letters going up, and puts Tesla\'s words back going down', async () => {
    expect(await gears(), 'seed, at 007').toEqual({
      [AT.t1]: 'ShiftStateD', [AT.t2]: 'ShiftStateSNA', [AT.t3]: 'ShiftStateP', [AT.t4]: 'D',
    })

    await run('up', 1)
    // ShiftStateSNA is NULL, not left as it was: it is exactly what the decoder
    // now writes for a position it cannot name, so a reprocess of the tape and
    // this backfill agree. A Rivian's D was never a ShiftState string and the
    // `LIKE` does not touch it.
    expect(await gears(), 'after 008 up').toEqual({
      [AT.t1]: 'D', [AT.t2]: null, [AT.t3]: 'P', [AT.t4]: 'D',
    })

    await run('down', 1)
    // Lossy for SNA, which stays NULL. The Rivian row keeps its 'D': prefixing
    // every letter would have invented a 'ShiftStateD' no Rivian ever sent.
    expect(await gears(), 'after 008 down').toEqual({
      [AT.t1]: 'ShiftStateD', [AT.t2]: null, [AT.t3]: 'ShiftStateP', [AT.t4]: 'D',
    })
  })
})
