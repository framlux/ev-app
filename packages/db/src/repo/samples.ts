import type { VehicleSample } from '@ev/core'
import type { DbClient } from './types.js'

/**
 * ON CONFLICT DO NOTHING makes replay idempotent: the primary key is
 * (vehicle_id, ts), so reprocessing the same raw tape cannot duplicate rows.
 *
 * DO NOTHING rather than an upsert on purpose. Two records with the same
 * timestamp are the same observation redelivered, and the first write already
 * holds it; an upsert would let a later, sparser redelivery of the same instant
 * overwrite populated columns with nulls.
 */
export async function insertSample(c: DbClient, s: VehicleSample): Promise<void> {
  await c.query(
    `INSERT INTO sample (
       vehicle_id, ts, soc_pct, range_km, odometer_km, lat, lon, speed_kph,
       power_state, charge_state, charge_power_kw, charge_energy_added_kwh,
       inside_temp_c, outside_temp_c, locked, doors_open, tpms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (vehicle_id, ts) DO NOTHING`,
    [s.vehicleId, s.ts, s.socPct, s.rangeKm, s.odometerKm, s.lat, s.lon,
      s.speedKph, s.powerState, s.chargeState, s.chargePowerKw,
      s.chargeEnergyAddedKwh, s.insideTempC, s.outsideTempC, s.locked,
      s.doorsOpen, s.tpms ? JSON.stringify(s.tpms) : null],
  )
}

/**
 * `sample` and `raw_message` are range-partitioned by month, and an INSERT for
 * a month with no partition fails outright ("no partition of relation ... found
 * for row"). The migration pre-creates this month and the next; a worker that
 * outlives that window, or a reprocess run over older data, must create its own.
 */
export async function ensurePartitions(c: DbClient, when: Date): Promise<void> {
  await c.query('SELECT ensure_month_partitions($1::date)', [when])
}
