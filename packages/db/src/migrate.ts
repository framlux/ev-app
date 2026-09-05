import { fileURLToPath } from 'node:url'
import path from 'node:path'
import migrate from 'node-pg-migrate'
import { getPool } from './pool.js'

const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

/**
 * Advisory-lock key guarding migration. Arbitrary but FIXED: every process that
 * might migrate this database has to pick the same number or the gate is not a
 * gate. Chosen once, never derived.
 */
export const MIGRATION_GATE_KEY = 7241865325823965

/**
 * runMigrations, serialised across processes by a Postgres advisory lock.
 *
 * node-pg-migrate takes its own lock and FAILS FAST when it cannot get it,
 * throwing "Another migration is already running" rather than waiting. That is
 * the right default for a migrator Job - two of them racing should not both
 * proceed - but it is wrong wherever concurrent callers are expected and all
 * of them need the schema to exist before they continue.
 *
 * The test suite is exactly that case, and it was failing in the worst way:
 * vitest schedules test files across parallel workers, three separate files
 * call this against one CI database, and the loser threw inside beforeAll. A
 * beforeAll failure reports its tests as SKIPPED, so CI went red while the
 * output said nothing had failed.
 *
 * pg_advisory_lock waits instead of failing, so the loser blocks until the
 * winner has finished and then runs migrations that are already applied - a
 * no-op. The lock is session-level and released explicitly, because the
 * connection returns to a pool and is reused rather than closed.
 */
export async function runMigrationsUnderGate(): Promise<void> {
  const gate = await getPool().connect()
  try {
    await gate.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_GATE_KEY])
    await runMigrations()
  } finally {
    await gate
      .query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_GATE_KEY])
      .catch(() => {})
    gate.release()
  }
}

export async function runMigrations(): Promise<void> {
  const client = await getPool().connect()
  try {
    await migrate({
      dbClient: client,
      dir: migrationsDir,
      direction: 'up',
      migrationsTable: 'pgmigrations',
      log: (m) => console.log(m),
    })
  } finally {
    client.release()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1) })
}
