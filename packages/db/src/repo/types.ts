import type pg from 'pg'

/**
 * The handle every repository function takes.
 *
 * Deliberately a `PoolClient` and not a `Pool`: every write in the ingest path
 * belongs to one transaction, and a `Pool` would silently hand each query a
 * different connection — turning what reads like a transaction into a sequence
 * of autocommitted statements. Consumers (`apps/ingest`) never import `pg`
 * themselves; they take this type and stay free of the driver.
 */
export type DbClient = pg.PoolClient

/** Re-exported so consumers can hold a pool without importing `pg` themselves. */
export type DbPool = pg.Pool

/** Run `fn` inside a single transaction, rolling back on any throw. */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (c: DbClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (err) {
    // A failed ROLLBACK must not mask the original error: that is the one that
    // says why the work failed, and it is what the caller logs and retries on.
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}
