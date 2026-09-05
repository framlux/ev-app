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
 * ABSENT MUST NEVER BECOME ZERO. `VehicleSample` makes every field nullable
 * precisely so "the car did not say" stays distinguishable from "the car said
 * 0". A parser that defaulted to 0 would tell the segmenter the car is parked at
 * 0 kph drawing 0 kW, which silently ends drives and charges. Every decoder here
 * returns `null` for anything it cannot vouch for, and an unknown field name is
 * ignored rather than guessed at.
 *
 * TYPE DRIFT. Upstream warns that a field's JSON type can change between vehicle
 * software versions - the vehicle's speed may arrive as `12.3` in one build and
 * as `"12.3"` in another. So numbers accept both, while still refusing `''`,
 * `'abc'`, NaN and Infinity, each of which `Number()` would happily turn into a
 * number-shaped lie.
 *
 * UNITS. Tesla streams US customary units for distance regardless of the display
 * setting on the touchscreen: `VehicleSpeed` is mph, `Odometer` and `RatedRange`
 * are miles. Our model is kph/km, so those three are converted by MILES_TO_KM.
 * Everything else is already in our units: temperatures Celsius, charging power
 * kW, charging energy kWh, `Soc` a percentage, TPMS pressures bar.
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

/**
 * The accumulated latest-known value of every slot we can fill from Tesla.
 *
 * This is deliberately NOT a `VehicleSample`. Several Tesla fields collapse into
 * one canonical field (AC/DC power, AC/DC energy, the four TPMS corners, the two
 * charge-state enums), and since each arrives in its own MQTT message the
 * collapse cannot happen at decode time - it happens once, in
 * `teslaStateToSample`, over whatever has accumulated.
 *
 * Every slot is nullable and `null` means "never reported", which is what keeps
 * an unreported field null in the emitted sample instead of 0.
 */
export interface TeslaFieldState {
  socPct: number | null
  rangeKm: number | null
  odometerKm: number | null
  speedKph: number | null
  insideTempC: number | null
  outsideTempC: number | null
  lat: number | null
  lon: number | null
  locked: boolean | null
  doorsOpen: boolean | null
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
  /** From connectivity messages, not from a metric. */
  powerState: PowerState | null
}

/** What one decoded field contributes. Merged into a `TeslaFieldState`. */
export type TeslaFieldUpdate = Partial<TeslaFieldState>

/**
 * Tesla field name -> the slots it fills.
 *
 * A decoder returns `null` when the value is unreadable, which is what
 * distinguishes "the car published Soc" from "the car published a readable Soc".
 * Only a non-null return is allowed to change accumulated state, so an
 * unreadable message can never blank a good earlier reading.
 *
 * Field names absent from this map are ignored on purpose. That covers fields
 * Tesla has not shipped yet, and fields we stream but have nowhere to put
 * (`Gear`, `ChargeAmps` have no `VehicleSample` counterpart, so they are
 * dropped rather than forced somewhere).
 */
const FIELD_DECODERS: Record<string, (value: unknown) => TeslaFieldUpdate | null> = {
  Soc: (v) => one('socPct', num(v)),
  // Miles on the wire, km in the model.
  RatedRange: (v) => one('rangeKm', milesToKm(num(v))),
  Odometer: (v) => one('odometerKm', milesToKm(num(v))),
  VehicleSpeed: (v) => one('speedKph', milesToKm(num(v))),
  InsideTemp: (v) => one('insideTempC', num(v)),
  OutsideTemp: (v) => one('outsideTempC', num(v)),

  // Power is reported per rail and coalesced at build time. The rail that is
  // actually delivering is recorded here, while we can still see it, because
  // the energy counters cannot be told apart on their own.
  ACChargingPower: (v) => power('ac', num(v)),
  DCChargingPower: (v) => power('dc', num(v)),
  ACChargingEnergyIn: (v) => one('acEnergyKwh', num(v)),
  DCChargingEnergyIn: (v) => one('dcEnergyKwh', num(v)),

  ChargeState: (v) => one('chargeStateBasic', chargeState(str(v))),
  DetailedChargeState: (v) => one('chargeStateDetailed', chargeState(str(v))),

  Locked: (v) => one('locked', bool(v)),
  DoorState: (v) => one('doorsOpen', anyDoorOpen(v)),

  /**
   * Latitude and longitude arrive in ONE message, as a two-key object, and the
   * pair is only meaningful whole: a sample carrying a latitude with a null
   * longitude would be plotted on the prime meridian. Both land or neither does.
   */
  Location: (v) => {
    const o = asRecord(v)
    if (!o) return null
    const lat = num(o['latitude'])
    const lon = num(o['longitude'])
    if (lat === null || lon === null) return null
    return { lat, lon }
  },

  // The four corners arrive as four separate messages and collapse into the
  // single tpms JSONB record at build time. Whichever corners are known land;
  // the record stays null if none do.
  TpmsPressureFl: (v) => one('tpmsFl', num(v)),
  TpmsPressureFr: (v) => one('tpmsFr', num(v)),
  TpmsPressureRl: (v) => one('tpmsRl', num(v)),
  TpmsPressureRr: (v) => one('tpmsRr', num(v)),
}

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
 * Build a `VehicleSample` from accumulated state.
 *
 * `ts` is supplied by the caller because the metrics transport carries no
 * timestamp of its own: the only time we have is when the message arrived.
 */
export function teslaStateToSample(
  vehicleId: string,
  ts: Date,
  state: TeslaFieldUpdate,
): VehicleSample {
  const tpms = tpmsRecord(state)
  return makeSample({
    vehicleId,
    ts,
    socPct: state.socPct ?? null,
    rangeKm: state.rangeKm ?? null,
    odometerKm: state.odometerKm ?? null,
    speedKph: state.speedKph ?? null,
    insideTempC: state.insideTempC ?? null,
    outsideTempC: state.outsideTempC ?? null,
    lat: state.lat ?? null,
    lon: state.lon ?? null,
    locked: state.locked ?? null,
    doorsOpen: state.doorsOpen ?? null,
    tpms,
    powerState: state.powerState ?? null,
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

/** Enums arrive as their protobuf `.String()` name, i.e. a bare JSON string. */
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
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
 * `DoorState` is the one struct-valued field besides Location: a set of per-door
 * booleans. Absent or unreadable gives null rather than false, because "no door
 * reported" is not "all doors shut" - a false would show a car we know nothing
 * about as secure.
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
