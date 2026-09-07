import { insertRate, listRates, withTransaction, type DbPool } from '@ev/db'

/**
 * The one outbound HTTP call this system makes on its own initiative.
 *
 * NREL's Utility Rate Database is the only free programmatic source for a PSE
 * tariff, and it is a database of documents rather than an API for a number:
 * one utility carries around 117 entries covering every schedule, every sector
 * and every past revision of each. So the work here is mostly refusal — of the
 * schedules that are not ours, of the revisions no longer in force, and above
 * all of the plan shapes a single multiplication cannot honestly price.
 *
 * Everything the module touches outside itself is injected: the transport, the
 * clock, and the two things it does to the rate table. That is not test
 * decoration. The documents that must be rejected are precisely the ones a live
 * call will not produce on request, so they can only ever be handed in.
 */

export const URDB_ENDPOINT = 'https://api.openei.org/utility_rates'

/**
 * Puget Sound Energy's EIA utility id.
 *
 * A constant rather than configuration because everything else here — the
 * schedule name, the single-tier assumption, the currency — is already specific
 * to this one tariff. A second utility is a second parser, not a second value.
 */
export const PSE_EIA_ID = '15500'

/**
 * The domestic tariff we can price: PSE's Schedule 7, Residential Service.
 *
 * Matched against the entry's human name AND its `label`. `label` is URDB's own
 * page id — an opaque hex string — so in practice the name is what matches; the
 * label is included because a future pin to one exact revision would be written
 * as its label, and then this keeps working unchanged.
 */
const SCHEDULE_7 = /schedule\s*7\b/i

/** How much of a non-JSON body is worth quoting back into a log line. */
const BODY_EXCERPT = 200

/** The part of a `Response` this module reads. Keeps the fakes tiny. */
export interface ResponseLike {
  ok: boolean
  status: number
  text(): Promise<string>
}

/** The part of `fetch` this module calls. */
export type FetchLike = (url: string) => Promise<ResponseLike>

/**
 * The two things a fetch does to the rate table.
 *
 * Narrower than the repo layer on purpose: this module may read the newest
 * price and add a row, and there is deliberately no way for it to change or
 * remove one. A rate someone charged at is a historical fact (spec §4), and the
 * seam is where that is enforced rather than remembered.
 */
export interface RateStore {
  latestRate(): Promise<{ pricePerKwh: number; currency: string } | null>
  insertRate(r: {
    effectiveFrom: Date
    pricePerKwh: number
    currency: string
    source: 'urdb' | 'manual'
    urdbLabel: string | null
  }): Promise<void>
}

export interface UrdbOptions {
  /** Null means the feature is off; see `refreshEnergyRate`. */
  apiKey: string | null
  fetch?: FetchLike
  now?: () => Date
}

/**
 * What a fetch did. `unchanged` is the overwhelmingly common answer and is not
 * an error: NREL refreshes roughly annually, so on all but one day a year the
 * correct outcome is to have confirmed what we already hold.
 */
export type UrdbOutcome =
  | { kind: 'skipped' }
  | { kind: 'unchanged'; pricePerKwh: number }
  | { kind: 'inserted'; pricePerKwh: number }

/**
 * URDB quotes in dollars per kWh and carries no currency field.
 *
 * Hardcoded rather than guessed from the response, because the response has
 * nothing to guess from — inventing a lookup would only hide that. A tariff
 * outside the US arrives with its own source, not through this file.
 */
const URDB_CURRENCY = 'USD'

/**
 * Fetch today's Schedule 7 price and record it if it moved.
 *
 * Throws on anything it does not understand — a refused request, a body that is
 * not JSON, a schedule that has vanished, a plan shape with more than one price
 * in it. That is the useful behaviour rather than the lazy one: this writes into
 * a history that prices real charges, and the alternative to stopping is
 * recording a number nobody can distinguish from a correct one. A failure here
 * costs a log line and leaves the last known rate in force, which is exactly
 * what should happen the day PSE moves the owner onto Schedule 307.
 *
 * A null key returns `skipped` without touching the network. The worker already
 * declines to register the timer in that state, so this is the second lock on
 * the same door: a future caller that forgets the check sends no request rather
 * than sending one credentialed with the string "null".
 */
export async function refreshEnergyRate(
  store: RateStore, opts: UrdbOptions,
): Promise<UrdbOutcome> {
  if (opts.apiKey === null) return { kind: 'skipped' }
  const http = opts.fetch ?? ((url: string) => fetch(url))
  const now = opts.now ?? (() => new Date())

  const document = await readJson(http, requestUrl(opts.apiKey))
  const { pricePerKwh, label } = parseScheduleRate(document)

  // Compared against the newest row whatever its source, so a value we already
  // hold costs no row. The comparison is exact rather than approximate: these
  // are five-decimal figures out of a JSON document and a NUMERIC(10,5) column,
  // so a tolerance would only be able to hide a genuine change of a hundredth
  // of a cent — which over a year of charging is a real amount of money.
  const latest = await store.latestRate()
  if (latest !== null && latest.pricePerKwh === pricePerKwh) {
    return { kind: 'unchanged', pricePerKwh }
  }

  await store.insertRate({
    // Now, and never URDB's own `startdate`. The tariff may well have taken
    // effect in 2022, but we did not know it then, and a row dated then silently
    // re-prices every charge already closed at the price we did know. The rate
    // history is a record of what this system understood and when, which is the
    // only version of it that can be checked against a bill.
    effectiveFrom: now(),
    pricePerKwh,
    currency: URDB_CURRENCY,
    source: 'urdb',
    urdbLabel: label,
  })
  return { kind: 'inserted', pricePerKwh }
}

/**
 * The same fetch, as the daily timer must call it: it never rejects.
 *
 * An unhandled rejection from a timer callback ends the process, and this
 * worker's actual job is ingesting telemetry the car will not send twice. A 500
 * from OpenEI, a DNS failure, or a tariff shape we refuse must therefore all
 * cost exactly one log line. The error is handed to the caller rather than
 * printed here so the entrypoint keeps its monopoly on what the pod says.
 */
export async function runRateRefresh(
  store: RateStore,
  opts: UrdbOptions & { onError?: (err: unknown) => void; onResult?: (o: UrdbOutcome) => void },
): Promise<void> {
  try {
    const out = await refreshEnergyRate(store, opts)
    opts.onResult?.(out)
  } catch (err) {
    opts.onError?.(err)
  }
}

/**
 * Bind the two operations to a pool.
 *
 * Its own short transaction, deliberately outside anything else: this runs on a
 * timer with no message in flight, and holding a connection across an HTTP call
 * to a third party is how a pool of ten becomes a pool of none during someone
 * else's outage. The read and the write are separate transactions for the same
 * reason, and the race that opens — a manual rate inserted between them — is
 * harmless, because `insertRate` does nothing on a conflicting key and a manual
 * row wins `rateAt`'s tiebreak regardless.
 */
export function pgRateStore(pool: DbPool): RateStore {
  return {
    latestRate: async () => {
      const [newest] = await withTransaction(pool, (c) => listRates(c, 1))
      return newest ? { pricePerKwh: newest.pricePerKwh, currency: newest.currency } : null
    },
    insertRate: async (r) => {
      await withTransaction(pool, (c) => insertRate(c, r))
    },
  }
}

/**
 * The query, assembled through URLSearchParams so a value containing a `&`
 * cannot smuggle in a parameter of its own.
 */
function requestUrl(apiKey: string): string {
  const params = new URLSearchParams({
    version: 'latest',
    format: 'json',
    api_key: apiKey,
    eia: PSE_EIA_ID,
    sector: 'Residential',
    approved: 'true',
  })
  return `${URDB_ENDPOINT}?${params.toString()}`
}

/**
 * Read the body as text and parse it here, rather than trusting `res.json()`.
 *
 * The failures this endpoint actually produces are not JSON: an expired key or
 * a proxy in the way answers with an HTML page, and `res.json()` turns that into
 * "Unexpected token <", which names neither the service nor the reason. Quoting
 * the beginning of the body is what tells an operator which of the two happened.
 *
 * Nothing here ever mentions the URL. It carries the API key, and these messages
 * go straight to a pod log.
 */
async function readJson(http: FetchLike, url: string): Promise<unknown> {
  const res = await http(url)
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`OpenEI refused the rate lookup: HTTP ${res.status} ${excerpt(text)}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`OpenEI answered with something that is not JSON: ${excerpt(text)}`)
  }
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > BODY_EXCERPT ? `${flat.slice(0, BODY_EXCERPT)}…` : flat
}

/**
 * Find Schedule 7 in the response and read its single price.
 *
 * The refusals are the substance of this function.
 *
 * MORE THAN ONE PERIOD means time-of-use. PSE's Schedule 307 is 11.2¢ off-peak
 * against 53.6¢ peak, and `[0][0]` on that document is the off-peak figure — so
 * taking it would price a year of evening charging at a fifth of its cost, with
 * every number on the charges page looking entirely reasonable. Pricing that
 * plan honestly needs per-interval energy, which is a different feature (spec
 * §1, non-goals), so the correct answer here is to stop.
 *
 * MORE THAN ONE TIER means a block rate: the first N kWh at one price and the
 * rest at another. `[0][0]` is the cheap block, and a household that charges a
 * car is exactly the household that exhausts it every month.
 *
 * Both leave the last known rate in place and nothing re-priced. That is the
 * intended outcome of "PSE moved you onto another schedule": a loud, visible
 * stop, answered by typing the new number in as a manual rate (spec §4).
 */
export function parseScheduleRate(
  document: unknown,
): { pricePerKwh: number; label: string | null } {
  const items = (document as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) {
    throw new Error('OpenEI answered without an items array; the API shape has changed')
  }

  const entry = pickSchedule7(items as Record<string, unknown>[])
  const structure = entry['energyratestructure']
  if (!Array.isArray(structure) || structure.length === 0) {
    throw new Error('Schedule 7 arrived with no energyratestructure to read')
  }
  if (structure.length > 1) {
    throw new Error(
      `Schedule 7 now has ${structure.length} rate periods, which is a ` +
      'time-of-use plan: pricing it needs per-interval energy, not a rate. ' +
      'Leaving the last known rate in place; enter the new tariff manually.',
    )
  }

  const period = structure[0]
  if (!Array.isArray(period) || period.length === 0) {
    throw new Error('Schedule 7 arrived with an empty rate period')
  }
  if (period.length > 1) {
    throw new Error(
      `Schedule 7 now has ${period.length} rate tiers, which is a block rate: ` +
      'the first tier is the cheap one and a car exhausts it. Leaving the last ' +
      'known rate in place; enter the new tariff manually.',
    )
  }

  const rate = (period[0] as { rate?: unknown } | null)?.rate
  // Zero is refused along with the nonsense. A genuinely free tariff is not a
  // thing PSE offers, and a zero here would price every charge at nothing —
  // which renders as a real, believable £0.00 rather than as unpriced.
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    throw new Error(`Schedule 7's rate is not a usable number: ${JSON.stringify(rate)}`)
  }

  const label = entry['label']
  return { pricePerKwh: rate, label: typeof label === 'string' ? label : null }
}

/**
 * The current revision of Schedule 7, out of everything PSE publishes.
 *
 * URDB keeps history, so the same schedule appears once per revision and the
 * 2019 copy is a real rate that is simply no longer charged; the greatest
 * `startdate` is the one in force. Nothing matching at all throws rather than
 * falling back to the first Residential entry — "PSE renamed or retired
 * Schedule 7" and "we are now pricing home charging off some unrelated
 * schedule" must not be the same outcome.
 */
function pickSchedule7(items: Record<string, unknown>[]): Record<string, unknown> {
  const matches = items.filter((it) =>
    SCHEDULE_7.test(String(it['name'] ?? '')) || SCHEDULE_7.test(String(it['label'] ?? '')))
  if (matches.length === 0) {
    throw new Error(
      `OpenEI listed ${items.length} PSE residential rates and none of them is ` +
      'Schedule 7. Leaving the last known rate in place; check what the tariff ' +
      'is now called and enter it manually.',
    )
  }
  return matches.reduce((best, it) => (startedAt(it) > startedAt(best) ? it : best))
}

/** URDB's `startdate`, in epoch seconds. Absent sorts oldest. */
function startedAt(entry: Record<string, unknown>): number {
  const v = entry['startdate']
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
