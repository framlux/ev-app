/**
 * The accumulator's clocks, in their own module so a vendor profile can name
 * them without importing `pipeline.ts` (which imports the profile's type): the
 * Tesla profile's stale windows are these constants, and a cycle between the two
 * files would make module-evaluation order load-bearing.
 *
 * `pipeline.ts` re-exports all four, so every existing import keeps working.
 */

/**
 * How long a vehicle must go quiet before its accumulated fields are emitted as
 * one sample.
 *
 * WHY DEBOUNCE AT ALL. fleet-telemetry publishes one message per field, so the
 * naive "a message is a sample" rule would write one row per field, each with
 * every other field null. That is worse than merely wasteful: the segmenter
 * reads speed, charge state and SoC off each sample, and a stream in which
 * almost every field is null looks like a car that keeps forgetting how fast it
 * is going. Drives would split, charges would end early, and the derived tables
 * would be wrong in a way that no later fix can distinguish from reality.
 *
 * Two seconds because the car publishes a burst of fields at each of its
 * reporting intervals: a gap that long means the burst is over, so the sample we
 * emit is a coherent snapshot rather than half of one.
 */
export const QUIET_PERIOD_MS = 2_000

/**
 * A hard ceiling on how long accumulation may continue without emitting.
 *
 * A continuously chatty car (a fast-charging session publishes power and SoC
 * without pause) may never leave a two-second gap. Without this it would
 * accumulate forever and produce no samples at all - exactly the silent stall
 * the ingest alert exists to catch, but with the worker looking perfectly
 * healthy. 30s is under the segmenter's one-minute-scale thresholds, so the
 * emitted stream still resolves everything the segmenter reasons about.
 */
export const MAX_SAMPLE_INTERVAL_MS = 30_000

/**
 * How long a field's value may be carried into later samples.
 *
 * DECISION: values DO persist between samples. Fields are published on change or
 * on their own interval, so the last reported value genuinely is the current
 * one; dropping it would put us back to samples that are almost entirely null.
 * A field never reported at all stays null - it is simply absent from the map,
 * and `teslaStateToSample` writes null for what is absent, never 0.
 *
 * But the window is PER FIELD CLASS, because a single global one is wrong in
 * both directions at once, and the first version of this used 15 minutes for
 * everything and was wrong both ways:
 *
 *  - TOO SHORT for level fields. scripts/push-telemetry-config.sh asks for
 *    TpmsPressure* every 3600s and Locked/DoorState/RatedRange/temps every 300s,
 *    and those are MINIMUM intervals - an unchanged value may simply not be
 *    resent. Expiring them turns a perfectly current tyre pressure into null and
 *    writes that null into the sample table as though the car had stopped
 *    reporting it.
 *  - TOO LONG for instantaneous fields. A car that reports 60 kph and then only
 *    publishes tyre pressures for the next quarter of an hour would keep
 *    emitting samples saying it is still doing 60, holding a drive open against
 *    a car that has actually parked.
 *
 * So: a level is true until contradicted, and a rate is only true for a moment.
 */

/** Rates and instantaneous readings. A stale one of these actively misleads. */
export const VOLATILE_STALE_MS = 5 * 60_000

/**
 * Levels: state that remains true until the car says otherwise. Six hours is
 * comfortably past the longest interval we request (TPMS, 3600s) while still
 * bounding the carry so an abandoned accumulator cannot describe a car that has
 * been gone for days.
 */
export const STALE_VALUE_MS = 6 * 60 * 60_000
