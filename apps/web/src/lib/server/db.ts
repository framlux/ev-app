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

/**
 * The Rivian credential and status repository, for `/settings/rivian` (§4.3).
 *
 * Re-exported UNCONDITIONALLY, like everything above, so that the routes, the
 * page load and `rivian-auth.ts` all reach it through this one module and a
 * test can `vi.mock` it and be sure it never touches a real row.
 *
 * What is deliberately NOT here: `writeRivianStatus` and
 * `readRivianCredentialStamp`. The connector is the only writer of the status
 * row (§5.7) and the only reader of the credential stamp (§5.2), so the web has
 * no reason to be able to do either, and a name that cannot be imported cannot
 * be called by mistake.
 *
 * `readRivianCredential` returns the sealed value along with the account. The
 * page load calls it for the account and the stamp and passes on nothing else;
 * the sealed string is useless without the connector's private key, which this
 * pod never holds.
 */
export {
	deleteRivianCredential,
	readRivianCredential,
	readRivianStatus,
	upsertRivianCredential
} from '@ev/db'
export type { RivianCredentialRow, RivianStatusRow } from '@ev/db'
