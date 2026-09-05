/**
 * Tesla Fleet Telemetry (MQTT transport) -> canonical `VehicleSample`.
 *
 * WHAT THE WIRE ACTUALLY LOOKS LIKE. This module was rewritten against
 * fleet-telemetry's `datastore/mqtt/mqtt_payload.go`, not against the protobuf
 * or Kafka shapes, because the two transports do not agree and the difference
 * is total rather than cosmetic:
 *
 *   - `processVehicleFields()` publishes ONE MQTT MESSAGE PER FIELD. There is no
 *     record envelope and no `data` array on this transport, so "one message ->
 *     one VehicleSample" is not a shape that exists here. One message carries
 *     one field of one vehicle.
 *   - The field NAME is only in the topic (`<base>/<VIN>/v/<FieldName>`); the
 *     payload is the JSON-encoded VALUE ALONE, because `getDatumValue()` has
 *     already unwrapped the protobuf oneof before publishing. So a payload is a
 *     bare number, a bare string (this includes every enum, rendered as its
 *     `.String()` name), a bare boolean, `{"latitude":..,"longitude":..}` for
 *     Location, or `null` for `Value_Invalid`. Wrapper arms such as
 *     `doubleValue` / `stringValue` / `invalid` belong to the protobuf
 *     transport and NEVER arrive here.
 *   - The metrics payload carries NO TIMESTAMP. Only connectivity carries
 *     `createdAt`. Sample time therefore has to come from message arrival.
 *
 * Because a sample needs several fields, this module only decodes and collapses;
 * the ACCUMULATION of fields into a sample (and the timing of when to emit one)
 * lives in the ingest worker, which is the layer that knows about message
 * arrival, transactions and restarts. See `apps/ingest/src/pipeline.ts`.
 *
 * ONE DECODER PER TYPE, NOT ONE PER FIELD. There are 204 catalogued signals and
 * a hand-written map of 204 decoders would be free to disagree with the list we
 * ask the car for and with the columns we store into - which is the whole
 * failure this design exists to prevent, and it is silent in every direction.
 * So `FIELD_DECODERS` is BUILT from `catalogue.ts`: the entry names the column,
 * the column names its SQL type, and the type owns the decoder. Fourteen fields
 * do something no generic rule can express and keep their hand-written decoders
 * in `FIELD_OVERRIDES` - the two charge-state enums, the door struct, the
 * charging rails, and the four TPMS corners, all of which collapse several
 * messages into one column.
 *
 * ABSENT MUST NEVER BECOME ZERO. `VehicleSample` makes every field nullable
 * precisely so "the car did not say" stays distinguishable from "the car said
 * 0". A parser that defaulted to 0 would tell the segmenter the car is parked at
 * 0 kph drawing 0 kW, which silently ends drives and charges. Every decoder here
 * returns `null` for anything it cannot vouch for, and an unknown field name is
 * ignored rather than guessed at.
 *
 * AND A WRONG TYPE MUST NEVER BECOME A BIND ERROR. `insertSample` binds every
 * column in one statement inside the ingest transaction, so a value the column
 * REJECTS - a float bound to INT, a number bound to TIMESTAMPTZ - rolls the
 * transaction back, is never acked, and is redelivered forever: a permanent
 * stall rather than a hole in one series. Each SQL type's decoder therefore
 * coerces into that column's domain or returns null, and the test table asserts
 * both directions for every catalogued field.
 *
 * TYPE DRIFT. Upstream warns that a field's JSON type can change between vehicle
 * software versions - the vehicle's speed may arrive as `12.3` in one build and
 * as `"12.3"` in another. So numbers accept both, while still refusing `''`,
 * `'abc'`, NaN and Infinity, each of which `Number()` would happily turn into a
 * number-shaped lie.
 *
 * UNITS. Tesla streams US customary units for distance regardless of the display
 * setting on the touchscreen: speeds are mph and distances miles. Our model is
 * kph/km, so the catalogue names the converter per field and any column holding
 * a converted value carries the real unit in its name. Everything else is
 * already in our units: temperatures Celsius, charging power kW, charging energy
 * kWh, `Soc` a percentage, TPMS pressures bar.
 */

import {
  SAMPLE_COLUMNS,
  makeSample,
  type ChargeState,
  type PowerState,
  type RawMessage,
  type SampleColumn,
  type SqlType,
  type VehicleSample,
} from '@ev/core'
import {
  TESLA_FIELDS,
  columnsOf,
  slotsOf,
  type Converter,
  type TeslaField,
} from './catalogue.js'

/**
 * Exact international mile. Named and exported because it is the one number in
 * this file whose value is load-bearing rather than structural: getting it
 * subtly wrong (1.6, or the survey mile) skews every distance, every derived
 * efficiency figure, and every capacity estimate downstream, and does so by an
 * amount small enough to look plausible.
 */
export const MILES_TO_KM = 1.609344

/** The columns whose value is collapsed from several fields at build time. */
const COLLAPSED_KEYS = [
  'chargeState',
  'chargePowerKw',
  'chargeEnergyAddedKwh',
  'tpms',
] as const satisfies readonly (keyof Omit<VehicleSample, 'vehicleId' | 'ts'>)[]

type CollapsedKey = (typeof COLLAPSED_KEYS)[number]

/**
 * The slots that are simply the column, carried through unchanged. Derived from
 * the column catalogue rather than written out: a slot missing from a hand list
 * would be decoded, accumulated, and then dropped on the floor at build time.
 */
type DirectSlots = {
  [K in Exclude<keyof Omit<VehicleSample, 'vehicleId' | 'ts'>, CollapsedKey>]: VehicleSample[K]
}

/**
 * The accumulated latest-known value of every slot we can fill from Tesla.
 *
 * This is deliberately NOT a `VehicleSample`. Several Tesla fields collapse into
 * one canonical column (AC/DC power, AC/DC energy, the four TPMS corners, the
 * two charge-state enums), and since each arrives in its own MQTT message the
 * collapse cannot happen at decode time - it happens once, in
 * `teslaStateToSample`, over whatever has accumulated. Those are the slots
 * spelled out below; every other slot IS its column.
 *
 * Every slot is nullable and `null` means "never reported", which is what keeps
 * an unreported field null in the emitted sample instead of 0.
 */
export interface TeslaFieldState extends DirectSlots {
  tpmsFl: number | null
  tpmsFr: number | null
  tpmsRl: number | null
  tpmsRr: number | null
  acPowerKw: number | null
  dcPowerKw: number | null
  acEnergyKwh: number | null
  dcEnergyKwh: number | null
  /**
   * Which rail was last seen actually drawing power. Derived, not reported.
   * It is what makes the cumulative energy counters usable - see
   * `teslaStateToSample`.
   */
  activeRail: 'ac' | 'dc' | null
  /** From `ChargeState`. */
  chargeStateBasic: ChargeState | null
  /** From `DetailedChargeState`; preferred when both are known. */
  chargeStateDetailed: ChargeState | null
}

/** What one decoded field contributes. Merged into a `TeslaFieldState`. */
export type TeslaFieldUpdate = Partial<TeslaFieldState>

/** Anything a decoder may produce: the runtime side of `@ev/core`'s `TsType`. */
type SlotValue = number | string | boolean | Date | Record<string, number>

/**
 * ONE DECODER PER SQL TYPE (§3.4).
 *
 * Each coerces into its column's domain or returns null, and null is always the
 * safe answer: it loses one reading, while a value the column rejects loses the
 * whole pipeline until someone notices. Exported because `TIME` and
 * `TIMESTAMPTZ` have no columns YET - every time-shaped field is parked at TEXT
 * until we have seen what the car actually sends - and the promotion of one of
 * those columns is a planned step, so the decoder that will carry it has to be
 * testable before the column exists.
 */
export const SQL_DECODERS: Record<SqlType, (value: unknown) => SlotValue | null> = {
  'REAL': real,
  'DOUBLE PRECISION': num,
  'INT': int,
  'BOOLEAN': bool,
  'TEXT': text,
  'TIME': timeOfDay,
  'TIMESTAMPTZ': timestamptz,
  'JSONB': numberRecord,
}

/**
 * The conversions the catalogue names, applied BEFORE the column's decoder, so
 * the decoder is always checking the value that will actually be bound.
 */
export const VALUE_CONVERTERS: Record<Converter, (value: unknown) => unknown> = {
  milesToKm: (v) => scaled(v, MILES_TO_KM),
  // The same factor: an mph is a mile per hour.
  mphToKph: (v) => scaled(v, MILES_TO_KM),
  /**
   * Unused by any entry today, and deliberately so: a `REAL` holding a Unix
   * epoch has a 128-second resolution, so a field of unobserved shape is TEXT
   * until we know, and this is what promotes it afterwards.
   */
  epochSecondsToDate: (v) => {
    const seconds = num(v)
    if (seconds === null) return null
    const date = new Date(seconds * 1000)
    return Number.isNaN(date.getTime()) ? null : date
  },
}

/** Widened to `string` keys: the catalogue's `column` is looked up by name. */
const COLUMNS_BY_NAME: ReadonlyMap<string, SampleColumn> = new Map(
  SAMPLE_COLUMNS.map((c) => [c.column, c]),
)

/**
 * The fields whose decoding is a judgement rather than a function of the column
 * type. Every one of them collapses several messages into one column, or reads
 * a struct: nine of the ten fields that share a column are here, plus the door
 * struct, and each writes exactly the slots it wrote before this file learned to
 * derive the rest.
 *
 * `Location` is NOT here, and that is the interesting absence: it was
 * hand-written until `OriginLocation` and `DestinationLocation` arrived with the
 * same `{latitude, longitude}` shape, at which point the both-or-neither rule
 * stopped being special and became the rule for any entry whose column is a
 * pair. It is the same code, reached from the catalogue.
 */
const FIELD_OVERRIDES: Record<string, (value: unknown) => TeslaFieldUpdate | null> = {
  ChargeState: (v) => one('chargeStateBasic', chargeState(str(v))),
  DetailedChargeState: (v) => one('chargeStateDetailed', chargeState(str(v))),

  DoorState: (v) => one('doorsOpen', anyDoorOpen(v)),

  // Power is reported per rail and coalesced at build time. The rail that is
  // actually delivering is recorded here, while we can still see it, because
  // the energy counters cannot be told apart on their own - which is why the
  // four rail fields are written together rather than left to the generic rule
  // that would handle the two energy counters perfectly well on their own.
  ACChargingPower: (v) => power('ac', num(v)),
  DCChargingPower: (v) => power('dc', num(v)),
  ACChargingEnergyIn: (v) => one('acEnergyKwh', num(v)),
  DCChargingEnergyIn: (v) => one('dcEnergyKwh', num(v)),

  // The four corners arrive as four separate messages and collapse into the
  // single tpms JSONB record at build time. Whichever corners are known land;
  // the record stays null if none do.
  TpmsPressureFl: (v) => one('tpmsFl', num(v)),
  TpmsPressureFr: (v) => one('tpmsFr', num(v)),
  TpmsPressureRl: (v) => one('tpmsRl', num(v)),
  TpmsPressureRr: (v) => one('tpmsRr', num(v)),
}

/** The hand-written exceptions, for the test that pins them to the catalogue. */
export const TESLA_OVERRIDDEN_FIELDS: readonly string[] = Object.keys(FIELD_OVERRIDES)

/**
 * Build the decoder for a field the column type fully describes.
 *
 * Throws rather than returning a no-op decoder if the catalogue names a column
 * that does not exist: a field that decodes to nothing is a signal we pay for,
 * receive and discard in silence, which is precisely what these two lists exist
 * to make impossible. `catalogue.test.ts` already asserts every entry's column
 * exists, so this cannot fire in a build that passed.
 */
function catalogueDecoder(entry: TeslaField): (value: unknown) => TeslaFieldUpdate | null {
  const columns = columnsOf(entry).map((name) => {
    const column = COLUMNS_BY_NAME.get(name)
    if (!column) throw new Error(`${entry.field} names column '${name}', which @ev/core lacks`)
    return column
  })
  const slots = slotsOf(entry)
  const convert = entry.convert === null ? null : VALUE_CONVERTERS[entry.convert]
  const decoders = columns.map((c) => SQL_DECODERS[c.sql])

  /**
   * A pair: latitude and longitude arrive in ONE message, as a two-key object,
   * and the pair is only meaningful whole - a sample carrying a latitude with a
   * null longitude would be plotted on the prime meridian. Both land or neither
   * does.
   */
  if (slots.length === 2) {
    // A converter would silently do nothing here - it takes a scalar and this
    // payload is a struct - so a catalogue that ever names one on a pair should
    // fail loudly rather than convert nothing.
    if (convert) throw new Error(`${entry.field} is a pair; a converter cannot apply to it`)
    const decodeLat = decoders[0]!
    const decodeLon = decoders[1]!
    const latSlot = slots[0]!
    const lonSlot = slots[1]!
    return (value) => {
      const o = asRecord(value)
      if (!o) return null
      const lat = decodeLat(o['latitude'])
      const lon = decodeLon(o['longitude'])
      if (lat === null || lon === null) return null
      return { [latSlot]: lat, [lonSlot]: lon } as TeslaFieldUpdate
    }
  }

  const decode = decoders[0]!
  const slot = slots[0]!
  return (value) => {
    const decoded = decode(convert ? convert(value) : value)
    return decoded === null ? null : ({ [slot]: decoded } as TeslaFieldUpdate)
  }
}

/**
 * Tesla field name -> the slots it fills, one entry per catalogued signal.
 *
 * A decoder returns `null` when the value is unreadable, which is what
 * distinguishes "the car published Soc" from "the car published a readable Soc".
 * Only a non-null return is allowed to change accumulated state, so an
 * unreadable message can never blank a good earlier reading.
 *
 * Field names absent from this map are ignored on purpose: they are the ones
 * `EXCLUDED_FIELDS` names and the ones Tesla has not shipped yet. A field the
 * proto gains that is neither catalogued nor excluded fails the catalogue test
 * rather than arriving here.
 */
const FIELD_DECODERS: Record<string, (value: unknown) => TeslaFieldUpdate | null> =
  Object.fromEntries(
    TESLA_FIELDS.map((entry) => [
      entry.field,
      FIELD_OVERRIDES[entry.field] ?? catalogueDecoder(entry),
    ]),
  )

/** The field names this adapter knows how to place. Exported for tests/metrics. */
export const TESLA_KNOWN_FIELDS: readonly string[] = Object.keys(FIELD_DECODERS)

export function isKnownTeslaField(field: string): boolean {
  return Object.hasOwn(FIELD_DECODERS, field)
}

/**
 * Decode one `<base>/<VIN>/v/<FieldName>` message.
 *
 * Returns `null` for an unknown field name AND for a value that cannot be
 * trusted (`null` payload - Value_Invalid - an empty string, a non-numeric
 * string where a number belongs, an unrecognised enum). Null means "change
 * nothing": the caller keeps whatever it already knew, which is strictly better
 * than overwriting a good reading with a fabricated one.
 */
export function decodeTeslaField(field: string, value: unknown): TeslaFieldUpdate | null {
  const decode = FIELD_DECODERS[field]
  if (!decode) return null
  const update = decode(value)
  // An empty object would count as "something landed" for the caller while
  // carrying nothing; collapse it to null so the two cases stay distinct.
  return update && Object.keys(update).length > 0 ? update : null
}

/**
 * The catalogued columns an accumulated state carries under their own key.
 * Everything else on `sample` is either collapsed below or has no Tesla field.
 */
const DIRECT_KEYS: readonly string[] = SAMPLE_COLUMNS
  .map((c) => c.key)
  .filter((key) => !(COLLAPSED_KEYS as readonly string[]).includes(key))

/**
 * Build a `VehicleSample` from accumulated state.
 *
 * `ts` is supplied by the caller because the metrics transport carries no
 * timestamp of its own: the only time we have is when the message arrived.
 *
 * The direct columns are copied by name over the catalogue rather than listed,
 * for the same reason the decoders are built from it: a column left out of a
 * hand-written list is a signal that is asked for, paid for, decoded and then
 * silently not stored, and nothing at runtime would say so.
 */
export function teslaStateToSample(
  vehicleId: string,
  ts: Date,
  state: TeslaFieldUpdate,
): VehicleSample {
  const direct: Record<string, unknown> = {}
  const slots = state as Record<string, unknown>
  for (const key of DIRECT_KEYS) {
    // Only what was actually reported: `makeSample` fills the rest with null,
    // and an `undefined` reaching the insert would bind as NULL anyway but say
    // nothing here about which of the two it meant.
    if (slots[key] !== undefined && slots[key] !== null) direct[key] = slots[key]
  }
  return makeSample({
    // The cast is the price of iterating the catalogue by name; the values are
    // whatever the per-type decoders produced, which the bindability test pins
    // to each column's declared SQL type.
    ...(direct as Partial<VehicleSample>),
    vehicleId,
    ts,
    tpms: tpmsRecord(state),
    // DetailedChargeState is the finer-grained of the two enums and wins when
    // both are known.
    chargeState: state.chargeStateDetailed ?? state.chargeStateBasic ?? null,
    chargePowerKw: coalescePower(state.acPowerKw ?? null, state.dcPowerKw ?? null),
    chargeEnergyAddedKwh: chooseEnergy(state),
  })
}

/**
 * POWER: pick the rail with the greater magnitude.
 *
 * AC and DC charging are mutually exclusive on a real car and the inactive rail
 * reports 0 (or nothing at all), so "greater magnitude" picks the live one, and
 * still yields 0 - a true reading - when the car is plugged in but not drawing.
 * If neither rail was readable the result stays null: a 0 here reads downstream
 * as "charger delivering nothing", which ends a charge session.
 */
function coalescePower(ac: number | null, dc: number | null): number | null {
  if (ac === null) return dc
  if (dc === null) return ac
  return Math.abs(dc) > Math.abs(ac) ? dc : ac
}

/**
 * ENERGY: pick by rail, never by magnitude.
 *
 * This is the one place where energy must NOT be treated like power.
 * `ACChargingEnergyIn` and `DCChargingEnergyIn` are CUMULATIVE COUNTERS: the
 * idle rail does not read 0, it retains a total from an earlier session. Under
 * the magnitude rule a car DC-fast-charging with 12 kWh added would report the
 * 40 kWh left over on the AC counter, and worse, would FLIP rails part-way
 * through as the live counter overtook the stale one - producing a session
 * energy figure that is a difference between two unrelated counters. Session
 * energy feeds the battery-capacity estimate, and a bad estimate is written to
 * a derived table where it looks exactly like a good one.
 *
 * So the rail is selected by evidence of actual power flow (`activeRail`, which
 * the accumulator carries forward from the last non-zero power reading, so it
 * still holds at the end of a charge when power has dropped back to 0). With no
 * such evidence, a single known counter is used - there is nothing to confuse it
 * with - and two known counters yield null rather than a coin toss.
 */
function chooseEnergy(state: TeslaFieldUpdate): number | null {
  const ac = state.acEnergyKwh ?? null
  const dc = state.dcEnergyKwh ?? null
  if (state.activeRail === 'ac') return ac
  if (state.activeRail === 'dc') return dc
  if (ac === null) return dc
  if (dc === null) return ac
  return null
}

function tpmsRecord(state: TeslaFieldUpdate): Record<string, number> | null {
  const out: Record<string, number> = {}
  if (state.tpmsFl != null) out['fl'] = state.tpmsFl
  if (state.tpmsFr != null) out['fr'] = state.tpmsFr
  if (state.tpmsRl != null) out['rl'] = state.tpmsRl
  if (state.tpmsRr != null) out['rr'] = state.tpmsRr
  return Object.keys(out).length > 0 ? out : null
}

function one<K extends keyof TeslaFieldState>(
  key: K,
  value: TeslaFieldState[K] | null,
): TeslaFieldUpdate | null {
  if (value === null) return null
  return { [key]: value } as TeslaFieldUpdate
}

/**
 * A power reading also tells us which rail is live, and that is the only
 * reliable way to read the energy counters. A 0 is recorded as a power value but
 * does NOT claim the rail: 0 kW on AC while DC delivers is exactly the case the
 * flag exists to survive.
 */
function power(rail: 'ac' | 'dc', kw: number | null): TeslaFieldUpdate | null {
  if (kw === null) return null
  const update: TeslaFieldUpdate = rail === 'ac' ? { acPowerKw: kw } : { dcPowerKw: kw }
  if (kw > 0) update.activeRail = rail
  return update
}

/**
 * Read a number from a metrics payload.
 *
 * Accepts the bare number and the numeric string, because upstream states the
 * JSON type of a field can change between vehicle software versions. Rejects
 * NaN, Infinity, `''` and any non-numeric string: `Number('')` is 0, and a 0
 * that means "unreadable" is the absent-becomes-zero bug this module exists to
 * prevent. Booleans are rejected too - `Number(false)` is 0.
 */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const trimmed = v.trim()
    if (trimmed === '') return null
    const n = Number(trimmed)
    return Number.isFinite(n) ? n : null
  }
  return null
}

const scaled = (v: unknown, factor: number): number | null => {
  const n = num(v)
  return n === null ? null : n * factor
}

/** Postgres `INT` is int4; anything outside it is a bind error, not a big number. */
const INT_MAX = 2_147_483_647

/**
 * Postgres `REAL` is float4, and it OVERFLOWS rather than saturating: binding
 * 1e39 raises "value out of range: overflow" and takes the transaction with it.
 *
 * Same argument as INT_MAX, and the same consequence, which is why it is not
 * merely tidiness: a rejected bind rolls back in `transactionally`, the message
 * is never acked, and MQTT redelivers it forever — the permanent stall. This
 * module's own header warns that a field's JSON type drifts between vehicle
 * software builds, so an absurd numeric string is an in-contract input, not a
 * hypothetical.
 */
const FLOAT4_MAX = 3.4028234663852886e38

/**
 * A `REAL` column's decoder: a number that column can actually hold, or null.
 *
 * `DOUBLE PRECISION` keeps plain `num` — float8 spans the whole of what
 * `Number.isFinite` admits, so there is nothing left to guard against.
 */
function real(v: unknown): number | null {
  const n = num(v)
  if (n === null) return null
  return Math.abs(n) > FLOAT4_MAX ? null : n
}

/**
 * ROUND OR REJECT. A count that arrives as 3.0000001 is a count, and refusing it
 * would lose a real reading; a count of 3e9 is not one this column can hold, and
 * binding it would take the transaction down with it.
 */
function int(v: unknown): number | null {
  const n = num(v)
  if (n === null) return null
  const rounded = Math.round(n)
  return Math.abs(rounded) > INT_MAX ? null : rounded
}

/** Enums arrive as their protobuf `.String()` name, i.e. a bare JSON string. */
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

/**
 * TEXT takes anything stringifiable, INCLUDING an object.
 *
 * That looks lax next to the rest of this file, and it is the point: a column is
 * TEXT either because it holds a vendor enum name, or because we have not yet
 * observed what shape the field arrives in (§3.4). For the second kind, storing
 * `{"hour":7,"minute":30}` verbatim is what lets a later migration promote the
 * column to `TIME` and `reprocess` fill it in; refusing the object would leave
 * the column null and the promotion with nothing to read but the tape. Only
 * `null` - Value_Invalid - and a blank string are refused, because neither is a
 * value the car meant to send.
 */
function text(v: unknown): string | null {
  // A NUL byte is not storable in a Postgres text column at all - the parameter
  // is rejected with "invalid byte sequence for encoding UTF8: 0x00", which is
  // the same wedge as a numeric overflow. Nothing the car legitimately sends
  // contains one, so refusing the value loses nothing real.
  if (typeof v === 'string') return v.trim() === '' || v.includes('\u0000') ? null : v
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null
  if (typeof v === 'boolean') return String(v)
  if (typeof v === 'object' && v !== null) {
    try {
      const json = JSON.stringify(v)
      return json === undefined ? null : json
    } catch {
      return null
    }
  }
  return null
}

function bool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v
  // Some builds render a boolean field as a string; anything else is unreadable
  // rather than false, because false is a claim ("the car is unlocked").
  if (v === 'true') return true
  if (v === 'false') return false
  return null
}

/**
 * The proto's `message Time` is `{hour, minute, second}`: a wall clock, with no
 * date and no zone, which is why these fields are NOT timestamps. Rendered as
 * `HH:MM:SS` because that is what a `TIME` column takes.
 *
 * Out-of-range parts are refused rather than clamped: postgres rejects `25:00`,
 * and a clamped `23:59` would be a value the car never sent.
 */
function timeOfDay(v: unknown): string | null {
  const o = asRecord(v)
  if (!o) return null
  const hour = num(o['hour'])
  const minute = num(o['minute'])
  // The proto omits a zero field rather than sending it, so a missing second is
  // the top of the minute, not an unreadable value.
  const second = o['second'] === undefined ? 0 : num(o['second'])
  if (!within(hour, 23) || !within(minute, 59) || !within(second, 59)) return null
  return [hour, minute, second].map((n) => String(n).padStart(2, '0')).join(':')
}

function within(n: number | null, max: number): n is number {
  return n !== null && Number.isInteger(n) && n >= 0 && n <= max
}

/**
 * A `TIMESTAMPTZ` column accepts ONLY what `epochSecondsToDate` produced.
 *
 * A bare epoch or an ISO string reaching here means the catalogue did not name
 * the converter, and postgres would read a bare number as a year - so this is
 * the case where accepting the value is worse than losing it.
 */
function timestamptz(v: unknown): Date | null {
  return v instanceof Date && !Number.isNaN(v.getTime()) ? v : null
}

/**
 * The only JSONB column is `tpms`, whose declared type is a record of numbers,
 * so that is what this takes. An empty record is null: "no corner reported" is
 * not "a reading with nothing in it".
 */
function numberRecord(v: unknown): Record<string, number> | null {
  const o = asRecord(v)
  if (!o) return null
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(o)) {
    const n = num(value)
    if (n === null) return null
    out[key] = n
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * Tesla enum -> our `ChargeState`.
 *
 * Both the plain form ("Charging") and the prefixed protobuf enum names
 * ("ChargeStateCharging", "DetailedChargeStateCharging") occur, so the prefix is
 * stripped before matching.
 *
 * An unrecognised value maps to null, never to a guess. Charge state feeds
 * session segmentation directly: guessing "connected" would fabricate charge
 * sessions and guessing "disconnected" would truncate real ones, and both are
 * written into derived tables that cannot be told apart from correct ones
 * afterwards. Null just means "we know nothing new about charging", which the
 * segmenter already handles.
 */
function chargeState(s: string | null): ChargeState | null {
  if (s === null) return null
  const bare = s
    .trim()
    .replace(/^DetailedChargeState/, '')
    .replace(/^ChargeState/, '')
  switch (bare) {
    case 'Charging':
      return 'charging'
    case 'Complete':
      return 'complete'
    case 'Stopped':
      return 'stopped'
    case 'Disconnected':
      return 'disconnected'
    // NoPower and Starting both mean "cable in, no energy moving yet".
    case 'NoPower':
    case 'Starting':
    case 'Connected':
      return 'connected'
    default:
      return null
  }
}

/**
 * Any door open?
 *
 * `DoorState` is the one struct-valued field besides the locations: a set of
 * per-door booleans. Absent or unreadable gives null rather than false, because
 * "no door reported" is not "all doors shut" - a false would show a car we know
 * nothing about as secure.
 */
function anyDoorOpen(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v
  const doors = asRecord(v)
  if (!doors) return null
  const flags = Object.values(doors).filter((x) => typeof x === 'boolean')
  if (flags.length === 0) return null
  return flags.some(Boolean)
}

/**
 * Decode a `<base>/<VIN>/connectivity` message.
 *
 * Connectivity is the only message on this transport that carries its own
 * `createdAt`, and the only source of power state, which the garage view and the
 * stall alert both need. Signature kept as (RawMessage -> VehicleSample | null)
 * because `apps/ingest/src/deps.ts` still calls it that way.
 */
export function normaliseTeslaConnectivity(raw: RawMessage): VehicleSample | null {
  const payload = asRecord(raw.payload)
  if (!payload) return null
  const state = connectivityState(payload['status'])
  if (!state) return null
  return makeSample({
    vehicleId: raw.vehicleId,
    ts: timestamp(payload['createdAt'], raw.receivedAt),
    powerState: state,
  })
}

/** Just the power state from a connectivity body, for the accumulator. */
export function decodeTeslaConnectivity(payload: unknown): PowerState | null {
  const body = asRecord(payload)
  return body ? connectivityState(body['status']) : null
}

function connectivityState(s: unknown): PowerState | null {
  switch (s) {
    case 'CONNECTED':
      return 'online'
    case 'DISCONNECTED':
      return 'offline'
    default:
      return null
  }
}

/**
 * Prefer the message's own `createdAt`; fall back to when we received it. An
 * unparseable date must fall back too - an Invalid Date propagates into a NULL
 * timestamp on insert and loses the row entirely.
 */
function timestamp(createdAt: unknown, receivedAt: Date): Date {
  if (typeof createdAt === 'string' || typeof createdAt === 'number') {
    const d = new Date(createdAt)
    if (!Number.isNaN(d.getTime())) return d
  }
  return receivedAt
}

/**
 * Accepts a raw JSON string as well as an already-parsed object, and never
 * throws on malformed JSON: one corrupt message must not take down ingest.
 */
function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v === 'string') {
    try {
      const parsed: unknown = JSON.parse(v)
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}
