import type { RawMessage, Vendor, VehicleSample } from '@ev/core'

/**
 * What one taped message contributes: a fragment of a vehicle's state, never a
 * sample.
 *
 * Both vendors publish in pieces - fleet-telemetry one field per MQTT message,
 * Rivian one property group per frame, with unchanged properties left out - so a
 * message cannot produce a `VehicleSample` without inventing the rest of it,
 * which is the null-becomes-zero failure this codebase is built to avoid. The
 * accumulator in `pipeline.ts` turns fragments into samples; this is the shape
 * of a fragment.
 */
export interface Decoded {
  /** Slot -> value. An explicit null is stored ("the car says unknown"); an absent key changes nothing. */
  slots: Record<string, unknown>
  /** Slot -> when the vehicle observed it, epoch ms. Absent: the message's receivedAt. */
  observedAt?: Record<string, number>
  /**
   * The slots whose `observedAt` the decoder made up from the message's arrival
   * because the source gave no observation time (spec §7.6). An arrival stamp is
   * strictly newer on every resubscribe snapshot, so the accumulator's
   * newer-wins comparison cannot tell an unchanged value from news. For these
   * slots a value equal to the one held refreshes the held entry's carry but
   * does not count as landing: it schedules no sample. A changed value lands as
   * usual. Absent for Tesla, which stamps nothing and lands every value.
   */
  arrivalStamped?: ReadonlySet<string>
  /** Properties whose own timestamp was missing or unparseable (spec §6.4), for the metric. */
  untimed?: number
}

/**
 * Everything the worker knows about one vendor, behind one object.
 *
 * This replaced the vehicle-adapter interface that used to live in `@ev/core`,
 * which modelled a vendor as a connection (`start`/`stop`) plus
 * `normalise(raw): VehicleSample[]`. Nothing ever implemented it, and the shape
 * was wrong for the same reason `decode` returns a `Decoded` and not a sample:
 * a message is a fragment, so the vendor knowledge that matters is not "turn a
 * message into samples" but the accumulator's policy - how a fragment is read,
 * how long each slot stays true, which slots mean a charge is going on, and how
 * the merged state becomes a row. Those are what a profile carries, and the
 * accumulator and pipeline ask it rather than naming a vendor. Transport (MQTT,
 * the connector's envelope) stays outside: it is the worker's business, not the
 * vehicle's.
 *
 * `observedAt` exists for spec §6.4. Tesla's receiver publishes no timestamp, so
 * arrival time is the only clock there is and Tesla's `Decoded` never sets it.
 * Rivian stamps every property with its own `timeStamp`, and a subscribe
 * re-sends current values that may be hours old: stamped with arrival, a parked
 * car's last non-zero speed would hold a drive open for good. So a profile can
 * say when the vehicle saw a value, and the carry window runs from that.
 */
export interface VendorProfile {
  readonly vendor: Vendor
  /** One taped message -> the fragment it contributes, or null if it contributes nothing. */
  decode(raw: RawMessage): Decoded | null
  /** The accumulator's merged state at `ts` -> a row. Absent slots become null, never 0. */
  toSample(vehicleId: string, ts: Date, state: Record<string, unknown>): VehicleSample
  /** How long a slot's value may be carried into later samples, in ms. */
  staleWindowFor(slot: string): number
  /** The slots a charge's state lives in; refreshed while a charge shows signs of going on. */
  readonly chargeStateSlots: readonly string[]
  /** Slots whose positive value is a sign of charging. */
  readonly chargingPowerSlots: readonly string[]
  /** Slots whose rise above where they stood is a sign of charging. */
  readonly chargingEnergySlots: readonly string[]
}
