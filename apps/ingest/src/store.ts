import {
  advanceCursor,
  appendPoint,
  closeSession,
  ensurePartitions,
  ensureVehicle,
  insertRaw,
  insertSample,
  openSession,
  upsertBatteryHealth,
  withTransaction,
  type DbClient,
  type DbPool,
} from '@ev/db'
import type { Config } from './config.js'
import type { Store, StoreRunner } from './pipeline.js'

/**
 * Make the configured vehicle exist, once, before the first message.
 *
 * `raw_message`, `sample` and `session` all carry a foreign key to
 * `vehicle(id)`, and nothing else in the system creates that row: the migrator
 * only applies schema, and the web app only reads. So on a fresh install the
 * first message the car sends rolls back on a FK violation, the handler throws,
 * the message is therefore never acked, and MQTT redelivers it forever. The
 * worker looks alive, the car keeps streaming, and not one row is ever written.
 *
 * Startup, not the message path: it is a fact about the deployment, not about
 * any message, and doing it per message would put an extra write in the hot
 * transaction to no purpose.
 *
 * The VIN is the vendor's identifier for the car; falling back to the local id
 * when EV_VEHICLE_VIN is unset keeps the (vendor, vendor_vehicle_id) unique
 * constraint satisfiable rather than blocking startup on a value the worker can
 * run without.
 */
export async function registerVehicle(pool: DbPool, vehicle: Config['vehicle']): Promise<void> {
  await withTransaction(pool, (client) =>
    ensureVehicle(client, {
      // This worker decodes Tesla fleet-telemetry and nothing else; the Rivian
      // adapter gets its own worker rather than a vendor switch here.
      vendor: 'tesla',
      id: vehicle.id,
      vendorVehicleId: vehicle.vin ?? vehicle.id,
      displayName: vehicle.displayName,
    }),
  )
}

/** Bind the repo layer's (client, ...) functions to one connection. */
export function storeOn(client: DbClient, cursorSource: string): Store {
  return {
    ensurePartitions: (when) => ensurePartitions(client, when),
    insertRaw: (m) => insertRaw(client, m),
    insertSample: (s) => insertSample(client, s),
    openSession: (kind, vehicleId, at) => openSession(client, vehicleId, kind, at),
    appendPoint: (sessionId, s) => appendPoint(client, sessionId, s),
    closeSession: (sessionId, summary) => closeSession(client, sessionId, summary),
    recordBatteryHealth: (row) => upsertBatteryHealth(client, row),
    advanceCursor: (at) => advanceCursor(client, cursorSource, at),
  }
}

/**
 * One `run()` is one transaction. Everything a single MQTT message produces —
 * the raw row, its samples, the session rows, the watermark — commits together
 * or not at all, which is what lets the caller ack only after a commit.
 */
export function pgRunner(pool: DbPool, cursorSource: string): StoreRunner {
  return {
    run: (fn) => withTransaction(pool, (client) => fn(storeOn(client, cursorSource))),
  }
}
