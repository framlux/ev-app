import { createRequire } from 'node:module'
import type pg from 'pg'

/**
 * `pg` is loaded by `require` from THIS file rather than imported.
 *
 * A globalSetup file is the entry point of the project's own vite-node server,
 * and a bare import from an entry point resolves from the PROJECT root. That
 * works for `packages/db`, which depends on `pg`, and fails for `apps/web` and
 * `apps/ingest`, which do not ("Failed to load url pg") - and only when they
 * run, because the first project to run happens to be the one that can see it.
 * `createRequire` resolves from this file's own directory, so it finds the same
 * driver whichever project asked.
 */
const { Client } = createRequire(import.meta.url)('pg') as typeof pg

/**
 * vitest globalSetup: give a project a pristine database of the name its
 * config chose. See isolated-database.ts for why projects get one.
 *
 * Runs once per project per run, in the main process, before any worker
 * starts. Vitest hands it the project's resolved config, and the name arrives
 * as `config.env.PGDATABASE`: the same value the workers will see, so the
 * database created here and the database the tests connect to cannot drift
 * apart.
 *
 * DROP then CREATE, every run, rather than "create if missing". A database
 * kept between runs carries whatever the last run left in it, including what a
 * crashed run never got to clean up - and a leftover `web-test-c5` is exactly
 * the sort of stranger these projects are being isolated from. It also means
 * every run migrates from nothing, so a migration that only works on top of the
 * previous schema fails here and not on the first fresh CI database.
 *
 * WITH (FORCE) because a previous run's worker can still hold a connection for
 * a moment after vitest reports; migration-008.test.ts does the same for the
 * same reason. The consequence is that two test runs against one Postgres at
 * the same time would drop each other's databases, which is the same promise
 * the shared database never kept, now said out loud.
 *
 * The admin connection reads the ordinary PG* variables and so lands on the
 * database the developer or CI named. The main process never has the
 * per-project override: vitest applies `env` to workers only.
 *
 * Nothing is dropped afterwards. The database is cheap, and the rows a failed
 * run left behind are what you want to look at.
 */
export default async function setup(
  { config }: { config: { env?: Record<string, string | undefined> } },
): Promise<void> {
  const name = config.env?.['PGDATABASE']
  if (!name || !process.env['PGHOST']) return

  // This drops a database by a name built from the environment, so it checks
  // the name is what isolated-database.ts would have made before it drops
  // anything. Both conditions are ways a
  // misconfigured project could point DROP at the database the developer or CI
  // named - which holds real data on a developer machine - rather than at a
  // disposable one: a config that set `env.PGDATABASE` by hand, and a vitest
  // that applied the override to this process, where `process.env` would then
  // already BE the isolated name and the admin connection below would land on a
  // database it is about to drop.
  if (!name.includes('_test_')) {
    throw new Error(
      `refusing to drop database "${name}": a test database's name must contain "_test_"`)
  }
  if (name === process.env['PGDATABASE']) {
    throw new Error(
      `refusing to drop database "${name}": it is the database PGDATABASE names, not an isolated one`)
  }

  const admin = new Client()
  await admin.connect()
  try {
    // `escapeIdentifier`, not a template literal: CREATE DATABASE takes an
    // identifier and cannot be parameterised, and the name is built from an
    // environment variable.
    const ident = admin.escapeIdentifier(name)
    await admin.query(`DROP DATABASE IF EXISTS ${ident} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${ident}`)
  } finally {
    await admin.end()
  }
}
