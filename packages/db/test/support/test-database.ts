/**
 * Refuse to go on unless the database this process is connected to is one the
 * test isolation made.
 *
 * WHAT IT GUARDS. `rivian_credential` and `rivian_status` hold at most one row
 * and have no key, so the suites that cover them (`rivian-repo.test.ts`, the
 * connector's `store.test.ts`) empty them WHOLESALE: `DELETE FROM
 * rivian_credential`, no WHERE. That is safe only because each vitest project
 * runs in a database of its own (see isolated-database.ts), and it is that
 * property, not anything in those files, that stops the DELETE reaching a
 * sealed Rivian sign-in somebody made in a real database. A project config that
 * lost its `isolatedDatabase(...)` spread, a `PGDATABASE` set on a command line
 * that bypasses it, or a future project added without one would all leave the
 * DELETE aimed at whatever `PGDATABASE` names, and on a developer's machine
 * that is the database holding their own credential.
 *
 * So the suites ask first. The name must contain `_test_`, the marker
 * isolated-database.ts puts in every name it makes and its setup checks before
 * it drops one, so that "a database this suite may empty" and "a database the
 * setup may drop" are the same test.
 *
 * An unset `PGDATABASE` is refused too, and not read as "nothing to check":
 * `pg` then connects to the database named for the user, which is exactly the
 * real one.
 *
 * `env` is a parameter so the guard can be tested without touching the
 * process's own.
 */
export function assertTestDatabase(env: { PGDATABASE?: string | undefined } = process.env): void {
  const name = env.PGDATABASE
  if (name === undefined || name === '') {
    throw new Error(
      'refusing to empty tables: PGDATABASE is unset, so the connection would land on the ' +
      'default database. A suite that deletes wholesale must run in an isolated test database ' +
      '(see packages/db/test/support/isolated-database.ts).')
  }
  if (!name.includes('_test_')) {
    throw new Error(
      `refusing to empty tables in database "${name}": a database a suite may empty must ` +
      'have a name containing "_test_", which is what the per-project isolation gives it ' +
      '(see packages/db/test/support/isolated-database.ts).')
  }
}
