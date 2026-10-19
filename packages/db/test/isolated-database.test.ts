import { afterEach, describe, expect, it } from 'vitest'
import { isolatedDatabase } from './support/isolated-database.js'

/**
 * The per-project database, and the proof that this project is using one.
 *
 * The second half is a tripwire and the reason this file exists. The isolation
 * works by vitest applying a project's `env` to its workers, and if that ever
 * stopped happening - a vitest upgrade, a config edit that dropped the spread -
 * every suite would carry on passing against the shared database and the
 * intermittent cross-project failures would come back with nothing to say why.
 * Failing here, by name, is the way to find out.
 */
const hasDb = Boolean(process.env['PGHOST'])

/** Read at import, before any test below edits the environment. */
const PGDATABASE_AT_START = process.env['PGDATABASE']

describe('isolatedDatabase', () => {
  const saved = { PGHOST: process.env['PGHOST'], PGDATABASE: process.env['PGDATABASE'] }
  afterEach(() => {
    for (const k of ['PGHOST', 'PGDATABASE'] as const) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('names the database for the project, marked as disposable', () => {
    process.env['PGHOST'] = 'localhost'
    process.env['PGDATABASE'] = 'ev'

    expect(isolatedDatabase('web').env).toEqual({ PGDATABASE: 'ev_test_web' })
    expect(isolatedDatabase('db').env).toEqual({ PGDATABASE: 'ev_test_db' })
    expect(isolatedDatabase('web').globalSetup).toHaveLength(1)
  })

  it('does nothing without a Postgres, so the suites still skip themselves', () => {
    delete process.env['PGHOST']
    process.env['PGDATABASE'] = 'ev'

    expect(isolatedDatabase('web')).toEqual({ env: {}, globalSetup: [] })
  })

  it.skipIf(!hasDb)('is in effect for this project\'s own workers', () => {
    expect(PGDATABASE_AT_START).toMatch(/_test_db$/)
  })
})
