import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertTestDatabase } from './support/test-database.js'

/**
 * The guard that stands between a wholesale `DELETE` in a test and a database
 * somebody cares about. See support/test-database.ts for what it protects.
 */
describe('assertTestDatabase', () => {
  it('passes for the database an isolated project is given', () => {
    expect(() => assertTestDatabase({ PGDATABASE: 'ev_test_rivian' })).not.toThrow()
    expect(() => assertTestDatabase({ PGDATABASE: 'ev_test_db' })).not.toThrow()
  })

  it.each(['ev', 'postgres', 'ev_test', 'evtest_db', 'test'])(
    'refuses %j, which is not a database the isolation made', (name) => {
      expect(() => assertTestDatabase({ PGDATABASE: name })).toThrow(/_test_/)
    })

  it('refuses a missing PGDATABASE, which would connect to the default one', () => {
    // pg falls back to a database named for the user when PGDATABASE is unset,
    // and that is a real database on a developer's machine.
    expect(() => assertTestDatabase({})).toThrow(/PGDATABASE/)
    expect(() => assertTestDatabase({ PGDATABASE: '' })).toThrow(/PGDATABASE/)
  })

  it('names the database it refused, so the one in the way is easy to find', () => {
    expect(() => assertTestDatabase({ PGDATABASE: 'production' }))
      .toThrow(/"production"/)
  })

  it('reads the process environment by default', () => {
    const was = process.env['PGDATABASE']
    try {
      process.env['PGDATABASE'] = 'not_isolated'
      expect(() => assertTestDatabase()).toThrow(/_test_/)
      process.env['PGDATABASE'] = 'x_test_y'
      expect(() => assertTestDatabase()).not.toThrow()
    } finally {
      if (was === undefined) delete process.env['PGDATABASE']
      else process.env['PGDATABASE'] = was
    }
  })

  /**
   * Read as text: the two suites that empty tables wholesale need a database to
   * run at all, so what can be checked here is the wiring. The call has to be the
   * FIRST statement of `beforeAll`, ahead of the migration and of every hook that
   * deletes: a suite that checked after would have emptied the tables of
   * whatever database it was pointed at before it noticed.
   */
  it.each([
    ['packages/db/test/rivian-repo.test.ts'],
    ['apps/rivian/test/store.test.ts'],
  ])('is the first thing %s does in beforeAll, and guards its afterAll too', (file) => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
    const source = readFileSync(path.join(root, file), 'utf8')
    expect(source).toMatch(/beforeAll\(async \(\) => \{\s*assertTestDatabase\(\)/)
    expect(source).toMatch(/afterAll\(async \(\) => \{\s*try \{[^]*?assertTestDatabase\(\)/)
  })
})
