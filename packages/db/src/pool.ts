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
