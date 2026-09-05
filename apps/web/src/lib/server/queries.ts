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
import type {
  BatteryHealthPoint,
  BatteryHealthResponse,
  ChargeState,
  PeriodStats,
  PowerState,
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
import { SAMPLE_FIELDS } from '../api-types.js'
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
 */
export function parseDateParam(name: string, raw: string): Date {
  const text = DATE_ONLY.test(raw) ? `${raw}T00:00:00.000Z` : raw
  const d = new Date(text)
  if (Number.isNaN(d.getTime())) {
    throw new ApiProblem(400, `invalid ${name}: expected an ISO date or datetime`)
  }
  return d
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
  if (kind !== null) {
    if (!SESSION_KINDS.includes(kind as SessionKind)) {
      throw new ApiProblem(400, `invalid kind: expected one of ${SESSION_KINDS.join(', ')}`)
    }
    q.kind = kind as SessionKind
  }

  const from = params.get('from')
  if (from !== null) q.from = parseDateParam('from', from)
  const to = params.get('to')
  if (to !== null) q.to = parseDateParam('to', to)
  if (q.from && q.to && q.to.getTime() < q.from.getTime()) {
    throw new ApiProblem(400, 'invalid range: to precedes from')
  }

  const limit = params.get('limit')
  if (limit !== null) {
    const n = Number(limit)
    // Number('') is 0 and Number(' 5 ') is 5, so test the raw string too: an
    // empty `?limit=` is a client bug, not a request for the default.
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
  if (from === null || to === null) {
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
  const from = params.get('from')
  if (from !== null) q.from = parseDateParam('from', from)
  const to = params.get('to')
  if (to !== null) q.to = parseDateParam('to', to)
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

/**
 * The latest `sample` row, camel-cased.
 *
 * `tpms` is passed through as whatever JSONB held: a vendor that reports two
 * wheels yields a two-key object, and filling the missing wheels with zeros
 * would render as two flat tyres.
 */
function mapState(vehicleId: string, r: Row): VehicleState {
  return {
    vehicleId,
    ts: isoRequired(r['ts']),
    socPct: round(num(r['soc_pct']), 1),
    rangeKm: round(num(r['range_km']), 1),
    odometerKm: round(num(r['odometer_km']), 1),
    lat: round(num(r['lat']), 6),
    lon: round(num(r['lon']), 6),
    speedKph: round(num(r['speed_kph']), 1),
    powerState: str(r['power_state']) as PowerState | null,
    chargeState: str(r['charge_state']) as ChargeState | null,
    chargePowerKw: round(num(r['charge_power_kw']), 1),
    chargeEnergyAddedKwh: round(num(r['charge_energy_added_kwh']), 2),
    insideTempC: round(num(r['inside_temp_c']), 1),
    outsideTempC: round(num(r['outside_temp_c']), 1),
    locked: bool(r['locked']),
    doorsOpen: bool(r['doors_open']),
    tpms: (r['tpms'] as Record<string, number> | null) ?? null,
  }
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
  state: VehicleState | null,
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

export function mapBatteryPoint(r: Row): BatteryHealthPoint {
  return {
    observedOn: String(r['observed_on']),
    // NOT NULL in the schema; a null here means the query changed, and a 0 kWh
    // battery would plot as total failure rather than as a bug.
    estimatedCapacityKwh: round(num(r['estimated_capacity_kwh']), 2) as number,
    ratedRangeAt100Km: round(num(r['rated_range_at_100_km']), 1),
    sampleConfidence: round(num(r['sample_confidence']), 2) as number,
  }
}

/* ------------------------------------------------------------------ *
 * Vehicles
 * ------------------------------------------------------------------ */

const VEHICLE_WITH_STATE_SQL = `
  SELECT
    v.id                AS vehicle_id,
    v.vendor            AS vendor,
    v.vendor_vehicle_id AS vendor_vehicle_id,
    v.display_name      AS display_name,
    v.model             AS model,
    v.model_year        AS model_year,
    v.created_at        AS created_at,
    st.ts, st.soc_pct, st.range_km, st.odometer_km, st.lat, st.lon,
    st.speed_kph, st.power_state, st.charge_state, st.charge_power_kw,
    st.charge_energy_added_kwh, st.inside_temp_c, st.outside_temp_c,
    st.locked, st.doors_open, st.tpms,
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

function mapVehicleWithState(r: Row): VehicleWithState {
  const vehicle = mapVehicle(r)
  // `ts` is NOT NULL in `sample`, so a null here is the LEFT JOIN missing, not
  // a row with an unknown timestamp.
  const state = r['ts'] === null || r['ts'] === undefined ? null : mapState(vehicle.id, r)
  const { activity, openSessionId } = deriveActivity(
    state,
    str(r['open_drive_id']),
    str(r['open_charge_id']),
  )
  return { vehicle, state, activity, openSessionId }
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

/**
 * The latest sample and nothing else — the cheap target for a card that polls.
 *
 * The two 404s are deliberately different. An unknown id is a bad URL; a known
 * vehicle with no samples is an ingestion problem, and collapsing them would
 * send the operator looking at the wrong thing.
 */
export async function getVehicleState(id: string, conn?: Queryable): Promise<VehicleState> {
  const c = db(conn)
  await assertVehicleExists(id, c)
  const { rows } = await c.query(
    `SELECT ts, soc_pct, range_km, odometer_km, lat, lon, speed_kph,
            power_state, charge_state, charge_power_kw, charge_energy_added_kwh,
            inside_temp_c, outside_temp_c, locked, doors_open, tpms
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
  return {
    session: mapSession(row),
    points: points.rows.map(mapPoint),
    downsampled: planDecimation(total, SESSION_POINT_CAP).downsampled,
  }
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
    if (s.sampleConfidence < BASELINE_CONFIDENCE_FLOOR) continue
    if (best === null || s.estimatedCapacityKwh > best) best = s.estimatedCapacityKwh
  }
  return best
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
  if (baseline === null || latest === null || baseline <= 0) return null
  // Clamped at zero: a low-confidence estimate can exceed the baseline, and
  // negative degradation is noise, not a battery that grew.
  const pct = Math.max(0, ((baseline - latest.estimatedCapacityKwh) / baseline) * 100)
  return round(pct, 1)
}

/**
 * Capacity over time.
 *
 * The whole history is read rather than just the requested window: there is at
 * most one row per vehicle per day, so a decade is a few thousand rows, and
 * the baseline is defined as the best ever seen — computing it from the window
 * would make the degradation figure change as the user pans the chart.
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
            estimated_capacity_kwh, rated_range_at_100_km, sample_confidence
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

  const baseline = selectBaseline(all)
  const latest = samples[samples.length - 1] ?? null
  return {
    vehicleId,
    samples,
    baselineCapacityKwh: baseline,
    latest,
    degradationPct: degradationPct(baseline, latest),
  }
}

/* ------------------------------------------------------------------ *
 * Raw sample series
 * ------------------------------------------------------------------ */

/**
 * Contract field name to column name.
 *
 * This map is what makes the dynamic SELECT list safe: the keys are a
 * validated `SampleField` union and the values are literals written here, so
 * nothing from the request ever reaches the SQL text. Adding a field means
 * editing SAMPLE_FIELDS and this map together, and TypeScript fails the build
 * if only one of them changes.
 */
const SAMPLE_FIELD_COLUMNS: Record<SampleField, string> = {
  socPct: 'soc_pct',
  rangeKm: 'range_km',
  odometerKm: 'odometer_km',
  speedKph: 'speed_kph',
  chargePowerKw: 'charge_power_kw',
  insideTempC: 'inside_temp_c',
  outsideTempC: 'outside_temp_c',
}

/** Decimal places per field, applied for the same float4-noise reason as mapState. */
const SAMPLE_FIELD_DP: Record<SampleField, number> = {
  socPct: 1,
  rangeKm: 1,
  odometerKm: 1,
  speedKph: 1,
  chargePowerKw: 1,
  insideTempC: 1,
  outsideTempC: 1,
}

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
