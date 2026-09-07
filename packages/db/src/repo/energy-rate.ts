import type { DbClient } from './types.js'

/** Where a rate came from. 'manual' is a human typing the number in (§3.2). */
export type RateSource = 'urdb' | 'manual'

/**
 * One price, and the window it opens (spec §3.1).
 *
 * `pricePerKwh` is a `number`, and that is load-bearing rather than obvious.
 * The column is NUMERIC, node-postgres hands NUMERIC back as a STRING to
 * preserve precision it cannot fit in a double, and this package installs no
 * `setTypeParser` — the only coercion anywhere in the repo lives in the web
 * tier's `queries.ts`, which the ingest worker never goes through. Left as it
 * arrives, `energyKwh * rate` would coerce by luck while `rate + fee`
 * concatenated and `rate.toFixed(2)` threw. `rateAt` converts once, here, so no
 * caller has to know.
 */
export interface EnergyRate {
  id: string
  effectiveFrom: Date
  pricePerKwh: number
  currency: string
  source: RateSource
  /** The URDB page label the value was read from; null on a manual row. */
  urdbLabel: string | null
  /** When we learned it. The gap from `effectiveFrom` is URDB's lag (§6). */
  fetchedAt: Date
}

/**
 * What a writer knows. Every field is required even where the column has a
 * default, for the reason `TelemetryCheck` gives: a caller that means "USD"
 * says USD, and a caller with no label says null out loud. An optional key
 * would let a URDB fetch omit its label by accident and leave the row
 * indistinguishable from a manual one on everything but `source`.
 */
export interface EnergyRateInsert {
  effectiveFrom: Date
  pricePerKwh: number
  currency: string
  source: RateSource
  urdbLabel: string | null
}

const SELECT = `SELECT id, effective_from, price_per_kwh, currency, source,
                       urdb_label, fetched_at FROM energy_rate`

function toRate(r: Record<string, unknown>): EnergyRate {
  return {
    id: r['id'] as string,
    effectiveFrom: r['effective_from'] as Date,
    // The coercion the interface promises. See the comment on `EnergyRate`.
    pricePerKwh: Number(r['price_per_kwh']),
    currency: r['currency'] as string,
    source: r['source'] as RateSource,
    urdbLabel: (r['urdb_label'] ?? null) as string | null,
    fetchedAt: r['fetched_at'] as Date,
  }
}

/**
 * The rate in force at an instant (spec §3.2): the greatest `effective_from`
 * that is not after `at`.
 *
 * The second sort key is the whole reason this is not a one-liner. A manual
 * override and a URDB row can legitimately share an instant — the UNIQUE is on
 * the pair, precisely so the human can contradict the fetch at the same moment
 * — and with only `effective_from DESC` the winner would be whichever row the
 * planner reached first. `(source = 'manual') DESC` puts true before false, so
 * the number someone typed on purpose wins the tie it was written to win.
 *
 * NULL for a moment before every row, rather than the oldest rate. A charge
 * older than our first price is unpriced, and it says so; inventing a rate
 * backwards is what §5's backfill does deliberately and visibly, marked as an
 * estimate. Falling back to the oldest row here would do the same thing
 * silently and label the result a measurement.
 */
export async function rateAt(c: DbClient, at: Date): Promise<EnergyRate | null> {
  const { rows } = await c.query(
    `${SELECT} WHERE effective_from <= $1
      ORDER BY effective_from DESC, (source = 'manual') DESC LIMIT 1`,
    [at])
  const r = rows[0]
  return r ? toRate(r) : null
}

/**
 * Record a price, or leave the one already recorded alone.
 *
 * DO NOTHING on the (effective_from, source) UNIQUE, because the writer is a
 * daily timer (§3.3) that finds the same answer nearly every time and a restart
 * loop must not be able to fill the table. It returns the new row's id, or null
 * when the row was already there — which is the only way the caller can tell a
 * genuine insert from a replay, since neither raises.
 *
 * Deliberately not an upsert. A rate someone charged at is a historical fact
 * (§4), so the write that would change one is a bug in the caller rather than a
 * correction; a second opinion about the same instant arrives as a `manual` row
 * beside the `urdb` one and wins through `rateAt`'s tiebreak.
 */
export async function insertRate(
  c: DbClient, r: EnergyRateInsert,
): Promise<string | null> {
  const { rows } = await c.query(
    `INSERT INTO energy_rate (effective_from, price_per_kwh, currency, source, urdb_label)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (effective_from, source) DO NOTHING
     RETURNING id`,
    [r.effectiveFrom, r.pricePerKwh, r.currency, r.source, r.urdbLabel])
  return (rows[0]?.id as string | undefined) ?? null
}

/**
 * The rate history, newest first, for the settings page (§4).
 *
 * Bounded by a limit rather than returning the table, because this is read on a
 * page render and the table only ever grows. Newest first because that is the
 * order the question is asked in — "what am I paying, and what was it before?"
 *
 * The tiebreak from `rateAt` is repeated here so the list agrees with the
 * lookup: two rows at one instant would otherwise be shown in an order that
 * implies the losing one is current.
 */
export async function listRates(c: DbClient, limit: number): Promise<EnergyRate[]> {
  const { rows } = await c.query(
    `${SELECT} ORDER BY effective_from DESC, (source = 'manual') DESC LIMIT $1`,
    [limit])
  return rows.map(toRate)
}
