import { findVehicle, type DbClient } from '@ev/db'
import type { Vendor } from './deps.js'

/**
 * What the guard needs of the worker's configuration: which vendor it is, and
 * which car it was told to ingest. A `Config` satisfies it, and so does the
 * `ReplayConfig` that `reprocess` hands its replay.
 */
export interface ConfiguredVehicle {
  vendor: Vendor
  vehicle: { id: string; vin: string | null }
}

/**
 * Refuse to run as a vehicle the database already knows as a different one.
 *
 * ONE EV_VEHICLE_ID, ONE CAR. Every table the worker writes is keyed by it, and
 * `ensureVehicle` is DO NOTHING on conflict, so a worker started with the id of
 * a row that belongs to another vendor's car does not fail: it "registers"
 * itself, changes nothing, and files every message it receives under that car.
 * A Rivian worker started with the Tesla's EV_VEHICLE_ID put the R2's tape and
 * samples on the Tesla, silently and for good, because the tape is the record
 * everything else is rebuilt from. `reprocess` under the wrong EV_VENDOR is the
 * same mistake with a delete in it: it clears the car's derived rows, decodes the
 * tape with the wrong vendor's profile, and rebuilds nothing.
 *
 * So the row is read before anything is written or deleted, and a row that
 * exists must agree on the VENDOR and, where both sides have one, on the VIN.
 * No row is fine: a fresh id has nothing for a mismatch to damage, and startup
 * registers it a moment later.
 *
 * TWO VINs ARE NOT COMPARED. None is configured (EV_VEHICLE_VIN is optional for
 * Tesla, and with none there is nothing to be different from). And the row's own
 * id stored as its "VIN": `registerVehicle` files `vin ?? id` so that the
 * (vendor, vendor_vehicle_id) uniqueness stays satisfiable, so a Tesla worker
 * first started without a VIN leaves exactly that, and adding the VIN later is a
 * legitimate change to the same car, not a different one. A Rivian worker cannot
 * be caught out by this, since it must have a VIN and a Tesla row fails on the
 * vendor first. VINs are compared upper-cased, as they are the same identifier
 * either way and a row written before config upper-cased them may hold the case
 * it was typed in.
 *
 * The message names the SETTINGS to look at and carries no other data: not the
 * stored VIN, not the configured one, not the id. It is printed by a crashing
 * pod and read in a log aggregator, and an operator who knows which variable to
 * change needs nothing else from it.
 */
export async function assertVehicleMatchesConfig(
  client: DbClient,
  config: ConfiguredVehicle,
): Promise<void> {
  const row = await findVehicle(client, config.vehicle.id)
  if (row === null) return

  if (row.vendor !== config.vendor) {
    throw new Error(
      `EV_VEHICLE_ID already names a ${row.vendor} vehicle, but this worker's EV_VENDOR is ` +
      `'${config.vendor}'. Data for one car must not be filed under another: give each vehicle ` +
      'its own EV_VEHICLE_ID, or correct EV_VENDOR if that is what is wrong.',
    )
  }

  const configured = config.vehicle.vin
  const stored = row.vendorVehicleId
  if (
    configured !== null && configured !== '' &&
    stored !== '' && stored !== row.id &&
    stored.toUpperCase() !== configured.toUpperCase()
  ) {
    throw new Error(
      'EV_VEHICLE_ID already names a vehicle with a different VIN from this worker\'s ' +
      'EV_VEHICLE_VIN. Data for one car must not be filed under another: give each vehicle its ' +
      'own EV_VEHICLE_ID, or correct EV_VEHICLE_VIN if that is what is wrong.',
    )
  }
}
