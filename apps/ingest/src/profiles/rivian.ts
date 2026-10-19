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
 */

/** The slots with the short window: a rate or a reading that is only true for a moment. */
const VOLATILE: ReadonlySet<string> = new Set<string>(RIVIAN_VOLATILE_SLOTS)

export function rivianStaleWindowFor(slot: string): number {
  return VOLATILE.has(slot) ? VOLATILE_STALE_MS : STALE_VALUE_MS
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
    // A frame carrying nothing we place (only unknown or null properties, or
    // values too old to apply) is unmapped, not an applied field: counting it
    // would schedule an emit of carried-only state on every 60 s resubscribe,
    // a sample row a minute for a car that has said nothing.
    if (d === null || (Object.keys(d.slots).length === 0 && d.untimed === 0)) return null
    return { slots: d.slots, observedAt: d.observedAt, untimed: d.untimed }
  },
  toSample: rivianStateToSample,
  staleWindowFor: rivianStaleWindowFor,
  chargeStateSlots: RIVIAN_CHARGE_STATE_SLOTS,
  chargingPowerSlots: RIVIAN_CHARGING_POWER_SLOTS,
  chargingEnergySlots: RIVIAN_CHARGING_ENERGY_SLOTS,
}
