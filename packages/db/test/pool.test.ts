import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closePool, getPool } from '../src/pool.js'

/**
 * The pool must survive the database going away.
 *
 * A Postgres restart makes every idle pooled client error, and node-postgres
 * re-emits that on the pool itself. An 'error' event with no listener is fatal
 * in Node, so the absence of this handler is not a missing log line — it is the
 * whole process dying whenever the database bounces.
 */
describe('getPool', () => {
  const saved = { ...process.env }

  beforeEach(() => {
    Object.assign(process.env, {
      PGHOST: 'localhost', PGPORT: '5432', PGUSER: 'u',
      PGPASSWORD: 'p', PGDATABASE: 'd',
    })
  })

  afterEach(async () => {
    await closePool()
    process.env = { ...saved }
  })

  it('handles idle-client errors rather than letting Node kill the process', () => {
    // Constructing a Pool opens no connection, so this needs no database.
    expect(getPool().listenerCount('error')).toBeGreaterThan(0)
  })

  it('does not throw when the pool reports a dead idle client', () => {
    const pool = getPool()
    expect(() => pool.emit('error', new Error('terminating connection'), null as never)).not.toThrow()
  })
})
