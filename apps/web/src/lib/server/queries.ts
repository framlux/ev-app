/**
 * Every read the web app performs, in one module.
 *
 * Two consumers share these functions: the `+server.ts` handlers under
 * `routes/api/v1` (which are thin auth-check-plus-json wrappers) and the
 * `+page.server.ts` loads (which call them directly rather than fetching their
 * own HTTP API). That is deliberate — one implementation means the page and
 * the JSON endpoint cannot drift apart, which is exactly what would happen if
 * a load function grew its own SQL.
 *
 * Three rules hold throughout and are the ones most likely to be broken by a
 * later edit:
 *
 *  1. Parameterised queries only. Nothing from a URL is ever concatenated into
 *     SQL. Where a column list varies (the `?fields=` selector) the strings
 *     come from a hard-coded map keyed by a validated union member, never from
 *     the request.
 *  2. Every query is bounded. `sample` is partitioned and will happily return
 *     millions of rows for an unbounded range, so the window is capped at 90
 *     days and the series is decimated in SQL rather than in Node — thinning a
 *     million rows after transferring them is not a bound.
 *  3. A missing value stays null. `SUM` over no rows is null and is returned as
 *     null, not 0: "no data recorded" and "the car did not move" are different
 *     claims and only the second is a fact about the car.
 */
/**
 * A VALUE import from @ev/core, which the rest of apps/web deliberately avoids.
 *
 * `SAMPLE_COLUMNS` is the column catalogue, not the engine: it is the same list
 * the migration, `insertSample` and the normaliser are generated from, and this
 * module is server-only, so nothing about it reaches the browser bundle. The
 * boundary that matters (rule 4, and test/boundaries.test.ts) is about the
 * segmentation logic — recomputing on read what ingest computed on write — and
 * a list of column names is the opposite of that: it is what stops the API and
 * the schema drifting apart.
 */
import { SAMPLE_COLUMNS, type SampleColumn } from '@ev/core'
import type {
  BatteryHealthPoint,
  BatteryHealthResponse,
  ChargeSetup,
  LiveVehicleState,
  LiveVehicleWithState,
  PeriodStats,
  SampleField,
  SampleSeriesPoint,
  SampleSeriesResponse,
  SessionDetail,
  SessionKind,
  SessionListItem,
  SessionListResponse,
  SessionPointDto,
  Vehicle,
  VehicleActivity,
  VehicleListResponse,
  VehicleState,
  VehicleStatsResponse,
  VehicleWithState,
  Vendor,
} from '../api-types.js'
import { LIVE_STATE_FIELDS } from '../api-types.js'
import { getPool } from './db.js'

/* ------------------------------------------------------------------ *
 * Plumbing
 * ------------------------------------------------------------------ */

type Row = Record<string, unknown>

/**
 * The slice of `pg.Pool` these functions use.
 *
 * Narrowing it to one method is what lets the unit tests drive every code path
 * — empty database, all-null columns, decimation — with a stub, and keeps the
 * real-Postgres tests for the things only Postgres can answer (that the SQL is
 * valid and the column names exist).
 */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Row[] }>
}

/**
 * A failure with an HTTP status attached.
 *
 * Thrown here rather than SvelteKit's `error()` so this module stays
 * importable from a plain vitest run with no Kit runtime, and so a page load
 * can decide for itself how to present a 404. `toHttpError` in http.ts is the
 * single place that converts one into a Kit response.
 */
export class ApiProblem extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiProblem'
  }
}

function db(override?: Queryable): Queryable {
  // Evaluated per call, not at import: constructing the pool reads required
  // environment variables and would make importing this module for a pure
  // unit test fail on a machine with no database configured.
  // pg's overloaded generic `query` does not structurally satisfy the narrowed
  // interface, so the cast is asserting the one method we use, not widening
  // anything: every call site below goes through `Queryable`.
  return override ?? (getPool() as unknown as Queryable)
}

/* ------------------------------------------------------------------ *
 * Column readers
 *
 * pg hands back `numeric` and `bigint` as strings (they do not fit a JS
 * number in general) and `real`/`double precision` as numbers. Every reader
 * below maps null and undefined to null and never to 0.
 * ------------------------------------------------------------------ */

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(v)
  // A non-numeric string here means the query selected the wrong column, which
  // is a bug we want visible rather than rendered as an em dash.
  if (!Number.isFinite(n)) throw new Error(`expected a number, got ${String(v)}`)
  return n
}

function count(v: unknown): number {
  return num(v) ?? 0
}

function str(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v)
}

function bool(v: unknown): boolean | null {
  return v === null || v === undefined ? null : Boolean(v)
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const d = v instanceof Date ? v : new Date(String(v))
  if (Number.isNaN(d.getTime())) throw new Error(`expected a timestamp, got ${String(v)}`)
  return d.toISOString()
}

function isoRequired(v: unknown): string {
  const s = iso(v)
  if (s === null) throw new Error('expected a non-null timestamp')
  return s
}

/**
 * Round to `dp` decimal places, preserving null.
 *
 * Rounding happens here rather than in the pages so the number in the JSON and
 * the number on the screen are the same number. It also erases the widening
 * noise `real` picks up on its way to a JS double: 12.2 stored as float4 comes
 * back as 12.199999809265137, which no chart axis should ever have to show.
 */
export function round(v: number | null, dp: number): number | null {
  if (v === null) return null
  const f = 10 ** dp
  return Math.round(v * f) / f
}

/* ------------------------------------------------------------------ *
 * Query-parameter validation
 * ------------------------------------------------------------------ */

const SESSION_KINDS: readonly SessionKind[] = ['drive', 'charge', 'idle']

export const DEFAULT_SESSION_LIMIT = 50
export const MAX_SESSION_LIMIT = 500

/** Session detail: at most this many points leave the server. */
export const SESSION_POINT_CAP = 2000
/** Raw sample series: at most this many points leave the server. */
export const SAMPLE_SERIES_CAP = 5000
/**
 * The widest `?from`/`?to` window the sample endpoint will serve.
 *
 * `sample` is a partitioned, append-only table with a row every few seconds.
 * An unbounded range is a request to stream the entire archive through Node,
 * so the range is refused rather than silently truncated — a truncated chart
 * that says nothing about being truncated is a lie about the car's history.
 */
export const MAX_SAMPLE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/**
 * Parse an ISO date or datetime from a query string.
 *
 * A bare `2026-09-01` is UTC midnight. JS already parses date-only strings as
 * UTC, but stating it explicitly means a future switch to a different parser
 * cannot quietly reinterpret every saved bookmark in the operator's timezone.
 *
 * A blank string is NOT a date and is rejected here. Callers where the
 * parameter is optional must use `optionalDateParam`, which treats blank as
 * absent; this function is for the places where a value is required and an
 * empty one is a client bug worth naming.
 */
export function parseDateParam(name: string, raw: string): Date {
  // Trimmed first: ' 2026-09-01' would otherwise miss the date-only branch and
  // be handed to the generic parser, which is a different (implementation
  // defined) instant for the same day the user typed.
  const value = raw.trim()
  const text = DATE_ONLY.test(value) ? `${value}T00:00:00.000Z` : value
  const d = new Date(text)
  if (Number.isNaN(d.getTime())) {
    throw new ApiProblem(400, `invalid ${name}: expected an ISO date or datetime`)
  }
  return d
}

/**
 * An optional date parameter, where blank means "not filtering".
 *
 * `params.get('from')` returns '' — not null — for a parameter that is present
 * but empty, which is what an unfilled `<input type="date">` submits on every
 * GET form. Testing only for null therefore sent '' to the parser and answered
 * the ORDINARY use of DateRangeFilter (open the drives page, press Apply
 * without picking dates) with a 400 error page instead of the list.
 *
 * Absent, empty and whitespace are one case: no bound. A non-empty value that
 * does not parse is still a 400, because a filter silently ignored is a list
 * claiming to show a week while showing everything.
 */
function optionalDateParam(params: URLSearchParams, name: string): Date | undefined {
  const raw = params.get(name)
  if (raw === null || raw.trim() === '') return undefined
  return parseDateParam(name, raw)
}

export interface SessionQuery {
  kind?: SessionKind
  from?: Date
  to?: Date
  limit: number
  cursor?: string
}

/**
 * Validate the session-list query string.
 *
 * Nothing here is silently ignored. An unknown `kind` almost always means a
 * typo in a hand-built URL, and answering it with every session of every kind
 * looks like success while showing the wrong data.
 */
export function parseSessionQuery(params: URLSearchParams): SessionQuery {
  const q: SessionQuery = { limit: DEFAULT_SESSION_LIMIT }

  const kind = params.get('kind')
  // Blank is absent, for the same reason as the dates: an "all kinds" option in
  // a GET form submits `kind=`, and answering that with a 400 would break the
  // filter for the one selection that asks for no filtering.
  if (kind !== null && kind !== '') {
    if (!SESSION_KINDS.includes(kind as SessionKind)) {
      throw new ApiProblem(400, `invalid kind: expected one of ${SESSION_KINDS.join(', ')}`)
    }
    q.kind = kind as SessionKind
  }

  // Assigned only when present: `exactOptionalPropertyTypes` makes an explicit
  // undefined a different thing from an absent key.
  const from = optionalDateParam(params, 'from')
  if (from) q.from = from
  const to = optionalDateParam(params, 'to')
  if (to) q.to = to
  if (q.from && q.to && q.to.getTime() < q.from.getTime()) {
    throw new ApiProblem(400, 'invalid range: to precedes from')
  }

  const limit = params.get('limit')
  if (limit !== null) {
    const n = Number(limit)
    // Number('') is 0 and Number(' 5 ') is 5, so test the raw string too: an
    // empty `?limit=` is a client bug, not a request for the default.
    // Deliberately unlike the dates above, which treat blank as absent: no form
    // submits `limit`, so a blank one can only come from a hand-built URL or a
    // client that failed to interpolate a number, and both want to hear about
    // it. The dates are submitted blank by DateRangeFilter on every ordinary
    // "Apply" with nothing picked.
    if (limit.trim() === '' || !Number.isInteger(n) || n < 1) {
      throw new ApiProblem(400, 'invalid limit: expected an integer of at least 1')
    }
    // Clamped rather than refused: a client asking for more than we will serve
    // still gets a valid, complete first page and a cursor for the rest.
    q.limit = Math.min(n, MAX_SESSION_LIMIT)
  }

  const cursor = params.get('cursor')
  if (cursor !== null && cursor !== '') q.cursor = cursor

  return q
}

export interface SampleQuery {
  from: Date
  to: Date
  fields: SampleField[]
}

/** Validate the raw-sample-series query string. All three parameters required. */
export function parseSampleQuery(params: URLSearchParams): SampleQuery {
  const from = params.get('from')
  const to = params.get('to')
  // Blank counts as missing, matching `fields` below: `?from=&to=` is a caller
  // that forgot to fill the range in, and 'from and to are required' says that,
  // where 'invalid from' sends them hunting for a formatting mistake.
  if (from === null || from.trim() === '' || to === null || to.trim() === '') {
    throw new ApiProblem(400, 'from and to are required')
  }
  const fromDate = parseDateParam('from', from)
  const toDate = parseDateParam('to', to)
  if (toDate.getTime() < fromDate.getTime()) {
    throw new ApiProblem(400, 'invalid range: to precedes from')
  }
  if (toDate.getTime() - fromDate.getTime() > MAX_SAMPLE_WINDOW_MS) {
    throw new ApiProblem(400, 'range too large')
  }

  const raw = params.get('fields')
  if (raw === null || raw.trim() === '') {
    throw new ApiProblem(400, 'fields is required: expected a comma-separated list')
  }
  const requested = raw.split(',').map((f) => f.trim()).filter((f) => f !== '')
  if (requested.length === 0) {
    throw new ApiProblem(400, 'fields is required: expected a comma-separated list')
  }
  const fields: SampleField[] = []
  for (const f of requested) {
    if (!(SAMPLE_FIELDS as readonly string[]).includes(f)) {
      throw new ApiProblem(400, `unknown field: ${f}`)
    }
    // De-duplicate so `?fields=socPct,socPct` cannot produce a duplicate column
    // in the SELECT list, which Postgres accepts and which would then be
    // echoed back twice in `fields`.
    if (!fields.includes(f as SampleField)) fields.push(f as SampleField)
  }
  return { from: fromDate, to: toDate, fields }
}

export interface RangeQuery {
  from?: Date
  to?: Date
}

/** Validate an optional `from`/`to` pair, used by battery health and stats. */
export function parseRangeQuery(params: URLSearchParams): RangeQuery {
  const q: RangeQuery = {}
  const from = optionalDateParam(params, 'from')
  if (from) q.from = from
  const to = optionalDateParam(params, 'to')
  if (to) q.to = to
  if (q.from && q.to && q.to.getTime() < q.from.getTime()) {
    throw new ApiProblem(400, 'invalid range: to precedes from')
  }
  return q
}

/* ------------------------------------------------------------------ *
 * Keyset cursors
 *
 * Offset pagination is wrong for this list: rows are inserted at the head, so
 * a session that starts while the user is reading page 1 shifts every later
 * page by one and silently duplicates a row. The cursor names the last row
 * seen instead, so pagination is stable regardless of what arrives.
 * ------------------------------------------------------------------ */

export function encodeCursor(startedAtIso: string, id: string): string {
  return Buffer.from(`${startedAtIso}|${id}`, 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string): { startedAt: Date; id: string } {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
  // base64url decoding never throws on junk — it just produces junk — so the
  // shape has to be validated here or a corrupt cursor silently becomes an
  // unfiltered first page, which looks to the user like the list resetting.
  const sep = decoded.indexOf('|')
  if (sep <= 0 || sep === decoded.length - 1) throw new ApiProblem(400, 'invalid cursor')
  const ts = new Date(decoded.slice(0, sep))
  if (Number.isNaN(ts.getTime())) throw new ApiProblem(400, 'invalid cursor')
  return { startedAt: ts, id: decoded.slice(sep + 1) }
}

/* ------------------------------------------------------------------ *
 * Decimation
 * ------------------------------------------------------------------ */

/**
 * How many rows to skip so `total` rows fit in `cap`, and whether any were
 * dropped.
 *
 * Decimation, not truncation: the series still spans the whole session, it is
 * just thinner. The `downsampled` flag exists so the UI can say "thinned for
 * display" rather than implying the car stopped reporting halfway through.
 *
 * Applied in SQL (`rn % step = 0 OR rn = total - 1`), which is why the step is
 * computed as a plain number here — it is the only part worth testing at the
 * boundary, and a comparison flipped from `>` to `>=` shows up immediately.
 */
export function planDecimation(
  total: number,
  cap: number,
): { step: number; downsampled: boolean } {
  if (total <= cap) return { step: 1, downsampled: false }
  return { step: Math.ceil(total / cap), downsampled: true }
}

/* ------------------------------------------------------------------ *
 * Row mappers
 * ------------------------------------------------------------------ */

function mapVehicle(r: Row): Vehicle {
  return {
    id: String(r['vehicle_id']),
    vendor: String(r['vendor']) as Vendor,
    vendorVehicleId: String(r['vendor_vehicle_id']),
    displayName: String(r['display_name']),
    model: str(r['model']),
    modelYear: num(r['model_year']),
    createdAt: isoRequired(r['created_at']),
  }
}

/* ------------------------------------------------------------------ *
 * The sample row
 *
 * `sample` has two hundred columns and @ev/core's catalogue is what the
 * migration, `insertSample` and the normaliser are all generated from. The
 * SELECT list and the mapper below are generated from the same list, so a
 * column that exists is read, and a column that is dropped stops being read,
 * with no edit here. A hand-written mapper would instead give a silent null
 * for every column somebody forgot to add to it — which is indistinguishable
 * from a car that never reported the signal.
 * ------------------------------------------------------------------ */

/**
 * Decimal places per column, defaulting to `DEFAULT_STATE_DP`.
 *
 * The rounding is not cosmetic: a `real` widens to a double with noise
 * attached (see `round`), so 12.2 comes back as 12.199999809265137. The
 * entries below are the ten columns whose precision the API contract states,
 * and they are pinned here so that growing the column set cannot quietly
 * change what /api/v1 has always returned.
 */
const STATE_DP: Record<string, number> = {
  soc_pct: 1,
  range_km: 1,
  odometer_km: 1,
  lat: 6,
  lon: 6,
  speed_kph: 1,
  charge_power_kw: 1,
  charge_energy_added_kwh: 2,
  inside_temp_c: 1,
  outside_temp_c: 1,
}

/**
 * Three, not one, for the columns the contract says nothing about.
 *
 * A brick voltage is ~3.9 V and the whole point of `BrickVoltageMin`/`Max` is
 * the millivolts between them, so one decimal place would round the signal
 * away entirely. Three keeps every column added by this spec meaningful while
 * still erasing float4 noise.
 */
const DEFAULT_STATE_DP = 3

/**
 * One catalogued column, read out of a row into its contract value.
 *
 * Dispatching on the DECLARED SQL type rather than on what the value looks
 * like at runtime is what makes this safe to generate: a `TEXT` column holding
 * a numeric-looking enum name stays a string, and a `REAL` that pg hands back
 * as a string still becomes a number.
 */
function readStateColumn(c: SampleColumn, r: Row): unknown {
  const v = r[c.column]
  switch (c.sql) {
    case 'REAL':
    case 'DOUBLE PRECISION':
      return round(num(v), STATE_DP[c.column] ?? DEFAULT_STATE_DP)
    case 'INT':
      return round(num(v), 0)
    case 'BOOLEAN':
      return bool(v)
    case 'TEXT':
    // A `time` has no date and no zone, so it crosses the wire as the
    // 'HH:MM:SS' pg hands back rather than being invented into an instant.
    case 'TIME':
      return str(v)
    case 'TIMESTAMPTZ':
      return iso(v)
    case 'JSONB':
      // Passed through as whatever JSONB held: a vendor that reports two
      // wheels yields a two-key object, and filling in the missing wheels
      // with zeros would render as two flat tyres.
      return (v as Record<string, number> | null) ?? null
    default: {
      // A new SqlType in the catalogue with no reader here would otherwise
      // become `undefined`, which vanishes through JSON.stringify.
      const unhandled: never = c.sql
      throw new Error(`no state reader for SQL type ${String(unhandled)}`)
    }
  }
}

/** The projected subset, resolved once: `LIVE_STATE_FIELDS` minus the key. */
const LIVE_STATE_COLUMNS: readonly SampleColumn[] = SAMPLE_COLUMNS.filter((c) =>
  (LIVE_STATE_FIELDS as readonly string[]).includes(c.key),
)

/** `st.ts, st.soc_pct, …` — the sample columns a vehicle query reads. */
function stateSelect(prefix: string, columns: readonly SampleColumn[]): string {
  return ['ts', ...columns.map((c) => c.column)].map((c) => `${prefix}${c}`).join(', ')
}

function mapColumns(vehicleId: string, r: Row, columns: readonly SampleColumn[]): Row {
  const out: Row = { vehicleId, ts: isoRequired(r['ts']) }
  for (const c of columns) out[c.key] = readStateColumn(c, r)
  return out
}

/**
 * The latest `sample` row, camel-cased. Every catalogued column, for the REST
 * endpoints, which are not paying for the payload per notification.
 */
function mapState(vehicleId: string, r: Row): VehicleState {
  return mapColumns(vehicleId, r, SAMPLE_COLUMNS) as unknown as VehicleState
}

/**
 * The same row projected to `LIVE_STATE_FIELDS`, for the SSE stream (§3.8).
 *
 * Built by omission rather than by nulling: an unprojected field must be
 * ABSENT, not null, or the frame is the same size it was and the client cannot
 * tell "not streamed" from "not recorded".
 */
function mapLiveState(vehicleId: string, r: Row): LiveVehicleState {
  return mapColumns(vehicleId, r, LIVE_STATE_COLUMNS) as unknown as LiveVehicleState
}

/**
 * Which pill the garage draws, decided once on the server.
 *
 * Both the garage and the vehicle page render this field rather than each
 * deriving it, because two derivations are two chances to disagree about what
 * "parked" means. An open drive wins over everything: a car can plausibly be
 * charging-and-driving in the data (a stale charge_state on a sample taken as
 * the driver pulls away) and "driving" is the true one.
 */
export function deriveActivity(
  // The two fields it actually reads, so it works on a projected state as well
  // as a full one — the pill on a streamed entry has to be the same pill.
  state: Pick<VehicleState, 'chargeState' | 'powerState'> | null,
  openDriveId: string | null,
  openChargeId: string | null,
): { activity: VehicleActivity; openSessionId: string | null } {
  if (openDriveId) return { activity: 'driving', openSessionId: openDriveId }
  if (openChargeId) return { activity: 'charging', openSessionId: openChargeId }
  // No sample has ever landed. Distinct from 'offline', which is a car that
  // reported and said it was unreachable.
  if (state === null) return { activity: 'unknown', openSessionId: null }
  if (state.chargeState === 'charging') return { activity: 'charging', openSessionId: null }
  if (state.powerState === 'asleep') return { activity: 'asleep', openSessionId: null }
  if (state.powerState === 'offline') return { activity: 'offline', openSessionId: null }
  return { activity: 'parked', openSessionId: null }
}

function mapSession(r: Row): SessionListItem {
  const startedAt = isoRequired(r['started_at'])
  const endedAt = iso(r['ended_at'])
  return {
    id: String(r['id']),
    vehicleId: String(r['vehicle_id']),
    kind: String(r['kind']) as SessionKind,
    startedAt,
    endedAt,
    // null while the session is open, so every page has the same answer for
    // "how long did this take" and a page that wants a live ticking duration
    // has to compute it from startedAt and knows that it is doing so.
    durationS:
      endedAt === null
        ? null
        : Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000),
    isOpen: Boolean(r['is_open']),
    startOdometerKm: round(num(r['start_odometer_km']), 1),
    endOdometerKm: round(num(r['end_odometer_km']), 1),
    startSocPct: round(num(r['start_soc_pct']), 1),
    endSocPct: round(num(r['end_soc_pct']), 1),
    energyKwh: round(num(r['energy_kwh']), 2),
    distanceKm: round(num(r['distance_km']), 2),
    efficiencyWhPerKm: round(num(r['efficiency_wh_per_km']), 0),
    avgSpeedKph: round(num(r['avg_speed_kph']), 1),
    maxChargePowerKw: round(num(r['max_charge_power_kw']), 1),
    startLat: round(num(r['start_lat']), 6),
    startLon: round(num(r['start_lon']), 6),
    endLat: round(num(r['end_lat']), 6),
    endLon: round(num(r['end_lon']), 6),
    cost: round(num(r['cost']), 2),
    // Never a currency without an amount: a lone 'GBP' would make the charges
    // page render a cost column full of em dashes that look like missing data
    // rather than an absent feature.
    costCurrency: num(r['cost']) === null ? null : str(r['cost_currency']),
  }
}

function mapPoint(r: Row): SessionPointDto {
  return {
    ts: isoRequired(r['ts']),
    lat: round(num(r['lat']), 6),
    lon: round(num(r['lon']), 6),
    socPct: round(num(r['soc_pct']), 1),
    speedKph: round(num(r['speed_kph']), 1),
    powerKw: round(num(r['power_kw']), 1),
  }
}

/**
 * One `battery_health_sample` row.
 *
 * Both capacities are nullable since migration 005: a day can carry the car's
 * own measurement with no qualifying charge to estimate from, and (for every
 * day before this feature shipped) an estimate with no measurement. Neither is
 * coerced to 0 — a 0 kWh battery would plot as total failure.
 */
export function mapBatteryPoint(r: Row): BatteryHealthPoint {
  return {
    observedOn: String(r['observed_on']),
    estimatedCapacityKwh: round(num(r['estimated_capacity_kwh']), 2),
    measuredCapacityKwh: round(num(r['measured_capacity_kwh']), 2),
    ratedRangeAt100Km: round(num(r['rated_range_at_100_km']), 1),
    sampleConfidence: round(num(r['sample_confidence']), 2),
  }
}

/* ------------------------------------------------------------------ *
 * Vehicles
 * ------------------------------------------------------------------ */

/**
 * The garage query, over whichever slice of the sample row the caller needs.
 *
 * Two callers, two column sets: the REST endpoints read everything, the live
 * stream reads only `LIVE_STATE_COLUMNS`. One template rather than two SQL
 * strings, because the laterals below are the part that is easy to get subtly
 * wrong and impossible to notice — a vehicle that stops being listed because
 * a join was written as an inner one looks exactly like a vehicle that was
 * deleted.
 */
function vehicleWithStateSql(columns: readonly SampleColumn[]): string {
  return `
  SELECT
    v.id                AS vehicle_id,
    v.vendor            AS vendor,
    v.vendor_vehicle_id AS vendor_vehicle_id,
    v.display_name      AS display_name,
    v.model             AS model,
    v.model_year        AS model_year,
    v.created_at        AS created_at,
    ${stateSelect('st.', columns)},
    od.id AS open_drive_id,
    oc.id AS open_charge_id
  FROM vehicle v
  -- One lateral per thing we need, so a vehicle with no samples and no open
  -- session still produces a row: the garage lists a car that has never
  -- reported rather than hiding it, because a missing car looks like a bug.
  LEFT JOIN LATERAL (
    SELECT * FROM sample WHERE vehicle_id = v.id ORDER BY ts DESC LIMIT 1
  ) st ON true
  LEFT JOIN LATERAL (
    SELECT id FROM session
    WHERE vehicle_id = v.id AND is_open AND kind = 'drive' LIMIT 1
  ) od ON true
  LEFT JOIN LATERAL (
    SELECT id FROM session
    WHERE vehicle_id = v.id AND is_open AND kind = 'charge' LIMIT 1
  ) oc ON true
`
}

const VEHICLE_WITH_STATE_SQL = vehicleWithStateSql(SAMPLE_COLUMNS)
const LIVE_VEHICLE_SQL = vehicleWithStateSql(LIVE_STATE_COLUMNS)

/**
 * One garage row into an entry, with the state mapped by whichever mapper the
 * caller's column set matches. The activity is derived HERE for both, so the
 * pill on a streamed card and the pill on a loaded page cannot disagree.
 */
function mapEntry<S extends Pick<VehicleState, 'chargeState' | 'powerState'>>(
  r: Row,
  mapper: (vehicleId: string, r: Row) => S,
): { vehicle: Vehicle; state: S | null; activity: VehicleActivity; openSessionId: string | null } {
  const vehicle = mapVehicle(r)
  // `ts` is NOT NULL in `sample`, so a null here is the LEFT JOIN missing, not
  // a row with an unknown timestamp.
  const state = r['ts'] === null || r['ts'] === undefined ? null : mapper(vehicle.id, r)
  const { activity, openSessionId } = deriveActivity(
    state,
    str(r['open_drive_id']),
    str(r['open_charge_id']),
  )
  return { vehicle, state, activity, openSessionId }
}

function mapVehicleWithState(r: Row): VehicleWithState {
  return mapEntry(r, mapState)
}

function mapLiveVehicle(r: Row): LiveVehicleWithState {
  return mapEntry(r, mapLiveState)
}

/**
 * The whole garage in one query. Unpaginated on purpose: this is a single-user
 * app with one or two cars, and a cursor here would be ceremony over a list
 * that cannot grow.
 */
export async function listVehicles(conn?: Queryable): Promise<VehicleListResponse> {
  const { rows } = await db(conn).query(
    `${VEHICLE_WITH_STATE_SQL} ORDER BY v.display_name ASC, v.id ASC`,
  )
  return { vehicles: rows.map(mapVehicleWithState) }
}

export async function getVehicle(id: string, conn?: Queryable): Promise<VehicleWithState> {
  const { rows } = await db(conn).query(`${VEHICLE_WITH_STATE_SQL} WHERE v.id = $1`, [id])
  const row = rows[0]
  if (!row) throw new ApiProblem(404, 'vehicle not found')
  return mapVehicleWithState(row)
}

/* ------------------------------------------------------------------ *
 * The live stream's pair of the two above (spec §3.8)
 *
 * Same rows, same activity derivation, projected state. These exist because
 * the stream sends a state object per notification AND one per vehicle in
 * every snapshot, to every open tab: at two hundred columns that is a few
 * kilobytes every couple of seconds to tell a parked car's tab that nothing
 * changed. Nothing but `notify-listener.ts` should call them — a page load
 * wants the full row.
 * ------------------------------------------------------------------ */

export async function listVehiclesLive(conn?: Queryable): Promise<LiveVehicleWithState[]> {
  const { rows } = await db(conn).query(
    `${LIVE_VEHICLE_SQL} ORDER BY v.display_name ASC, v.id ASC`,
  )
  return rows.map(mapLiveVehicle)
}

export async function getVehicleLive(
  id: string,
  conn?: Queryable,
): Promise<LiveVehicleWithState> {
  const { rows } = await db(conn).query(`${LIVE_VEHICLE_SQL} WHERE v.id = $1`, [id])
  const row = rows[0]
  if (!row) throw new ApiProblem(404, 'vehicle not found')
  return mapLiveVehicle(row)
}

/**
 * The latest sample and nothing else — the cheap target for a card that polls.
 *
 * Every catalogued column, deliberately: this is the REST contract, and a
 * client asking "what is the car doing" pays for one response rather than one
 * per notification.
 *
 * The two 404s are deliberately different. An unknown id is a bad URL; a known
 * vehicle with no samples is an ingestion problem, and collapsing them would
 * send the operator looking at the wrong thing.
 */
export async function getVehicleState(id: string, conn?: Queryable): Promise<VehicleState> {
  const c = db(conn)
  await assertVehicleExists(id, c)
  const { rows } = await c.query(
    `SELECT ${stateSelect('', SAMPLE_COLUMNS)}
       FROM sample WHERE vehicle_id = $1 ORDER BY ts DESC LIMIT 1`,
    [id],
  )
  const row = rows[0]
  if (!row) throw new ApiProblem(404, 'no samples for vehicle')
  return mapState(id, row)
}

async function assertVehicleExists(id: string, conn: Queryable): Promise<void> {
  const { rows } = await conn.query(`SELECT 1 FROM vehicle WHERE id = $1`, [id])
  if (!rows[0]) throw new ApiProblem(404, 'vehicle not found')
}

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

const SESSION_COLUMNS = `
  id, vehicle_id, kind, started_at, ended_at, is_open,
  start_odometer_km, end_odometer_km, start_soc_pct, end_soc_pct,
  energy_kwh, distance_km, efficiency_wh_per_km, avg_speed_kph,
  max_charge_power_kw, start_lat, start_lon, end_lat, end_lon,
  cost, cost_currency
`

/**
 * A page of sessions, newest first.
 *
 * `from` is inclusive and `to` is exclusive so that consecutive windows
 * (a month at a time, say) tile without double-counting the boundary session.
 *
 * Kept exclusive after review, deliberately, even though it has a visible cost:
 * DateRangeFilter submits a bare `to=2026-09-04` from a date input, that parses
 * to UTC midnight, and so "to = today" shows none of today's drives. The fix is
 * NOT to loosen this comparison — `<=` against a midnight instant would still
 * miss every drive after 00:00:00 on that day, so it would swap a silent
 * exclusion for a subtler one, and it would make consecutive windows overlap on
 * their shared boundary for the JSON API's machine callers. What a date picker
 * means by "to 2026-09-04" is "through the end of that day", and the only place
 * that knows the bound came from a picker rather than from a caller tiling
 * instants is the page load that reads the form. `getBatteryHealth` and
 * `periodStats` both filter `< to` as well, so changing this one alone would
 * also make the same URL mean two different windows on two pages.
 */
export async function listSessions(
  vehicleId: string,
  q: SessionQuery,
  conn?: Queryable,
): Promise<SessionListResponse> {
  const where: string[] = ['vehicle_id = $1']
  const values: unknown[] = [vehicleId]

  if (q.kind) {
    values.push(q.kind)
    where.push(`kind = $${values.length}`)
  }
  if (q.from) {
    values.push(q.from)
    where.push(`started_at >= $${values.length}`)
  }
  if (q.to) {
    values.push(q.to)
    where.push(`started_at < $${values.length}`)
  }
  if (q.cursor) {
    const { startedAt, id } = decodeCursor(q.cursor)
    values.push(startedAt, id)
    // Row-value comparison, matching ORDER BY exactly. Comparing started_at
    // alone would drop rows that share a timestamp; comparing them separately
    // with OR would be a different, slower plan for the same answer.
    where.push(`(started_at, id) < ($${values.length - 1}, $${values.length})`)
  }

  // One extra row is the end-of-list probe: if it comes back there is another
  // page. Deciding from `rows.length === limit` instead would emit a cursor
  // for a page that turns out to be empty.
  values.push(q.limit + 1)
  const { rows } = await db(conn).query(
    `SELECT ${SESSION_COLUMNS} FROM session
      WHERE ${where.join(' AND ')}
      ORDER BY started_at DESC, id DESC
      LIMIT $${values.length}`,
    values,
  )

  const page = rows.slice(0, q.limit).map(mapSession)
  const last = page[page.length - 1]
  const nextCursor =
    rows.length > q.limit && last ? encodeCursor(last.startedAt, last.id) : null
  return { sessions: page, nextCursor }
}

/**
 * One session and its series, decimated to `SESSION_POINT_CAP` rows.
 *
 * Idles have no points and a session recorded across an ingest gap may have
 * none either; an empty array is a valid answer, not a 404.
 */
export async function getSessionDetail(id: string, conn?: Queryable): Promise<SessionDetail> {
  const c = db(conn)
  const { rows } = await c.query(
    `SELECT ${SESSION_COLUMNS} FROM session WHERE id = $1`,
    [id],
  )
  const row = rows[0]
  if (!row) throw new ApiProblem(404, 'session not found')

  const points = await c.query(
    `WITH numbered AS (
       SELECT ts, lat, lon, soc_pct, speed_kph, power_kw,
              row_number() OVER (ORDER BY ts) - 1 AS rn,
              (count(*) OVER ())::int              AS total
         FROM session_point
        WHERE session_id = $1
     )
     SELECT ts, lat, lon, soc_pct, speed_kph, power_kw, total
       FROM numbered
      -- Keep every Nth row plus the last one, so the series still ends where
      -- the session ended. GREATEST guards the total <= cap case, where
      -- ceil(total/cap) is 1 and every row is kept.
      WHERE rn % GREATEST(1, ceil(total::numeric / $2::numeric)::int) = 0 OR rn = total - 1
      ORDER BY ts ASC`,
    [id, SESSION_POINT_CAP],
  )

  const total = points.rows[0] ? count(points.rows[0]['total']) : 0
  const session = mapSession(row)
  return {
    session,
    points: points.rows.map(mapPoint),
    downsampled: planDecimation(total, SESSION_POINT_CAP).downsampled,
    chargeSetup: session.kind === 'charge' ? await readChargeSetup(c, session) : null,
  }
}

/**
 * What the car was plugged into during one charge (spec §3.8).
 *
 * These live on `sample`, not on `session` — the segmenter has no reason to
 * summarise them — so they are read back from the session's own window. That
 * window is what bounds the query: `sample` is partitioned and a scan without
 * one would read the archive.
 *
 * The voltage and the phase count are taken as the MAXIMUM over the session
 * rather than as the last reading. The last sample of a charge is usually the
 * one taken after the car stopped drawing, where the supply reads zero; "this
 * charge ran at 0 V" is a wrong answer that looks like a right one. The two
 * enum names are taken as the last non-null instead, because they are labels
 * rather than measurements and `max` over a string would be alphabetical.
 */
async function readChargeSetup(
  c: Queryable,
  session: SessionListItem,
): Promise<ChargeSetup | null> {
  const { rows } = await c.query(
    `SELECT max(charger_voltage) AS charger_voltage,
            max(charger_phases)  AS charger_phases,
            (array_agg(fast_charger_type ORDER BY ts DESC)
               FILTER (WHERE fast_charger_type IS NOT NULL))[1]   AS fast_charger_type,
            (array_agg(charging_cable_type ORDER BY ts DESC)
               FILTER (WHERE charging_cable_type IS NOT NULL))[1] AS charging_cable_type
       FROM sample
      WHERE vehicle_id = $1 AND ts >= $2 AND ts <= $3`,
    [
      session.vehicleId,
      new Date(session.startedAt),
      // An open charge has no end. A null upper bound compares as unknown and
      // would match no rows at all, so the car currently plugged in would show
      // nothing about the charger it is plugged into.
      session.endedAt === null ? new Date() : new Date(session.endedAt),
    ],
  )
  const r = rows[0]
  if (!r) return null
  const setup: ChargeSetup = {
    chargerVoltage: round(num(r['charger_voltage']), 0),
    chargerPhases: round(num(r['charger_phases']), 0),
    fastChargerType: str(r['fast_charger_type']),
    chargingCableType: str(r['charging_cable_type']),
  }
  // Nothing reported at all is null, not four nulls: a "charging equipment"
  // panel of four em dashes reads as broken rather than as not-yet-reported,
  // and that is the state of every charge until the config push lands.
  return Object.values(setup).some((v) => v !== null) ? setup : null
}

/* ------------------------------------------------------------------ *
 * Battery health
 * ------------------------------------------------------------------ */

/**
 * The degradation reference: the best capacity ever measured from a charge
 * wide enough to trust.
 *
 * There is no nameplate capacity in the database, so "new" has to be defined
 * as the best measurement. The confidence floor is what stops a 3% top-up —
 * whose implied capacity is mostly rounding error — from setting a baseline
 * the real battery can never match and inventing permanent degradation.
 */
export const BASELINE_CONFIDENCE_FLOOR = 0.5

export function selectBaseline(samples: readonly BatteryHealthPoint[]): number | null {
  let best: number | null = null
  for (const s of samples) {
    // Both null checks are load-bearing since migration 005: a measurement-only
    // day has neither, and `null < 0.5` is false while `null > best` is also
    // false — so it would be skipped for the right reason by accident, and
    // would stop being skipped the moment either comparison was rewritten.
    if (s.estimatedCapacityKwh === null || s.sampleConfidence === null) continue
    if (s.sampleConfidence < BASELINE_CONFIDENCE_FLOOR) continue
    if (best === null || s.estimatedCapacityKwh > best) best = s.estimatedCapacityKwh
  }
  return best
}

/**
 * The same, for the car's own measurement — with no confidence floor.
 *
 * `NominalFullPackEnergyKwh` is the BMS's own figure for a full pack, not an
 * inference from a charge window, so there is no span to be sceptical of and
 * nothing to weigh readings against each other with. Kept as a separate series
 * from the estimate because they are different quantities: charting them as one
 * line would show a step wherever the estimator happened to run.
 */
export function selectMeasuredBaseline(
  samples: readonly BatteryHealthPoint[],
): number | null {
  let best: number | null = null
  for (const s of samples) {
    if (s.measuredCapacityKwh === null) continue
    if (best === null || s.measuredCapacityKwh > best) best = s.measuredCapacityKwh
  }
  return best
}

/**
 * The most recent point that actually carries the reading named by `has`.
 *
 * Not simply the last row in the window. Since migration 005 a row can exist
 * for a day that has only the other kind of reading, and "the latest estimate"
 * has to mean the latest ESTIMATE — otherwise the tile blanks on every day the
 * car reported its pack energy and no charge happened, which is most days.
 */
function latestWith(
  samples: readonly BatteryHealthPoint[],
  has: (s: BatteryHealthPoint) => number | null,
): BatteryHealthPoint | null {
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i]
    if (s && has(s) !== null) return s
  }
  return null
}

/**
 * Percentage lost against a baseline, or null when that is not a claim we can
 * make. Shared by both series so they cannot round or clamp differently.
 */
function lossPct(baseline: number | null, value: number | null): number | null {
  if (baseline === null || value === null || baseline <= 0) return null
  // Clamped at zero: a low-confidence estimate can exceed the baseline, and
  // negative degradation is noise, not a battery that grew.
  return round(Math.max(0, ((baseline - value) / baseline) * 100), 1)
}

/**
 * Percentage lost against the baseline, or null when that is not a claim we
 * can make. One measurement is not a trend, so a lone sample yields null
 * rather than 0% — which would read as "no degradation", a stronger statement
 * than the data supports.
 */
export function degradationPct(
  baseline: number | null,
  latest: BatteryHealthPoint | null,
): number | null {
  return lossPct(baseline, latest?.estimatedCapacityKwh ?? null)
}

/** The measured series' equivalent: latest measurement against the best one. */
export function measuredDegradationPct(
  baseline: number | null,
  latest: BatteryHealthPoint | null,
): number | null {
  return lossPct(baseline, latest?.measuredCapacityKwh ?? null)
}

/**
 * Capacity over time.
 *
 * The whole history is read rather than just the requested window: there is at
 * most one row per vehicle per day, so a decade is a few thousand rows, and
 * the baseline is defined as the best ever seen — computing it from the window
 * would make the degradation figure change as the user pans the chart.
 *
 * BOTH SERIES, since spec §3.8. Most rows now carry the car's own
 * `measured_capacity_kwh` and no estimate at all — an estimate needs a charge
 * spanning roughly twenty points of SoC — so the two are summarised separately
 * (baseline, latest, degradation each twice) rather than merged into one line.
 * Merging them would put a step in the chart wherever the estimator happened to
 * run, and would make "degradation" mean two different measurements on two
 * different days.
 */
export async function getBatteryHealth(
  vehicleId: string,
  range: RangeQuery,
  conn?: Queryable,
): Promise<BatteryHealthResponse> {
  const c = db(conn)
  await assertVehicleExists(vehicleId, c)
  const { rows } = await c.query(
    `SELECT to_char(observed_on, 'YYYY-MM-DD') AS observed_on,
            estimated_capacity_kwh, measured_capacity_kwh,
            rated_range_at_100_km, sample_confidence
       FROM battery_health_sample
      WHERE vehicle_id = $1
      ORDER BY observed_on ASC`,
    [vehicleId],
  )
  const all = rows.map(mapBatteryPoint)

  // Filtered here rather than in SQL because `all` is also the baseline input.
  // Inclusive of from, exclusive of to, matching the session list.
  const fromKey = range.from ? range.from.toISOString().slice(0, 10) : null
  const toKey = range.to ? range.to.toISOString().slice(0, 10) : null
  const samples = all.filter(
    (s) =>
      (fromKey === null || s.observedOn >= fromKey) &&
      (toKey === null || s.observedOn < toKey),
  )

  // Both baselines come from `all`, not from the window: the reference is the
  // best reading ever taken, and computing it from the window would make the
  // degradation figure move as the user pans the chart.
  const baseline = selectBaseline(all)
  const measuredBaseline = selectMeasuredBaseline(all)
  const latest = latestWith(samples, (s) => s.estimatedCapacityKwh)
  const lastMeasured = latestWith(samples, (s) => s.measuredCapacityKwh)
  return {
    vehicleId,
    samples,
    baselineCapacityKwh: baseline,
    latest,
    degradationPct: degradationPct(baseline, latest),
    measuredBaselineCapacityKwh: measuredBaseline,
    latestMeasured: lastMeasured,
    measuredDegradationPct: measuredDegradationPct(measuredBaseline, lastMeasured),
  }
}

/* ------------------------------------------------------------------ *
 * Raw sample series
 * ------------------------------------------------------------------ */

/**
 * The field names `?fields=` accepts, and their columns.
 *
 * DERIVED from the column catalogue, not listed. The listed version held seven
 * names and went on holding seven when the catalogue grew to two hundred, which
 * made the series API answer 400 for almost every signal the ingest worker had
 * just started paying to record — the spec's own escape hatch ("everything else
 * is reachable through samples?fields=") closed while looking open.
 *
 * Numeric columns only: a series point is `number | null` and `chart.ts`
 * decimates by averaging, which a boolean or an enum name cannot survive. Those
 * columns are still readable through the state endpoints; they are simply not a
 * time series.
 *
 * The dynamic SELECT stays safe for the same reason it always did: a request
 * names a KEY, and the column text comes from this map, so nothing from the
 * request reaches the SQL.
 */
const SERIES_COLUMNS: readonly SampleColumn[] = SAMPLE_COLUMNS.filter((c) => c.ts === 'number')

export const SAMPLE_FIELDS: readonly string[] = SERIES_COLUMNS.map((c) => c.key)

const SAMPLE_FIELD_COLUMNS: Record<string, string> = Object.fromEntries(
  SERIES_COLUMNS.map((c) => [c.key, c.column])
)

/**
 * Decimal places per field, applied for the same float4-noise reason as
 * mapState: a REAL round-trips as 20.100000381469727 and rendering that is
 * noise, not precision. One place suits every quantity we chart — percentages,
 * temperatures, speeds, powers — except position, which needs the precision it
 * has, and odometers, which are large enough that a decimal place is the point.
 */
const SAMPLE_FIELD_DP: Record<string, number> = Object.fromEntries(
  SERIES_COLUMNS.map((c) => [c.key, c.sql === 'DOUBLE PRECISION' ? 5 : 1])
)

export async function getSampleSeries(
  vehicleId: string,
  q: SampleQuery,
  conn?: Queryable,
): Promise<SampleSeriesResponse> {
  const c = db(conn)
  await assertVehicleExists(vehicleId, c)

  const columns = q.fields.map((f) => SAMPLE_FIELD_COLUMNS[f]).join(', ')
  const { rows } = await c.query(
    `WITH numbered AS (
       SELECT ts, ${columns},
              row_number() OVER (ORDER BY ts) - 1 AS rn,
              (count(*) OVER ())::int              AS total
         FROM sample
        WHERE vehicle_id = $1 AND ts >= $2 AND ts < $3
     )
     SELECT ts, ${columns}, total
       FROM numbered
      WHERE rn % GREATEST(1, ceil(total::numeric / $4::numeric)::int) = 0 OR rn = total - 1
      ORDER BY ts ASC`,
    [vehicleId, q.from, q.to, SAMPLE_SERIES_CAP],
  )

  const samples: SampleSeriesPoint[] = rows.map((r) => {
    const point: SampleSeriesPoint = { ts: isoRequired(r['ts']) }
    for (const f of q.fields) {
      // Always assigned, possibly null: "you did not ask" (absent) and "the car
      // did not say" (null) are different answers and the UI distinguishes them.
      point[f] = round(num(r[SAMPLE_FIELD_COLUMNS[f]]), SAMPLE_FIELD_DP[f])
    }
    return point
  })

  const total = rows[0] ? count(rows[0]['total']) : 0
  return {
    vehicleId,
    from: q.from.toISOString(),
    to: q.to.toISOString(),
    fields: q.fields,
    samples,
    downsampled: planDecimation(total, SAMPLE_SERIES_CAP).downsampled,
  }
}

/* ------------------------------------------------------------------ *
 * Stats
 * ------------------------------------------------------------------ */

const DEFAULT_STATS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/**
 * One window's aggregates.
 *
 * Only completed sessions contribute (`is_open = false AND ended_at IS NOT
 * NULL`) so no number moves while a drive is in progress. `SUM` over no rows
 * is null in Postgres and is passed through as null, which is the whole point:
 * an empty month reports null distance, not 0 km.
 */
async function periodStats(
  vehicleId: string,
  from: Date | null,
  to: Date | null,
  conn: Queryable,
): Promise<Omit<PeriodStats, 'from' | 'to'>> {
  const where = ['vehicle_id = $1', 'is_open = false', 'ended_at IS NOT NULL']
  const values: unknown[] = [vehicleId]
  if (from) {
    values.push(from)
    where.push(`started_at >= $${values.length}`)
  }
  if (to) {
    values.push(to)
    where.push(`started_at < $${values.length}`)
  }

  const { rows } = await conn.query(
    `SELECT
       count(*) FILTER (WHERE kind = 'drive')                     AS drive_count,
       count(*) FILTER (WHERE kind = 'charge')                    AS charge_count,
       sum(distance_km) FILTER (WHERE kind = 'drive')             AS distance_km,
       sum(energy_kwh)  FILTER (WHERE kind = 'drive')             AS drive_energy_kwh,
       sum(energy_kwh)  FILTER (WHERE kind = 'charge')            AS charge_energy_kwh,
       sum(extract(epoch FROM (ended_at - started_at)))
         FILTER (WHERE kind = 'drive')                            AS driving_time_s,
       sum(extract(epoch FROM (ended_at - started_at)))
         FILTER (WHERE kind = 'charge')                           AS charging_time_s,
       max(max_charge_power_kw)                                   AS max_charge_power_kw
     FROM session
     WHERE ${where.join(' AND ')}`,
    values,
  )
  const r = rows[0] ?? {}

  const distanceKm = round(num(r['distance_km']), 1)
  const driveEnergyKwh = round(num(r['drive_energy_kwh']), 2)
  return {
    driveCount: count(r['drive_count']),
    chargeCount: count(r['charge_count']),
    distanceKm,
    driveEnergyKwh,
    chargeEnergyKwh: round(num(r['charge_energy_kwh']), 2),
    // Computed from the totals, not by averaging per-drive efficiencies: that
    // would weight a 2 km trip the same as a 200 km one.
    efficiencyWhPerKm:
      driveEnergyKwh !== null && distanceKm !== null && distanceKm > 0
        ? round((driveEnergyKwh * 1000) / distanceKm, 0)
        : null,
    drivingTimeS: round(num(r['driving_time_s']), 0),
    chargingTimeS: round(num(r['charging_time_s']), 0),
    maxChargePowerKw: round(num(r['max_charge_power_kw']), 1),
  }
}

export async function getVehicleStats(
  vehicleId: string,
  range: RangeQuery,
  conn?: Queryable,
): Promise<VehicleStatsResponse> {
  const c = db(conn)
  await assertVehicleExists(vehicleId, c)

  const to = range.to ?? new Date()
  const from = range.from ?? new Date(to.getTime() - DEFAULT_STATS_WINDOW_MS)

  const [period, lifetime, extras] = await Promise.all([
    periodStats(vehicleId, from, to, c),
    periodStats(vehicleId, null, null, c),
    c.query(
      `SELECT
         (SELECT min(ts) FROM sample WHERE vehicle_id = $1) AS recording_since,
         (SELECT odometer_km FROM sample
           WHERE vehicle_id = $1 AND odometer_km IS NOT NULL
           ORDER BY ts DESC LIMIT 1)                        AS odometer_km,
         (SELECT min(started_at) FROM session
           WHERE vehicle_id = $1 AND is_open = false AND ended_at IS NOT NULL)
                                                            AS lifetime_from,
         (SELECT max(ended_at) FROM session
           WHERE vehicle_id = $1 AND is_open = false AND ended_at IS NOT NULL)
                                                            AS lifetime_to`,
      [vehicleId],
    ),
  ])
  const e = extras.rows[0] ?? {}

  return {
    vehicleId,
    period: { from: from.toISOString(), to: to.toISOString(), ...period },
    lifetime: {
      // With no completed sessions there is no lifetime window to report, so
      // it collapses to the requested one rather than claiming a span that
      // never contained anything.
      from: iso(e['lifetime_from']) ?? from.toISOString(),
      to: iso(e['lifetime_to']) ?? to.toISOString(),
      ...lifetime,
    },
    odometerKm: round(num(e['odometer_km']), 1),
    recordingSince: iso(e['recording_since']),
  }
}
