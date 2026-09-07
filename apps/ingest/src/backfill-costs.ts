/**
 * Give a price to charges that closed before there was one.
 *
 *   node dist/backfill-costs.js            # report what it would do
 *   node dist/backfill-costs.js --apply    # write it
 *
 * EVERY FIGURE THIS WRITES IS AN ESTIMATE, and the estimate is a worse one the
 * further back it reaches. There is exactly one rate table and it starts the day
 * the URDB fetch first ran, so a charge from last March is priced at what
 * electricity costs today: for anything older than the last PSE rate change the
 * number is invented, and no arithmetic here can make it otherwise (spec §5).
 *
 * Three things bound that. `cost_source = 'backfill-estimate'` is written on
 * every row this touches, so the UI can mark the figure as estimated (§3.7) and
 * a total that includes one is legibly approximate. The same column makes the
 * rows identifiable as a set, so once `energy_rate` holds real history a
 * properly dated pass can correct exactly these and nothing else. And nothing
 * here ever writes over a row that already names a source — a measured price, or
 * an estimate from an earlier run — so the correction is a later decision rather
 * than a race with this script.
 *
 * What it deliberately does not do: price a charge awaiting a Tesla invoice.
 * §3.5 will settle those against what was actually billed, or give up on them at
 * 45 days, and an estimate written here would both be wrong and stop that
 * happening — the reconciliation's work guard looks for `cost IS NULL`.
 */
import { pathToFileURL } from 'node:url'
import {
  closePool,
  getPool,
  rateAt,
  priceSession,
  withTransaction,
  type DbPool,
} from '@ev/db'
import { makeSample, type SessionSummary, type VehicleSample } from './deps.js'
import { loadConfig } from './config.js'
import {
  classifyCharge,
  priceCharge,
  type ChargeClassification,
  type ChargeCost,
  type EnergyPrice,
  type HomeLocation,
} from './pricing.js'

/** One closed charge with no price, as this script needs to see it. */
export interface BackfillCharge {
  id: string
  vehicleId: string
  startedAt: Date | null
  endedAt: Date | null
  energyKwh: number | null
  startLat: number | null
  startLon: number | null
  /** What the row already says, so an unchanged answer costs no write. */
  costBasis: string | null
}

/**
 * Everything this reaches outside itself.
 *
 * Narrow on purpose, in the shape `urdb.ts`'s `RateStore` established: the
 * script can list unpriced charges, read their samples, ask what a kWh costs
 * today, and attach a price. There is no way through here to delete a session,
 * to move a rate, or to price anything the listing did not offer.
 */
export interface BackfillStore {
  unpricedCharges(): Promise<BackfillCharge[]>
  samplesFor(c: BackfillCharge): Promise<VehicleSample[]>
  currentRate(at: Date): Promise<EnergyPrice | null>
  priceCharge(id: string, cost: ChargeCost): Promise<void>
}

/**
 * What became of the sessions, in the words the report prints.
 *
 * `unpriced` and `unknown` are counted apart because they are different
 * problems with different fixes: `unpriced` is a home charge with no rate or no
 * energy reading — run the URDB fetch, or accept that the car never told us —
 * while `unknown` means the coordinate fallback could not place it, which is
 * usually EV_HOME_LAT/EV_HOME_LON not being set when the script ran.
 */
export interface BackfillCounts {
  considered: number
  priced: number
  unpriced: number
  unknown: number
  pending: number
  skipped: number
  unchanged: number
}

export interface BackfillOptions {
  home: HomeLocation | null
  now: Date
  apply: boolean
}

/** The basis values this script is allowed to overwrite. */
const OURS_TO_DECIDE = new Set([null, 'home', 'unknown'])

/**
 * Classify and price every unpriced charge.
 *
 * Dry by default at the call site as well as at the command line: `apply` is
 * required rather than defaulted, so a caller that forgets it reports instead
 * of writing. The two runs are otherwise the same code down to the counts —
 * a dry run that took a different path would be a report about a program
 * nobody is going to run.
 */
export async function runBackfill(
  store: BackfillStore, opts: BackfillOptions,
): Promise<BackfillCounts> {
  const charges = await store.unpricedCharges()
  const counts: BackfillCounts = {
    considered: charges.length,
    priced: 0, unpriced: 0, unknown: 0, pending: 0, skipped: 0, unchanged: 0,
  }
  if (charges.length === 0) return counts

  // One lookup for the whole run. Asking per session would put the same answer
  // on the wire once per charge, and — worse — would let a rate inserted
  // half-way through a long run split the history into two tariffs at an
  // arbitrary session boundary that nothing records.
  const rate = await store.currentRate(opts.now)

  for (const charge of charges) {
    if (!OURS_TO_DECIDE.has(charge.costBasis)) {
      // 'pending' and 'tesla' both belong to §3.5. Left exactly as found.
      counts.skipped++
      continue
    }

    const points = await store.samplesFor(charge)
    const classification = classifyCharge(points, summaryOf(charge), opts.home)
    const cost = estimate(classification, rate)

    // Nothing to say that the row does not already say. This is what makes a
    // second run free rather than merely harmless: an unplaceable charge is
    // `unknown` after the first pass and stays that way, and re-writing it
    // every run would churn a table whose rows are meant to be stable enough
    // for a later correction to target.
    if (cost.cost === null && cost.costBasis === charge.costBasis) {
      counts.unchanged++
      continue
    }

    if (opts.apply) await store.priceCharge(charge.id, cost)
    counts[outcomeOf(cost)]++
  }
  return counts
}

/**
 * The estimate marker, applied at the one place a figure is minted.
 *
 * `priceCharge` writes the rate's own source, which is right at close time and
 * wrong here: a `urdb` on a March charge would claim we knew March's price,
 * when what we have is September's. Overwriting it is the whole contract of
 * this script, and it happens in one expression so no branch can forget.
 *
 * Left null when there is no figure, keeping the invariant the read API rests
 * on — cost, currency, rate and source are null together, and only the basis
 * survives alone.
 */
function estimate(
  classification: ChargeClassification, rate: EnergyPrice | null,
): ChargeCost {
  const cost = priceCharge(classification, rate)
  return cost.cost === null ? cost : { ...cost, costSource: 'backfill-estimate' }
}

function outcomeOf(cost: ChargeCost): keyof BackfillCounts {
  if (cost.costBasis === 'pending') return 'pending'
  if (cost.costBasis === 'unknown') return 'unknown'
  return cost.cost === null ? 'unpriced' : 'priced'
}

/**
 * The stored session, in the shape the classifier reads.
 *
 * The classifier takes a `SessionSummary` because at close time that is what
 * the caller is holding. Here the summary was computed a year ago and only its
 * four surviving columns are available, so the rest are stated as null rather
 * than re-derived from the samples: nothing in classification or pricing reads
 * them, and recomputing a summary would risk this script disagreeing with the
 * `energy_kwh` the charges page has been showing all along.
 */
function summaryOf(c: BackfillCharge): SessionSummary {
  return {
    startedAt: c.startedAt,
    endedAt: c.endedAt,
    energyKwh: c.energyKwh,
    startLat: c.startLat,
    startLon: c.startLon,
    distanceKm: null,
    efficiencyWhPerKm: null,
    avgSpeedKph: null,
    maxChargePowerKw: null,
    startSocPct: null,
    endSocPct: null,
    startOdometerKm: null,
    endOdometerKm: null,
    endLat: null,
    endLon: null,
  }
}

/**
 * Bind the seam to a pool.
 *
 * One transaction per write rather than one for the run. A backfill can touch a
 * year of history, and holding a single transaction open across all of it would
 * block the live worker's writes on the same rows and leave the whole pass to
 * be redone if it failed on the last session. Each row is independent — nothing
 * here reads what a previous row wrote — so partial progress is progress, and
 * re-running picks up exactly where it stopped.
 */
export function pgBackfillStore(pool: DbPool): BackfillStore {
  return {
    // `cost_source IS NULL` is the guard that makes this safe to re-run, and it
    // is deliberately stricter than `cost IS NULL`: a row whose source is set
    // belongs to whoever set it — a real rate, a Tesla invoice, or an earlier
    // pass of this script whose figure a later dated backfill will correct.
    // `NOT is_open` because a session still charging has no energy total to
    // price and will be priced properly when it closes.
    unpricedCharges: async () => {
      const { rows } = await withTransaction(pool, (c) => c.query(
        `SELECT id, vehicle_id, started_at, ended_at, energy_kwh,
                start_lat, start_lon, cost_basis
           FROM session
          WHERE kind='charge' AND NOT is_open
            AND cost IS NULL AND cost_source IS NULL
          ORDER BY started_at`))
      return rows.map((r) => ({
        id: r.id,
        vehicleId: r.vehicle_id,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        // NUMERIC arrives from pg as a string and this package installs no type
        // parser, so an uncoerced energy would make `energy * rate` work by
        // luck and the rounding beside it not.
        energyKwh: r.energy_kwh === null ? null : Number(r.energy_kwh),
        startLat: r.start_lat,
        startLon: r.start_lon,
        costBasis: r.cost_basis,
      }))
    },

    // Only the three fields classification reads, bounded by the session's own
    // window. `loadSessionSamples` is the neighbouring reader and cannot be
    // reused: it selects the columns a summary needs, which do not include
    // `located_at_home` or the fast-charger pair, and it has no upper bound —
    // on a year of history it would return the whole table per session.
    samplesFor: async (charge) => {
      const until = charge.endedAt ?? charge.startedAt
      if (charge.startedAt === null || until === null) return []
      const { rows } = await withTransaction(pool, (c) => c.query(
        `SELECT ts, located_at_home, fast_charger_present, fast_charger_type
           FROM sample WHERE vehicle_id=$1 AND ts >= $2 AND ts <= $3 ORDER BY ts`,
        [charge.vehicleId, charge.startedAt, until]))
      return rows.map((r) => makeSample({
        vehicleId: charge.vehicleId,
        ts: r.ts,
        locatedAtHome: r.located_at_home,
        fastChargerPresent: r.fast_charger_present,
        fastChargerType: r.fast_charger_type,
      }))
    },

    currentRate: async (at) => {
      const rate = await withTransaction(pool, (c) => rateAt(c, at))
      return rate === null
        ? null
        : { pricePerKwh: rate.pricePerKwh, currency: rate.currency, source: rate.source }
    },

    priceCharge: async (id, cost) => {
      await withTransaction(pool, (c) => priceSession(c, id, cost))
    },
  }
}

export interface Options { apply: boolean }

/**
 * Dry by default, and the asymmetry is on purpose.
 *
 * `reprocess` takes no such flag because its input is the tape and its output is
 * reproducible from it: running it again fixes a run that went wrong. This
 * writes numbers that are not derivable from anything — the rate they used is
 * gone the next time PSE moves — so the first thing an operator wants is the
 * count, and the second is to have chosen.
 *
 * An unrecognised argument stops the run. Silently ignoring `--aply` would
 * report instead of writing, which sounds like the safe direction until it is
 * the third time somebody has run a backfill that did nothing.
 */
export function parseArgs(argv: string[]): Options {
  let apply = false
  for (const arg of argv) {
    if (arg === '--apply') apply = true
    else if (arg === '--dry-run') apply = false
    else throw new Error(`unknown argument ${arg}; usage: backfill-costs [--apply]`)
  }
  return { apply }
}

async function main(): Promise<void> {
  // Flags before config: a typo in the arguments should not need a full pod
  // environment to be reported, and this is run by hand more often than by a
  // deployment.
  const { apply } = parseArgs(process.argv.slice(2))
  const config = loadConfig()
  const now = new Date()

  const counts = await runBackfill(pgBackfillStore(getPool()), {
    home: config.home, now, apply,
  })

  // Printed as one line per outcome because the interesting number is whichever
  // one is unexpectedly large — a run that is all `unknown` means the home
  // coordinates were not set, and a table of counts shows that at a glance
  // where a single total would hide it.
  console.log(apply ? 'backfill applied' : 'backfill dry run — nothing written')
  console.log(`  considered ${counts.considered}`)
  console.log(`  priced     ${counts.priced} (at today's rate, marked backfill-estimate)`)
  console.log(`  unpriced   ${counts.unpriced} (at home, but no rate or no energy reading)`)
  console.log(`  unknown    ${counts.unknown} (could not place the charge)`)
  console.log(`  pending    ${counts.pending} (left for the Tesla reconciliation)`)
  console.log(`  skipped    ${counts.skipped} (already awaiting an invoice)`)
  console.log(`  unchanged  ${counts.unchanged} (already says what we would say)`)
  if (!apply) console.log('re-run with --apply to write these.')
  await closePool()
}

// Only when executed directly: `parseArgs` and `runBackfill` are imported by
// tests, and a top-level main() would open a database connection to read flags.
const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    console.error('backfill-costs failed', err)
    process.exit(1)
  })
}
