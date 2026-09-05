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

/**
 * The local `vehicle.id` for the identifier a vendor API reports, or null.
 *
 * The two identifiers are genuinely different things and the split is not
 * cosmetic: `vehicle.id` is what every FK in this schema points at (including
 * `telemetry_status`), while `vendor_vehicle_id` is the VIN Tesla answers with.
 * Anything holding a VIN and wanting to write a derived row has to cross that
 * gap, and `UNIQUE (vendor, vendor_vehicle_id)` from migration 001 is what
 * makes the crossing single-valued.
 *
 * Matched on the PAIR, never on the identifier alone: VIN-shaped strings are
 * not globally unique across vendors, and a lookup that ignored the vendor
 * would silently attribute one vendor's car to another's row the day a second
 * vendor exists — which is the kind of mistake that is invisible until data
 * arrives under the wrong id.
 *
 * NULL rather than a throw. A vendor account can perfectly well hold a car this
 * deployment was never configured to ingest, and the caller (the web app's
 * telemetry page, today) has a far better sentence to say about that than a
 * repository function does.
 */
export async function findVehicleIdByVendorId(
  c: DbClient, vendor: Vendor, vendorVehicleId: string,
): Promise<string | null> {
  const { rows } = await c.query(
    `SELECT id FROM vehicle WHERE vendor=$1 AND vendor_vehicle_id=$2`,
    [vendor, vendorVehicleId])
  return rows[0]?.id ?? null
}
