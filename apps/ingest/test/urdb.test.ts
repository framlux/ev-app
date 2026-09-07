import { describe, expect, it } from 'vitest'
import {
  URDB_ENDPOINT,
  refreshEnergyRate,
  runRateRefresh,
  type RateStore,
  type ResponseLike,
} from '../src/urdb.js'

/**
 * The URDB client, exercised entirely through its injected transport.
 *
 * No test here reaches the network, and that is not only about speed: OpenEI's
 * answer is the input to a decision that prices a year of charging, so the
 * shapes that must fail — a tiered plan, a time-of-use plan — are exactly the
 * ones a live call would refuse to produce on demand. They can only be tested
 * by handing the parser the document we are afraid of.
 */

const KEY = 'test-key'
const NOW = new Date('2026-09-07T12:00:00.000Z')

/** A URDB entry as the real API returns one, trimmed to what we read. */
function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    label: '5f0bc3e15457a3a04d0c8f4b',
    name: 'Schedule 7 Residential Service',
    sector: 'Residential',
    startdate: 1_640_995_200,
    energyratestructure: [[{ rate: 0.11256, unit: 'kWh' }]],
    ...over,
  }
}

function body(...items: Record<string, unknown>[]): string {
  return JSON.stringify({ items })
}

/** A transport that always answers with one canned response. */
function respondWith(res: Partial<ResponseLike> & { text: () => Promise<string> }) {
  const urls: string[] = []
  const fetchLike = async (url: string): Promise<ResponseLike> => {
    urls.push(url)
    return { ok: true, status: 200, ...res }
  }
  return { urls, fetchLike }
}

function ok(text: string) {
  return respondWith({ text: async () => text })
}

/**
 * The rate table, as much of it as the fetch touches: the newest row it
 * compares against and the rows it writes.
 */
class FakeRates implements RateStore {
  /**
   * The row `rateAt` would return, source and all. The source is not
   * decoration: a manual row in force is a standing instruction the fetch is
   * not allowed to write past, so a fake that cannot say which kind of row is
   * in force cannot express the case that matters most.
   */
  inForce: { pricePerKwh: number; currency: string; source: 'urdb' | 'manual' } | null = null
  readonly asked: Date[] = []
  readonly inserted: {
    effectiveFrom: Date
    pricePerKwh: number
    currency: string
    source: string
    urdbLabel: string | null
  }[] = []

  async rateInForce(
    at: Date,
  ): Promise<{ pricePerKwh: number; currency: string; source: 'urdb' | 'manual' } | null> {
    this.asked.push(at)
    return this.inForce
  }

  async insertRate(r: {
    effectiveFrom: Date
    pricePerKwh: number
    currency: string
    source: 'urdb' | 'manual'
    urdbLabel: string | null
  }): Promise<void> {
    this.inserted.push(r)
  }
}

describe('the URDB request', () => {
  it('asks for the one utility, sector and revision we can parse', async () => {
    const rates = new FakeRates()
    const { urls, fetchLike } = ok(body(entry()))

    await refreshEnergyRate(rates, { apiKey: KEY, fetch: fetchLike, now: () => NOW })

    const url = new URL(urls[0] ?? '')
    expect(`${url.origin}${url.pathname}`).toBe(URDB_ENDPOINT)
    // Every one of these narrows the answer to a document this parser has a
    // chance of understanding. `eia` pins the utility (PSE), `sector` drops the
    // commercial and industrial schedules, `approved` drops drafts, and
    // `version=latest` is what stops NREL's schema moving under us silently.
    expect(url.searchParams.get('eia')).toBe('15500')
    expect(url.searchParams.get('sector')).toBe('Residential')
    expect(url.searchParams.get('approved')).toBe('true')
    expect(url.searchParams.get('version')).toBe('latest')
    expect(url.searchParams.get('format')).toBe('json')
    expect(url.searchParams.get('api_key')).toBe(KEY)
  })

  it('does no work at all without a key', async () => {
    // The worker never registers the timer in this state, so this is the second
    // half of that rule rather than a duplicate of it: a future caller that
    // forgets the check gets a clean skip, not a request to OpenEI with the
    // literal string "null" as its credential.
    const rates = new FakeRates()
    const { urls, fetchLike } = ok(body(entry()))

    const out = await refreshEnergyRate(rates, {
      apiKey: null, fetch: fetchLike, now: () => NOW,
    })

    expect(out.kind).toBe('skipped')
    expect(urls).toEqual([])
    expect(rates.inserted).toEqual([])
  })
})

describe('the URDB parser', () => {
  it('reads the rate off a flat Schedule 7', async () => {
    const rates = new FakeRates()
    const { fetchLike } = ok(body(entry()))

    const out = await refreshEnergyRate(rates, { apiKey: KEY, fetch: fetchLike, now: () => NOW })

    expect(out).toMatchObject({ kind: 'inserted', pricePerKwh: 0.11256 })
    expect(rates.inserted).toHaveLength(1)
    expect(rates.inserted[0]?.pricePerKwh).toBe(0.11256)
    expect(rates.inserted[0]?.source).toBe('urdb')
    expect(rates.inserted[0]?.urdbLabel).toBe('5f0bc3e15457a3a04d0c8f4b')
  })

  it('dates the row now, never at the tariff’s own start', async () => {
    // URDB carries a `startdate` — here, the beginning of 2022 — and using it
    // would look more truthful than it is. We did not know this number then,
    // and a row dated then re-prices every charge already closed at whatever we
    // did know, rewriting history to match today's understanding of it. `now`
    // says only what is true: this is the rate from the moment we learned it.
    const rates = new FakeRates()
    const { fetchLike } = ok(body(entry()))

    await refreshEnergyRate(rates, { apiKey: KEY, fetch: fetchLike, now: () => NOW })

    expect(rates.inserted[0]?.effectiveFrom).toEqual(NOW)
  })

  it('refuses a time-of-use plan rather than pricing peak at the off-peak rate', async () => {
    // Schedule 307 is 11.2c off-peak against 53.6c peak. Taking [0][0] out of
    // this document yields the off-peak number and no error, so a year of
    // evening charging would be billed at a fifth of its cost and every figure
    // on the charges page would look entirely plausible. Throwing leaves the
    // last known rate in place, which is wrong in a way somebody notices.
    const rates = new FakeRates()
    const { fetchLike } = ok(body(entry({
      energyratestructure: [[{ rate: 0.112 }], [{ rate: 0.536 }]],
    })))

    await expect(refreshEnergyRate(rates, {
      apiKey: KEY, fetch: fetchLike, now: () => NOW,
    })).rejects.toThrow(/period/i)
    expect(rates.inserted).toEqual([])
  })

  it('refuses a tiered plan for the same reason', async () => {
    // One period, two tiers: the first N kWh at one price and the rest at
    // another. [0][0] is the cheap tier, and a household that charges a car is
    // exactly the household that leaves it.
    const rates = new FakeRates()
    const { fetchLike } = ok(body(entry({
      energyratestructure: [[{ rate: 0.09, max: 600 }, { rate: 0.13 }]],
    })))

    await expect(refreshEnergyRate(rates, {
      apiKey: KEY, fetch: fetchLike, now: () => NOW,
    })).rejects.toThrow(/tier/i)
    expect(rates.inserted).toEqual([])
  })

  it('refuses a response with no Schedule 7 in it', async () => {
    // PSE moving the domestic tariff to another schedule is a real event, and
    // the only safe response is to stop and say so. Picking "the first
    // Residential entry" instead would quietly start pricing home charging at
    // whatever NREL happens to list first.
    const rates = new FakeRates()
    const { fetchLike } = ok(body(entry({ name: 'Schedule 26 Residential Time of Use' })))

    await expect(refreshEnergyRate(rates, {
      apiKey: KEY, fetch: fetchLike, now: () => NOW,
    })).rejects.toThrow(/schedule 7/i)
  })

  it('takes the current revision when URDB still lists the superseded ones', async () => {
    // URDB keeps history: the same schedule appears once per revision, and the
    // 2019 copy of Schedule 7 is a real rate that is no longer charged. The
    // greatest `startdate` is the one in force.
    const rates = new FakeRates()
    const { fetchLike } = ok(body(
      entry({ startdate: 1_546_300_800, energyratestructure: [[{ rate: 0.09 }]] }),
      entry({ startdate: 1_704_067_200, energyratestructure: [[{ rate: 0.11256 }]] }),
    ))

    const out = await refreshEnergyRate(rates, { apiKey: KEY, fetch: fetchLike, now: () => NOW })

    expect(out).toMatchObject({ pricePerKwh: 0.11256 })
  })

  it('refuses a rate that is not a usable number', async () => {
    // A null or a string here multiplied by kWh gives NaN or a concatenation,
    // and both reach the database as something the charges page renders. The
    // shape has to be rejected where it arrives.
    const rates = new FakeRates()
    const { fetchLike } = ok(body(entry({ energyratestructure: [[{ rate: null }]] })))

    await expect(refreshEnergyRate(rates, {
      apiKey: KEY, fetch: fetchLike, now: () => NOW,
    })).rejects.toThrow(/rate/i)
  })

  it('says what the body was when it is not JSON at all', async () => {
    // An expired key or a proxy in the way answers 200 with an HTML page.
    // JSON.parse's "Unexpected token <" names nothing; the first of the text is
    // what tells an operator which of those two happened.
    const rates = new FakeRates()
    const { fetchLike } = ok('<html><body>Rate limit exceeded</body></html>')

    await expect(refreshEnergyRate(rates, {
      apiKey: KEY, fetch: fetchLike, now: () => NOW,
    })).rejects.toThrow(/Rate limit exceeded/)
  })

  it('never puts the API key in the message it throws', async () => {
    // Errors from here go to the pod log, which is not a secret store. The URL
    // carries the credential, so it is the one thing that must not travel with
    // the complaint.
    const rates = new FakeRates()
    const { fetchLike } = respondWith({
      ok: false, status: 403, text: async () => 'forbidden',
    })

    await expect(refreshEnergyRate(rates, {
      apiKey: KEY, fetch: fetchLike, now: () => NOW,
    })).rejects.toThrow(/403/)
    await refreshEnergyRate(rates, { apiKey: KEY, fetch: fetchLike, now: () => NOW })
      .catch((err: unknown) => {
        expect(String(err)).not.toContain(KEY)
      })
  })
})

describe('what a fetch writes', () => {
  it('writes nothing when the answer has not changed', async () => {
    // This is the common case by an enormous margin — NREL refreshes roughly
    // annually, so 364 fetches a year agree with what we already hold. A row
    // per fetch would turn the settings page's rate history into a log and make
    // a genuine rate change impossible to spot in it.
    const rates = new FakeRates()
    rates.inForce = { pricePerKwh: 0.11256, currency: 'USD', source: 'urdb' }
    const { fetchLike } = ok(body(entry()))

    const out = await refreshEnergyRate(rates, { apiKey: KEY, fetch: fetchLike, now: () => NOW })

    expect(out).toMatchObject({ kind: 'unchanged' })
    expect(rates.inserted).toEqual([])
  })

  it('writes a row when the number moves', async () => {
    const rates = new FakeRates()
    rates.inForce = { pricePerKwh: 0.10412, currency: 'USD', source: 'urdb' }
    const { fetchLike } = ok(body(entry()))

    const out = await refreshEnergyRate(rates, { apiKey: KEY, fetch: fetchLike, now: () => NOW })

    expect(out).toMatchObject({ kind: 'inserted', pricePerKwh: 0.11256 })
    expect(rates.inserted).toHaveLength(1)
  })

  it('leaves a manual override alone, and does not even ask OpenEI', async () => {
    // The override is the escape hatch for URDB lag (spec §3.2), and it exists
    // precisely for the days the two numbers disagree — so a fetch that wrote
    // whenever they disagreed would delete the feature within a day of anyone
    // using it. The fetch dates its row `now()` and `rateAt` sorts on the date
    // first, so a written row does not tie with the override, it beats it.
    // Nothing is fetched either: a request whose answer can only be discarded
    // is a request to a third party for nothing.
    const rates = new FakeRates()
    rates.inForce = { pricePerKwh: 0.31, currency: 'USD', source: 'manual' }
    const { urls, fetchLike } = ok(body(entry()))

    const out = await refreshEnergyRate(rates, { apiKey: KEY, fetch: fetchLike, now: () => NOW })

    expect(out).toEqual({ kind: 'overridden', pricePerKwh: 0.31 })
    expect(rates.inserted).toEqual([])
    expect(urls).toEqual([])
  })

  it('asks what is in force at the clock it was given, not at the newest row', async () => {
    // A row dated next month is in the history and is not in force, and the
    // question this fetch has to answer is "what would a charge cost right
    // now" — the same question the pricing path asks.
    const rates = new FakeRates()
    const { fetchLike } = ok(body(entry()))

    await refreshEnergyRate(rates, { apiKey: KEY, fetch: fetchLike, now: () => NOW })

    expect(rates.asked).toEqual([NOW])
  })

  it('writes the first row into an empty table', async () => {
    const rates = new FakeRates()
    const { fetchLike } = ok(body(entry()))

    await refreshEnergyRate(rates, { apiKey: KEY, fetch: fetchLike, now: () => NOW })

    expect(rates.inserted).toHaveLength(1)
  })
})

describe('the daily task', () => {
  it('survives an OpenEI outage without taking the worker with it', async () => {
    // The timer's callback is fire-and-forget, and an unhandled rejection from
    // a timer ends the process. The worker's whole job — ingesting telemetry
    // that the car will not resend — has nothing to do with electricity
    // tariffs, so a 500 from OpenEI must cost us a log line and nothing else.
    const rates = new FakeRates()
    const { fetchLike } = respondWith({
      ok: false, status: 500, text: async () => 'upstream unavailable',
    })
    const errors: unknown[] = []

    await runRateRefresh(rates, {
      apiKey: KEY, fetch: fetchLike, now: () => NOW, onError: (e) => errors.push(e),
    })

    expect(errors).toHaveLength(1)
    expect(rates.inserted).toEqual([])
  })

  it('survives a transport that never answers at all', async () => {
    const rates = new FakeRates()
    const errors: unknown[] = []

    await runRateRefresh(rates, {
      apiKey: KEY,
      fetch: () => Promise.reject(new Error('ENOTFOUND api.openei.org')),
      now: () => NOW,
      onError: (e) => errors.push(e),
    })

    expect(errors).toHaveLength(1)
  })

  it('survives a database that is down, having already spent the fetch', async () => {
    // The insert is the second half of the operation and fails independently of
    // the first. Letting it escape would be the same crash by another route.
    const rates = new FakeRates()
    rates.insertRate = () => Promise.reject(new Error('connection terminated'))
    const { fetchLike } = ok(body(entry()))
    const errors: unknown[] = []

    await runRateRefresh(rates, {
      apiKey: KEY, fetch: fetchLike, now: () => NOW, onError: (e) => errors.push(e),
    })

    expect(errors).toHaveLength(1)
  })

  it('reports nothing when there was nothing wrong', async () => {
    const rates = new FakeRates()
    const { fetchLike } = ok(body(entry()))
    const errors: unknown[] = []

    await runRateRefresh(rates, {
      apiKey: KEY, fetch: fetchLike, now: () => NOW, onError: (e) => errors.push(e),
    })

    expect(errors).toEqual([])
  })
})
