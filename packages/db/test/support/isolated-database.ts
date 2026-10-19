import { fileURLToPath } from 'node:url'

/**
 * A database of its own for one vitest project, so that projects which write
 * to Postgres cannot see each other's rows.
 *
 * WHY THIS EXISTS. `pnpm test` runs `@ev/db`, `@ev/ingest` and `web` as
 * separate vitest projects, and vitest schedules their test files across one
 * shared pool of worker processes - they run AT THE SAME TIME. Every one of
 * them used to point at the single `PGDATABASE`, so a table with no vehicle
 * column, or a query with no vehicle filter, read what a stranger had just
 * written. It was observed twice, as an intermittent failure of the whole
 * gate, with no change to either side:
 *
 *   - "finds the charges awaiting an invoice, oldest first" received a
 *     `web-test-c5` it never created. `pendingChargesSince` is deliberately
 *     global (the §3.5 invoice gate asks about EVERY pending charge, not one
 *     car's), and the web project holds a pending Supercharger stop in the
 *     same table for as long as its file is running.
 *   - the "no rate before every rate" case reads `energy_rate`, which has no
 *     vehicle column at all, so it can only be scoped by time window; see
 *     `RATE_AT` in migrate.test.ts for the in-project half of that story.
 *
 * Scoping each assertion to the rows its own test made would have fixed those
 * two and left the CLASS: every global query in the repository layer, and
 * every future one, is a test that fails on a day nobody changed anything.
 * `rivian_credential` and `rivian_status` are exactly that shape (one row, no
 * key), and their test empties them wholesale. A database per project is the
 * boundary that makes that safe, and it is a line of config rather than a
 * rewrite of assertions that were correct.
 *
 * WHAT IT DOES NOT FIX. Test FILES inside one project still share a database
 * with each other, and still have to keep to their own ids and their own time
 * windows, as repo.test.ts and migrate.test.ts do. Only the project is
 * isolated here.
 *
 * HOW. `isolatedDatabase('web')` returns the two things a project config needs
 * to spread in: `env`, which points every worker of that project at
 * `<PGDATABASE>_test_web`, and `globalSetup`, which (re)creates that database
 * once per run before any worker starts. The tests keep migrating it
 * themselves, under the advisory-lock gate, exactly as they did the shared one.
 *
 * It is a no-op without `PGHOST`, so a developer with no Postgres still gets
 * the suites that skip themselves, and the CI guard that refuses to skip
 * (`PGHOST is unset in CI`) is untouched.
 *
 * Kept free of imports like `pg` on purpose: vitest bundles a project's config
 * file, and a bare import there resolves from the config's own directory, which
 * for `apps/web` has no `pg`. The code that needs the driver is in
 * isolated-database-setup.ts, which vitest loads from where it lives.
 */
export function isolatedDatabase(project: string): {
  env: Record<string, string>
  globalSetup: string[]
} {
  const base = process.env['PGDATABASE']
  if (!process.env['PGHOST'] || !base) return { env: {}, globalSetup: [] }

  return {
    // `_test_` so that the name says what it is: the setup DROPs and recreates
    // it on every run, and nobody should ever mistake it for a database
    // holding something worth keeping.
    env: { PGDATABASE: `${base}_test_${project}` },
    globalSetup: [
      fileURLToPath(new URL('./isolated-database-setup.ts', import.meta.url)),
    ],
  }
}
