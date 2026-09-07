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

/** Why a charge is priced the way it is — where the energy came from (§3.1). */
export type CostBasis = 'home' | 'tesla' | 'pending' | 'unknown'

/** Where the figure came from. 'backfill-estimate' marks §5's invented ones. */
export type CostSource = 'urdb' | 'manual' | 'tesla-invoice' | 'backfill-estimate'

/**
 * A price for a charge, as `priceSession` writes it.
 *
 * `costBasis` is the only non-nullable field, and that asymmetry is the point.
 * The other four are null together whenever we have no number, but the basis
 * survives: it is what the UI renders INSTEAD of a figure (§3.7), so a charge
 * awaiting a Tesla invoice reads as awaiting one rather than as free. A caller
 * that has nothing to say still has to say which of the four states it is in.
 */
export interface SessionCost {
  cost: number | null
  costCurrency: string | null
  costRatePerKwh: number | null
  costBasis: CostBasis
  costSource: CostSource | null
}

/**
 * Attach a price to a session (spec §3.4).
 *
 * A SIBLING of `closeSession` rather than five more arguments to it, and that
 * is structural rather than stylistic. `closeSession` writes a `SessionSummary`
 * — a pure function of the samples, computed by the metrics engine and true
 * whoever runs it — through a positional UPDATE that already binds fifteen
 * parameters. A price is not a function of the samples: it depends on a tariff
 * table, on where the car was, and on what Tesla eventually billed, and one of
 * its sources does not arrive for weeks. Folding it in would make the summary
 * un-recomputable and put a fifth kind of failure inside the statement that
 * closes every drive.
 *
 * It matches on `kind='charge'` as well as the id, so a bug that hands it a
 * drive changes nothing rather than putting a cost on a session the read API
 * promises has none. Callers run it in the same transaction as `closeSession`,
 * so a session never commits half-classified.
 */
export async function priceSession(
  c: DbClient, sessionId: string, p: SessionCost,
): Promise<void> {
  await c.query(
    `UPDATE session SET
       cost=$2, cost_currency=$3, cost_rate_per_kwh=$4,
       cost_basis=$5, cost_source=$6
     WHERE id=$1 AND kind='charge'`,
    [sessionId, p.cost, p.costCurrency, p.costRatePerKwh, p.costBasis, p.costSource])
}

/**
 * Is there any charge still waiting on a Tesla invoice? (spec §3.5's work guard)
 *
 * This is the query that makes a month with no Supercharging cost nothing. It
 * runs BEFORE any Tesla call is made, and `session_pending_cost_idx` is the
 * partial index it reads — without one, discovering there is no work to do
 * would be a sequential scan of every session ever recorded.
 *
 * EXISTS rather than a count, so Postgres stops at the first row: the answer is
 * "any", and how many there are is a question the caller asks next, with
 * `pendingChargesSince`, only once it knows the answer is yes.
 */
export async function hasPendingCharges(c: DbClient): Promise<boolean> {
  const { rows } = await c.query(
    `SELECT EXISTS (
       SELECT 1 FROM session
        WHERE kind='charge' AND cost IS NULL AND cost_basis='pending'
     ) AS pending`)
  return rows[0]?.pending === true
}

/** One charge awaiting a price, with what §3.5's matching needs to match on. */
export interface PendingCharge {
  id: string
  vehicleId: string
  startedAt: Date
  endedAt: Date | null
  energyKwh: number | null
}

/**
 * The charges awaiting an invoice that ended at or after `from`, oldest first.
 *
 * Oldest first because the caller turns the first row's start into the
 * `startTime` of one Tesla request covering the whole batch — a per-session
 * query would multiply the API calls the §3.5 gate exists to avoid.
 *
 * `from` is a floor and not a filter on how far back to look: it is what stops
 * a run asking Tesla for a window wider than the give-up horizon, where every
 * record returned would be about a session that has already been abandoned.
 */
export async function pendingChargesSince(
  c: DbClient, from: Date,
): Promise<PendingCharge[]> {
  const { rows } = await c.query(
    `SELECT id, vehicle_id, started_at, ended_at, energy_kwh FROM session
      WHERE kind='charge' AND cost IS NULL AND cost_basis='pending'
        AND ended_at >= $1
      ORDER BY started_at`,
    [from])
  return rows.map((r) => ({
    id: r.id,
    vehicleId: r.vehicle_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    energyKwh: r.energy_kwh,
  }))
}

/**
 * Stop waiting on charges that ended before `endedBefore` (spec §3.5).
 *
 * Free Supercharging, a stop billed to somebody else's account, and a record
 * Tesla simply never publishes all look identical from here: a pending session
 * that no invoice will ever match. Without this they would be re-queried at
 * every run forever, growing the request window without bound.
 *
 * They become `unknown`, not priced-at-zero. "We never found out" and "it was
 * free" are different sentences and §3.7 prints both; a zero would put a
 * fabricated £0.00 into the running totals.
 *
 * `ended_at` and not `started_at`, because the invoice is raised against the
 * end of the stop — dating the horizon from the start would give a long
 * overnight charge slightly less patience than a short one for no reason. A
 * still-open session has no `ended_at`, and `NULL <= x` is NULL, so it is never
 * given up on: it has not finished waiting because it has not finished.
 *
 * The comparison is INCLUSIVE despite the parameter's name. The rule is "still
 * pending 45 days after it ended", so a caller passing `now - 45 days` means a
 * session that ended exactly then to flip; a strict `<` would make that instant
 * the last one on which it is still kept, and the horizon would be 45 days plus
 * a tick. Returns how many it gave up on, so the caller can log a number rather
 * than an intention.
 */
export async function giveUpPendingCharges(
  c: DbClient, endedBefore: Date,
): Promise<number> {
  const res = await c.query(
    `UPDATE session SET cost_basis='unknown'
      WHERE kind='charge' AND cost IS NULL AND cost_basis='pending'
        AND ended_at <= $1`,
    [endedBefore])
  return res.rowCount ?? 0
}
