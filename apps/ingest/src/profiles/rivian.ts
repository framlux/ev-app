import {
  RIVIAN_CHARGE_STATE_SLOTS,
  RIVIAN_CHARGING_ENERGY_SLOTS,
  RIVIAN_CHARGING_POWER_SLOTS,
  RIVIAN_VOLATILE_SLOTS,
  decodeRivian,
  rivianStateToSample,
} from '@ev/rivian'
import type { VendorProfile } from '../profile.js'
import { STALE_VALUE_MS, VOLATILE_STALE_MS } from '../timing.js'

/**
 * Rivian's side of the worker, the counterpart of `profiles/tesla.ts` and, with
 * it and `deps.ts`, one of the places that may name `@ev/rivian` (the import
 * boundary `test/boundaries.test.ts` enforces). Almost everything that file
 * spends its comments on is a fact about the Tesla's telemetry, and this one is
 * short because the Rivian's differ in ways that remove the work rather than
 * move it.
 *
 * NO CARRIED-DRIVE EXCEPTIONS. Tesla's volatile set is DERIVED from a field
 * catalogue, by taking the drive tier and then carving `Location` and `Gear`
 * back out (`CARRIED_DRIVE_FIELDS`), because they sit on that tier for how often
 * they are asked for and not for how fast they decay. Rivian has no tiers: the
 * volatile slots are three named ones (`RIVIAN_VOLATILE_SLOTS`: speed, heading
 * and charge power), and `lat`, `lon` and `gear` are simply not among them. They
 * are levels here from the start - a parked car is where it parked and in the
 * gear it left - so there is no exception to remember and none to get wrong.
 * The list lives in `@ev/rivian`, typed against the named slots, because it is
 * the normaliser that knows which slots are rates; this file only turns it into
 * a window.
 *
 * WHEN THE CAR SAW A VALUE (spec §6.4). Unlike Tesla's, a Rivian frame says
 * when each property was observed, and `decodeRivian` hands that on as
 * `observedAt`. That is the whole defence against a subscribe snapshot: the
 * connector re-sends current values with their ORIGINAL stamps, hours old for a
 * parked car, and the accumulator measures the carry window from the
 * observation. Stamped with arrival instead, a parked car's last non-zero speed
 * would be carried as if the car had just said it, and a drive would never end.
 * The window a value is judged by in the decoder, to be dropped as too old to
 * apply, is passed in so that it is the very one the accumulator applies later.
 *
 * THREE WINDOWS, NOT TWO (spec §7.6). Rivian streams CHANGES: a property that has
 * not moved is not re-sent as news, and the connector's resubscribe re-sends it
 * with its ORIGINAL `timeStamp`. So a level's observation time is when it last
 * CHANGED, not when it was last true, and for a car that sits it is old by
 * construction. Held to Tesla's six hours, a car parked at 07:00 read null for
 * SoC, odometer, position and tyre pressures in every sample after 13:00 (the
 * decoder dropped the re-sent values as too old and `take()` expired what was
 * held), and a charge that began after that could not be classified at home,
 * since the start coordinates it falls back on were null too. Tesla's windows are
 * right for Tesla because its receiver publishes on an interval and a value that
 * has stopped being resent has stopped being true; that is not a fact about
 * Rivian's.
 *
 * The long window does not weaken the defences that need a short one, because
 * what the car does is carried by the slots that keep theirs: speed, heading
 * and charge power are the rates (five minutes), and the charge words keep six
 * hours so an old `charging_active` cannot hold a session open. Everything else
 * is a level that is true until contradicted.
 *
 * Why seven days and not for ever: it bounds how long an abandoned accumulator
 * may describe a car it has not heard from, as `STALE_VALUE_MS` does for Tesla.
 * A parked car's levels go unchanged for days (a week away from the driveway is
 * ordinary), so the bound is a week, not hours.
 *
 * THE RESUME WINDOW STAYS SIX HOURS (`resumeWindowStart` in `store.ts`). It
 * could not reach seven days without replaying a week of tape at every start,
 * and it does not need to: a parked car's connector re-sends every level once a
 * minute (the 60 s silence resubscribe), so the levels an ingest restart forgets
 * are back in the accumulator within a minute of it subscribing.
 */

/**
 * How long a Rivian level may be carried, measured from the car's own
 * observation of it. See the three-windows note above for why it is so long.
 */
export const RIVIAN_LEVEL_STALE_MS = 7 * 24 * 60 * 60_000

/** The slots with the short window: a rate or a reading that is only true for a moment. */
const VOLATILE: ReadonlySet<string> = new Set<string>(RIVIAN_VOLATILE_SLOTS)

/** The slots a charge's state lives in: the window is Tesla's, so an old word cannot hold a session open. */
const CHARGE_STATE: ReadonlySet<string> = new Set<string>(RIVIAN_CHARGE_STATE_SLOTS)

export function rivianStaleWindowFor(slot: string): number {
  if (VOLATILE.has(slot)) return VOLATILE_STALE_MS
  if (CHARGE_STATE.has(slot)) return STALE_VALUE_MS
  return RIVIAN_LEVEL_STALE_MS
}

/**
 * Rivian, as the accumulator sees it.
 *
 * `decode` refuses another vendor's message outright, as the Tesla profile does,
 * rather than leaving a foreign payload to whatever `readRivianEnvelope` makes
 * of it.
 */
export const rivianProfile: VendorProfile = {
  vendor: 'rivian',
  decode(raw) {
    if (raw.vendor !== 'rivian') return null
    const d = decodeRivian(raw.payload, raw.receivedAt, rivianStaleWindowFor)
    // A frame that decodes to NOTHING (only unknown or null properties, or
    // values too old to apply) is unmapped, not an applied field.
    //
    // This is only half of what a 60 s resubscribe delivers, and not the half
    // that bit. A snapshot also re-sends values that DO decode (a charger state
    // from 08:00, still inside its six hours) but that the accumulator already
    // holds at that very observation, so they land nowhere. The profile cannot
    // see that: it has no state. `FieldAccumulator.apply` does, reports that
    // nothing landed, schedules no sample, and `Pipeline.handle` counts the
    // frame unmapped, so a parked car's replays neither emit a carried-state
    // sample a minute nor keep a session open past the segmenter's gap close.
    if (d === null || (Object.keys(d.slots).length === 0 && d.untimed === 0)) return null
    return {
      slots: d.slots,
      observedAt: d.observedAt,
      arrivalStamped: d.arrivalStamped,
      untimed: d.untimed,
    }
  },
  toSample: rivianStateToSample,
  staleWindowFor: rivianStaleWindowFor,
  chargeStateSlots: RIVIAN_CHARGE_STATE_SLOTS,
  chargingPowerSlots: RIVIAN_CHARGING_POWER_SLOTS,
  chargingEnergySlots: RIVIAN_CHARGING_ENERGY_SLOTS,
}
