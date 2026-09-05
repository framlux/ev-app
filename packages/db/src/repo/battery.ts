import type { DbClient } from './types.js'

export interface BatteryHealthRow {
  vehicleId: string
  observedOn: Date
  estimatedCapacityKwh: number
  ratedRangeAt100Km: number | null
  sampleConfidence: number
}

export interface MeasuredCapacityRow {
  vehicleId: string
  observedOn: Date
  /** `NominalFullPackEnergyKwh`: the pack's full energy as the car computes it. */
  measuredCapacityKwh: number
  ratedRangeAt100Km: number | null
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
 * `sample_confidence IS NULL` is the case that arrives with the measurement
 * (see `recordMeasuredCapacity`): a day whose row exists because the car
 * reported its pack energy has no confidence yet, and `NULL < 0.4` is NULL
 * rather than true, so without that arm the first estimate of every such day
 * would be a silent no-op. Since a measurement is written daily and an estimate
 * only after a wide charge, that is nearly every estimate we will ever make.
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
       rated_range_at_100_km  = COALESCE(EXCLUDED.rated_range_at_100_km,
                                         battery_health_sample.rated_range_at_100_km),
       sample_confidence      = EXCLUDED.sample_confidence
     WHERE battery_health_sample.sample_confidence IS NULL
        OR battery_health_sample.sample_confidence < EXCLUDED.sample_confidence`,
    [r.vehicleId, r.observedOn, r.estimatedCapacityKwh,
      r.ratedRangeAt100Km, r.sampleConfidence],
  )
}

/**
 * The car's own measurement of its pack, once per day, beside the estimate.
 *
 * A SEPARATE FUNCTION rather than a fifth argument to `upsertBatteryHealth`,
 * and that is the whole point rather than a style choice. That function guards
 * its update with `WHERE … sample_confidence < EXCLUDED.sample_confidence`, and
 * a `DO UPDATE … WHERE` that loses its comparison writes nothing AND RAISES
 * NOTHING. A measurement has no confidence on the estimator's scale — there is
 * no SoC span behind it to be wide or narrow — so any value invented for it
 * would silently discard the measurement on every day the estimator had already
 * written a better-scoring row. No guard here: the car's number is the car's
 * number, and re-writing it with the same value is what makes a redelivery or a
 * `reprocess` idempotent.
 *
 * It writes only the two columns it has an opinion about. `estimated_capacity_kwh`
 * and `sample_confidence` are left untouched — nulls on a day with no qualifying
 * charge (which is most days), and the estimator's own values on a day with one.
 *
 * `rated_range_at_100_km` is COALESCEd rather than assigned so a later write with
 * nothing to say cannot erase what an earlier one measured — the same reason the
 * estimator's upsert now coalesces it too, since it always passes null.
 *
 * The `observed_on` cast is the one in `upsertBatteryHealth`, for the same
 * reason: the day is counted in UTC rather than in whatever zone the writing
 * container happens to have.
 */
export async function recordMeasuredCapacity(
  c: DbClient, r: MeasuredCapacityRow,
): Promise<void> {
  await c.query(
    `INSERT INTO battery_health_sample (
       vehicle_id, observed_on, measured_capacity_kwh, rated_range_at_100_km)
     VALUES ($1,($2::timestamptz AT TIME ZONE 'UTC')::date,$3,$4)
     ON CONFLICT (vehicle_id, observed_on) DO UPDATE SET
       measured_capacity_kwh = EXCLUDED.measured_capacity_kwh,
       rated_range_at_100_km = COALESCE(EXCLUDED.rated_range_at_100_km,
                                        battery_health_sample.rated_range_at_100_km)`,
    [r.vehicleId, r.observedOn, r.measuredCapacityKwh, r.ratedRangeAt100Km],
  )
}
