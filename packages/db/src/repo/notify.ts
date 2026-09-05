import type { DbClient } from './types.js'

/**
 * The one channel this system notifies on.
 *
 * A single channel rather than one per vehicle: `LISTEN` takes an identifier,
 * not a parameter, so per-vehicle channels would mean issuing DDL-shaped SQL
 * built by concatenation every time a vehicle appears — and the listener would
 * have to know the vehicle set before it could subscribe to it. One channel
 * with the id in the payload has neither problem.
 */
export const VEHICLE_CHANGED_CHANNEL = 'vehicle_changed'

/**
 * What a notification carries: identifiers, never rendered state.
 *
 * The reader queries the state back through the same functions the HTTP routes
 * use, so what the stream sends and what a page reload shows are produced by
 * one piece of code and cannot drift. See spec §3.2.
 *
 * `ts` is an ISO string rather than a Date because this round-trips through
 * JSON in the NOTIFY payload; typing it as Date would be a lie on the way out.
 */
export interface VehicleChange {
  vehicleId: string
  ts: string
  /** 'session' when a drive/charge opened or closed — that is what moves the
   *  activity pill. 'sample' for an ordinary state update. */
  kind: 'sample' | 'session'
}

/**
 * Emit a change notification on the current transaction.
 *
 * `pg_notify(channel, payload)` rather than `NOTIFY channel, 'payload'`:
 * NOTIFY's arguments are literals, so the payload would have to be built by
 * string concatenation into SQL. The function form takes bound parameters.
 *
 * Delivery is tied to COMMIT by Postgres itself, which is the property the
 * whole design rests on: a transaction that rolls back notifies nothing, with
 * no compensating logic anywhere.
 */
export async function notifyVehicleChanged(c: DbClient, change: VehicleChange): Promise<void> {
  await c.query('SELECT pg_notify($1, $2)', [VEHICLE_CHANGED_CHANNEL, JSON.stringify(change)])
}

/**
 * Read a payload back, defensively.
 *
 * Never throws. The payload crosses a process boundary from a worker that may
 * be a different version than the reader — the same reason `readEnvelope` in
 * the ingest pipeline is written this way. An unreadable notification is a
 * dropped update, which the next sample repairs; an exception here would take
 * out the listener that would have delivered it.
 */
export function parseVehicleChange(raw: string): VehicleChange | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const o = parsed as Record<string, unknown>
  const { vehicleId, ts, kind } = o
  if (typeof vehicleId !== 'string' || vehicleId === '') return null
  if (typeof ts !== 'string' || ts === '') return null
  if (kind !== 'sample' && kind !== 'session') return null
  return { vehicleId, ts, kind }
}
