import {
  TESLA_FIELDS,
  slotsOf,
  teslaStateToSample,
  type TeslaFieldState,
  type TeslaFieldUpdate,
} from '@ev/tesla'
import { decodeIfKnown } from './deps.js'
import {
  estimateCapacity,
  initialState,
  step,
  summariseSession,
  type MetricsOptions,
  type RawMessage,
  type SegmenterState,
  type SessionKind,
  type SessionSummary,
  type VehicleSample,
} from './deps.js'

/**
 * The pipeline's view of persistence.
 *
 * Argument order here is (kind, vehicleId, at) rather than the repo layer's
 * (client, vehicleId, kind, startedAt): `store.ts` adapts between them by
 * binding a `DbClient`, which is also what keeps this file free of any `pg`
 * types and therefore unit-testable against a plain object.
 */
export interface Store {
  /** Called before any write into a partitioned table for that month. */
  ensurePartitions(when: Date): Promise<void>
  insertRaw(m: RawMessage): Promise<void>
  insertSample(s: VehicleSample): Promise<void>
  openSession(kind: SessionKind, vehicleId: string, at: Date): Promise<string>
  appendPoint(sessionId: string, s: VehicleSample): Promise<void>
  closeSession(sessionId: string, summary: SessionSummary): Promise<void>
  recordBatteryHealth(row: BatteryHealthWrite): Promise<void>
  recordMeasuredCapacity(row: MeasuredCapacityWrite): Promise<void>
  advanceCursor(at: Date): Promise<void>
}

export interface BatteryHealthWrite {
  vehicleId: string
  observedOn: Date
  estimatedCapacityKwh: number
  ratedRangeAt100Km: number | null
  sampleConfidence: number
}

export interface MeasuredCapacityWrite {
  vehicleId: string
  observedOn: Date
  measuredCapacityKwh: number
  ratedRangeAt100Km: number | null
}

/**
 * Runs one unit of work against a `Store`.
 *
 * The whole of `handle()` runs inside a single `run()` call, and the pg
 * implementation makes that call one transaction. That is what "ack only after
 * the row is committed" means in practice: `handle()` resolves after COMMIT, and
 * only then does the MQTT layer send the PUBACK. fleet-telemetry chains the
 * vehicle's own acknowledgement to the broker accepting the message
 * (`reliable_ack_sources {"V":"mqtt"}`), so acking early would turn a crash into
 * data the car has already discarded.
 */
export interface StoreRunner {
  run<T>(fn: (store: Store) => Promise<T>): Promise<T>
}

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

export interface PipelineResult {
  /** Samples handed to the store. Rows may be deduplicated by the store. */
  samples: number
  sessionsOpened: number
  sessionsClosed: number
  /** Field messages whose value landed in the accumulator. */
  fieldsApplied: number
  /** Messages carrying nothing we could place: unknown field, unreadable value. */
  unmapped: number
  /** Timestamp of the newest sample emitted here, for the staleness gauge. */
  lastSampleTs: Date | null
}

const EMPTY: PipelineResult = {
  samples: 0, sessionsOpened: 0, sessionsClosed: 0,
  fieldsApplied: 0, unmapped: 0, lastSampleTs: null,
}

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

export function staleWindowFor(field: string): number {
  return VOLATILE_FIELDS.has(field) ? VOLATILE_STALE_MS : STALE_VALUE_MS
}

/** One field's latest value and when that value arrived. */
interface Entry {
  value: unknown
  at: number
}

/**
 * Per-vehicle latest-value map plus the emit timing.
 *
 * Timing is driven by MESSAGE ARRIVAL TIME, not by a wall-clock timer, so that
 * replaying the tape through `reprocess` produces the same samples as the live
 * worker did. A timer-only design would also lose the last burst of state on
 * every restart, and would emit samples stamped with the timer's time rather
 * than the observation's.
 *
 * The live worker still needs `Pipeline.flush()` on an interval for the other
 * half of the problem: a car that goes quiet sends no further message, so
 * nothing would arrive to trigger the emit.
 */
export class FieldAccumulator {
  private slots = new Map<string, Entry>()
  /** Arrival of the newest field in the pending sample. */
  private newestAt: number | null = null
  /** Arrival of the oldest field in the pending sample. */
  private pendingSince: number | null = null
  /** Event time of the last sample emitted, for the hard-ceiling rule. */
  private lastEmitAt: number | null = null

  apply(update: TeslaFieldUpdate, at: Date): void {
    const ms = at.getTime()
    for (const [key, value] of Object.entries(update)) {
      if (value === undefined) continue
      this.slots.set(key, { value, at: ms })
    }
    this.newestAt = ms
    this.pendingSince ??= ms
  }

  /** Is there a pending sample, and is it time to emit it at `now`? */
  due(now: Date): boolean {
    if (this.pendingSince === null || this.newestAt === null) return false
    const ms = now.getTime()
    // A clock that went backwards (NTP step, or a replayed tape out of order)
    // must not emit on every message; treat it as "not yet".
    if (ms - this.newestAt >= QUIET_PERIOD_MS) return true
    return ms - (this.lastEmitAt ?? this.pendingSince) >= MAX_SAMPLE_INTERVAL_MS
  }

  /** Anything accumulated but not yet emitted? */
  get pending(): boolean {
    return this.pendingSince !== null
  }

  /**
   * Take the pending sample's state, stamped with the arrival time of its newest
   * field. Values older than STALE_VALUE_MS are dropped rather than carried.
   */
  take(): { state: TeslaFieldUpdate; ts: Date } | null {
    if (this.newestAt === null) return null
    const ts = this.newestAt
    const state: Record<string, unknown> = {}
    for (const [key, entry] of this.slots) {
      if (ts - entry.at >= staleWindowFor(key)) {
        this.slots.delete(key)
        continue
      }
      state[key] = entry.value
    }
    this.lastEmitAt = ts
    this.pendingSince = null
    // newestAt is kept: it is the anchor for the staleness of what remains.
    return { state: state as TeslaFieldUpdate, ts: new Date(ts) }
  }

  /** Deep enough copy for transaction rollback. Entries are immutable. */
  clone(): FieldAccumulator {
    const copy = new FieldAccumulator()
    copy.slots = new Map(this.slots)
    copy.newestAt = this.newestAt
    copy.pendingSince = this.pendingSince
    copy.lastEmitAt = this.lastEmitAt
    return copy
  }
}

/** Everything that must be rolled back with the transaction. */
interface Snapshot {
  state: SegmenterState
  openId: string | null
  openPoints: VehicleSample[]
  ensuredMonths: Set<string>
  accumulators: Map<string, FieldAccumulator>
  measuredDays: Map<string, string>
}

export class Pipeline {
  private state: SegmenterState = initialState()
  private openId: string | null = null
  private openPoints: VehicleSample[] = []
  /**
   * Months whose partitions are known to exist. `ensure_month_partitions` is
   * DDL, so it is part of the transaction and a rollback undoes it — which is
   * why this set is snapshotted and restored alongside the segmenter state. A
   * cache that outlived its rollback would skip the CREATE on the retry and the
   * insert would fail again, permanently.
   */
  private ensuredMonths = new Set<string>()
  /**
   * Keyed by our vehicle id. One entry in practice, but keyed rather than
   * singular so a broker carrying two cars cannot blend their fields into one
   * sample - which would be undetectable afterwards.
   */
  private accumulators = new Map<string, FieldAccumulator>()
  /**
   * The UTC day each vehicle's pack measurement was last written for.
   *
   * The last day rather than a set of them, because it is only ever compared
   * with the day of the sample in hand and a set would grow for the life of the
   * process. Replaying out of order (`reprocess` walking a window) can
   * therefore write the same day twice; `recordMeasuredCapacity` is an upsert
   * of the same value, so that costs a statement and changes nothing.
   *
   * It is memory, not truth: a restart forgets it and the first sample after
   * rewrites the day. That is deliberate - the alternative is a SELECT per
   * sample to ask the database a question whose wrong answer is one redundant
   * UPDATE a day.
   */
  private measuredDays = new Map<string, string>()

  constructor(private runner: StoreRunner, private opts: MetricsOptions) {}

  /**
   * Raw first, always. The tape is what makes everything else rebuildable, so a
   * crash between the two writes must never lose the message — and because both
   * writes share one transaction, there is no window in which one exists
   * without the other.
   *
   * A message that carries nothing we can place (an unknown field, an
   * unreadable value, an alert) is still taped and still counted; it simply adds
   * nothing to the accumulator. Never a throw: one bad message must not kill the
   * worker, and it must not be acked as if it had produced a sample either -
   * `unmapped` in the result is how the caller can tell.
   */
  async handle(raw: RawMessage): Promise<PipelineResult> {
    return this.transactionally(async (store) => {
      await this.ensureMonth(store, raw.receivedAt)
      await store.insertRaw(raw)

      const acc = this.accumulatorFor(raw.vehicleId)
      let result = { ...EMPTY }

      // Emit BEFORE applying this message. The gap in front of it is the
      // evidence that the previous burst finished, and emitting first keeps the
      // sample stamped at the last observation's time rather than at this one's.
      if (acc.due(raw.receivedAt)) {
        result = merge(result, await this.emit(store, raw.vehicleId, acc))
      }

      const update = decode(raw)
      if (update) {
        acc.apply(update, raw.receivedAt)
        result.fieldsApplied = 1
      } else {
        result.unmapped = 1
      }

      // Inside the transaction: a watermark that survived a rolled-back message
      // would claim progress that never happened.
      await store.advanceCursor(raw.receivedAt)
      return result
    })
  }

  /**
   * Emit any sample that is due, or - with `force` - whatever is pending.
   *
   * The live worker calls this on a short interval and once at shutdown. Without
   * the interval a car that goes quiet leaves its last burst in memory until the
   * next message, which may be hours away or (across a restart) never; `force`
   * at shutdown is what stops a planned restart from dropping it.
   */
  async flush(now: Date = new Date(), force = false): Promise<PipelineResult> {
    let result = { ...EMPTY }
    for (const [vehicleId, acc] of this.accumulators) {
      if (!(force ? acc.pending : acc.due(now))) continue
      result = merge(
        result,
        await this.transactionally((store) => this.emit(store, vehicleId, acc)),
      )
    }
    return result
  }

  /** Feed one already-normalised sample. Used by reprocess and by tests. */
  async handleSample(sample: VehicleSample): Promise<PipelineResult> {
    return this.transactionally((store) => this.applySample(store, sample))
  }

  /**
   * Rebuild in-memory state for a session that was still open when the worker
   * died, by replaying its own samples through the segmenter.
   *
   * Without this a restart mid-drive forgets the session: the next sample opens
   * a second one (the partial unique index turns that into adopting the first,
   * with no points behind it) and the drive is summarised from whatever arrived
   * after the restart. Replay costs one pass over rows already in `sample`.
   *
   * If the replay ends with nothing open, the session genuinely finished before
   * the crash and is closed here rather than left open forever.
   */
  async recoverOpenSession(
    sessionId: string, kind: SessionKind, samples: VehicleSample[],
  ): Promise<void> {
    let state = initialState()
    const points: VehicleSample[] = []
    for (const sample of samples) {
      const result = step(state, sample)
      state = result.state
      for (const event of result.events) {
        if (event.type === 'session-start') points.length = 0
        else if (event.type === 'session-point') points.push(event.sample)
      }
    }

    this.state = state
    this.openPoints = points

    if (state.open) {
      this.openId = sessionId
      return
    }

    this.openId = null
    if (points.length > 0) {
      await this.transactionally((store) => this.finish(store, sessionId, kind, points))
    }
  }

  private accumulatorFor(vehicleId: string): FieldAccumulator {
    let acc = this.accumulators.get(vehicleId)
    if (!acc) {
      acc = new FieldAccumulator()
      this.accumulators.set(vehicleId, acc)
    }
    return acc
  }

  private async emit(
    store: Store, vehicleId: string, acc: FieldAccumulator,
  ): Promise<PipelineResult> {
    const pending = acc.take()
    if (!pending) return { ...EMPTY }
    return this.applySample(store, teslaStateToSample(vehicleId, pending.ts, pending.state))
  }

  private async transactionally<T>(fn: (store: Store) => Promise<T>): Promise<T> {
    const snapshot = this.snapshot()
    try {
      return await this.runner.run(fn)
    } catch (err) {
      // The transaction rolled back, so the in-memory segmenter and the
      // accumulator must too. Leaving either advanced would make the redelivery
      // of this message land in a state that no longer matches the database —
      // and would drop the field it carried, since a redelivery is the only
      // copy left once the rollback threw the first one away.
      this.restore(snapshot)
      throw err
    }
  }

  private async applySample(store: Store, sample: VehicleSample): Promise<PipelineResult> {
    await this.ensureMonth(store, sample.ts)
    await store.insertSample(sample)
    await this.measurePack(store, sample)

    const { state, events } = step(this.state, sample)
    this.state = state

    let opened = 0
    let closed = 0
    for (const event of events) {
      if (event.type === 'session-start') {
        this.openId = await store.openSession(event.kind, sample.vehicleId, event.at)
        this.openPoints = []
        opened++
      } else if (event.type === 'session-point' && this.openId) {
        this.openPoints.push(event.sample)
        await store.appendPoint(this.openId, event.sample)
      } else if (event.type === 'session-end' && this.openId) {
        await this.finish(store, this.openId, event.kind, this.openPoints)
        this.openId = null
        this.openPoints = []
        closed++
      }
    }

    return {
      ...EMPTY,
      samples: 1,
      sessionsOpened: opened,
      sessionsClosed: closed,
      lastSampleTs: sample.ts,
    }
  }

  private async finish(
    store: Store, sessionId: string, kind: SessionKind, points: VehicleSample[],
  ): Promise<void> {
    const summary = summariseSession(kind, points, this.opts)
    await store.closeSession(sessionId, summary)

    // Battery health is only measurable from a charge: it divides measured
    // energy in by the SoC span, and a drive has no measured energy at all
    // (its energy is inferred FROM a nameplate capacity, so using it would be
    // circular). estimateCapacity returns null for spans too narrow to mean
    // anything, and that null is the whole point — no row beats a bad row.
    if (kind !== 'charge') return
    const estimate = estimateCapacity({
      startSocPct: summary.startSocPct,
      endSocPct: summary.endSocPct,
      energyKwh: summary.energyKwh,
    })
    const observedOn = summary.endedAt ?? summary.startedAt
    const vehicleId = points[0]?.vehicleId
    if (!estimate || !observedOn || !vehicleId) return

    await store.recordBatteryHealth({
      vehicleId,
      observedOn,
      estimatedCapacityKwh: estimate.estimatedCapacityKwh,
      // Rated range at 100% is not derivable from a partial charge: the car
      // reports range at whatever SoC it is at, and extrapolating it would
      // invent precision. Left null until a genuine full charge is observed.
      ratedRangeAt100Km: null,
      sampleConfidence: estimate.confidence,
    })
  }

  /**
   * The car's own measurement of its pack, at most once per UTC day.
   *
   * The estimate above is inferred from a charge session, which is why it is
   * written when one closes. This is not inferred from anything: the car
   * publishes `NominalFullPackEnergyKwh` as a field, so it arrives on a sample
   * and has no session to hang off. Hence the sample path, and hence a daily
   * gate rather than an event - the value moves by a few tenths of a kWh over
   * months, so one reading a day is already more resolution than the quantity
   * has, and writing it per sample would turn a daily row into an UPDATE
   * roughly every thirty seconds.
   *
   * Inside the caller's transaction, so the measurement commits with the sample
   * it was read from or not at all - and the memory of having written it rolls
   * back with the transaction (see `measuredDays`), or a rolled-back write
   * would be skipped on the retry and the day would silently lose its
   * measurement.
   */
  private async measurePack(store: Store, sample: VehicleSample): Promise<void> {
    const measured = sample.nominalFullPackEnergyKwh
    // A pack of zero kWh is a decode artefact, not a dead battery.
    if (measured === null || !(measured > 0)) return

    const day = sample.ts.toISOString().slice(0, 10)
    if (this.measuredDays.get(sample.vehicleId) === day) return

    await store.recordMeasuredCapacity({
      vehicleId: sample.vehicleId,
      observedOn: sample.ts,
      measuredCapacityKwh: measured,
      ratedRangeAt100Km: ratedRangeAtFull(sample),
    })
    this.measuredDays.set(sample.vehicleId, day)
  }

  private async ensureMonth(store: Store, when: Date): Promise<void> {
    const key = `${when.getUTCFullYear()}-${when.getUTCMonth()}`
    if (this.ensuredMonths.has(key)) return
    await store.ensurePartitions(when)
    this.ensuredMonths.add(key)
  }

  private snapshot(): Snapshot {
    const accumulators = new Map<string, FieldAccumulator>()
    for (const [id, acc] of this.accumulators) accumulators.set(id, acc.clone())
    return {
      state: this.state,
      openId: this.openId,
      openPoints: [...this.openPoints],
      ensuredMonths: new Set(this.ensuredMonths),
      accumulators,
      measuredDays: new Map(this.measuredDays),
    }
  }

  private restore(s: Snapshot): void {
    this.state = s.state
    this.openId = s.openId
    this.openPoints = s.openPoints
    this.ensuredMonths = s.ensuredMonths
    this.accumulators = s.accumulators
    this.measuredDays = s.measuredDays
  }
}

/**
 * How much of the pack must be left before rated range is worth extrapolating.
 *
 * `rated_range_at_100_km` has never been written: a partial charge cannot give
 * it (the estimator passes null and says so), but a sample can, because the car
 * reports rated range, energy remaining and full pack energy together and the
 * ratio of the last two is what the first is quoted against.
 *
 * The extrapolation is a division by that ratio, so its error grows as the pack
 * empties - at 10% left, a kWh of disagreement between the two energy figures
 * moves the answer by tens of kilometres, and the car's own range figure is at
 * its least linear down there anyway. Half a pack caps the extrapolation at 2x
 * and keeps the estimator's discipline: no row beats a bad row, and a day with
 * no qualifying sample simply carries the measurement without a range.
 */
const MIN_PACK_FRACTION_FOR_RANGE = 0.5

/**
 * Rated range at 100% from one sample, or null when it would be invention.
 *
 * `rangeKm` is `RatedRange`, already converted from the miles the car streams.
 */
function ratedRangeAtFull(s: VehicleSample): number | null {
  const full = s.nominalFullPackEnergyKwh
  const remaining = s.energyRemaining
  const rated = s.rangeKm
  if (full === null || remaining === null || rated === null) return null
  if (!(full > 0) || !(rated > 0)) return null

  const fraction = remaining / full
  // Over 1 the two energy figures are describing different things (a usable
  // figure against a nominal one, or a stale carry), which makes the ratio
  // meaningless rather than merely imprecise.
  if (fraction < MIN_PACK_FRACTION_FOR_RANGE || fraction > 1) return null
  return Math.round((rated / fraction) * 10) / 10
}

/**
 * One taped message -> the fields it contributes.
 *
 * The vendor dispatch lives in `deps.ts`, which is the seam Rivian will be added
 * at. It is imported lazily inside the function because deps.ts imports
 * `readEnvelope` from this module, and a top-level import would make that cycle
 * load-bearing at module-evaluation time.
 */
function decode(raw: RawMessage): TeslaFieldUpdate | null {
  return decodeIfKnown(raw)
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

function merge(a: PipelineResult, b: PipelineResult): PipelineResult {
  return {
    samples: a.samples + b.samples,
    sessionsOpened: a.sessionsOpened + b.sessionsOpened,
    sessionsClosed: a.sessionsClosed + b.sessionsClosed,
    fieldsApplied: a.fieldsApplied + b.fieldsApplied,
    unmapped: a.unmapped + b.unmapped,
    lastSampleTs: later(a.lastSampleTs, b.lastSampleTs),
  }
}

function later(a: Date | null, b: Date | null): Date | null {
  if (!a) return b
  if (!b) return a
  return a.getTime() >= b.getTime() ? a : b
}
