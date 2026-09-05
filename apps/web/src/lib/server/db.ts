/**
 * The web app's single door to Postgres.
 *
 * It is a re-export rather than a second pool: @ev/db owns the connection
 * settings, and a pool constructed here would double the connection count the
 * cluster sees while reading the same environment variables from a second
 * place. Routes import `$lib/server/db.js` so that the whole app has one
 * import path to grep for when the data access story changes.
 *
 * Only derived tables are READ through here (vehicle, sample, session,
 * session_point, battery_health_sample). The segmentation engine runs in the
 * ingest worker; the web recomputes nothing.
 */
export { getPool } from '@ev/db'

/**
 * `withTransaction` and the `telemetry_status` repository, for the settings
 * page's two actions.
 *
 * These are the app's first writes, and the transaction is why they arrive
 * together: the repository functions take a `DbClient`, not a `Pool`, because
 * one connection is what makes a sequence of statements a transaction rather
 * than a sequence of autocommits. A push records both what the preflight
 * observed and that a configuration was sent, and those two rows describe one
 * button press.
 *
 * `findVehicleIdByVendorId` is the bridge the actions cannot do without: Tesla
 * answers with a VIN and every row in this schema is keyed by `vehicle.id`.
 */
export {
	findVehicleIdByVendorId,
	readTelemetryStatus,
	recordTelemetryCheck,
	recordTelemetryPush,
	withTransaction
} from '@ev/db'
export type { DbClient, TelemetryCheck, TelemetryStatus } from '@ev/db'
