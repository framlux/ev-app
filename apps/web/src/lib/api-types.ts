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
  VehicleSample,
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
 * A contract value for a `VehicleSample` value.
 *
 * The sample model is the vendor-neutral truth; this is what survives
 * `JSON.stringify` on the way to a browser. Only `Date` differs — JSON has no
 * date type, and the server/client boundary would turn one into a string
 * anyway, so the contract says so out loud (rule 1 at the top of this file).
 */
type Wire<T> = T extends Date ? string : T

/**
 * Every catalogued column of `sample`, camel-cased, minus the primary key —
 * which `VehicleState` restates with `ts` as an ISO string.
 *
 * DERIVED, not written out. There are two hundred columns and @ev/core's
 * catalogue is what the migration, the insert and the normaliser are all built
 * from; a hand-maintained copy here would be free to disagree with the row it
 * is describing, and the disagreement would surface as a field that is silently
 * always null. Adding a column to the catalogue adds it here for free.
 */
type SampleFields = {
  [K in Exclude<keyof VehicleSample, 'vehicleId' | 'ts'>]: Wire<VehicleSample[K]>
}

/**
 * The latest `sample` row for a vehicle, camel-cased.
 *
 * This is a snapshot of one row, not a merge of the most recent non-null value
 * per field: merging would let the map show a position from yesterday beside a
 * SoC from now, with nothing in the payload saying so. `ts` therefore dates
 * every field in the object at once.
 *
 * Every field but `vehicleId` and `ts` is nullable and most of them ARE null:
 * the car reports a signal only once it has something to say about it, and a
 * column exists from the day the migration ran rather than from the day the
 * value first arrived. Rendering null as 0 here would invent readings.
 */
export interface VehicleState extends SampleFields {
  vehicleId: string
  ts: string
}

/**
 * What the SSE stream sends instead of the whole row.
 *
 * `VehicleState` is ~204 fields. The stream sends one per notification and one
 * per vehicle in every snapshot, to every open tab — so a parked car with a
 * page open would push a few kilobytes every couple of seconds to render a
 * dozen numbers, and none of that cost would show up in a test. This list is
 * what the pages that render a LIVE entry actually read: the garage card, the
 * vehicle overview's tiles, and the fields `deriveActivity` decides the pill
 * from. The REST endpoints keep returning everything.
 *
 * The rule for adding one: put a field here when a page renders it from the
 * live entry, and NOT because it might be interesting. Anything else stays
 * reachable through /api/v1/vehicles/[id]/samples?fields=… and the state
 * endpoint. `test/live-projection.test.ts` fails if a live page reads a field
 * this list does not carry — the failure mode being a tile that paints once on
 * load and then blanks the moment the car reports.
 */
export const LIVE_STATE_FIELDS = [
  // Identity and age. The client store dedupes on the first and orders on the
  // second, so neither is optional.
  'vehicleId',
  'ts',
  // The 17 the stream carried before this list existed: the garage card, the
  // gauge, the map marker and the pill.
  'socPct',
  'rangeKm',
  'odometerKm',
  'lat',
  'lon',
  'speedKph',
  'powerState',
  'chargeState',
  'chargePowerKw',
  'chargeEnergyAddedKwh',
  'insideTempC',
  'outsideTempC',
  'locked',
  'doorsOpen',
  'tpms',
  // Spec §3.8's overview tiles.
  'gear',
  'chargeLimitSoc',
  'chargePortDoorOpen',
  'chargePortLatch',
  'hvacPower',
  'hvacAcEnabled',
  'cabinOverheatProtectionMode',
  'sentryMode',
  'version',
  'softwareUpdateAvailable',
  'softwareUpdateVersion',
] as const satisfies readonly (keyof VehicleState)[]

export type LiveStateField = (typeof LIVE_STATE_FIELDS)[number]

/** A `VehicleState` narrowed to `LIVE_STATE_FIELDS`. */
export type LiveVehicleState = Pick<VehicleState, LiveStateField>

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

/**
 * A garage entry as the LIVE STREAM sends it: everything but the state, which
 * is projected (`LIVE_STATE_FIELDS`).
 *
 * Note the direction of assignability, which is what makes this workable: a
 * full `VehicleWithState` satisfies this type, so a component typed on it
 * renders both the load-time entry and the streamed one. The reverse does not
 * hold, which is exactly the compile error we want when a page reads a field
 * the stream does not carry.
 */
export interface LiveVehicleWithState {
  vehicle: Vehicle
  state: LiveVehicleState | null
  activity: VehicleActivity
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

/**
 * What the car was plugged into, for a charge session (spec §3.8).
 *
 * Read from the samples inside the session's own window rather than stored on
 * the session row: these are `sample` columns, and the segmenter does not
 * summarise them. Every field is independently nullable — the car reports the
 * cable type long before it reports a voltage on a slow AC charge — and the
 * whole object is null when it said nothing at all, which is the normal case
 * until the telemetry config asking for these fields is accepted.
 */
export interface ChargeSetup {
  /** Supply voltage, the highest seen during the session. 0 dp. */
  chargerVoltage: number | null
  /** 1 or 3 on AC; absent on DC. */
  chargerPhases: number | null
  /** Tesla's own name for the charger, verbatim (e.g. 'Supercharger'). */
  fastChargerType: string | null
  /** Tesla's own name for the cable, verbatim. */
  chargingCableType: string | null
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
  /** Charges only, and null unless the car reported something about the
   *  charger. Always null for a drive or an idle — there was no charger. */
  chargeSetup: ChargeSetup | null
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

/**
 * One day of battery health, carrying up to two independent readings.
 *
 * The estimate is INFERRED from a charge session; the measurement is the car's
 * own `NominalFullPackEnergyKwh`, written once a day (spec §3.7). Most days
 * have the measurement and no estimate — an estimate needs a charge spanning
 * roughly twenty points of state of charge — so both are nullable and a
 * consumer must handle a point that carries only one of them. Which value is
 * present is what says which kind of reading it is; there is no `source` field.
 */
export interface BatteryHealthPoint {
  /** Calendar date, 'YYYY-MM-DD'. One row per day at most. */
  observedOn: string
  /** Inferred from a charge session. 2 dp. null on a day no charge qualified. */
  estimatedCapacityKwh: number | null
  /** The car's own figure for a full pack. 2 dp. null before ingest recorded
   *  one for that day, which is every day before this feature shipped. */
  measuredCapacityKwh: number | null
  ratedRangeAt100Km: number | null
  /**
   * 0..1, from the SoC span the estimate was drawn from. A narrow charge is a
   * weaker data point; charts carry this as point opacity so the trend does
   * not present every estimate as equally trustworthy. null exactly when
   * `estimatedCapacityKwh` is: a measurement has no span to be confident about.
   */
  sampleConfidence: number | null
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
  /** The most recent point that carries an ESTIMATE, or null when there are
   *  none. Not simply the last row: a day can carry only a measurement, and
   *  "the latest estimate" would otherwise blank on most days. */
  latest: BatteryHealthPoint | null
  /**
   * Percentage lost against `baselineCapacityKwh`, 1 dp, never negative
   * (a new best resets the baseline instead). null unless both a baseline and
   * a latest sample exist — a single measurement is not a trend.
   */
  degradationPct: number | null
  /**
   * The same three, for the car's own measurement (spec §3.7/§3.8).
   *
   * Kept as a separate series rather than merged with the estimate: they are
   * different quantities measured different ways, and a chart that mixed them
   * would show a step every time the estimator happened to run. There is still
   * no manufacturer figure in this database, so "new" is again the best
   * reading ever taken and not a nameplate capacity.
   */
  measuredBaselineCapacityKwh: number | null
  /** The most recent point that carries a measurement, or null. */
  latestMeasured: BatteryHealthPoint | null
  /** 1 dp, never negative. null unless both a measured baseline and a latest
   *  measurement exist. */
  measuredDegradationPct: number | null
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
