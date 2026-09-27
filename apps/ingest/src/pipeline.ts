import {
  TESLA_FIELDS,
  slotsOf,
  teslaStateToSample,
  type TeslaFieldState,
  type TeslaFieldUpdate,
} from '@ev/tesla'
import { decodeIfKnown } from './deps.js'
import {
  classifyCharge,
  priceCharge,
  type ChargeCost,
  type EnergyPrice,
  type HomeLocation,
} from './pricing.js'
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
  /** Close without a summary: a row resume cannot account for. See `Pipeline.resume`. */
  abandonSession(sessionId: string): Promise<void>
  /** Replace an open row's start and points with a replay's. See `Pipeline.resume`. */
  resetSession(sessionId: string, startedAt: Date, points: readonly VehicleSample[]): Promise<void>
  recordBatteryHealth(row: BatteryHealthWrite): Promise<void>
  recordMeasuredCapacity(row: MeasuredCapacityWrite): Promise<void>
  /**
   * The price in force at an instant, or null if none is (spec §3.2).
   *
   * THE FIRST READ THROUGH THIS SEAM, which was write-only until pricing
   * needed it, and a decision rather than an addition. The alternative was a
   * separate `RateLookup` handed to the Pipeline beside its options, keeping
   * `Store` a pure sink — and that would have put the lookup outside the
   * message transaction, where a rate inserted between the SELECT and the
   * COMMIT could price a charge at a tariff that was never in force when it
   * closed. Reading here keeps the price and the session it belongs to inside
   * one snapshot.
   *
   * The cost of the widening is bounded deliberately: one indexed SELECT, on
   * the close of a charge only, on a connection the transaction already holds.
   * A read that fanned out — a query per sample, or an unbounded scan — would
   * make the hot path depend on the size of a table that only grows, and is
   * the thing this comment exists to refuse.
   */
  rateAt(at: Date): Promise<EnergyPrice | null>
  recordSessionCost(row: SessionCostWrite): Promise<void>
  advanceCursor(at: Date): Promise<void>
}

/** A price and the session it belongs to, as `priceSession` writes it. */
export interface SessionCostWrite extends ChargeCost {
  sessionId: string
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
  /** Arrival of the oldest field in the pending sample, for the hard-ceiling rule. */
  private pendingSince: number | null = null

  apply(update: TeslaFieldUpdate, at: Date): void {
    const ms = at.getTime()
    // Before the slots move: a rising counter is judged against where it stood.
    const charging = this.showsCharging(update)
    for (const [key, value] of Object.entries(update)) {
      if (value === undefined) continue
      this.slots.set(key, { value, at: ms })
    }
    if (charging) {
      for (const key of CHARGE_STATE_SLOTS) {
        const entry = this.slots.get(key)
        // A new entry, not a mutation: `clone` shares entries with its copy.
        if (entry) this.slots.set(key, { value: entry.value, at: ms })
      }
    }
    this.newestAt = ms
    this.pendingSince ??= ms
  }

  /** Positive power, or an energy counter above where it stood. See CHARGE_STATE_SLOTS. */
  private showsCharging(update: TeslaFieldUpdate): boolean {
    for (const key of CHARGING_POWER_SLOTS) {
      const value = update[key]
      if (typeof value === 'number' && value > 0) return true
    }
    for (const key of CHARGING_ENERGY_SLOTS) {
      const value = update[key]
      const before = this.slots.get(key)?.value
      if (typeof value === 'number' && typeof before === 'number' && value > before) return true
    }
    return false
  }

  /** Is there a pending sample, and is it time to emit it at `now`? */
  due(now: Date): boolean {
    if (this.pendingSince === null || this.newestAt === null) return false
    const ms = now.getTime()
    // A clock that went backwards (NTP step, or a replayed tape out of order)
    // must not emit on every message; treat it as "not yet".
    if (ms - this.newestAt >= QUIET_PERIOD_MS) return true
    // From the pending burst's own start, not the last emit: measured from the
    // last emit, any gap over 30 s made a new burst's second message overdue,
    // and its first field was written alone.
    return ms - this.pendingSince >= MAX_SAMPLE_INTERVAL_MS
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

  /**
   * `home` is optional and defaults to off, because EV_HOME_LAT/LON are
   * optional: without them the coordinate fallback is disabled and the car's
   * own `locatedAtHome` is the only test of where a charge happened, which is
   * the better signal anyway (spec §3.8).
   */
  constructor(
    private runner: StoreRunner,
    private opts: MetricsOptions,
    private home: HomeLocation | null = null,
  ) {}

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
   * Pick up where the previous worker stopped, by replaying the tape it wrote.
   *
   * Everything the pipeline knows lives in memory: the carried field values,
   * the open session and its points. A restart used to forget all of it, so a
   * charge or drive open across a deploy was never closed, and the next session
   * of its kind was merged into it (`openSession` adopts an open row). Nor could
   * the state be rebuilt from `sample`: the car sends a field only when it
   * changes, so a worker that restarted blind wrote samples without, say, the
   * charge state, and replaying those rows would close a charge still running.
   *
   * The tape is what the previous worker actually saw, so the replay runs the
   * very code the live path does, against a store that writes nothing. Then one
   * transaction reconciles what it found with the rows that are really open,
   * matched by kind and by time, never by kind alone:
   *  - a row whose session the replay shows still running is carried on;
   *  - a row whose session ended is closed with the replay's summary and price;
   *  - either way, the row's start and points become the replay's, which fills
   *    the hole a blind worker left and drops a session it absorbed;
   *  - a row the tape cannot account for is closed without a summary;
   *  - a session still running with no row of its own gets one.
   *
   * `now` stands in for the previous worker's shutdown flush, so the replay
   * ends where it did; if that worker crashed instead, the last burst it never
   * emitted is written here.
   */
  async resume(
    tape: Iterable<RawMessage> | AsyncIterable<RawMessage>,
    open: readonly OpenRow[],
    now: Date,
  ): Promise<ResumeReport> {
    const dry = new DryStore()
    const live = this.runner
    this.runner = { run: (fn) => fn(dry) }
    let replayed = 0
    try {
      for await (const raw of tape) {
        await this.handle(raw)
        replayed++
      }
      dry.finalFlush = true
      await this.flush(now, true)
    } finally {
      this.runner = live
    }
    // Both memos were filled against a store that wrote nothing.
    this.ensuredMonths.clear()
    this.measuredDays.clear()
    return this.transactionally((store) => this.reconcile(store, dry, open, replayed))
  }

  private async reconcile(
    store: Store, dry: DryStore, open: readonly OpenRow[], replayed: number,
  ): Promise<ResumeReport> {
    const report: ResumeReport = {
      ...EMPTY, replayed, resumed: null, closed: [], abandoned: [],
      samples: dry.flushed.length, lastSampleTs: dry.newestSampleTs,
    }
    for (const sample of dry.flushed) {
      await this.ensureMonth(store, sample.ts)
      await store.insertSample(sample)
    }

    const running = this.openId === null ? null : dry.session(this.openId)
    let carried: string | null = null
    const byStart = [...open].sort((x, y) => x.startedAt.getTime() - y.startedAt.getTime())
    for (const row of byStart) {
      const match = dry.matchFor(row)
      if (match !== null && match === running) {
        carried = row.id
        report.resumed = { ...row, startedAt: match.startedAt }
      } else if (match?.closed) {
        await store.resetSession(row.id, match.startedAt, match.points)
        await this.finish(store, row.id, row.kind, match.points)
        report.closed.push(row)
      } else {
        await store.abandonSession(row.id)
        report.abandoned.push(row)
      }
    }

    if (running) {
      // Closed rows are settled above, so this cannot adopt one of them.
      if (carried === null) {
        carried = await store.openSession(running.kind, running.vehicleId, running.startedAt)
        report.sessionsOpened = 1
      }
      report.resumed ??= { id: carried, kind: running.kind, startedAt: running.startedAt }
      await store.resetSession(carried, running.startedAt, this.openPoints)
    }
    this.openId = carried
    report.sessionsClosed = report.closed.length + report.abandoned.length
    return report
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
        // The segmenter ends a session on a named sample: for a charge, the
        // one that says it stopped, which carries the final energy counter and
        // SoC. It is not always a point already, and the summary is built from
        // the points, so without this a charge ended one reading early.
        const last = this.openPoints.at(-1)
        if (!last || event.sample.ts.getTime() > last.ts.getTime()) {
          this.openPoints.push(event.sample)
          await store.appendPoint(this.openId, event.sample)
        }
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

    // Two things hang off a closing charge and nothing hangs off a closing
    // drive, so the guard is here, once, rather than at the top of each. It
    // used to live inside the battery block below — where it read as that
    // block's own early return, and where anything appended after the block
    // would silently never run. Both consequences are charge-only for the same
    // reason: a drive's energy is inferred from a nameplate capacity rather
    // than measured, so neither a capacity estimate nor a price could be
    // anything but circular.
    if (kind !== 'charge') return
    await this.recordHealth(store, summary, points)
    await this.attachCost(store, sessionId, summary, points)
  }

  /**
   * What this charge cost, and why (spec §3.4).
   *
   * Unconditional for a charge: every one gets a `cost_basis`, including the
   * ones with no figure. A row left null is ambiguous between free, unknown and
   * not-yet-written, and the charges page has no way to tell them apart — which
   * is the whole reason the basis is a column rather than an inference.
   *
   * In the same transaction as `closeSession`, so a session never commits
   * half-classified: a crash between the two would leave a closed charge that
   * nothing ever revisits, since only the close triggers pricing.
   */
  private async attachCost(
    store: Store, sessionId: string, summary: SessionSummary, points: VehicleSample[],
  ): Promise<void> {
    const classified = classifyCharge(points, summary, this.home)
    // Only a home charge has a rate to look up. A Supercharger stop is priced
    // from what Tesla billed and an unknown charger from nothing at all, so
    // asking the database would be a query whose answer is discarded.
    const rate = classified.basis === 'home' && classified.at !== null
      ? await store.rateAt(classified.at)
      : null
    await store.recordSessionCost({ sessionId, ...priceCharge(classified, rate) })
  }

  /**
   * Battery health, estimated from the charge that just closed.
   *
   * It divides measured energy in by the SoC span, so `estimateCapacity`
   * returns null for spans too narrow to mean anything — and that null is the
   * whole point. No row beats a bad row: a fabricated capacity would rescale
   * every drive's energy figure that reads it.
   */
  private async recordHealth(
    store: Store, summary: SessionSummary, points: VehicleSample[],
  ): Promise<void> {
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

/** An open `session` row, as `findOpenSessions` reads it. */
export interface OpenRow {
  id: string
  kind: SessionKind
  startedAt: Date
}

/**
 * What `Pipeline.resume` did, for the startup log, and as a `PipelineResult`
 * so the runner announces it and main() counts it as it would a live message:
 * the sessions it closed and opened, the samples it wrote, and the newest
 * sample the replay saw.
 */
export interface ResumeReport extends PipelineResult {
  /** Tape messages replayed. */
  replayed: number
  /** The row the worker carries on with, if a session is still running. */
  resumed: OpenRow | null
  /** Open rows whose session had ended, now closed with the replay's summary. */
  closed: OpenRow[]
  /** Open rows the tape cannot account for, closed without a summary. */
  abandoned: OpenRow[]
}

interface ReplayedSession {
  id: string
  kind: SessionKind
  vehicleId: string
  startedAt: Date
  points: VehicleSample[]
  closed: boolean
  endedAt: Date | null
}

/**
 * The store `resume` replays against. It writes nothing, and remembers the
 * sessions the replay opened and closed so they can be matched with real rows.
 */
class DryStore implements Store {
  private readonly sessions = new Map<string, ReplayedSession>()
  private next = 0
  /** Set for the flush that stands in for the stopped worker's shutdown. */
  finalFlush = false
  /** What that flush emitted: the burst a crashed worker never wrote. */
  readonly flushed: VehicleSample[] = []
  /** The newest sample the replay produced, written now or by the old worker. */
  newestSampleTs: Date | null = null

  session(id: string): ReplayedSession | null {
    return this.sessions.get(id) ?? null
  }

  /**
   * The replayed session a real row stands for: same kind, and the row's start
   * inside the session's span, or at most one sample interval before it. The
   * slack is for a start the live worker and the replay disagree on: the live
   * flush timer races the database near the quiet boundary, and an exact match
   * would abandon the row and open a duplicate. Of several, the nearest start;
   * a row adopted into a later session keeps its own start, so it is still
   * nearest the first.
   */
  matchFor(row: OpenRow): ReplayedSession | null {
    const at = row.startedAt.getTime()
    let best: ReplayedSession | null = null
    const distance = (s: ReplayedSession) => Math.abs(s.startedAt.getTime() - at)
    for (const s of this.sessions.values()) {
      if (s.kind !== row.kind || s.startedAt.getTime() - MAX_SAMPLE_INTERVAL_MS > at) continue
      const end = s.closed ? (s.endedAt ?? s.points.at(-1)?.ts ?? s.startedAt).getTime() : Infinity
      if (at > end) continue
      if (!best || distance(s) < distance(best)) best = s
    }
    return best
  }

  async ensurePartitions(): Promise<void> {}
  async insertRaw(): Promise<void> {}
  async insertSample(s: VehicleSample): Promise<void> {
    if (this.finalFlush) this.flushed.push(s)
    if (!this.newestSampleTs || s.ts.getTime() > this.newestSampleTs.getTime()) this.newestSampleTs = s.ts
  }
  async openSession(kind: SessionKind, vehicleId: string, at: Date): Promise<string> {
    const id = `replay:${++this.next}`
    this.sessions.set(id, { id, kind, vehicleId, startedAt: at, points: [], closed: false, endedAt: null })
    return id
  }
  async appendPoint(sessionId: string, s: VehicleSample): Promise<void> {
    this.sessions.get(sessionId)?.points.push(s)
  }
  async closeSession(sessionId: string, summary: SessionSummary): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (s) {
      s.closed = true
      s.endedAt = summary.endedAt
    }
  }
  async abandonSession(): Promise<void> {}
  async resetSession(): Promise<void> {}
  async recordBatteryHealth(): Promise<void> {}
  async recordMeasuredCapacity(): Promise<void> {}
  async rateAt(): Promise<EnergyPrice | null> {
    return null
  }
  async recordSessionCost(): Promise<void> {}
  async advanceCursor(): Promise<void> {}
}
