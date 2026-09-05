import { randomUUID } from 'node:crypto'
import { makeSample, type SessionKind, type SessionSummary, type VehicleSample } from '@ev/core'
import type { DbClient } from './types.js'

/**
 * Open a session, or adopt the one that is already open.
 *
 * `session_one_open_per_kind` is a PARTIAL unique index (`WHERE is_open`), and
 * Postgres refuses a partial index as a named ON CONFLICT target — hence the
 * bare `ON CONFLICT DO NOTHING`, which still suppresses the violation.
 *
 * The RETURNING/fallback pair is the part that matters: on conflict the insert
 * writes nothing and RETURNING yields no row, so the freshly generated UUID
 * names a session that does not exist. Returning it anyway would make every
 * subsequent `appendPoint` fail on a foreign key. We return the id of the
 * session that is genuinely open instead, which is also exactly the behaviour
 * restart recovery needs.
 */
export async function openSession(
  c: DbClient, vehicleId: string, kind: SessionKind, startedAt: Date,
): Promise<string> {
  const id = randomUUID()
  const { rows } = await c.query(
    `INSERT INTO session (id, vehicle_id, kind, started_at, is_open)
     VALUES ($1,$2,$3,$4,true)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [id, vehicleId, kind, startedAt])
  if (rows[0]?.id) return rows[0].id as string

  const existing = await findOpenSession(c, vehicleId, kind)
  if (existing) return existing.id
  // No conflict row and no insert means something other than the partial index
  // rejected the write; failing loudly beats returning an id that is not there.
  throw new Error(`could not open ${kind} session for ${vehicleId}`)
}

export interface OpenSessionRow {
  id: string
  kind: SessionKind
  startedAt: Date
}

export async function findOpenSession(
  c: DbClient, vehicleId: string, kind: SessionKind,
): Promise<OpenSessionRow | null> {
  const { rows } = await c.query(
    `SELECT id, kind, started_at FROM session
      WHERE vehicle_id=$1 AND kind=$2 AND is_open LIMIT 1`,
    [vehicleId, kind])
  const r = rows[0]
  return r ? { id: r.id, kind: r.kind, startedAt: r.started_at } : null
}

/** Every open session for a vehicle, used to rebuild worker state on restart. */
export async function findOpenSessions(
  c: DbClient, vehicleId: string,
): Promise<OpenSessionRow[]> {
  const { rows } = await c.query(
    `SELECT id, kind, started_at FROM session
      WHERE vehicle_id=$1 AND is_open ORDER BY started_at`,
    [vehicleId])
  return rows.map((r) => ({ id: r.id, kind: r.kind, startedAt: r.started_at }))
}

export async function appendPoint(
  c: DbClient, sessionId: string, s: VehicleSample,
): Promise<void> {
  await c.query(
    `INSERT INTO session_point (session_id, ts, lat, lon, soc_pct, speed_kph, power_kw)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (session_id, ts) DO NOTHING`,
    [sessionId, s.ts, s.lat, s.lon, s.socPct, s.speedKph, s.chargePowerKw])
}

export async function closeSession(
  c: DbClient, sessionId: string, sum: SessionSummary,
): Promise<void> {
  await c.query(
    `UPDATE session SET
       ended_at=$2, start_odometer_km=$3, end_odometer_km=$4,
       start_soc_pct=$5, end_soc_pct=$6, energy_kwh=$7, distance_km=$8,
       efficiency_wh_per_km=$9, avg_speed_kph=$10, max_charge_power_kw=$11,
       start_lat=$12, start_lon=$13, end_lat=$14, end_lon=$15, is_open=false
     WHERE id=$1`,
    [sessionId, sum.endedAt, sum.startOdometerKm, sum.endOdometerKm,
      sum.startSocPct, sum.endSocPct, sum.energyKwh, sum.distanceKm,
      sum.efficiencyWhPerKm, sum.avgSpeedKph, sum.maxChargePowerKw,
      sum.startLat, sum.startLon, sum.endLat, sum.endLon])
}

/**
 * Reload the samples belonging to an open session, so a restarted worker can
 * still summarise it when it finally closes.
 *
 * Read from `sample`, not `session_point`. `session_point` is a display
 * projection: it keeps lat/lon/soc/speed/power and drops odometer and the
 * charge energy counter, which are precisely the two columns
 * `summariseSession` needs for distance and charge energy. Reading it back
 * would silently produce sessions with a null distance after every restart.
 */
export async function loadSessionSamples(
  c: DbClient, vehicleId: string, from: Date,
): Promise<VehicleSample[]> {
  const { rows } = await c.query(
    `SELECT ts, soc_pct, range_km, odometer_km, lat, lon, speed_kph,
            power_state, charge_state, charge_power_kw, charge_energy_added_kwh,
            inside_temp_c, outside_temp_c, locked, doors_open, tpms
       FROM sample WHERE vehicle_id=$1 AND ts >= $2 ORDER BY ts`,
    [vehicleId, from])
  return rows.map((r) => makeSample({
    vehicleId,
    ts: r.ts,
    socPct: r.soc_pct,
    rangeKm: r.range_km,
    odometerKm: r.odometer_km,
    lat: r.lat,
    lon: r.lon,
    speedKph: r.speed_kph,
    powerState: r.power_state,
    chargeState: r.charge_state,
    chargePowerKw: r.charge_power_kw,
    chargeEnergyAddedKwh: r.charge_energy_added_kwh,
    insideTempC: r.inside_temp_c,
    outsideTempC: r.outside_temp_c,
    locked: r.locked,
    doorsOpen: r.doors_open,
    tpms: r.tpms,
  }))
}

/**
 * Drop everything derived from the tape in a window, so a reprocess run rebuilds
 * rather than merges. Sessions are matched on `started_at` because that is what
 * ties them to the raw window being replayed; `session_point` follows via
 * ON DELETE CASCADE.
 */
export async function deleteDerived(
  c: DbClient, vehicleId: string, from: Date, to: Date,
): Promise<void> {
  await c.query(
    `DELETE FROM session WHERE vehicle_id=$1 AND started_at >= $2 AND started_at < $3`,
    [vehicleId, from, to])
  await c.query(
    `DELETE FROM sample WHERE vehicle_id=$1 AND ts >= $2 AND ts < $3`,
    [vehicleId, from, to])
  await c.query(
    `DELETE FROM battery_health_sample
      WHERE vehicle_id=$1 AND observed_on >= $2::date AND observed_on < $3::date`,
    [vehicleId, from, to])
}
