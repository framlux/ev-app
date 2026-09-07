import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SAMPLE_COLUMNS, type SqlType } from '@ev/core'
import { closePool, getPool } from '../src/pool.js'
import { runMigrationsUnderGate } from '../src/migrate.js'

/**
 * What `information_schema` calls each of our declared SQL types. Spelled out
 * rather than lower-cased, because Postgres renames three of them on the way in
 * and a test that compared `sql.toLowerCase()` would pass while believing
 * `TIMESTAMPTZ` and `TIMESTAMP` are different columns.
 */
const INFORMATION_SCHEMA_TYPE: Record<SqlType, string> = {
  'REAL': 'real',
  'DOUBLE PRECISION': 'double precision',
  'INT': 'integer',
  'BOOLEAN': 'boolean',
  'TEXT': 'text',
  'TIME': 'time without time zone',
  'TIMESTAMPTZ': 'timestamp with time zone',
  'JSONB': 'jsonb',
}

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

/**
 * The instant every `energy_rate` fixture below is written at. That table has
 * no vehicle column, so unlike everything else here its rows cannot be scoped
 * to a test vehicle — they are scoped to one implausible instant instead, so
 * afterAll can delete exactly what this file wrote and nothing else.
 */
const RATE_AT = new Date('2019-05-05T05:05:05.000Z')

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
    await p.query('DELETE FROM energy_rate WHERE effective_from=$1', [RATE_AT])
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

  /**
   * The drift test spec §5 exists for, asserted against the schema that is
   * actually applied rather than against the text of one migration. A signal
   * added to the catalogue but to no migration is invisible at runtime — the
   * insert would fail, the transaction would roll back and the message would be
   * redelivered forever — and this is what makes it a test failure instead.
   *
   * It compares the whole applied `sample` table, so it keeps holding when
   * `005` and later add columns of their own; a check against `004`'s text
   * alone would have to be rewritten every time.
   */
  it('gives sample exactly the catalogued columns plus the primary key', async () => {
    const { rows } = await getPool().query<{ column_name: string, data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'sample' ORDER BY ordinal_position`)

    // vehicle_id and ts are structural, not catalogued: they are the key.
    expect(rows.map((r) => r.column_name))
      .toEqual(['vehicle_id', 'ts', ...SAMPLE_COLUMNS.map((c) => c.column)])

    const actual = new Map(rows.map((r) => [r.column_name, r.data_type]))
    for (const c of SAMPLE_COLUMNS) {
      expect(`${c.column}: ${actual.get(c.column)}`)
        .toBe(`${c.column}: ${INFORMATION_SCHEMA_TYPE[c.sql]}`)
    }
  })

  it('creates the current month partitions', async () => {
    const { rows } = await getPool().query(
      `SELECT to_regclass('sample_' || to_char(CURRENT_DATE,'YYYY_MM')) AS t`)
    expect(rows[0]?.t).not.toBeNull()
  })

  /**
   * Spec §3.7's cached status. Asserted here rather than against `006`'s text
   * for the reason at the top of migration-004.test.ts: a migration is applied
   * history, and what matters is the schema that came out of it.
   *
   * Two things are load-bearing and neither fails loudly if it is missing. The
   * FK is what stops a status row outliving the vehicle it describes — the
   * page reads this table with no Tesla session at all, so an orphan would
   * render as telemetry facts about a car nobody owns rather than as an error.
   * And every column but the key is nullable BECAUSE either half of the flow
   * can create the row first: a push on day one knows `pushed_at` and nothing
   * about what the car has applied, and a `synced` defaulted to false there
   * would report "the car says no" when the truth is "nobody has asked yet".
   */
  it('creates telemetry_status, one nullable row per vehicle', async () => {
    const p = getPool()
    const { rows } = await p.query<{
      column_name: string, data_type: string, is_nullable: string,
    }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'telemetry_status' ORDER BY ordinal_position`)

    expect(rows.map((r) => `${r.column_name}: ${r.data_type}`)).toEqual([
      'vehicle_id: text',
      'synced: boolean',
      'field_count: integer',
      'ca_present: boolean',
      'firmware: text',
      'key_paired: boolean',
      'streaming_enabled: boolean',
      'checked_at: timestamp with time zone',
      'pushed_at: timestamp with time zone',
    ])
    expect(rows.filter((r) => r.is_nullable === 'NO').map((r) => r.column_name))
      .toEqual(['vehicle_id'])

    await expect(
      p.query(`INSERT INTO telemetry_status (vehicle_id) VALUES ('no-such-vehicle')`),
    ).rejects.toThrow(/foreign key/)
  })

  /**
   * Spec §3.1's tariff history. Asserted against the applied schema rather than
   * against 007's text, for the reason at the top of migration-004.test.ts: a
   * migration is history, and what matters is what came out of it.
   *
   * Three things here are load-bearing and none of them fails loudly. The
   * `gen_random_uuid()` default is used nowhere else in this repo, so nothing
   * else would notice if `pgcrypto` turned out to be required after all — the
   * failure would be a NOT NULL violation on the first rate anyone ever saved.
   * The UNIQUE is on the PAIR so a manual override can sit at the same instant
   * as the URDB row it contradicts; on `effective_from` alone the override
   * would be refused, which is the one write it exists to make. And
   * `price_per_kwh` keeps five decimals because a residential rate is around
   * $0.199 — at NUMERIC(10,2) the tariff itself rounds to $0.20 before it is
   * ever multiplied by anything.
   */
  it('creates energy_rate, keyed by an instant and a source', async () => {
    const p = getPool()
    const { rows } = await p.query<{
      column_name: string, data_type: string, is_nullable: string,
    }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'energy_rate' ORDER BY ordinal_position`)

    expect(rows.map((r) => `${r.column_name}: ${r.data_type}`)).toEqual([
      'id: uuid',
      'effective_from: timestamp with time zone',
      'price_per_kwh: numeric',
      'currency: text',
      'source: text',
      'urdb_label: text',
      'fetched_at: timestamp with time zone',
    ])
    // Only the URDB label is optional: a rate with no price, no instant or no
    // provenance is not a rate.
    expect(rows.filter((r) => r.is_nullable === 'YES').map((r) => r.column_name))
      .toEqual(['urdb_label'])

    const inserted = await p.query(
      `INSERT INTO energy_rate (effective_from, price_per_kwh, source)
       VALUES ($1, 0.19912, 'urdb') RETURNING id, currency, price_per_kwh`,
      [RATE_AT])
    // Minted by the database, because neither writer of this table — a daily
    // fetch and a settings form — has an id in hand at the point it inserts.
    expect(inserted.rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(inserted.rows[0]?.currency).toBe('USD')
    expect(Number(inserted.rows[0]?.price_per_kwh)).toBeCloseTo(0.19912, 5)

    // The override, at the same instant. It must be allowed in, or §3.2's
    // tiebreak has nothing to break a tie between.
    await p.query(
      `INSERT INTO energy_rate (effective_from, price_per_kwh, source)
       VALUES ($1, 0.31, 'manual')`, [RATE_AT])

    // And the same source twice is the daily fetch finding what it already
    // knows: refused here so the repository's DO NOTHING has a rule to lean on.
    await expect(
      p.query(`INSERT INTO energy_rate (effective_from, price_per_kwh, source)
               VALUES ($1, 0.22, 'urdb')`, [RATE_AT]),
    ).rejects.toThrow(/energy_rate_effective_from_source_key/)
  })

  /**
   * The three columns §3.4 writes beside the `cost` that 003 created and
   * nothing ever filled in.
   *
   * `SESSION_COLUMNS` in the web tier selects these by name, and a DTO field
   * whose column is missing reads back `undefined` — which renders as the
   * string "undefined" rather than raising. This is the test that catches it,
   * and only this one: the web tier's fake database stub answers happily for
   * columns that do not exist.
   */
  it('gives session the three columns a price needs beside the figure', async () => {
    const { rows } = await getPool().query<{ column_name: string, data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'session'
         AND column_name IN ('cost','cost_currency','cost_rate_per_kwh',
                             'cost_basis','cost_source')
       ORDER BY column_name`)
    expect(rows.map((r) => `${r.column_name}: ${r.data_type}`)).toEqual([
      'cost: numeric',
      'cost_basis: text',
      'cost_currency: text',
      'cost_rate_per_kwh: numeric',
      'cost_source: text',
    ])
  })
})
