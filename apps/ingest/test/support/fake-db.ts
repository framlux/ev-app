import type { RawMessage, SessionKind, SessionSummary, VehicleSample } from '@ev/core'
import type {
  BatteryHealthWrite, MeasuredCapacityWrite, SessionCostWrite, Store, StoreRunner,
} from '../../src/pipeline.js'
import type { EnergyPrice } from '../../src/pricing.js'

/**
 * An in-memory stand-in for the Postgres side of the worker.
 *
 * It is not a generic mock: it reproduces the three schema behaviours the
 * pipeline's correctness actually rests on, so that a test passing here means
 * something about the real database.
 *
 *  - `sample` has PRIMARY KEY (vehicle_id, ts) and inserts DO NOTHING on
 *    conflict, so a replayed message adds no row.
 *  - `session_one_open_per_kind` is a partial unique index, so a second open
 *    session of the same kind is impossible and `openSession` adopts the
 *    existing one instead.
 *  - `run()` is a transaction: writes are only visible once it resolves, and a
 *    throw rolls everything back.
 *  - `rateAt` applies `energy_rate`'s real ORDER BY, tiebreak included, so a
 *    test can seed a manual override beside a URDB row and get the answer
 *    Postgres would give.
 */
export interface FakeSession {
  id: string
  vehicleId: string
  kind: SessionKind
  startedAt: Date
  isOpen: boolean
  summary: SessionSummary | null
}

/** A seeded row of `energy_rate`. Order does not matter; `rateAt` sorts. */
export interface FakeRate extends EnergyPrice {
  effectiveFrom: Date
}

export interface FakeState {
  raw: RawMessage[]
  samples: VehicleSample[]
  sessions: FakeSession[]
  points: { sessionId: string; ts: Date }[]
  battery: BatteryHealthWrite[]
  measured: MeasuredCapacityWrite[]
  partitions: string[]
  cursor: Date | null
  /** Seeded by the test. Nothing in the pipeline writes rates. */
  rates: FakeRate[]
  costs: SessionCostWrite[]
  /**
   * Every instant `rateAt` was asked about.
   *
   * Recorded rather than counted because both halves matter: that the lookup
   * happens at all only for a charge that could be priced, and that the instant
   * is the session's own start rather than the wall clock.
   */
  rateLookups: Date[]
}

function emptyState(): FakeState {
  return {
    raw: [], samples: [], sessions: [], points: [],
    battery: [], measured: [], partitions: [], cursor: null,
    rates: [], costs: [], rateLookups: [],
  }
}

export class FakeDb implements StoreRunner {
  state: FakeState = emptyState()
  /** Ordered trace of transaction outcomes and, in the MQTT tests, acks. */
  readonly log: string[] = []
  /** Set to make the next `run()` fail after the callback's writes. */
  failNextCommit: Error | null = null
  private nextId = 1

  async run<T>(fn: (store: Store) => Promise<T>): Promise<T> {
    // structuredClone gives a genuine rollback: the callback mutates the live
    // state as it goes, exactly as SQL statements do inside a transaction.
    const before = structuredClone(this.state)
    try {
      const out = await fn(this.store())
      if (this.failNextCommit) {
        const err = this.failNextCommit
        this.failNextCommit = null
        throw err
      }
      this.log.push('commit')
      return out
    } catch (err) {
      this.state = before
      this.log.push('rollback')
      throw err
    }
  }

  private store(): Store {
    const s = this.state
    return {
      ensurePartitions: async (when) => {
        s.partitions.push(`${when.getUTCFullYear()}-${when.getUTCMonth()}`)
      },
      insertRaw: async (m) => { s.raw.push(m) },
      insertSample: async (sample) => {
        const clash = s.samples.some(
          (x) => x.vehicleId === sample.vehicleId && x.ts.getTime() === sample.ts.getTime())
        if (!clash) s.samples.push(sample)
      },
      openSession: async (kind, vehicleId, at) => {
        const existing = s.sessions.find(
          (x) => x.vehicleId === vehicleId && x.kind === kind && x.isOpen)
        if (existing) return existing.id
        const id = `s${this.nextId++}`
        s.sessions.push({ id, vehicleId, kind, startedAt: at, isOpen: true, summary: null })
        return id
      },
      appendPoint: async (sessionId, sample) => {
        // session_point.session_id is a foreign key. Modelling it matters: it
        // is what turns "the worker kept an id from a rolled-back transaction"
        // into a visible failure rather than an orphaned row.
        if (!s.sessions.some((x) => x.id === sessionId)) {
          throw new Error(`appendPoint: no session ${sessionId}`)
        }
        const clash = s.points.some(
          (p) => p.sessionId === sessionId && p.ts.getTime() === sample.ts.getTime())
        if (!clash) s.points.push({ sessionId, ts: sample.ts })
      },
      closeSession: async (sessionId, summary) => {
        const session = s.sessions.find((x) => x.id === sessionId)
        if (!session) throw new Error(`closeSession: no session ${sessionId}`)
        session.isOpen = false
        session.summary = summary
      },
      recordBatteryHealth: async (row) => { s.battery.push(row) },
      rateAt: async (at) => {
        s.rateLookups.push(at)
        // effective_from DESC, then manual before urdb — the tiebreak exists
        // because a human typing a rate is contradicting the fetch on purpose,
        // and without it the winner would be whichever row the planner reached
        // first.
        const covering = s.rates
          .filter((r) => r.effectiveFrom.getTime() <= at.getTime())
          .sort((a, b) =>
            b.effectiveFrom.getTime() - a.effectiveFrom.getTime() ||
            Number(b.source === 'manual') - Number(a.source === 'manual'))
        return covering[0] ?? null
      },
      recordSessionCost: async (row) => {
        // `priceSession` matches on kind='charge' as well as the id, so a price
        // aimed at a drive changes nothing rather than contradicting the read
        // API's promise that drives have none.
        const session = s.sessions.find((x) => x.id === row.sessionId)
        if (session?.kind !== 'charge') return
        s.costs.push(row)
      },
      recordMeasuredCapacity: async (row) => { s.measured.push(row) },
      advanceCursor: async (at) => {
        if (!s.cursor || at.getTime() > s.cursor.getTime()) s.cursor = at
      },
    }
  }
}

export function openSessions(db: FakeDb): FakeSession[] {
  return db.state.sessions.filter((x) => x.isOpen)
}
