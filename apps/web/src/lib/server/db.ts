/**
 * The web app's single door to Postgres.
 *
 * It is a re-export rather than a second pool: @ev/db owns the connection
 * settings, and a pool constructed here would double the connection count the
 * cluster sees while reading the same environment variables from a second
 * place. Routes import `$lib/server/db.js` so that the whole app has one
 * import path to grep for when the data access story changes.
 *
 * Only derived tables are read through here (vehicle, sample, session,
 * session_point, battery_health_sample). The segmentation engine runs in the
 * ingest worker; the web recomputes nothing.
 */
export { getPool } from '@ev/db'
