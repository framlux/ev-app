/**
 * Tesla Fleet Telemetry -> canonical `VehicleSample`.
 *
 * The car streams JSON because the server config sets `transmit_decoded_records:
 * true` and `prefer_typed: true`. A telemetry record ("V" record type) looks
 * roughly like:
 *
 *   { "vin": "5YJ...", "createdAt": "2026-09-04T10:00:00Z",
 *     "data": [ { "key": "Soc", "value": { "doubleValue": 72.5 } }, ... ] }
 *
 * Two properties of that feed drive every decision below.
 *
 * 1. The wire shape is only loosely pinned. `prefer_typed` means each value is a
 *    protobuf `Value` oneof rendered as a single-key object, but WHICH key
 *    appears depends on the field, the firmware, and how the record was
 *    marshalled (protojson emits camelCase; some builds emit snake_case). Tesla
 *    also adds new fields and new oneof arms without warning. So the parser
 *    accepts a family of shapes and, crucially, ignores anything it does not
 *    recognise instead of throwing: one unknown arm must never cost us the other
 *    twenty fields in the same message.
 *
 * 2. Absent must never become zero. `VehicleSample` makes every field nullable
 *    precisely so that "the car did not say" stays distinguishable from "the car
 *    said 0". A parser that defaults to 0 would tell the segmenter the car is
 *    parked at 0 kph and drawing 0 kW, which silently ends drives and charges.
 *    Every extractor here returns `null` on any shape it cannot vouch for, and a
 *    field only lands when a value was genuinely read.
 *
 * UNITS. Tesla streams US customary units for distance regardless of the
 * display setting on the touchscreen: `VehicleSpeed` is mph, `Odometer` and
 * `RatedRange` are miles. Our model is kph/km, so those three are converted by
 * MILES_TO_KM. Everything else is already in our units and is passed through
 * untouched: temperatures are Celsius, charging power is kW, charging energy is
 * kWh, `Soc` is a percentage, and TPMS pressures are bar.
 */

import {
  makeSample,
  type ChargeState,
  type PowerState,
  type RawMessage,
  type VehicleSample,
} from '@ev/core'

/**
 * Exact international mile. Named and exported because it is the one number in
 * this file whose value is load-bearing rather than structural: getting it
 * subtly wrong (1.6, or the survey mile) skews every distance, every derived
 * efficiency figure, and every capacity estimate downstream, and does so by an
 * amount small enough to look plausible.
 */
export const MILES_TO_KM = 1.609344

const milesToKm = (miles: number | null): number | null =>
  miles === null ? null : miles * MILES_TO_KM

/** The subset of a sample a field handler is allowed to populate. */
type SampleFields = Partial<Omit<VehicleSample, 'vehicleId' | 'ts'>>

/**
 * Accumulator for one record.
 *
 * Several Tesla fields collapse into one canonical field (AC/DC power, AC/DC
 * energy, the four TPMS corners, the two charge-state enums). Those cannot be
 * written straight into `SampleFields` as they are encountered: entries arrive
 * in arbitrary order, so a later `DCChargingPower: invalid` would otherwise
 * clobber an earlier good `ACChargingPower`. They are staged here and resolved
 * once, after the whole `data` array has been walked.
 */
interface Draft {
  fields: SampleFields
  acPowerKw: number | null
  dcPowerKw: number | null
  acEnergyKwh: number | null
  dcEnergyKwh: number | null
  /** From `ChargeState`. */
  chargeStateBasic: ChargeState | null
  /** From `DetailedChargeState`; preferred when both are present. */
  chargeStateDetailed: ChargeState | null
  tpms: Record<string, number>
}

/**
 * Tesla field name -> how it lands in a `VehicleSample`.
 *
 * A handler returns `true` only when it actually extracted a usable value.
 * That return is what distinguishes "the record mentioned Soc" from "the record
 * carried a readable Soc", and it is what stops a record made entirely of
 * `{ invalid: true }` values from producing an all-null sample that the
 * segmenter would treat as a real observation.
 *
 * Keys absent from this map are ignored on purpose. That covers both fields
 * Tesla has not shipped yet and fields we stream but have nowhere to put:
 * `Gear` and `ChargeAmps` are configured on the car but have no `VehicleSample`
 * counterpart, so they are deliberately dropped rather than forced somewhere.
 */
export const TESLA_FIELD_MAP: Record<string, (value: unknown, into: Draft) => boolean> = {
  Soc: (v, d) => assignNum(d.fields, 'socPct', num(v)),
  // Miles on the wire, km in the model.
  RatedRange: (v, d) => assignNum(d.fields, 'rangeKm', milesToKm(num(v))),
  Odometer: (v, d) => assignNum(d.fields, 'odometerKm', milesToKm(num(v))),
  VehicleSpeed: (v, d) => assignNum(d.fields, 'speedKph', milesToKm(num(v))),
  InsideTemp: (v, d) => assignNum(d.fields, 'insideTempC', num(v)),
  OutsideTemp: (v, d) => assignNum(d.fields, 'outsideTempC', num(v)),

  // Staged, not assigned: coalesced in `finish`.
  ACChargingPower: (v, d) => stage(d, 'acPowerKw', num(v)),
  DCChargingPower: (v, d) => stage(d, 'dcPowerKw', num(v)),
  ACChargingEnergyIn: (v, d) => stage(d, 'acEnergyKwh', num(v)),
  DCChargingEnergyIn: (v, d) => stage(d, 'dcEnergyKwh', num(v)),

  ChargeState: (v, d) => stage(d, 'chargeStateBasic', chargeState(enumString(v))),
  DetailedChargeState: (v, d) => stage(d, 'chargeStateDetailed', chargeState(enumString(v))),

  Locked: (v, d) => {
    const b = bool(v)
    if (b === null) return false
    d.fields.locked = b
    return true
  },
  DoorState: (v, d) => {
    const open = anyDoorOpen(v)
    if (open === null) return false
    d.fields.doorsOpen = open
    return true
  },

  /**
   * Latitude and longitude live in a single value, and the pair is only
   * meaningful whole: a sample carrying a latitude with a null longitude would
   * be plotted at the prime meridian. Both land or neither does.
   */
  Location: (v, d) => {
    const loc = location(v)
    if (!loc) return false
    d.fields.lat = loc.lat
    d.fields.lon = loc.lon
    return true
  },

  // The four corners collapse into the single tpms JSONB record. Whichever
  // corners are readable land; the record stays null if none do.
  TpmsPressureFl: (v, d) => tyre(d, 'fl', num(v)),
  TpmsPressureFr: (v, d) => tyre(d, 'fr', num(v)),
  TpmsPressureRl: (v, d) => tyre(d, 'rl', num(v)),
  TpmsPressureRr: (v, d) => tyre(d, 'rr', num(v)),
}

/**
 * Normalise one decoded telemetry record.
 *
 * Returns `null` when the payload carries nothing mappable - an unparseable
 * body, an empty `data` array, only unknown keys, or only unreadable values.
 * Null rather than an all-null sample, because an all-null sample is not
 * "nothing happened": written to the sample table it would look like an
 * observation that the car reported no speed, no SOC and no charge state.
 */
export function normaliseTeslaMessage(raw: RawMessage): VehicleSample | null {
  const payload = asRecord(raw.payload)
  if (!payload) return null
  const data = payload['data']
  if (!Array.isArray(data)) return null

  const draft: Draft = {
    fields: {},
    acPowerKw: null,
    dcPowerKw: null,
    acEnergyKwh: null,
    dcEnergyKwh: null,
    chargeStateBasic: null,
    chargeStateDetailed: null,
    tpms: {},
  }

  let landed = 0
  for (const entry of data) {
    const e = asRecord(entry)
    const key = e?.['key']
    if (typeof key !== 'string') continue
    const apply = TESLA_FIELD_MAP[key]
    if (!apply) continue // unknown field: ignore, keep the rest of the message
    if (apply(e?.['value'], draft)) landed++
  }
  if (landed === 0) return null

  finish(draft)
  return makeSample({
    vehicleId: raw.vehicleId,
    ts: timestamp(payload['createdAt'], raw.receivedAt),
    ...draft.fields,
  })
}

/**
 * Connectivity records are a separate record type with no `data` array, so
 * `normaliseTeslaMessage` returns null for them. They are the only source of
 * sleep state, which the garage view and the ingest-stall alert both need.
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

/** Resolve everything that was staged rather than assigned directly. */
function finish(d: Draft): void {
  // AC and DC charging are mutually exclusive on a real car: the inactive one
  // reports 0 (or nothing at all). Coalescing on "greater magnitude" therefore
  // picks the active one when both are present, and still yields 0 - a true
  // reading - when the car is plugged in but not drawing. If neither field was
  // readable the result must stay null: a 0 here reads downstream as "charger
  // delivering nothing", which ends a charge session.
  d.fields.chargePowerKw = coalesceCharging(d.acPowerKw, d.dcPowerKw)
  d.fields.chargeEnergyAddedKwh = coalesceCharging(d.acEnergyKwh, d.dcEnergyKwh)

  // DetailedChargeState is the finer-grained of the two enums and wins when
  // both are present and both recognised.
  d.fields.chargeState = d.chargeStateDetailed ?? d.chargeStateBasic

  if (Object.keys(d.tpms).length > 0) d.fields.tpms = d.tpms
}

function coalesceCharging(ac: number | null, dc: number | null): number | null {
  if (ac === null) return dc
  if (dc === null) return ac
  return Math.abs(dc) > Math.abs(ac) ? dc : ac
}

function assignNum<K extends keyof SampleFields>(
  fields: SampleFields,
  key: K,
  value: number | null,
): boolean {
  if (value === null) return false
  ;(fields as Record<string, unknown>)[key as string] = value
  return true
}

function stage<K extends 'acPowerKw' | 'dcPowerKw' | 'acEnergyKwh' | 'dcEnergyKwh'>(
  d: Draft,
  key: K,
  value: number | null,
): boolean
function stage<K extends 'chargeStateBasic' | 'chargeStateDetailed'>(
  d: Draft,
  key: K,
  value: ChargeState | null,
): boolean
function stage(d: Draft, key: keyof Draft, value: unknown): boolean {
  if (value === null) return false
  ;(d as unknown as Record<string, unknown>)[key as string] = value
  return true
}

function tyre(d: Draft, corner: string, bar: number | null): boolean {
  if (bar === null) return false
  d.tpms[corner] = bar
  return true
}

/** Numeric wrapper arms, camelCase (protojson) and snake_case (some builds). */
const NUMERIC_KEYS = [
  'doubleValue',
  'double_value',
  'floatValue',
  'float_value',
  'intValue',
  'int_value',
  'longValue',
  'long_value',
  'uintValue',
  'uint_value',
] as const

/**
 * Read a number out of a typed value wrapper.
 *
 * Tolerates the bare-number form (untyped records), and the string form that
 * protojson uses for 64-bit ints. Rejects NaN/Infinity and the empty string,
 * both of which `Number()` would otherwise turn into a number-shaped lie: `0`
 * for `''` is exactly the absent-becomes-zero bug this module exists to avoid.
 */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const o = asRecord(v)
  if (!o || isInvalid(o)) return null
  for (const k of NUMERIC_KEYS) {
    const raw = o[k]
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      if (trimmed === '') return null
      const n = Number(trimmed)
      return Number.isFinite(n) ? n : null
    }
  }
  return null
}

/**
 * Read an enum-ish value: a `stringValue`, or one of the dedicated enum arms
 * (`chargingValue`, `detailedChargeStateValue`, ...). The arm name is not worth
 * enumerating - any string-valued single key is accepted and then validated by
 * the mapper, which rejects anything it does not know.
 */
function enumString(v: unknown): string | null {
  if (typeof v === 'string') return v
  const o = asRecord(v)
  if (!o || isInvalid(o)) return null
  for (const raw of Object.values(o)) {
    if (typeof raw === 'string') return raw
  }
  return null
}

function bool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v
  const o = asRecord(v)
  if (!o || isInvalid(o)) return null
  for (const k of ['booleanValue', 'boolean_value', 'boolValue', 'bool_value']) {
    const raw = o[k]
    if (typeof raw === 'boolean') return raw
    // Some firmware renders Locked as the string "true"/"false".
    if (raw === 'true') return true
    if (raw === 'false') return false
  }
  const s = o['stringValue'] ?? o['string_value']
  if (s === 'true') return true
  if (s === 'false') return false
  return null
}

function location(v: unknown): { lat: number; lon: number } | null {
  const o = asRecord(v)
  if (!o || isInvalid(o)) return null
  const loc = asRecord(o['locationValue'] ?? o['location_value']) ?? o
  const lat = num(loc['latitude'])
  const lon = num(loc['longitude'])
  // Both or neither: half a fix is worse than none, because it plots.
  if (lat === null || lon === null) return null
  return { lat, lon }
}

/**
 * Tesla enum -> our `ChargeState`.
 *
 * Both the plain form ("Charging") and the prefixed protobuf enum names
 * ("ChargeStateCharging", "DetailedChargeStateCharging") appear depending on
 * how the record was marshalled, so the prefix is stripped before matching.
 *
 * An unrecognised value maps to null, never to a guess. Charge state feeds
 * session segmentation directly: guessing "connected" for an unknown enum would
 * fabricate charge sessions, and guessing "disconnected" would truncate real
 * ones. Null just means "this record says nothing about charging", which the
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
 * `doorValue` is a struct of per-door booleans. Absent or unreadable gives null
 * rather than false, because "no door reported" is not "all doors shut" - a
 * false here would show a locked-up car as secure when we simply do not know.
 */
function anyDoorOpen(v: unknown): boolean | null {
  const o = asRecord(v)
  if (!o || isInvalid(o)) return null
  const doors = asRecord(o['doorValue'] ?? o['door_value'])
  if (!doors) return null
  const flags = Object.values(doors).filter((x) => typeof x === 'boolean')
  if (flags.length === 0) return null
  return flags.some(Boolean)
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
 * Prefer the car's own `createdAt`; fall back to when we received the message.
 * An unparseable date must fall back too - an Invalid Date would propagate into
 * a NULL timestamp on insert and lose the sample entirely.
 */
function timestamp(createdAt: unknown, receivedAt: Date): Date {
  if (typeof createdAt === 'string' || typeof createdAt === 'number') {
    const d = new Date(createdAt)
    if (!Number.isNaN(d.getTime())) return d
  }
  return receivedAt
}

/**
 * The `invalid` arm is Fleet Telemetry's explicit "this reading is unavailable".
 * It must read as absent, not as a value.
 *
 * This guard is not redundant with the extractors' shape checks: protobuf JSON
 * happily renders the sibling arm's zero default alongside the flag, so an
 * unavailable speed can arrive as `{ "invalid": true, "doubleValue": 0 }`. Read
 * naively that is a parked car - exactly the absent-becomes-zero failure this
 * module exists to prevent - so the flag is checked before any arm is read.
 */
function isInvalid(o: Record<string, unknown>): boolean {
  return o['invalid'] === true || o['invalidValue'] === true || o['invalid_value'] === true
}

/**
 * Accepts the raw MQTT string body as well as an already-parsed object, and
 * never throws on malformed JSON: a single corrupt message must not take down
 * the ingest loop.
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
