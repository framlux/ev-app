/**
 * The read API contract.
 *
 * This file is the single agreement between the API route handlers under
 * `src/routes/api/v1` and every page that renders their output. Both sides are
 * written independently, so a shape that is ambiguous here becomes a mismatch
 * at runtime. Rules that hold for EVERY type below:
 *
 *  - Timestamps are ISO 8601 strings in UTC (`2026-09-04T07:31:00.000Z`),
 *    never epoch numbers and never `Date` — JSON has no date type, and the
 *    server/client boundary would silently turn one into a string anyway.
 *    `observedOn` is the one exception: a calendar date, `YYYY-MM-DD`.
 *  - `null` means "not recorded". It is NEVER coerced to 0, and a consumer
 *    must not treat it as 0: a drive with `energyKwh: null` is a drive whose
 *    energy is unknown, not a drive that used nothing. Render an em dash.
 *  - Units are in the field name where they are not obvious: `Km`, `Kw`,
 *    `Kwh`, `Kph`, `C` (celsius), `Pct` (0-100), `S` (seconds), `WhPerKm`.
 *  - Numbers are already rounded server-side to the precision shown in each
 *    comment, so pages format rather than round.
 *
 * Only type-level imports from '@ev/core' are permitted (rule 4: apps/web must
 * not import the engine). The unions below are the canonical vendor-neutral
 * vocabulary and are re-exported so pages import one module, not two.
 */
import type {
  ChargeState,
  PowerState,
  SessionKind,
  Vendor,
} from '@ev/core'

export type { ChargeState, PowerState, SessionKind, Vendor }

/**
 * Every non-2xx response body. SvelteKit's `error(status, message)` serialises
 * to exactly this, so handlers get it for free — but pages must not assume a
 * body is present at all on a 401, because the auth hook redirects browsers.
 */
export interface ApiError {
  message: string
}

/* ------------------------------------------------------------------ *
 * Vehicles and current state
 * ------------------------------------------------------------------ */

/** Static identity. Changes only when the car is renamed. */
export interface Vehicle {
  id: string
  vendor: Vendor
  /** Tesla VIN or Rivian vehicle id. Shown only on the vehicle detail page. */
  vendorVehicleId: string
  displayName: string
  model: string | null
  modelYear: number | null
  createdAt: string
}

/**
 * The latest `sample` row for a vehicle, camel-cased.
 *
 * This is a snapshot of one row, not a merge of the most recent non-null value
 * per field: merging would let the map show a position from yesterday beside a
 * SoC from now, with nothing in the payload saying so. `ts` therefore dates
 * every field in the object at once.
 */
export interface VehicleState {
  vehicleId: string
  ts: string
  socPct: number | null
  rangeKm: number | null
  odometerKm: number | null
  lat: number | null
  lon: number | null
  speedKph: number | null
  powerState: PowerState | null
  chargeState: ChargeState | null
  chargePowerKw: number | null
  chargeEnergyAddedKwh: number | null
  insideTempC: number | null
  outsideTempC: number | null
  locked: boolean | null
  doorsOpen: boolean | null
  /** Keys are wheel positions 'fl' | 'fr' | 'rl' | 'rr'; values are bar. A
   *  vendor that reports only some wheels yields a partial object, not zeros. */
  tpms: Record<string, number> | null
}

/**
 * What the garage renders per car: the status pill, not just a word.
 *
 * Derived server-side from the open session and the latest sample so that the
 * garage and the vehicle page cannot disagree about what "parked" means.
 *  - 'driving'  — an open session of kind 'drive'
 *  - 'charging' — an open session of kind 'charge', or chargeState 'charging'
 *  - 'asleep'   — powerState 'asleep'
 *  - 'offline'  — powerState 'offline'
 *  - 'parked'   — online, not driving, not charging
 *  - 'unknown'  — no sample has ever been recorded for this vehicle
 */
export type VehicleActivity =
  | 'driving'
  | 'charging'
  | 'parked'
  | 'asleep'
  | 'offline'
  | 'unknown'

/** A vehicle plus enough state to draw a garage card without a second call. */
export interface VehicleWithState {
  vehicle: Vehicle
  /** null when the vehicle exists but no sample has ever landed for it. */
  state: VehicleState | null
  activity: VehicleActivity
  /** The id of the currently open drive/charge session, for deep-linking the
   *  status pill. null whenever `activity` is not 'driving' or 'charging'. */
  openSessionId: string | null
}

export interface VehicleListResponse {
  vehicles: VehicleWithState[]
}

/* ------------------------------------------------------------------ *
 * Sessions: drives, charges, idles
 * ------------------------------------------------------------------ */

/**
 * One `session` row. Used for both the drives list and the charges list; the
 * fields a given kind never populates are simply null (a drive has no
 * `maxChargePowerKw`, a charge has no `avgSpeedKph`).
 *
 * `durationS` is computed by the API rather than by each page, so an open
 * session (`endedAt: null`) has a defined answer everywhere: null. A page that
 * wants a live-ticking duration for an open session computes it from
 * `startedAt` itself and knows it is doing so.
 */
export interface SessionListItem {
  id: string
  vehicleId: string
  kind: SessionKind
  startedAt: string
  endedAt: string | null
  /** Whole seconds; null while the session is open. */
  durationS: number | null
  isOpen: boolean
  startOdometerKm: number | null
  endOdometerKm: number | null
  startSocPct: number | null
  endSocPct: number | null
  /** Drive: energy consumed. Charge: energy added. Both positive. 2 dp. */
  energyKwh: number | null
  /** 2 dp. */
  distanceKm: number | null
  /** Drives only. 0 dp. */
  efficiencyWhPerKm: number | null
  /** Drives only. 1 dp. */
  avgSpeedKph: number | null
  /** Charges only. 1 dp. */
  maxChargePowerKw: number | null
  startLat: number | null
  startLon: number | null
  endLat: number | null
  endLon: number | null
  /**
   * Charge cost in the currency named by `costCurrency`, when known. Nothing
   * writes this yet (tariffs are deferred), so it is null in practice — but it
   * is in the contract because the UI must render the column as absent rather
   * than as a zero cost the moment a value does appear.
   */
  cost: number | null
  /** ISO 4217, e.g. 'GBP'. null whenever `cost` is null. */
  costCurrency: string | null
}

/**
 * One `session_point`. The drive path and the charge curve are the same rows
 * read two ways: a drive plots lat/lon and speed against ts, a charge plots
 * powerKw against socPct.
 *
 * lat/lon are independently nullable from the rest: `vehicle_location` is a
 * separate OAuth scope, so a perfectly valid drive can have a complete speed
 * and SoC series with no coordinates at all. Consumers must render that as a
 * drive without a map, never as an error.
 */
export interface SessionPointDto {
  ts: string
  lat: number | null
  lon: number | null
  socPct: number | null
  speedKph: number | null
  /** Drive: instantaneous power, sign not guaranteed. Charge: charging power,
   *  positive. 1 dp. */
  powerKw: number | null
}

export interface SessionDetail {
  session: SessionListItem
  /** Ascending by ts. Empty for an idle, and possibly empty for a session
   *  recorded during an ingest gap — an empty array is not an error. */
  points: SessionPointDto[]
  /**
   * True when `points` was downsampled to stay under the row cap. The series
   * still spans the whole session; it is thinned, not truncated. Detail pages
   * should say so rather than implying the car stopped reporting.
   */
  downsampled: boolean
}

/**
 * Keyset pagination. `nextCursor` is an opaque string — pages must pass it
 * back verbatim and must never parse or construct one. It is null on the last
 * page, which is the only reliable end-of-list signal (a full page can still
 * be the last one).
 */
export interface SessionListResponse {
  sessions: SessionListItem[]
  nextCursor: string | null
}

/* ------------------------------------------------------------------ *
 * Battery health
 * ------------------------------------------------------------------ */

export interface BatteryHealthPoint {
  /** Calendar date, 'YYYY-MM-DD'. One row per day at most. */
  observedOn: string
  /** 2 dp. */
  estimatedCapacityKwh: number
  ratedRangeAt100Km: number | null
  /**
   * 0..1, from the SoC span the estimate was drawn from. A narrow charge is a
   * weaker data point; charts carry this as point opacity so the trend does
   * not present every estimate as equally trustworthy.
   */
  sampleConfidence: number
}

export interface BatteryHealthResponse {
  vehicleId: string
  /** Ascending by observedOn. */
  samples: BatteryHealthPoint[]
  /**
   * The best capacity ever observed with `sampleConfidence >= 0.5`, used as
   * the degradation reference. There is no nameplate capacity in the database,
   * so "new" is defined as the best measurement rather than a manufacturer
   * figure. null when no sample clears the confidence floor.
   */
  baselineCapacityKwh: number | null
  /** The most recent point, or null when there are none. */
  latest: BatteryHealthPoint | null
  /**
   * Percentage lost against `baselineCapacityKwh`, 1 dp, never negative
   * (a new best resets the baseline instead). null unless both a baseline and
   * a latest sample exist — a single measurement is not a trend.
   */
  degradationPct: number | null
}

/* ------------------------------------------------------------------ *
 * Raw sample series (charts on the vehicle page)
 * ------------------------------------------------------------------ */

/**
 * The only field names `?fields=` accepts, as a value so both the route's
 * validator and the pages that build the query string use one list.
 */
export const SAMPLE_FIELDS = [
  'socPct',
  'rangeKm',
  'odometerKm',
  'speedKph',
  'chargePowerKw',
  'insideTempC',
  'outsideTempC',
] as const

export type SampleField = (typeof SAMPLE_FIELDS)[number]

/**
 * `ts` is always present; every requested field is present and possibly null;
 * fields that were not requested are absent. Absent and null mean different
 * things here — "you did not ask" versus "the car did not say".
 */
export type SampleSeriesPoint = { ts: string } & {
  [K in SampleField]?: number | null
}

export interface SampleSeriesResponse {
  vehicleId: string
  from: string
  to: string
  /** Echoes the fields actually served, in request order. */
  fields: SampleField[]
  /** Ascending by ts. */
  samples: SampleSeriesPoint[]
  /** True when the series was downsampled to the row cap. See SessionDetail. */
  downsampled: boolean
}

/* ------------------------------------------------------------------ *
 * Lifetime and period stats
 * ------------------------------------------------------------------ */

/**
 * Aggregates over completed sessions in a window. Open sessions are excluded
 * so a number does not move while a drive is in progress.
 *
 * Every total is null when the window contains no session that could
 * contribute one — an empty month reports null distance, not 0 km, because
 * "no data recorded" and "the car did not move" are different claims and only
 * the second is a fact about the car.
 */
export interface PeriodStats {
  /** Inclusive window bounds actually used, after defaulting. */
  from: string
  to: string
  driveCount: number
  chargeCount: number
  /** 1 dp. */
  distanceKm: number | null
  /** Energy consumed while driving. 2 dp. */
  driveEnergyKwh: number | null
  /** Energy added while charging. 2 dp. */
  chargeEnergyKwh: number | null
  /** driveEnergyKwh / distanceKm, computed from the totals rather than
   *  averaging per-drive efficiencies (which would weight a 2 km trip the same
   *  as a 200 km one). 0 dp. null unless both totals are present and
   *  distanceKm > 0. */
  efficiencyWhPerKm: number | null
  /** Sum of completed drive durations, whole seconds. */
  drivingTimeS: number | null
  /** Sum of completed charge durations, whole seconds. */
  chargingTimeS: number | null
  /** Highest `maxChargePowerKw` seen in the window. 1 dp. */
  maxChargePowerKw: number | null
}

export interface VehicleStatsResponse {
  vehicleId: string
  /** The requested window, defaulting to the last 30 days. */
  period: PeriodStats
  /** Every completed session ever recorded, ignoring `from`/`to`. */
  lifetime: PeriodStats
  /** Latest odometer reading seen in any sample, 1 dp. null if never reported. */
  odometerKm: number | null
  /** ts of the earliest sample for this vehicle — how far back history goes. */
  recordingSince: string | null
}
