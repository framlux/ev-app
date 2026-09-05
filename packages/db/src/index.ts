export { getPool, closePool } from './pool.js'
export { runMigrations, runMigrationsUnderGate, MIGRATION_GATE_KEY } from './migrate.js'
export * from './listen.js'

/**
 * Repository modules.
 *
 * These were written but never re-exported, and the gap was invisible locally
 * because a stale `dist/` from an earlier build still satisfied the imports.
 * The first place it surfaced was CI, which builds from clean and failed with
 * seventeen "has no exported member" errors in apps/ingest.
 *
 * Anything importing @ev/db resolves through this barrel, so a module that is
 * not listed here does not exist as far as consumers are concerned, however
 * complete the file is.
 */
export * from './repo/types.js'
export * from './repo/battery.js'
export * from './repo/cursor.js'
export * from './repo/notify.js'
export * from './repo/raw.js'
export * from './repo/samples.js'
export * from './repo/sessions.js'
export * from './repo/telemetry-status.js'
export * from './repo/vehicles.js'
