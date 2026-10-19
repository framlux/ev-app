/**
 * Rivian GraphQL frames -> the slots the ingest accumulator holds, and the
 * accumulated slots -> the canonical `VehicleSample` (design §7).
 *
 * It is the Rivian counterpart to `packages/tesla/src/normalise.ts` and keeps
 * that file's two-step shape for the same reason: a frame is a FRAGMENT. A
 * `vehicleState` push names only the properties that changed (an unchanged one
 * arrives as null, design §2.3), so a frame cannot produce a sample without
 * inventing the rest of it, and an invented rest is the null-becomes-zero bug
 * this codebase is built to avoid. `decodeRivian` therefore turns a frame into
 * slot values, the accumulator in `apps/ingest` merges them over time, and
 * `rivianStateToSample` turns whatever has accumulated into a row.
 *
 * ABSENT MUST NEVER BECOME ZERO. Every decoder here returns nothing for a value
 * it cannot vouch for, and "nothing" means the slot is not written at all, so
 * the accumulator carries the previous value. That covers a null, the three
 * placeholders Rivian sends in place of a value (`fault`, `signal_not_available`
 * and `undefined`, design §2.5), a string that is not a number, a number that is
 * not finite, and a word outside the documented vocabulary. A speed of 0 is a
 * claim that the car is stationary; it is only ever written for a speed the car
 * actually reported.
 *
 * ONE ABSENCE IS DELIBERATELY NOT "NOTHING": a gear the decoder cannot name,
 * placeholders included, is an explicit null `gear`, so that it overwrites a
 * carried D instead of letting it hold a drive open (design §7.5).
 *
 * A WRONG TYPE MUST NEVER BECOME A BIND ERROR EITHER. `insertSample` binds every
 * column in one statement inside the ingest transaction, so a value its column
 * rejects (a float4 overflow or underflow, a NUL in a TEXT) rolls the transaction back, is
 * never acked, and is redelivered for ever: a permanent stall and not a hole in
 * one series. The `REAL` columns therefore refuse what float4 cannot hold, the
 * text slots refuse a NUL, and `rivianStateToSample` reads each slot by its
 * runtime type rather than trusting the `Record<string, unknown>` it is handed.
 *
 * OLD VALUES MUST LOOK OLD (design §6.4). A subscribe re-sends the car's current
 * values, which may be hours old, and a frame says nothing of its own about
 * that. Stamped with arrival, a parked car's last non-zero speed would hold a
 * drive open for good, and a `charging_active` from before the car dropped off
 * would hold a charge open for days. So each property's own `timeStamp` becomes
 * `observedAt[slot]`, clamped to the frame's arrival (a clock ahead of ours must
 * not make a value look fresher than its frame), and a property already older
 * than its slot's window is not applied at all: it would expire at the next
 * emit, and applying it would briefly resurrect it.
 *
 * VALUES WITH NO TIME OF THEIR OWN ARE THE OTHER HALF OF THAT. `cloudConnection`
 * and the two flat streams have no `timeStamp`, so they are stamped with arrival,
 * and an arrival stamp is strictly newer on every per-minute snapshot: an
 * UNCHANGED `isOnline` or charge power would look like news each time, schedule a
 * carried-state sample, and hold a session open. `arrivalStamped` names those
 * slots so the accumulator can compare them by value (design §7.6).
 *
 * UNITS. Two Rivian properties are not in our units. `vehicleMileage` is metres
 * and `gnssSpeed` is metres per second, so the slots that hold the converted
 * values carry the real unit in their names (`odometerKm`, `speedKph`), as the
 * columns do. `timeToEndOfCharge` is minutes and the column is hours. Everything
 * else (percentages, kilometres, bar, kWh, degrees Celsius) is already ours.
 * Every value is R1-derived (design §2.5) and a hypothesis for the R2 until the
 * tape confirms it (§8.4).
 */

import {
  makeSample,
  type ChargeState,
  type Gear,
  type PowerState,
  type VehicleSample,
} from '@ev/core'
import { readRivianEnvelope } from './envelope.js'
import { rivianGear } from './gear.js'

/**
 * The slots with a name of their own. Every other slot is a lock or closure,
 * keyed by its property name (`LOCK_PROPERTIES` / `CLOSED_PROPERTIES`) and
 * collapsed into one boolean at build time.
 *
 * Split out of `RivianFieldState` because that interface needs an index
 * signature for those ten-plus-ten keys, and an index signature makes
 * `keyof RivianFieldState` plain `string`: a list typed against it would accept
 * any spelling. Typed against THIS interface, a misspelt slot fails to compile.
 */
export interface RivianNamedSlots {
  socPct: number | null
  rangeKm: number | null
  odometerKm: number | null
  lat: number | null
  lon: number | null
  speedKph: number | null
  gpsHeading: number | null
  /** The `powerState` word, collapsed with `cloudOnline` into `power_state`. */
  powerStateRaw: string | null
  cloudOnline: boolean | null
  /** `chargerState` and `chargerStatus` collapse into `charge_state`. */
  chargerState: string | null
  chargerStatus: string | null
  insideTempC: number | null
  /** The four corners collapse into the `tpms` record. */
  tpmsFl: number | null
  tpmsFr: number | null
  tpmsRl: number | null
  tpmsRr: number | null
  gear: Gear | null
  chargeLimitSoc: number | null
  nominalFullPackEnergyKwh: number | null
  timeToFullChargeHours: number | null
  version: string | null
  chargePowerKw: number | null
  chargeEnergyAddedKwh: number | null
}

/** A slot with a name of its own, for lists that must not accept a misspelling. */
export type RivianNamedSlot = keyof RivianNamedSlots

/**
 * The accumulated latest-known value of every slot Rivian can fill.
 *
 * Deliberately not a `VehicleSample`: the lock and closure properties, the tyre
 * corners, and the power and charge enums each arrive as several independent
 * slots and collapse into one column in `rivianStateToSample`, which is the only
 * place that can see them together. Every other slot is its column.
 */
export interface RivianFieldState extends RivianNamedSlots {
  /** `LOCK_PROPERTIES` / `CLOSED_PROPERTIES` keys hold 'locked'|'unlocked'|'open'|'closed'. */
  [lockOrClosed: string]: unknown
}

/**
 * The ten lock properties, the first four being the doors and the rest the
 * closures a truck or SUV has beyond them. `locked` is true only if every one
 * that was reported says `locked` (design §7.2). Each is its own slot, named for
 * the property, because they arrive in separate frames and only the build can
 * judge them together.
 */
const LOCKS = [
  'doorFrontLeftLocked',
  'doorFrontRightLocked',
  'doorRearLeftLocked',
  'doorRearRightLocked',
  'closureFrunkLocked',
  'closureLiftgateLocked',
  'closureTailgateLocked',
  'closureTonneauLocked',
  'closureSideBinLeftLocked',
  'closureSideBinRightLocked',
] as const

/** The same ten closures, asked whether they are shut: the inputs to `doors_open`. */
const CLOSURES = [
  'doorFrontLeftClosed',
  'doorFrontRightClosed',
  'doorRearLeftClosed',
  'doorRearRightClosed',
  'closureFrunkClosed',
  'closureLiftgateClosed',
  'closureTailgateClosed',
  'closureTonneauClosed',
  'closureSideBinLeftClosed',
  'closureSideBinRightClosed',
] as const

export const LOCK_PROPERTIES: readonly string[] = LOCKS
export const CLOSED_PROPERTIES: readonly string[] = CLOSURES

/**
 * The slots whose value is only true for a moment, so they get the short stale
 * window (design §7.6): a car's speed and heading, and the power it draws while
 * charging. Everything else, `lat`, `lon` and `gear` included, is held for the
 * long one, for the reasons `CARRIED_DRIVE_FIELDS` gives in the segmenter.
 *
 * Typed against `RivianNamedSlot` so that a misspelling is a compile error, not
 * a slot that silently gets the six-hour window and carries a stale speed.
 */
const VOLATILE = [
  'speedKph',
  'gpsHeading',
  'chargePowerKw',
] as const satisfies readonly RivianNamedSlot[]

/**
 * The slots a charge's state lives in, and the signs that one is going on
 * (design §7.4). The accumulator refreshes the state while positive power or a
 * rising energy counter says energy is flowing, so a steady charge that reports
 * its state once is not read as paused when the six-hour window runs out.
 */
const CHARGE_STATE = [
  'chargerState',
  'chargerStatus',
] as const satisfies readonly RivianNamedSlot[]
const CHARGING_POWER = ['chargePowerKw'] as const satisfies readonly RivianNamedSlot[]
const CHARGING_ENERGY = ['chargeEnergyAddedKwh'] as const satisfies readonly RivianNamedSlot[]

/**
 * Exported as lists of NAMED slots, not of strings. A `string[]` is what the
 * profile consumes, and a named-slot list is assignable to it, so nothing is
 * lost; but the narrower type is what the exported declarations are held to, so
 * a non-slot added to one of them stops compiling at the declaration itself,
 * even if the `satisfies` above were ever deleted. `typecheck` compiles the
 * tests, and `normalise.test.ts` pins that the exports keep this type.
 */
export const RIVIAN_VOLATILE_SLOTS: readonly RivianNamedSlot[] = VOLATILE
export const RIVIAN_CHARGE_STATE_SLOTS: readonly RivianNamedSlot[] = CHARGE_STATE
export const RIVIAN_CHARGING_POWER_SLOTS: readonly RivianNamedSlot[] = CHARGING_POWER
export const RIVIAN_CHARGING_ENERGY_SLOTS: readonly RivianNamedSlot[] = CHARGING_ENERGY

/**
 * Below this, GPS speed is noise (design §7.2). A receiver reports a few tenths
 * of a metre per second for a car that is not moving at all, and read as speed
 * that jitter opens phantom drives and splits charges. At or above it, the
 * reading is the reading.
 */
export const GPS_SPEED_NOISE_FLOOR_MS = 0.5

/** m/s to km/h. Exact: an hour is 3600 seconds and a kilometre is 1000 metres. */
const MS_TO_KPH = 3.6

/**
 * What one frame contributes: slot values, when the vehicle observed each, and
 * how many of the properties behind them had no usable timestamp. The shape
 * `apps/ingest` calls `Decoded`; it is repeated here because `@ev/rivian` may
 * not import an app.
 */
export interface RivianDecoded {
  slots: Record<string, unknown>
  /** Slot -> epoch ms. A slot with no key here is stamped with the frame's arrival. */
  observedAt: Record<string, number>
  /**
   * The slots whose `observedAt` above is the frame's arrival because Rivian
   * gave no observation time to read (`cloudConnection`, and both flat streams),
   * as against one the car stamped. An arrival stamp is strictly newer on every
   * snapshot, so the accumulator's newer-wins comparison cannot tell an
   * unchanged value from news; this is what lets it (design §7.6). Not the
   * untimed properties: those have no `observedAt` key at all and are counted.
   */
  arrivalStamped: ReadonlySet<string>
  /** Properties whose own `timeStamp` was missing or unparseable (design §6.4). */
  untimed: number
}

/**
 * Rivian's stand-ins for a value (design §2.5). Any property can carry one, and
 * none is a reading: carried as a string into a numeric decoder each fails, but
 * a TEXT slot would happily take one for a word, so they are screened out first
 * and the property contributes nothing (§7.1), its previous value carrying.
 *
 * The one exception is `gearStatus`, which does not use this screen: a gear we
 * cannot name, a placeholder included, is an explicit null gear (§7.5).
 */
const PLACEHOLDERS: ReadonlySet<string> = new Set(['fault', 'signal_not_available', 'undefined'])

/** One slot -> value map, an explicit null being a value ("the car says unknown"). */
type Update = Record<string, unknown>

/**
 * How one `vehicleState` property is read.
 *
 * `read` gets the property object (`{timeStamp, value}`, or the structured
 * shapes the catalogue names) and returns the slots it fills, or null for
 * nothing. `timed` is false for the one property that has no `timeStamp`.
 */
interface Property {
  readonly timed: boolean
  read(prop: Record<string, unknown>): Update | null
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

/**
 * An own property that is an object, or null. `hasOwn` keeps a key like
 * `constructor` a name and not a function.
 */
function child(
  parent: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  return parent !== null && Object.hasOwn(parent, key) ? asRecord(parent[key]) : null
}

/**
 * Read a number from a frame.
 *
 * Accepts the bare number and the numeric string, because a field's JSON type
 * can change between vehicle software versions. Rejects NaN, Infinity, `''` and
 * any non-numeric string: `Number('')` is 0, and a 0 that means "unreadable" is
 * the absent-becomes-zero bug this module exists to prevent. Booleans are
 * rejected too, since `Number(false)` is 0.
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

/**
 * Postgres `REAL` is float4, and it refuses BOTH ends of its range rather than
 * saturating: '1e39'::real raises "out of range" on overflow, and so does
 * '1e-50'::real on underflow. Either takes the ingest transaction with it, so
 * the message is never acked and is redelivered for ever. A `DOUBLE PRECISION`
 * column spans everything `Number.isFinite` admits, so only the `REAL` ones are
 * checked.
 *
 * `Math.fround` is the float4 rounding Postgres applies, so it is the check
 * itself and not an approximation of one: a value that rounds to infinity
 * overflows, and a non-zero value that rounds to zero underflows. A denormal
 * (1e-40) rounds to a non-zero float4 and Postgres accepts it, and so do we; a
 * genuine zero is a reading and is kept.
 */
function fitsReal(n: number | null): number | null {
  if (n === null) return null
  const f = Math.fround(n)
  return Number.isFinite(f) && (f !== 0 || n === 0) ? n : null
}

/** A number for a `REAL` column. */
const real = (v: unknown): number | null => fitsReal(num(v))

/** A number for a `DOUBLE PRECISION` column. */
const double = num

/**
 * A word: a non-blank string with no NUL. A NUL is not storable in a Postgres
 * text column (the parameter is rejected, the same wedge as an overflow), and
 * nothing the car legitimately sends contains one.
 */
function word(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' && !v.includes('\u0000') ? v : null
}

/**
 * Metres to kilometres. Checked after converting, like the other REAL columns:
 * a `DOUBLE PRECISION` odometer cannot overflow, so there is nothing more to do.
 */
const metresToKm = (v: unknown): number | null => {
  const n = num(v)
  return n === null ? null : n / 1000
}

/**
 * GPS speed in m/s -> kph, with the noise floor applied (design §7.2).
 *
 * A negative speed is refused outright. A speed is a magnitude, so a negative
 * one is a value we cannot vouch for, and folding it into the noise floor would
 * turn garbage into a claim that the car is stationary. The conversion comes
 * before the `REAL` check: 3e38 m/s is under float4 and its kph is not.
 */
function gpsSpeedKph(v: unknown): number | null {
  const ms = num(v)
  if (ms === null || ms < 0) return null
  return fitsReal(ms < GPS_SPEED_NOISE_FLOOR_MS ? 0 : ms * MS_TO_KPH)
}

/** Minutes to hours, for the charge-time estimate. */
function minutesToHours(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : fitsReal(n / 60)
}

/** A word from a closed vocabulary, matched exactly. A word outside it is not guessed at. */
function oneOf(...allowed: readonly string[]): (v: unknown) => string | null {
  const set: ReadonlySet<string> = new Set(allowed)
  return (v) => (typeof v === 'string' && set.has(v) ? v : null)
}

/**
 * The value of a `timeStamp`/`value` property, or `undefined` when it says
 * nothing: a null or absent value, or a placeholder (design §7.1). Everything
 * downstream may then assume it holds a real attempt at a reading.
 */
function sayable(prop: Record<string, unknown>): unknown {
  const value = prop['value']
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string' && PLACEHOLDERS.has(value)) return undefined
  return value
}

/** The slots a single-slot property may fill: a named one, or a lock or closure. */
type ScalarSlot = RivianNamedSlot | (typeof LOCKS)[number] | (typeof CLOSURES)[number]

/**
 * A property that fills one slot. `decode` returns null for a value it cannot
 * vouch for, and null means the slot is not written, which is what keeps an
 * unreadable value from overwriting a good earlier one.
 */
function scalar(slot: ScalarSlot, decode: (v: unknown) => unknown): Property {
  return {
    timed: true,
    read(prop) {
      const value = sayable(prop)
      if (value === undefined) return null
      const decoded = decode(value)
      return decoded === null ? null : { [slot]: decoded }
    },
  }
}

/**
 * `gnssLocation`: `{timeStamp, latitude, longitude, isAuthorized}`, a struct and
 * not a `value`. The pair is only meaningful whole (a latitude with a null
 * longitude would be plotted on the prime meridian), so both land or neither.
 */
const location: Property = {
  timed: true,
  read(prop) {
    const lat = double(prop['latitude'])
    const lon = double(prop['longitude'])
    if (lat === null || lon === null) return null
    return { lat, lon } satisfies Partial<RivianNamedSlots>
  },
}

/**
 * `powerState`: the raw word is kept for `power_state` (design §7.3), and a car
 * that is asleep or on standby is also in Park (design §7.5).
 *
 * The second half is what stops a car that powers down without reporting P from
 * carrying its last D for six hours, the bug 71aa244 fixed for Tesla's null
 * gear. `go`, `ready` and `vehicle_reset` say nothing about the selector, so
 * they leave gear alone.
 */
const powerState: Property = {
  timed: true,
  read(prop) {
    const value = sayable(prop)
    const raw = word(value)
    if (raw === null) return null
    if (raw === 'sleep' || raw === 'standby') {
      return { powerStateRaw: raw, gear: 'P' } satisfies Partial<RivianNamedSlots>
    }
    return { powerStateRaw: raw } satisfies Partial<RivianNamedSlots>
  },
}

/**
 * `gearStatus`. Any string we cannot name is an EXPLICIT null gear, not nothing
 * (design §7.5, "anything else is an explicit null"): an explicit null
 * overwrites an earlier D, where nothing would carry the D forward and hold a
 * drive open, the bug 71aa244 fixed for Tesla. `rivianGear` makes the three-way
 * call, and a non-string (a null, an absent value, a number) writes nothing.
 *
 * This INCLUDES the placeholders. `fault` and `signal_not_available` on the
 * selector are the Rivian analogue of Tesla's `ShiftStateSNA`: the drive system
 * has stopped vouching for its gear, which is when it is powering down, and
 * carrying the last D through that is how a parked car reads as one waiting in
 * gear. So `gearStatus` does not go through `sayable`, whose placeholder screen
 * would make `signal_not_available` carry the previous gear instead of clearing
 * it. Every other property takes that screen (design §7.1).
 */
const gearStatus: Property = {
  timed: true,
  read(prop) {
    const gear = rivianGear(prop['value'])
    return gear === undefined ? null : ({ gear } satisfies Partial<RivianNamedSlots>)
  },
}

/**
 * `cloudConnection`: `{isOnline, lastSync}`. It has NO `timeStamp` (`lastSync`
 * is when the car last talked, not when this was observed), so the frame's
 * arrival is its observation time and it is not counted as untimed.
 *
 * `lastSync` is not used as the observation time, though it looks like one: it
 * is old for a car that is offline, and stamping `isOnline: false` with it would
 * date the car's going offline hours back and then drop it as too old to apply.
 * The cost of arrival is that an unchanged `isOnline` re-sent by a snapshot
 * looks newer each time; the decoder reports the slot as arrival-stamped so the
 * accumulator can treat that as a refresh and not as news.
 */
const cloudConnection: Property = {
  timed: false,
  read(prop) {
    const online = prop['isOnline']
    if (typeof online !== 'boolean') return null
    return { cloudOnline: online } satisfies Partial<RivianNamedSlots>
  },
}

/**
 * The properties we read, in the order we read them, which is not cosmetic:
 * `powerState` and `gearStatus` both write `gear`, and when one frame carries
 * both with the same observation time the LATER ENTRY here wins (see
 * `Collector.put`). The car's own gear report outranks the one inferred from its
 * power state, so `gearStatus` follows `powerState`.
 *
 * Anything not named here is skipped: it is on the tape, and the connector's
 * discovery (design §5.6) may subscribe to properties this table has never
 * heard of. Names are checked against the catalogue by a test, because a
 * property decoded here and not subscribed would never arrive.
 */
const PROPERTIES: ReadonlyMap<string, Property> = new Map<string, Property>([
  ['batteryLevel', scalar('socPct', real)],
  ['distanceToEmpty', scalar('rangeKm', real)],
  ['vehicleMileage', scalar('odometerKm', metresToKm)],
  ['gnssLocation', location],
  ['gnssSpeed', scalar('speedKph', gpsSpeedKph)],
  ['gnssBearing', scalar('gpsHeading', real)],
  ['powerState', powerState],
  ['cloudConnection', cloudConnection],
  ['chargerState', scalar('chargerState', word)],
  ['chargerStatus', scalar('chargerStatus', word)],
  ['cabinClimateInteriorTemperature', scalar('insideTempC', real)],
  ['tirePressureFrontLeft', scalar('tpmsFl', num)],
  ['tirePressureFrontRight', scalar('tpmsFr', num)],
  ['tirePressureRearLeft', scalar('tpmsRl', num)],
  ['tirePressureRearRight', scalar('tpmsRr', num)],
  ['gearStatus', gearStatus],
  ['batteryLimit', scalar('chargeLimitSoc', real)],
  ['batteryCapacity', scalar('nominalFullPackEnergyKwh', real)],
  ['timeToEndOfCharge', scalar('timeToFullChargeHours', minutesToHours)],
  ['otaCurrentVersion', scalar('version', word)],
  ...LOCKS.map((name): [string, Property] => [name, scalar(name, oneOf('locked', 'unlocked'))]),
  ...CLOSURES.map((name): [string, Property] => [name, scalar(name, oneOf('open', 'closed'))]),
])

/** The `vehicleState` names this module reads, for the test that pins them to the catalogue. */
export const RIVIAN_DECODED_PROPERTIES: readonly string[] = [...PROPERTIES.keys()]

/** A slot's value so far, with the observation it was read at and its rank against rivals. */
interface Candidate {
  value: unknown
  observed: number | undefined
  /** `observed` was the frame's arrival, made up here, and not a time the car gave. */
  arrival: boolean
  rank: number
}

/**
 * Gathers one frame's slots, and settles the one conflict a single frame can
 * hold: two properties writing the same slot.
 *
 * The accumulator resolves a conflict between FRAMES (newer observation wins),
 * but a frame's `slots` is a single record, so two writers in one frame cannot
 * both reach it. That happens: a re-sent snapshot carries `powerState` and
 * `gearStatus` together, and both write `gear`. The newer observation wins here
 * too. An untimed property counts as the frame's arrival, the newest moment
 * there is, which is what the accumulator does with it.
 */
class Collector {
  private readonly winners = new Map<string, Candidate>()
  untimed = 0

  constructor(private readonly receivedMs: number) {}

  /**
   * `arrival` says `observed` is the frame's arrival and not the car's own time,
   * so the slot is reported in `arrivalStamped`. Whichever candidate wins a slot
   * brings its flag with it.
   */
  put(update: Update, observed: number | undefined, arrival = false): void {
    const rank = observed ?? this.receivedMs
    for (const [slot, value] of Object.entries(update)) {
      const held = this.winners.get(slot)
      // `>=`: on a tie the later table entry wins.
      if (held === undefined || rank >= held.rank) {
        this.winners.set(slot, { value, observed, arrival, rank })
      }
    }
  }

  result(): RivianDecoded {
    const slots: Record<string, unknown> = {}
    const observedAt: Record<string, number> = {}
    const arrivalStamped = new Set<string>()
    for (const [slot, { value, observed, arrival }] of this.winners) {
      slots[slot] = value
      if (observed !== undefined) observedAt[slot] = observed
      if (arrival) arrivalStamped.add(slot)
    }
    return { slots, observedAt, arrivalStamped, untimed: this.untimed }
  }
}

/**
 * Walk `body.data.vehicleState` (design §7.1).
 *
 * Per property: read it, then date it. A property that reads as nothing is not
 * dated at all, so it is never counted as untimed. A property with a
 * `timeStamp` is observed at that time, clamped to the frame's arrival, and
 * skipped if it is already as old as the window of any slot it fills: whole or
 * not at all, because half of a location is worse than none. One with no
 * usable `timeStamp` falls back to arrival (no `observedAt` key) and is counted.
 */
function decodeVehicleState(
  group: Record<string, unknown>,
  receivedMs: number,
  staleWindowFor: (slot: string) => number,
): RivianDecoded {
  const out = new Collector(receivedMs)
  for (const [name, property] of PROPERTIES) {
    if (!Object.hasOwn(group, name)) continue
    const prop = asRecord(group[name])
    // Absent, or null: unchanged, per design §2.3.
    if (prop === null) continue
    const update = property.read(prop)
    if (update === null) continue
    const slots = Object.keys(update)
    if (slots.length === 0) continue

    if (!property.timed) {
      // Observed when it arrived: a stamp, so the accumulator's newer-wins guard
      // covers it, but never old. Flagged as arrival-stamped, because that guard
      // is all a stamp like this one buys: every snapshot's arrival is strictly
      // newer than the last, so the guard cannot tell an unchanged value from
      // news, and the accumulator has to be told which slots to compare by value.
      out.put(update, receivedMs, true)
      continue
    }
    const stamp = prop['timeStamp']
    const parsed = typeof stamp === 'string' ? Date.parse(stamp) : Number.NaN
    if (Number.isNaN(parsed)) {
      out.untimed++
      out.put(update, undefined)
      continue
    }
    const observed = Math.min(parsed, receivedMs)
    const age = receivedMs - observed
    if (slots.some((slot) => age >= staleWindowFor(slot))) continue
    out.put(update, observed)
  }
  return out.result()
}

/** `[key in the frame, slot it fills, decoder]`. */
type FlatField = readonly [key: string, slot: RivianNamedSlot, decode: (v: unknown) => unknown]

/**
 * A flat object's fields -> slots, for the two streams that are not
 * `vehicleState`. Neither has per-field timestamps, so the frame's arrival is
 * each value's observation time (design §6.4). Stamping it matters: a subscribe
 * snapshot of `vehicleState` can re-send an older `chargerState` than the
 * charging stream just reported, and only values with an observation time
 * compete in the accumulator's newer-wins guard.
 *
 * Every slot read here is reported as arrival-stamped. The same stamp that lets
 * the guard work makes a re-sent, unchanged value look newer than the one held,
 * so a resubscribe's snapshot of the charging session would land every minute;
 * flagging them is what lets the accumulator treat an unchanged one as a
 * refresh and not as news (design §7.6).
 */
function decodeFlat(
  source: Record<string, unknown>,
  fields: readonly FlatField[],
  receivedMs: number,
): RivianDecoded {
  const out = new Collector(receivedMs)
  for (const [key, slot, decode] of fields) {
    if (!Object.hasOwn(source, key)) continue
    const value = source[key]
    if (value === null || value === undefined) continue
    if (typeof value === 'string' && PLACEHOLDERS.has(value)) continue
    const decoded = decode(value)
    if (decoded !== null) out.put({ [slot]: decoded }, receivedMs, true)
  }
  return out.result()
}

const LIVE_DATA_FIELDS = [
  ['powerKW', 'chargePowerKw', real],
  // Assumed kWh, this session, and unverified (design §2.5).
  ['totalChargedEnergy', 'chargeEnergyAddedKwh', real],
  ['vehicleChargerState', 'chargerState', word],
] as const satisfies readonly FlatField[]

/**
 * Read one envelope body into slots, or null if it contributes nothing to read.
 *
 * `receivedAt` is the frame's arrival on the connector's clock, which the
 * caller has already settled (design §6.2), and `staleWindowFor` is the
 * profile's own, passed in so that the window a value is judged by here is the
 * very one the accumulator will later apply.
 *
 * Null means "not mapped": any stream but `state`, `charging` and `cloud`, an
 * unknown envelope version, or a body with nowhere to look (an errors-only
 * frame, a null `chargingSession` because no session is running). An empty
 * fragment is NOT null: it is a readable frame whose properties we do not
 * decode, or decoded to nothing.
 */
export function decodeRivian(
  payload: unknown,
  receivedAt: Date,
  staleWindowFor: (slot: string) => number,
): RivianDecoded | null {
  const env = readRivianEnvelope(payload)
  if (env === null) return null
  const receivedMs = receivedAt.getTime()
  const data = child(asRecord(env.body), 'data')
  switch (env.stream) {
    case 'state': {
      const group = child(data, 'vehicleState')
      return group === null ? null : decodeVehicleState(group, receivedMs, staleWindowFor)
    }
    case 'charging': {
      const live = child(child(data, 'chargingSession'), 'liveData')
      return live === null ? null : decodeFlat(live, LIVE_DATA_FIELDS, receivedMs)
    }
    case 'cloud': {
      const connection = child(data, 'vehicleCloudConnection')
      if (connection === null) return null
      return decodeFlat(connection, [['isOnline', 'cloudOnline', asBoolean]], receivedMs)
    }
    default:
      return null
  }
}

function asBoolean(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}

/** `powerState` words -> ours. A Map, so `constructor` is an unknown word and not a function. */
const POWER_STATES: ReadonlyMap<string, PowerState> = new Map<string, PowerState>([
  ['sleep', 'asleep'],
  ['standby', 'online'],
  ['ready', 'online'],
  ['go', 'online'],
  ['vehicle_reset', 'online'],
])

/**
 * `power_state` (design §7.3). Offline wins: a car the cloud has lost has a last
 * power state that is stale by definition. An unknown word is null, never a
 * guess, because power state decides whether the segmenter may trust the rest.
 */
function powerStateOf(state: Record<string, unknown>): PowerState | null {
  if (state['cloudOnline'] === false) return 'offline'
  const raw = state['powerStateRaw']
  return typeof raw === 'string' ? (POWER_STATES.get(raw) ?? null) : null
}

/**
 * `charge_state` from the two charger slots (design §7.3, every row of its
 * table). `not_connected` wins over everything, because a charger that is not
 * plugged in is not charging whatever a stale state says.
 *
 * `charging_connecting` is NOT charging: no energy flows yet, and a session
 * opened on a handshake starts before the energy does. It reads as `connected`
 * if the status says the cable is in, and as null otherwise. A connected status
 * is evidence of a cable on its own, so the state need not be reported for it
 * to count. Anything else is null, with the raw words left on the tape: a guess
 * here would fabricate or truncate real charge sessions.
 */
function chargeStateOf(state: Record<string, unknown>): ChargeState | null {
  const status = typeof state['chargerStatus'] === 'string' ? state['chargerStatus'] : null
  const charger = typeof state['chargerState'] === 'string' ? state['chargerState'] : null
  if (status === 'chrgr_sts_not_connected') return 'disconnected'
  if (charger === 'charging_active') return 'charging'
  if (charger === 'charging_complete') return 'complete'
  if (status !== null && status.startsWith('chrgr_sts_connected')) return 'connected'
  return null
}

/**
 * `locked`: true only if every lock that was reported says `locked`, false if
 * any says `unlocked`, null if none was reported (design §7.2). "Unlocked" is a
 * claim, so it is never what an absent lock means.
 */
function lockedOf(state: Record<string, unknown>): boolean | null {
  let reported = false
  for (const name of LOCKS) {
    const v = state[name]
    if (v === 'unlocked') return false
    if (v === 'locked') reported = true
  }
  return reported ? true : null
}

/**
 * `doors_open`: true if any reported closure is open, false if all are closed,
 * null if none was reported.
 */
function doorsOpenOf(state: Record<string, unknown>): boolean | null {
  let reported = false
  for (const name of CLOSURES) {
    const v = state[name]
    if (v === 'open') return true
    if (v === 'closed') reported = true
  }
  return reported ? false : null
}

/** The corners that were reported, as the same JSONB shape Tesla's TPMS uses; null if none was. */
function tpmsOf(state: Record<string, unknown>): Record<string, number> | null {
  const out: Record<string, number> = {}
  const corners = [['fl', 'tpmsFl'], ['fr', 'tpmsFr'], ['rl', 'tpmsRl'], ['rr', 'tpmsRr']] as const
  for (const [corner, slot] of corners) {
    const v = numberOf(state[slot])
    if (v !== null) out[corner] = v
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * The slots are read by runtime type, not trusted. They come from the
 * accumulator as `Record<string, unknown>`, and a value of the wrong type is a
 * bind error that wedges ingest, so it reads as unreported instead.
 */
const numberOf = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null
const stringOf = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const gearOf = (v: unknown): Gear | null =>
  v === 'P' || v === 'R' || v === 'N' || v === 'D' ? v : null

/**
 * Build a `VehicleSample` from accumulated state.
 *
 * `ts` is supplied by the caller: it is the arrival of the newest frame, which
 * is the only clock the accumulator has (the observation times only decide how
 * long a value is carried).
 *
 * The direct columns are written out, not looped, so a misspelt column is a
 * compile error. The combined ones (`powerState`, `chargeState`, `locked`,
 * `doorsOpen`, `tpms`) are built from their several slots, and the Park speed
 * rule is applied last, over the finished speed.
 */
export function rivianStateToSample(
  vehicleId: string,
  ts: Date,
  state: Record<string, unknown>,
): VehicleSample {
  const gear = gearOf(state['gear'])
  const speedKph = numberOf(state['speedKph'])
  return makeSample({
    vehicleId,
    ts,
    socPct: numberOf(state['socPct']),
    rangeKm: numberOf(state['rangeKm']),
    odometerKm: numberOf(state['odometerKm']),
    lat: numberOf(state['lat']),
    lon: numberOf(state['lon']),
    gpsHeading: numberOf(state['gpsHeading']),
    insideTempC: numberOf(state['insideTempC']),
    chargeLimitSoc: numberOf(state['chargeLimitSoc']),
    nominalFullPackEnergyKwh: numberOf(state['nominalFullPackEnergyKwh']),
    timeToFullChargeHours: numberOf(state['timeToFullChargeHours']),
    version: stringOf(state['version']),
    chargePowerKw: numberOf(state['chargePowerKw']),
    chargeEnergyAddedKwh: numberOf(state['chargeEnergyAddedKwh']),
    gear,
    powerState: powerStateOf(state),
    chargeState: chargeStateOf(state),
    locked: lockedOf(state),
    doorsOpen: doorsOpenOf(state),
    tpms: tpmsOf(state),
    // GPS speed on a car in Park is noise (design §7.5). With the noise floor
    // above it keeps jitter from opening a phantom drive or splitting a charge.
    // Only a speed the car reported: a car in Park that said nothing about speed
    // has no speed, not a speed of zero.
    speedKph: gear === 'P' && speedKph !== null ? 0 : speedKph,
  })
}
