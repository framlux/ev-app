import {
  estimateCapacity,
  initialState,
  normaliseIfKnown,
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
  advanceCursor(at: Date): Promise<void>
}

export interface BatteryHealthWrite {
  vehicleId: string
  observedOn: Date
  estimatedCapacityKwh: number
  ratedRangeAt100Km: number | null
  sampleConfidence: number
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
  /** Timestamp of the newest sample in this message, for the staleness gauge. */
  lastSampleTs: Date | null
}

const EMPTY: PipelineResult = {
  samples: 0, sessionsOpened: 0, sessionsClosed: 0, lastSampleTs: null,
}

/** Everything that must be rolled back with the transaction. */
interface Snapshot {
  state: SegmenterState
  openId: string | null
  openPoints: VehicleSample[]
  ensuredMonths: Set<string>
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

  constructor(private runner: StoreRunner, private opts: MetricsOptions) {}

  /**
   * Raw first, always. The tape is what makes everything else rebuildable, so a
   * crash between the two writes must never lose the message — and because both
   * writes share one transaction, there is no window in which one exists
   * without the other.
   */
  async handle(raw: RawMessage): Promise<PipelineResult> {
    return this.transactionally(async (store) => {
      await this.ensureMonth(store, raw.receivedAt)
      await store.insertRaw(raw)

      let result = { ...EMPTY }
      for (const sample of normaliseIfKnown(raw)) {
        result = merge(result, await this.applySample(store, sample))
      }
      // Inside the transaction: a watermark that survived a rolled-back message
      // would claim progress that never happened.
      await store.advanceCursor(raw.receivedAt)
      return result
    })
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

  private async transactionally<T>(fn: (store: Store) => Promise<T>): Promise<T> {
    const snapshot = this.snapshot()
    try {
      return await this.runner.run(fn)
    } catch (err) {
      // The transaction rolled back, so the in-memory segmenter must too.
      // Leaving it advanced would make the redelivery of this message land in a
      // state that no longer matches the database.
      this.restore(snapshot)
      throw err
    }
  }

  private async applySample(store: Store, sample: VehicleSample): Promise<PipelineResult> {
    await this.ensureMonth(store, sample.ts)
    await store.insertSample(sample)

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

    return { samples: 1, sessionsOpened: opened, sessionsClosed: closed, lastSampleTs: sample.ts }
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

  private async ensureMonth(store: Store, when: Date): Promise<void> {
    const key = `${when.getUTCFullYear()}-${when.getUTCMonth()}`
    if (this.ensuredMonths.has(key)) return
    await store.ensurePartitions(when)
    this.ensuredMonths.add(key)
  }

  private snapshot(): Snapshot {
    return {
      state: this.state,
      openId: this.openId,
      openPoints: [...this.openPoints],
      ensuredMonths: new Set(this.ensuredMonths),
    }
  }

  private restore(s: Snapshot): void {
    this.state = s.state
    this.openId = s.openId
    this.openPoints = s.openPoints
    this.ensuredMonths = s.ensuredMonths
  }
}

function merge(a: PipelineResult, b: PipelineResult): PipelineResult {
  return {
    samples: a.samples + b.samples,
    sessionsOpened: a.sessionsOpened + b.sessionsOpened,
    sessionsClosed: a.sessionsClosed + b.sessionsClosed,
    lastSampleTs: later(a.lastSampleTs, b.lastSampleTs),
  }
}

function later(a: Date | null, b: Date | null): Date | null {
  if (!a) return b
  if (!b) return a
  return a.getTime() >= b.getTime() ? a : b
}
