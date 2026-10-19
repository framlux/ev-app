import type { RawMessage } from '@ev/core'
import {
  TESLA_FIELDS,
  decodeTeslaConnectivity,
  decodeTeslaField,
  slotsOf,
  teslaStateToSample,
  type TeslaFieldState,
  type TeslaFieldUpdate,
} from '@ev/tesla'
import type { VendorProfile } from '../profile.js'
import { STALE_VALUE_MS, VOLATILE_STALE_MS } from '../timing.js'

/**
 * Tesla's side of the worker, one of the two places (with `deps.ts`) that names
 * `@ev/tesla` - the import boundary `test/boundaries.test.ts` enforces. The
 * constants below used to sit in `pipeline.ts`, hard-coded into the accumulator;
 * they are moved here whole, with the reasoning that produced them, because
 * every one of them is a fact about THIS car's telemetry and not about
 * accumulating fragments.
 */

export type RecordKind = 'metrics' | 'alert' | 'error' | 'connectivity'

/**
 * One fleet-telemetry MQTT message, as it is written to the tape.
 *
 * The transport publishes ONE FIELD PER MESSAGE and puts the field name in the
 * topic, not in the body, so the body alone is meaningless: `72.5` could be a
 * state of charge or an inside temperature. `mqtt.ts` therefore folds the topic
 * into this envelope before the message is stored, which is what keeps
 * `raw_message` replayable - `reprocess` sees exactly what the handler saw.
 */
export interface TeslaEnvelope {
  kind: RecordKind
  vin: string
  /** Metrics: the Tesla field name. Alerts/errors: the alert or error name. */
  field: string | null
  /** The decoded JSON body: a number, string, boolean, object, or null. */
  value: unknown
}

/**
 * Drive-tier fields whose last value is still true in Park, so they are carried
 * like levels despite their tier.
 *
 * `Location` and `Gear` are on the drive tier because they are asked for often
 * while moving, not because they decay: a parked car is still where it parked,
 * and a car left in P stays in P. Expiring either would write a null over a
 * fact - the position column would blank mid-drive whenever GPS went quiet for
 * five minutes, which is a gap in the route rather than an absence of one.
 */
const CARRIED_DRIVE_FIELDS: ReadonlySet<string> = new Set(['Location', 'Gear'])

/**
 * Slots that are volatile for a reason the tier does not express.
 *
 * `speedKph` is also drive-tier, and is repeated here because it is the one
 * that matters most: the segmenter reads a null speed as 'unknown' motion,
 * which does NOT start the parked clock, so a stale non-zero speed is what
 * wedges a drive open. The two charge rails are the same argument for charge
 * sessions - a carried non-zero power holds a session open against a car that
 * has been unplugged - and they are charge-tier, so nothing below would pick
 * them up.
 *
 * `satisfies keyof TeslaFieldState` is the load-bearing part: this list is the
 * hand-written half of the set, and it is exactly where the bug lived.
 * `chargePowerKw` was listed here for a year and expired nothing, because it is
 * a COLUMN - `teslaStateToSample` collapses the two rails into it - and never a
 * slot, so `staleWindowFor` was never called with that name. Written this way
 * the same mistake is a compile error.
 */
const ALWAYS_VOLATILE = [
  'speedKph',
  'acPowerKw',
  'dcPowerKw',
] as const satisfies readonly (keyof TeslaFieldState)[]

/**
 * The slots treated as volatile: a rate or an instantaneous reading, whose
 * staleness actively misleads rather than merely ages.
 *
 * DERIVED FROM THE FIELD CATALOGUE, not listed. The drive tier already means
 * "pins to a constant in Park" - speed 0, torque 0, pedals released - which is
 * the same statement as "a value carried out of a drive is a lie". Listing them
 * by hand at 20 fields (and at 204 signals, growing) is how the `chargePowerKw`
 * entry survived: a name that matches no slot is silently inert, and the field
 * it was meant to expire is carried for six hours instead of five minutes.
 *
 * Everything not here - SoC, odometer, range, lock state, doors, temperatures,
 * tyre pressures, charge state - is a level, and its last value stays true.
 */
export const VOLATILE_FIELDS: ReadonlySet<string> = new Set<string>([
  ...ALWAYS_VOLATILE,
  ...TESLA_FIELDS
    .filter((e) => e.tier === 'drive' && !CARRIED_DRIVE_FIELDS.has(e.field))
    .flatMap(slotsOf),
])

/**
 * The slots a charge's state lives in, and the signs that a charge is going on.
 *
 * The car sends a field only when it changes, so a steady charge reports its
 * state once, when it starts, and its power only when it moves by 0.5 kW: the
 * 2026-09-26 charge sent no power at all for eight hours. Expired like any other
 * level, the state vanished six hours in, the segmenter read the charge as
 * paused, closed it ten minutes later with energy still flowing, and ignored
 * the `Complete` that followed. So a sign of charging - positive power, or an
 * energy counter above where it stood (its delta is 0.1 kWh, so it moves every
 * few minutes while energy flows) - refreshes the state as if the car had just
 * said it again. It still expires six hours after the last sign, so a lost
 * `Complete` cannot hold a charge open forever.
 *
 * `activeRail` is refreshed with it. Only positive power claims a rail, and it
 * says which counter measures the charge; expired, both counters are known and
 * `chooseEnergy` gives up, so the same charge was measured only to 22:00 (8.3
 * of its 12.0 kWh). A rising counter does not claim a rail itself: the DC
 * counter rose through that AC charge too.
 */
const CHARGE_STATE_SLOTS = [
  'chargeStateDetailed',
  'chargeStateBasic',
  'activeRail',
] as const satisfies readonly (keyof TeslaFieldState)[]
const CHARGING_POWER_SLOTS = [
  'acPowerKw',
  'dcPowerKw',
] as const satisfies readonly (keyof TeslaFieldState)[]
const CHARGING_ENERGY_SLOTS = [
  'acEnergyKwh',
  'dcEnergyKwh',
] as const satisfies readonly (keyof TeslaFieldState)[]

export function staleWindowFor(field: string): number {
  return VOLATILE_FIELDS.has(field) ? VOLATILE_STALE_MS : STALE_VALUE_MS
}

/**
 * One taped Tesla message -> the fields it contributes, or null if it
 * contributes nothing.
 *
 * This replaced a `normaliseIfKnown(raw): VehicleSample[]`, and the signature
 * change is the whole point rather than a tidy-up. On the MQTT transport
 * fleet-telemetry publishes ONE FIELD PER MESSAGE, so a message cannot produce
 * a sample: it produces a fragment, and the accumulator in `pipeline.ts` is
 * what turns fragments into samples. The old signature could only ever have
 * been satisfied by inventing the rest of the sample, which is exactly the
 * null-becomes-zero failure this codebase is built to avoid.
 */
function decodeTeslaMessage(raw: RawMessage): TeslaFieldUpdate | null {
  const env = readEnvelope(raw.payload)
  if (!env) return null
  switch (env.kind) {
    case 'metrics':
      return env.field === null ? null : decodeTeslaField(env.field, env.value)
    case 'connectivity': {
      const powerState = decodeTeslaConnectivity(env.value)
      return powerState === null ? null : { powerState }
    }
    // Alerts and errors have no VehicleSample counterpart yet. They stay on
    // the tape so a future parser has history to work from, and are
    // deliberately not guessed into a sample.
    case 'alert':
    case 'error':
      return null
  }
}

/**
 * Tesla, as the accumulator sees it.
 *
 * `decode` never sets `observedAt`: fleet-telemetry publishes no timestamp, so
 * the arrival time the accumulator falls back to is the only clock there is, and
 * Tesla's behaviour is exactly what it was before the profile existed. It also
 * refuses another vendor's message outright, as the switch on `raw.vendor` in
 * the old `decodeIfKnown` did, rather than leaving a foreign payload to whatever
 * `readEnvelope` makes of it.
 */
export const teslaProfile: VendorProfile = {
  vendor: 'tesla',
  decode(raw) {
    if (raw.vendor !== 'tesla') return null
    const update = decodeTeslaMessage(raw)
    return update === null ? null : { slots: update as Record<string, unknown> }
  },
  toSample: (vehicleId, ts, state) => teslaStateToSample(vehicleId, ts, state as TeslaFieldUpdate),
  staleWindowFor,
  chargeStateSlots: CHARGE_STATE_SLOTS,
  chargingPowerSlots: CHARGING_POWER_SLOTS,
  chargingEnergySlots: CHARGING_ENERGY_SLOTS,
}

/**
 * Read the envelope back off the tape.
 *
 * Defensive because `reprocess` feeds rows written by older builds of this
 * worker: an unrecognised payload shape yields null (counted as unmapped) rather
 * than an exception that would abort the whole replay transaction.
 */
export function readEnvelope(payload: unknown): TeslaEnvelope | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const o = payload as Record<string, unknown>
  const kind = o['kind']
  if (kind !== 'metrics' && kind !== 'alert' && kind !== 'error' && kind !== 'connectivity') {
    return null
  }
  const vin = typeof o['vin'] === 'string' ? o['vin'] : ''
  const field = typeof o['field'] === 'string' ? o['field'] : null
  return { kind, vin, field, value: o['value'] }
}
