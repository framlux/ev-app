import {
  advanceCursor,
  appendPoint,
  closeSession,
  ensurePartitions,
  ensureVehicle,
  insertRaw,
  insertSample,
  notifyVehicleChanged,
  openSession,
  upsertBatteryHealth,
  withTransaction,
  type DbClient,
  type DbPool,
  type VehicleChange,
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
 * Does this unit of work contain anything a viewer could see?
 *
 * Keyed off the RESULT rather than the transaction, and that distinction is the
 * whole design. fleet-telemetry publishes one field per message, and the
 * accumulator debounces a burst of them into a single sample, so transactions
 * are about ten times more frequent than samples and most of them do nothing
 * but add a value to the accumulator. Notifying per transaction would wake the
 * web tier — and cost it a query — for an answer that has not changed.
 *
 * Typed as `unknown` because StoreRunner.run is generic: `reprocess` and the
 * tests hand it callbacks returning other things. A shape that is not a
 * PipelineResult simply does not notify.
 */
export function vehicleChangeFrom(result: unknown, vehicleId: string): VehicleChange | null {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null
  const r = result as Record<string, unknown>
  const num = (k: string): number => (typeof r[k] === 'number' ? (r[k] as number) : 0)
  const opened = num('sessionsOpened')
  const closed = num('sessionsClosed')
  if (num('samples') === 0 && opened === 0 && closed === 0) return null
  // Stamped with the observation's time, not the wall clock, so a replayed or
  // late message describes when the car was in this state rather than when we
  // heard about it. Nothing observable landed without one, so its absence means
  // there is nothing to announce.
  const ts = r['lastSampleTs']
  if (!(ts instanceof Date)) return null
  return {
    vehicleId,
    ts: ts.toISOString(),
    kind: opened > 0 || closed > 0 ? 'session' : 'sample',
  }
}

/**
 * One `run()` is one transaction. Everything a single MQTT message produces —
 * the raw row, its samples, the session rows, the watermark — commits together
 * or not at all, which is what lets the caller ack only after a commit.
 *
 * The change notification is issued HERE, inside that transaction, rather than
 * from a Store method, for two reasons that both matter:
 *
 *  - `reprocess.ts` builds its own runner over the same `storeOn`, and replays
 *    an entire window inside ONE transaction. A Store-level notify would queue
 *    one pg_notify per replayed sample — potentially hundreds of thousands,
 *    delivered in a single burst at COMMIT — and set the web tier querying for
 *    as long as it took to drain, for nothing anyone asked to see. Placing it
 *    here means a replay notifies nothing, with no flag to remember to set.
 *  - Only the runner sees the PipelineResult, which is what makes "notify once
 *    per sample" possible rather than once per field message.
 *
 * Inside the transaction, so a rollback un-notifies exactly as it un-writes.
 */
export function pgRunner(pool: DbPool, cursorSource: string, vehicleId: string): StoreRunner {
  return {
    run: (fn) =>
      withTransaction(pool, async (client) => {
        const out = await fn(storeOn(client, cursorSource))
        const change = vehicleChangeFrom(out, vehicleId)
        if (change) await notifyVehicleChanged(client, change)
        return out
      }),
  }
}
