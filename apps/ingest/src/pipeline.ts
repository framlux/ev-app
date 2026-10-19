import { isDeepStrictEqual } from 'node:util'
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
import type { Decoded, VendorProfile } from './profile.js'
import {
  MAX_SAMPLE_INTERVAL_MS,
  QUIET_PERIOD_MS,
} from './timing.js'

// The clocks live in timing.ts so a vendor profile can use them without
// importing this file. Re-exported so every existing import keeps working.
export {
  MAX_SAMPLE_INTERVAL_MS,
  QUIET_PERIOD_MS,
  STALE_VALUE_MS,
  VOLATILE_STALE_MS,
} from './timing.js'

// The Tesla envelope moved to its profile with the code that reads it. Re-exported
// because mqtt.ts writes it and the tests read it back through this module.
export { readEnvelope, type RecordKind, type TeslaEnvelope } from './profiles/tesla.js'

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
  /** Delete a session and its points: a drive that went nowhere. See `wentNowhere`. */
  discardSession(sessionId: string): Promise<void>
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

export interface PipelineResult {
  /** Samples handed to the store. Rows may be deduplicated by the store. */
  samples: number
  sessionsOpened: number
  sessionsClosed: number
  /** Field messages whose value landed in the accumulator. */
  fieldsApplied: number
  /**
   * Messages carrying nothing we could place: an unknown field, an unreadable
   * value, or values the accumulator already held (a resubscribe's re-sent
   * snapshot), none of which landed.
   */
  unmapped: number
  /**
   * Properties that arrived without a usable timestamp of their own and were
   * stamped with the message's arrival instead (spec §6.4). Always 0 for Tesla,
   * which publishes none; for Rivian it is the count a rising
   * `ev_ingest_untimed_values_total` is read from.
   */
  untimed: number
  /** Timestamp of the newest sample emitted here, for the staleness gauge. */
  lastSampleTs: Date | null
}

const EMPTY: PipelineResult = {
  samples: 0, sessionsOpened: 0, sessionsClosed: 0,
  fieldsApplied: 0, unmapped: 0, untimed: 0, lastSampleTs: null,
}

/** One field's latest value and when that value arrived. */
interface Entry {
  value: unknown
  /**
   * What the carry window runs from: the vehicle's own observation time where
   * the profile gave one, otherwise the arrival of the frame that carried it.
   */
  at: number
  /**
   * The vehicle's observation time, set only when `Decoded.observedAt` gave one.
   * It is what separates "newer than what we hold" from "merely arrived later"
   * (see `apply`), and is undefined for every Tesla value.
   */
  observed?: number | undefined
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
 *
 * Arrival drives WHEN a sample is emitted; it need not drive how long a value is
 * carried. Where the profile says when the vehicle observed a value
 * (`Decoded.observedAt`, spec §6.4) the carry window runs from that, so a
 * snapshot re-sent after a resubscribe cannot make an old value look new.
 * Everything vendor-specific - the windows, the charge slots - is the profile's.
 */
export class FieldAccumulator {
  private slots = new Map<string, Entry>()
  /** Arrival of the newest field in the pending sample. */
  private newestAt: number | null = null
  /** Arrival of the oldest field in the pending sample, for the hard-ceiling rule. */
  private pendingSince: number | null = null

  constructor(private readonly profile: VendorProfile) {}

  /**
   * Fold one decoded message in. `at` is the message's arrival, which drives the
   * emit timing whatever the values inside say about when they were observed.
   *
   * Returns whether ANY slot landed. A message whose every slot was superseded
   * (an older observation than the one held, or the same observation of the same
   * value) changes nothing, and it must not look like something did: it leaves
   * `newestAt` and `pendingSince` alone, so no sample is scheduled for it, and
   * the caller counts it as unmapped rather than applied. The connector
   * resubscribes after every 60 s of silence and the snapshot re-sends the car's
   * last-known values with their original stamps, so a parked car delivers a
   * message of exactly this kind every minute. Scheduled as news, each would emit
   * a carried-state sample stamped at ITS arrival: a charge last seen at 08:30
   * kept getting samples through the afternoon, which defeated the segmenter's
   * one-hour gap close, and a drive last seen in D was held open the same way.
   * Tesla never sets `observedAt`, so every defined value lands there and this is
   * always true for it.
   */
  apply(decoded: Decoded, at: Date): boolean {
    const ms = at.getTime()
    // Decide what lands BEFORE anything moves, so that "is this charging" is
    // judged over the slots that actually land, against the values held before
    // this frame (a rising counter is judged against where it stood).
    const landing = new Map<string, Entry>()
    for (const [key, value] of Object.entries(decoded.slots)) {
      if (value === undefined) continue
      // The vehicle's own observation time where the vendor gives one (spec
      // §6.4), never later than the frame that carried it; arrival otherwise.
      const observed = decoded.observedAt?.[key]
      const stamp = observed === undefined ? ms : Math.min(observed, ms)
      // A re-sent snapshot can carry an OLDER observation than the one we hold
      // (a resubscribe replays the car's last-known values); it must not
      // overwrite a newer one. Only values with an observation time compete
      // this way - Tesla never sets one, so its behaviour is unchanged.
      //
      // The SAME observation of the SAME value is a replay too, and is a no-op
      // rather than a rewrite: the held entry's `at` may since have been moved
      // forward by the charge refresh below, and rewriting it would put `at`
      // back at the observation and shorten the carry window the refresh
      // bought. It is strictly the same observation AND the same value - a
      // different value at the same instant is real news and still applies.
      const held = this.slots.get(key)
      if (observed !== undefined && held?.observed !== undefined) {
        if (stamp < held.observed) continue
        if (stamp === held.observed && isDeepStrictEqual(value, held.value)) continue
      }
      landing.set(key, { value, at: stamp, observed: observed === undefined ? undefined : stamp })
    }
    if (landing.size === 0) return false
    // Over what landed, not over what arrived: an older power or energy value
    // that was skipped above is a replay, and must not refresh the charge state
    // as if the car had just said it.
    const charging = this.showsCharging(landing)
    for (const [key, entry] of landing) this.slots.set(key, entry)
    if (charging) {
      for (const key of this.profile.chargeStateSlots) {
        const entry = this.slots.get(key)
        // A new entry, not a mutation: `clone` shares entries with its copy. It
        // keeps `observed`: the refresh moves when we last heard of the value,
        // not when the car saw it, and dropping that would let an older replay
        // of the same slot past the guard above.
        if (entry) this.slots.set(key, { value: entry.value, at: ms, observed: entry.observed })
      }
    }
    this.newestAt = ms
    this.pendingSince ??= ms
    return true
  }

  /**
   * Positive power, or an energy counter above where it stood. The slots are the
   * profile's; the reasoning is on `CHARGE_STATE_SLOTS` in `profiles/tesla.ts`.
   */
  private showsCharging(landing: ReadonlyMap<string, Entry>): boolean {
    for (const key of this.profile.chargingPowerSlots) {
      const value = landing.get(key)?.value
      if (typeof value === 'number' && value > 0) return true
    }
    for (const key of this.profile.chargingEnergySlots) {
      const value = landing.get(key)?.value
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
   * field. Values older than the profile's window for their slot (measured from
   * when the vehicle observed them, where it said) are dropped rather than carried.
   */
  take(): { state: Record<string, unknown>; ts: Date } | null {
    if (this.newestAt === null) return null
    const ts = this.newestAt
    const state: Record<string, unknown> = {}
    for (const [key, entry] of this.slots) {
      if (ts - entry.at >= this.profile.staleWindowFor(key)) {
        this.slots.delete(key)
        continue
      }
      state[key] = entry.value
    }
    this.pendingSince = null
    // newestAt is kept: it is the anchor for the staleness of what remains.
    return { state, ts: new Date(ts) }
  }

  /** Deep enough copy for transaction rollback. Entries are immutable. */
  clone(): FieldAccumulator {
    const copy = new FieldAccumulator(this.profile)
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
  /** The tail of the work queue. See `locked`. */
  private chain: Promise<unknown> = Promise.resolve()

  /**
   * `profile` is the vendor: how a message is read, how long each slot stays
   * true, which slots mean a charge is going on, and how the merged state
   * becomes a row. The pipeline itself names no vendor.
   *
   * `home` is optional and defaults to off, because EV_HOME_LAT/LON are
   * optional: without them the coordinate fallback is disabled and the car's
   * own `locatedAtHome` is the only test of where a charge happened, which is
   * the better signal anyway (spec §3.8).
   */
  constructor(
    private profile: VendorProfile,
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

      const decoded = this.profile.decode(raw)
      // Applied only if something LANDED. A message that decodes but is wholly
      // superseded (a resubscribe's re-sent snapshot) is the same as one that
      // decodes to nothing: counted unmapped, and no sample scheduled for it.
      if (decoded !== null && acc.apply(decoded, raw.receivedAt)) {
        result.fieldsApplied = 1
      } else {
        result.unmapped = 1
      }
      result.untimed = decoded?.untimed ?? 0

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
   *
   * The lock is taken ONCE for the whole loop, and each emit is an `attempt`
   * inside it. Two reasons. Taking it per vehicle would let a handle() slip in
   * between two emits of one flush; and the loop reads `this.accumulators`, which
   * a queued handle may be about to change, so it must not start until that
   * handle has run. Each accumulator is re-read from the map as the loop reaches
   * it, because an `attempt` that rolls back replaces the whole map with its
   * snapshot's clones, and an accumulator held from before would be one the
   * pipeline no longer owns.
   */
  async flush(now: Date = new Date(), force = false): Promise<PipelineResult> {
    return this.locked(async () => {
      let result = { ...EMPTY }
      for (const vehicleId of [...this.accumulators.keys()]) {
        const acc = this.accumulators.get(vehicleId)
        if (!acc || !(force ? acc.pending : acc.due(now))) continue
        result = merge(
          result,
          await this.attempt((store) => this.emit(store, vehicleId, this.accumulators.get(vehicleId)!)),
        )
      }
      return result
    })
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
   *
   * NOT SAFE UNDER LIVE TRAFFIC. It swaps `this.runner` for the dry store
   * without holding the lock, so a handle() or flush() arriving meanwhile would
   * run against the dry store and its writes would vanish. It is only safe
   * before the subscription and the flush timer start, which is where `main.ts`
   * calls it.
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
      ...EMPTY, replayed, resumed: null, closed: [], abandoned: [], discarded: [],
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
        const kept = await this.finish(store, row.id, row.kind, match.points)
        ;(kept ? report.closed : report.discarded).push(row)
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
    report.sessionsClosed = report.closed.length + report.abandoned.length + report.discarded.length
    return report
  }

  private accumulatorFor(vehicleId: string): FieldAccumulator {
    let acc = this.accumulators.get(vehicleId)
    if (!acc) {
      acc = new FieldAccumulator(this.profile)
      this.accumulators.set(vehicleId, acc)
    }
    return acc
  }

  private async emit(
    store: Store, vehicleId: string, acc: FieldAccumulator,
  ): Promise<PipelineResult> {
    const pending = acc.take()
    if (!pending) return { ...EMPTY }
    return this.applySample(store, this.profile.toSample(vehicleId, pending.ts, pending.state))
  }

  /**
   * One unit of work at a time. The flush timer used to be able to run in the
   * middle of a handle(): each snapshots the in-memory state, and a rollback in
   * one restored its snapshot over the other's committed progress - and flush
   * read `this.accumulators` before a queued handle had run. A promise chain,
   * not a mutex library. The queue is short but not bounded to one flush: the
   * flush timer fires every second with no in-flight guard (main.ts), so a
   * stalled transaction queues a flush per tick behind it, plus the message
   * mqtt.js is waiting on. They drain in order once it resolves, and a flush
   * that finds nothing due is cheap.
   *
   * NEVER call `locked` or `transactionally` from inside a `locked` callback:
   * the inner call would wait on the outer one forever.
   */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => undefined)
    return next
  }

  /** Snapshot, run one transaction, restore on failure. No lock: callers hold it. */
  private async attempt<T>(fn: (store: Store) => Promise<T>): Promise<T> {
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

  private transactionally<T>(fn: (store: Store) => Promise<T>): Promise<T> {
    return this.locked(() => this.attempt(fn))
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

  /** Close a session, or discard it if it was a drive that went nowhere; true if kept. */
  private async finish(
    store: Store, sessionId: string, kind: SessionKind, points: VehicleSample[],
  ): Promise<boolean> {
    const summary = summariseSession(kind, points, this.opts)
    if (kind === 'drive' && wentNowhere(summary, points)) {
      await store.discardSession(sessionId)
      return false
    }
    await store.closeSession(sessionId, summary)

    // Two things hang off a closing charge and nothing hangs off a closing
    // drive, so the guard is here, once, rather than at the top of each. It
    // used to live inside the battery block below — where it read as that
    // block's own early return, and where anything appended after the block
    // would silently never run. Both consequences are charge-only for the same
    // reason: a drive's energy is inferred from a nameplate capacity rather
    // than measured, so neither a capacity estimate nor a price could be
    // anything but circular.
    if (kind !== 'charge') return true
    await this.recordHealth(store, summary, points)
    await this.attachCost(store, sessionId, summary, points)
    return true
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

function merge(a: PipelineResult, b: PipelineResult): PipelineResult {
  return {
    samples: a.samples + b.samples,
    sessionsOpened: a.sessionsOpened + b.sessionsOpened,
    sessionsClosed: a.sessionsClosed + b.sessionsClosed,
    fieldsApplied: a.fieldsApplied + b.fieldsApplied,
    unmapped: a.unmapped + b.unmapped,
    untimed: a.untimed + b.untimed,
    lastSampleTs: later(a.lastSampleTs, b.lastSampleTs),
  }
}

/**
 * The fastest a drive may go and still count as going nowhere, in km/h.
 *
 * Walking pace with room to spare: the shuffles this is for (2026-09-14,
 * 09-15, 09-26, 09-27, pulling into the garage after stopping at the door)
 * topped out at 2-6 km/h, and the shortest real trip on the tape, 0.16 km on
 * 2026-09-09, reached 23.
 */
export const NOWHERE_MAX_SPEED_KPH = 10

/**
 * A drive that went nowhere: the odometer never moved and it never went
 * faster than NOWHERE_MAX_SPEED_KPH. The car really moved, into the garage or
 * across the driveway, but it was not a trip, and kept it would count as one
 * in the drive list and totals. `finish` deletes it rather than close it.
 */
export function wentNowhere(summary: SessionSummary, points: readonly VehicleSample[]): boolean {
  if (summary.distanceKm !== null && summary.distanceKm > 0) return false
  return points.every((p) => p.speedKph === null || p.speedKph <= NOWHERE_MAX_SPEED_KPH)
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
  /** Open rows whose drive ended having gone nowhere, deleted. */
  discarded: OpenRow[]
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
  async discardSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (s) {
      s.closed = true
      s.endedAt = s.points.at(-1)?.ts ?? s.startedAt
    }
  }
  async resetSession(): Promise<void> {}
  async recordBatteryHealth(): Promise<void> {}
  async recordMeasuredCapacity(): Promise<void> {}
  async rateAt(): Promise<EnergyPrice | null> {
    return null
  }
  async recordSessionCost(): Promise<void> {}
  async advanceCursor(): Promise<void> {}
}
