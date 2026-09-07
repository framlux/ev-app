import { describe, expect, it } from 'vitest'
import { makeSample, type VehicleSample } from '@ev/core'
import {
  parseArgs,
  runBackfill,
  type BackfillCharge,
  type BackfillStore,
} from '../src/backfill-costs.js'
import type { ChargeCost, EnergyPrice, HomeLocation } from '../src/pricing.js'

/**
 * The backfill, driven entirely through its store seam.
 *
 * Every figure this script writes is an estimate, and the two things that keep
 * that honest are behavioural rather than arithmetic: it must never overwrite a
 * price somebody else established, and running it again must be a no-op. Both
 * are properties of a second run, so most of what follows runs the thing twice
 * and asserts the difference.
 */

const HOME: HomeLocation = { lat: 47.6062, lon: -122.3321, radiusKm: 0.1 }
const NOW = new Date('2026-09-07T12:00:00.000Z')
const RATE: EnergyPrice = { pricePerKwh: 0.11256, currency: 'USD', source: 'urdb' }

/** A charge two streets from home, well outside the 100 m radius. */
const AWAY = { lat: 47.6162, lon: -122.3421 }

interface Row extends BackfillCharge {
  cost: number | null
  costCurrency: string | null
  costRatePerKwh: number | null
  costSource: string | null
  samples: VehicleSample[]
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: `s-${Math.random().toString(36).slice(2, 8)}`,
    vehicleId: 'veh-1',
    startedAt: new Date('2025-03-04T02:00:00.000Z'),
    endedAt: new Date('2025-03-04T06:00:00.000Z'),
    energyKwh: 41.2,
    startLat: HOME.lat,
    startLon: HOME.lon,
    costBasis: null,
    cost: null,
    costCurrency: null,
    costRatePerKwh: null,
    costSource: null,
    samples: [],
    ...over,
  }
}

function sample(over: Partial<VehicleSample> = {}): VehicleSample {
  return makeSample({
    vehicleId: 'veh-1', ts: new Date('2025-03-04T03:00:00.000Z'), ...over,
  })
}

/**
 * The `session` table as much of it as the backfill touches, with the same
 * predicate the real query carries: a row that already has a figure, or already
 * names where its figure came from, is not offered again.
 */
class FakeStore implements BackfillStore {
  rateLookups: Date[] = []
  writes: { id: string; cost: ChargeCost }[] = []

  constructor(readonly rows: Row[], readonly rate: EnergyPrice | null = RATE) {}

  async unpricedCharges(): Promise<BackfillCharge[]> {
    return this.rows.filter((r) => r.cost === null && r.costSource === null)
  }

  async samplesFor(c: BackfillCharge): Promise<VehicleSample[]> {
    return this.rows.find((r) => r.id === c.id)?.samples ?? []
  }

  async currentRate(at: Date): Promise<EnergyPrice | null> {
    this.rateLookups.push(at)
    return this.rate
  }

  async priceCharge(id: string, cost: ChargeCost): Promise<void> {
    this.writes.push({ id, cost })
    const r = this.rows.find((x) => x.id === id)
    if (!r) throw new Error(`no such session ${id}`)
    Object.assign(r, cost)
  }
}

describe('parseArgs', () => {
  it('writes nothing unless the operator asks for it', () => {
    expect(parseArgs([]).apply).toBe(false)
    expect(parseArgs(['--dry-run']).apply).toBe(false)
    expect(parseArgs(['--apply']).apply).toBe(true)
  })

  // A misspelled flag must not be the difference between a report and a year of
  // invented figures written to the database, so anything unrecognised stops
  // the run rather than falling through to the safe-looking default.
  it('refuses a flag it does not recognise', () => {
    expect(() => parseArgs(['--aply'])).toThrow(/--aply/)
    expect(() => parseArgs(['--from', '2025-01-01'])).toThrow(/--from/)
  })
})

describe('runBackfill', () => {
  it('prices a charge that started at home, and marks the figure an estimate', async () => {
    const store = new FakeStore([row({ id: 'a' })])

    const counts = await runBackfill(store, { home: HOME, now: NOW, apply: true })

    expect(counts.priced).toBe(1)
    expect(store.writes).toHaveLength(1)
    const written = store.writes[0]?.cost
    // 41.2 kWh at 11.256c.
    expect(written?.cost).toBeCloseTo(4.64, 2)
    expect(written?.costBasis).toBe('home')
    expect(written?.costRatePerKwh).toBeCloseTo(0.11256, 5)
    expect(written?.costCurrency).toBe('USD')
    // Never the rate's own source. `urdb` would claim we knew this price in
    // March 2025, and the estimate marker is the only thing separating a
    // figure we measured from one we invented.
    expect(written?.costSource).toBe('backfill-estimate')
  })

  // The classifier is imported rather than reimplemented, so a session the car
  // itself placed at home is priced on that evidence and needs no coordinates.
  it('accepts the car\'s own locatedAtHome over the coordinate fallback', async () => {
    const store = new FakeStore([
      row({ id: 'a', startLat: AWAY.lat, startLon: AWAY.lon, samples: [sample({ locatedAtHome: true })] }),
    ])

    const counts = await runBackfill(store, { home: HOME, now: NOW, apply: true })

    expect(counts.priced).toBe(1)
    expect(store.writes[0]?.cost.costBasis).toBe('home')
  })

  // §3.5 will price these against what Tesla actually billed, or give up on
  // them at 45 days. An estimate written here would look like the answer and
  // would stop the reconciliation ever running: its work guard reads
  // `cost IS NULL`.
  it('never touches a charge awaiting a Tesla invoice', async () => {
    const store = new FakeStore([
      row({ id: 'a', costBasis: 'pending', startLat: AWAY.lat, startLon: AWAY.lon }),
    ])

    const counts = await runBackfill(store, { home: HOME, now: NOW, apply: true })

    expect(counts.skipped).toBe(1)
    expect(counts.priced).toBe(0)
    expect(store.writes).toEqual([])
  })

  // A charge whose connector says Tesla might bill it becomes pending, not an
  // estimate, even though nothing at close time ever classified it.
  it('leaves a Supercharged session for the reconciliation to price', async () => {
    const store = new FakeStore([
      row({
        id: 'a', startLat: AWAY.lat, startLon: AWAY.lon,
        samples: [sample({ fastChargerPresent: true, fastChargerType: 'FastChargerSupercharger' })],
      }),
    ])

    const counts = await runBackfill(store, { home: HOME, now: NOW, apply: true })

    expect(counts.pending).toBe(1)
    expect(store.writes[0]?.cost).toMatchObject({ costBasis: 'pending', cost: null, costSource: null })
  })

  it('leaves a charge it cannot place unknown rather than guessing at home', async () => {
    const store = new FakeStore([
      row({ id: 'a', startLat: null, startLon: null }),
    ])

    const counts = await runBackfill(store, { home: HOME, now: NOW, apply: true })

    expect(counts.unknown).toBe(1)
    expect(store.writes[0]?.cost).toMatchObject({ costBasis: 'unknown', cost: null })
  })

  // Rather than the rate in force when it was charged, which is the whole cost
  // of this script and the reason its rows are marked. One lookup for the run:
  // per-session would be the same answer fetched once per charge.
  it('prices every session at one rate, read for today', async () => {
    const store = new FakeStore([row({ id: 'a' }), row({ id: 'b' })])

    await runBackfill(store, { home: HOME, now: NOW, apply: true })

    expect(store.rateLookups).toEqual([NOW])
  })

  it('reports what it would do without writing, and the same run applies it', async () => {
    const rows = [row({ id: 'a' }), row({ id: 'b', startLat: null, startLon: null })]
    const dry = new FakeStore(rows.map((r) => ({ ...r })))
    const wet = new FakeStore(rows.map((r) => ({ ...r })))

    const planned = await runBackfill(dry, { home: HOME, now: NOW, apply: false })
    const done = await runBackfill(wet, { home: HOME, now: NOW, apply: true })

    expect(dry.writes).toEqual([])
    expect(planned).toEqual(done)
    expect(planned.priced).toBe(1)
    expect(planned.unknown).toBe(1)
  })

  // The property that makes this safe to run twice by accident: the second run
  // finds a figure already there and offers the row to nobody.
  it('writes nothing on a second run', async () => {
    const store = new FakeStore([row({ id: 'a' }), row({ id: 'b', startLat: null, startLon: null })])

    await runBackfill(store, { home: HOME, now: NOW, apply: true })
    const before = store.writes.length
    const second = await runBackfill(store, { home: HOME, now: NOW, apply: true })

    expect(store.writes).toHaveLength(before)
    expect(second.unchanged).toBe(1)
    expect(second.priced).toBe(0)
  })

  // A rate could move between two runs, and the second run must not re-price
  // history at the newer number: the marker identifies the rows a properly
  // dated backfill will correct, and rewriting them would move that target.
  it('leaves an estimate it already wrote alone when the rate has changed', async () => {
    const store = new FakeStore(
      [row({ id: 'a', cost: 4.64, costSource: 'backfill-estimate', costBasis: 'home', costRatePerKwh: 0.11256 })],
      { pricePerKwh: 0.2, currency: 'USD', source: 'manual' },
    )

    const counts = await runBackfill(store, { home: HOME, now: NOW, apply: true })

    expect(store.writes).toEqual([])
    expect(counts.considered).toBe(0)
  })

  // Nothing here may overwrite a measured price, and the guard is the same
  // predicate for a real one as for an estimate: a row that names its source
  // is a row somebody else owns.
  it('never overwrites a price that came from a real rate', async () => {
    const store = new FakeStore([
      row({ id: 'a', cost: 4.1, costSource: 'manual', costBasis: 'home', costCurrency: 'USD' }),
    ])

    await runBackfill(store, { home: HOME, now: NOW, apply: true })

    expect(store.writes).toEqual([])
  })

  // With no rate at all, a home charge is still home: we know where the
  // electrons came from and have no number for them, and saying so is worth a
  // write. Saying it twice is not.
  it('records the basis when there is no rate to price at, once', async () => {
    const store = new FakeStore([row({ id: 'a' })], null)

    const first = await runBackfill(store, { home: HOME, now: NOW, apply: true })
    const second = await runBackfill(store, { home: HOME, now: NOW, apply: true })

    expect(first.unpriced).toBe(1)
    expect(store.writes[0]?.cost).toMatchObject({ costBasis: 'home', cost: null, costSource: null })
    expect(second.unchanged).toBe(1)
    expect(store.writes).toHaveLength(1)
  })

  // Without coordinates configured and without the signal, every charge is
  // unplaceable — a working configuration, and one whose report says plainly
  // that it priced nothing rather than looking like a successful run.
  it('prices nothing when no home is configured and the signal never arrived', async () => {
    const store = new FakeStore([row({ id: 'a' })])

    const counts = await runBackfill(store, { home: null, now: NOW, apply: true })

    expect(counts.priced).toBe(0)
    expect(counts.unknown).toBe(1)
  })

  it('counts every session it looked at', async () => {
    const store = new FakeStore([
      row({ id: 'a' }),
      row({ id: 'b', startLat: null, startLon: null }),
      row({ id: 'c', costBasis: 'pending' }),
    ])

    const counts = await runBackfill(store, { home: HOME, now: NOW, apply: true })

    expect(counts.considered).toBe(3)
    expect(counts.priced + counts.unpriced + counts.unknown + counts.pending +
      counts.skipped + counts.unchanged).toBe(3)
  })
})
