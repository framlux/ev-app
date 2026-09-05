import type { Vendor } from '@ev/core'
import type { DbClient } from './types.js'

export interface VehicleIdentity {
  id: string
  vendor: Vendor
  vendorVehicleId: string
  displayName: string
}

/**
 * Make the configured vehicle exist before ingestion starts.
 *
 * `raw_message`, `sample` and `session` all carry a FK to `vehicle`, so without
 * this the very first message of a fresh deployment fails on a foreign key
 * violation — and, because the message is never acked, is redelivered forever.
 * DO NOTHING on conflict: the row is owned by whoever created it, and a restart
 * must not overwrite a display name edited elsewhere.
 */
export async function ensureVehicle(c: DbClient, v: VehicleIdentity): Promise<void> {
  await c.query(
    `INSERT INTO vehicle (id, vendor, vendor_vehicle_id, display_name)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (id) DO NOTHING`,
    [v.id, v.vendor, v.vendorVehicleId, v.displayName],
  )
}
