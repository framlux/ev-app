import type { DbClient } from './types.js'

export interface BatteryHealthRow {
  vehicleId: string
  observedOn: Date
  estimatedCapacityKwh: number
  ratedRangeAt100Km: number | null
  sampleConfidence: number
}

/**
 * One estimate per vehicle per day, keeping the most confident one.
 *
 * Upsert rather than DO NOTHING because two charges on the same day are two
 * genuinely different measurements, and the wider one is the better estimate —
 * `estimateCapacity` scales confidence with the SoC span for exactly this
 * comparison. The WHERE clause makes the write idempotent all the same:
 * replaying the same charge cannot change a row it already produced.
 */
export async function upsertBatteryHealth(
  c: DbClient, r: BatteryHealthRow,
): Promise<void> {
  await c.query(
    `INSERT INTO battery_health_sample (
       vehicle_id, observed_on, estimated_capacity_kwh,
       rated_range_at_100_km, sample_confidence)
     VALUES ($1,$2::date,$3,$4,$5)
     ON CONFLICT (vehicle_id, observed_on) DO UPDATE SET
       estimated_capacity_kwh = EXCLUDED.estimated_capacity_kwh,
       rated_range_at_100_km  = EXCLUDED.rated_range_at_100_km,
       sample_confidence      = EXCLUDED.sample_confidence
     WHERE battery_health_sample.sample_confidence < EXCLUDED.sample_confidence`,
    [r.vehicleId, r.observedOn, r.estimatedCapacityKwh,
      r.ratedRangeAt100Km, r.sampleConfidence],
  )
}
