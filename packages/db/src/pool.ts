import pg from 'pg'

let pool: pg.Pool | undefined

/**
 * Builds the pool from the discrete PG* variables that CloudNativePG's
 * generated `ev-pg-app` Secret provides. We use the individual fields rather
 * than the `uri` key because the URI form is awkward to override per-consumer.
 */
export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      host: required('PGHOST'),
      port: Number(process.env['PGPORT'] ?? 5432),
      user: required('PGUSER'),
      password: required('PGPASSWORD'),
      database: required('PGDATABASE'),
      max: Number(process.env['PGPOOL_MAX'] ?? 10),
      idleTimeoutMillis: 30_000,
    })

    /**
     * Without this, a database restart kills the process.
     *
     * node-postgres emits 'error' on the POOL when a client sitting idle in it
     * dies — a Postgres restart, a CNPG failover, a network drop. An 'error'
     * event with no listener is an unhandled error in Node, so the whole worker
     * or web server goes down with "Unhandled 'error' event: terminating
     * connection due to unexpected postmaster exit". Observed, not theorised:
     * restarting Postgres under the web app killed it instantly.
     *
     * Kubernetes restarted the pod, which is why this was survivable and
     * therefore invisible. It stopped being survivable when the app grew a
     * live stream: a crash drops every open SSE connection, and clients then
     * reconnect into the restart window rather than riding it out.
     *
     * Nothing to do but log. The pool has already discarded the broken client,
     * and the next checkout opens a fresh connection.
     */
    pool.on('error', (err) => {
      console.error('postgres pool: idle client error', err)
    })
  }
  return pool
}

export async function closePool(): Promise<void> {
  await pool?.end()
  pool = undefined
}

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`missing required environment variable ${name}`)
  return v
}
