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
 *
 * `observed_on` is derived in UTC explicitly. `observedOn` is an instant (the
 * end of the charge), and node-postgres serialises a JS Date using the WRITING
 * PROCESS's local offset, so a bare `$2::date` parses that string as a date by
 * keeping its leading calendar day — the day then follows whatever TZ the
 * container happens to have rather than anything about the charge. Casting to
 * timestamptz first keeps the instant, and `AT TIME ZONE 'UTC'` names the zone
 * the day is counted in instead of inheriting the session's. Without this a
 * charge near midnight is filed on different days by different writers, which
 * splits one day's estimate into two rows and puts a bogus point in the
 * battery-health series at every timezone boundary.
 */
export async function upsertBatteryHealth(
  c: DbClient, r: BatteryHealthRow,
): Promise<void> {
  await c.query(
    `INSERT INTO battery_health_sample (
       vehicle_id, observed_on, estimated_capacity_kwh,
       rated_range_at_100_km, sample_confidence)
     VALUES ($1,($2::timestamptz AT TIME ZONE 'UTC')::date,$3,$4,$5)
     ON CONFLICT (vehicle_id, observed_on) DO UPDATE SET
       estimated_capacity_kwh = EXCLUDED.estimated_capacity_kwh,
       rated_range_at_100_km  = EXCLUDED.rated_range_at_100_km,
       sample_confidence      = EXCLUDED.sample_confidence
     WHERE battery_health_sample.sample_confidence < EXCLUDED.sample_confidence`,
    [r.vehicleId, r.observedOn, r.estimatedCapacityKwh,
      r.ratedRangeAt100Km, r.sampleConfidence],
  )
}
