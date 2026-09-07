import { afterEach, describe, expect, it, vi } from 'vitest'
import { isHttpError } from '@sveltejs/kit'

/**
 * The energy-rates settings surface: what the rate history reads back as, and
 * what the app refuses to store.
 *
 * Two things about this feature make the tests below the ones worth having.
 *
 * The first is that a rate row is a HISTORICAL FACT — it is what a charge was
 * priced at — so the only write is an insert. There is no edit and no delete,
 * and the test that pins that is a check on the route module's export list
 * rather than a behavioural one: the way this rule gets broken is by someone
 * adding a `DELETE` handler to tidy up a typo, not by an insert going wrong.
 *
 * The second is that "the current rate" is NOT "the newest row". A row dated
 * next month is in the history and is not in effect, and a manual override
 * dated the same day as a fetched one wins. Both of those live in the repo
 * layer's lookup, so the assertion here is that this surface ASKS it rather
 * than re-deriving the answer from the list it already has in hand.
 *
 * The database is mocked at the @ev/db boundary. There is nothing interesting
 * about the SQL from here — the interesting part of the SQL has its own tests
 * next to it — and mocking lower down would test Postgres.
 */
const rateAt = vi.fn()
const listRates = vi.fn()
const insertRate = vi.fn()

vi.mock('@ev/db', () => ({
	getPool: () => ({}) as never,
	withTransaction: (_pool: unknown, fn: (c: unknown) => unknown) => fn({}),
	rateAt: (...args: unknown[]) => rateAt(...args),
	listRates: (...args: unknown[]) => listRates(...args),
	insertRate: (...args: unknown[]) => insertRate(...args)
}))

vi.mock('../src/lib/server/db.js', () => ({
	getPool: () => ({}) as never,
	withTransaction: (_pool: unknown, fn: (c: unknown) => unknown) => fn({})
}))

const routes = await import('../src/routes/api/v1/energy-rates/+server.js')
const { load } = await import('../src/routes/settings/energy/+page.server.js')
const { parseManualRate } = await import('../src/lib/server/rates.js')

const USER = { locals: { user: { sub: 'operator' } } }

/** A row as the repo layer hands it back: camelCase, Dates, a real number. */
const row = (over: Record<string, unknown> = {}) => ({
	id: 'r1',
	effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
	pricePerKwh: 0.199,
	currency: 'USD',
	source: 'urdb',
	urdbLabel: 'Residential Schedule 7',
	fetchedAt: new Date('2026-01-02T00:00:00.000Z'),
	...over
})

const post = (body: unknown, locals: unknown = USER.locals) =>
	routes.POST({
		locals,
		request: new Request('http://localhost/api/v1/energy-rates', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: typeof body === 'string' ? body : JSON.stringify(body)
		})
	} as never)

/** The thrown value, so a refusal can be asserted on rather than awaited. */
async function thrownBy(fn: () => unknown): Promise<unknown> {
	try {
		await fn()
	} catch (e) {
		return e
	}
	throw new Error('expected a throw, got a value')
}

/**
 * The sentence a refusal puts on screen.
 *
 * These endpoints are read as TEXT by the page (`errorMessageFrom`), so the
 * message IS the error the operator sees — asserting the status alone would
 * pass on a 400 saying "Bad Request", which tells nobody which field to fix.
 */
async function refusal(body: unknown): Promise<string> {
	const e = await thrownBy(() => post(body))
	expect(isHttpError(e, 400)).toBe(true)
	// Nothing reaches the database on a refusal: a half-validated row is worse
	// than no row when nothing can ever delete it again.
	expect(insertRate).not.toHaveBeenCalled()
	return (e as { body: { message: string } }).body.message
}

const VALID = {
	pricePerKwh: 0.2314,
	currency: 'USD',
	effectiveFrom: '2026-09-07T00:00:00.000Z'
}

afterEach(() => {
	vi.clearAllMocks()
})

describe('GET /api/v1/energy-rates', () => {
	it('answers with the rate in effect and the history behind it', async () => {
		rateAt.mockResolvedValue(row())
		listRates.mockResolvedValue([row(), row({ id: 'r0', pricePerKwh: 0.181, source: 'manual' })])

		const body = (await (await routes.GET(USER as never)).json()) as {
			current: Record<string, unknown> | null
			history: Record<string, unknown>[]
		}

		// Instants cross the wire as ISO strings, not as whatever `Date` happens
		// to serialise to, because the page formats them.
		expect(body.current).toMatchObject({
			pricePerKwh: 0.199,
			currency: 'USD',
			source: 'urdb',
			effectiveFrom: '2026-01-01T00:00:00.000Z',
			urdbLabel: 'Residential Schedule 7'
		})
		// Every row carries its source and its date: without those, a history is
		// a column of numbers that cannot explain why any charge was priced.
		expect(body.history.map((r) => r['source'])).toEqual(['urdb', 'manual'])
		expect(body.history.every((r) => typeof r['effectiveFrom'] === 'string')).toBe(true)
	})

	it('reads the current rate through the lookup rather than taking the newest row', async () => {
		// A rate dated next month belongs in the history and is not in effect, and
		// a manual row beats a fetched one on the same date. Both rules live in
		// the repo layer's ORDER BY; taking `history[0]` here would quietly
		// contradict the price every charge was actually computed at.
		const future = row({ id: 'future', effectiveFrom: new Date('2027-01-01T00:00:00.000Z') })
		const inEffect = row({ id: 'now', pricePerKwh: 0.21, source: 'manual' })
		listRates.mockResolvedValue([future, inEffect])
		rateAt.mockResolvedValue(inEffect)

		const body = (await (await routes.GET(USER as never)).json()) as {
			current: { pricePerKwh: number } | null
			history: unknown[]
		}

		expect(rateAt).toHaveBeenCalledTimes(1)
		expect(body.current?.pricePerKwh).toBe(0.21)
		expect(body.history).toHaveLength(2)
	})

	it('coerces the price to a number, because pg hands NUMERIC back as a string', async () => {
		// No `setTypeParser` is installed anywhere in this repo, so a rate that
		// arrives as '0.199' would multiply by luck and concatenate on an add.
		// `typeof` rather than a value comparison: `toBe(0.199)` passes on a
		// string under `==` semantics in enough matchers to hide this.
		rateAt.mockResolvedValue(row({ pricePerKwh: '0.199' as unknown as number }))
		listRates.mockResolvedValue([])

		const body = (await (await routes.GET(USER as never)).json()) as {
			current: { pricePerKwh: unknown }
		}
		expect(typeof body.current.pricePerKwh).toBe('number')
		expect(body.current.pricePerKwh).toBeCloseTo(0.199, 5)
	})

	it('says there is no rate rather than inventing one, on a fresh install', async () => {
		rateAt.mockResolvedValue(null)
		listRates.mockResolvedValue([])

		const body = (await (await routes.GET(USER as never)).json()) as {
			current: unknown
			history: unknown[]
		}
		expect(body.current).toBeNull()
		expect(body.history).toEqual([])
	})

	it('refuses an unauthenticated read', async () => {
		const e = await thrownBy(() => routes.GET({ locals: {} } as never))
		expect(isHttpError(e, 401)).toBe(true)
		expect(listRates).not.toHaveBeenCalled()
	})
})

describe('POST /api/v1/energy-rates', () => {
	it('inserts a manual rate and hands the stored row back', async () => {
		// `insertRate` answers with the new row's id, not with the row — its
		// insert is ON CONFLICT DO NOTHING, so null there means "already
		// recorded". The row the page gets back is read through `rateAt`, the
		// same lookup that prices a charge, which is why it is mocked here too.
		insertRate.mockResolvedValue('new')
		rateAt.mockResolvedValue(row({ id: 'new', pricePerKwh: 0.2314, source: 'manual' }))

		const res = await post(VALID)
		expect(res.status).toBe(201)

		const [, input] = insertRate.mock.calls[0] as [unknown, Record<string, unknown>]
		expect(input).toMatchObject({
			pricePerKwh: 0.2314,
			currency: 'USD',
			// A Date, not the string off the wire: the column is TIMESTAMPTZ and a
			// bare '2026-09-07' would be read in the server's zone rather than the
			// one the operator typed it in.
			source: 'manual'
		})
		expect(input['effectiveFrom']).toBeInstanceOf(Date)
		expect((input['effectiveFrom'] as Date).toISOString()).toBe(VALID.effectiveFrom)

		const body = (await res.json()) as { pricePerKwh: number; source: string }
		expect(body).toMatchObject({ pricePerKwh: 0.2314, source: 'manual' })
	})

	it('stores a rate added here as manual whatever the body claims', async () => {
		// The source is what §3.2's tiebreak reads to decide that a human meant
		// this one. A body that could set it to 'urdb' would let a typed rate lose
		// to the fetched one it was typed to override.
		insertRate.mockResolvedValue('r2')
		rateAt.mockResolvedValue(row({ source: 'manual' }))
		await post({ ...VALID, source: 'urdb', urdbLabel: 'Residential Schedule 7' })

		const [, input] = insertRate.mock.calls[0] as [unknown, Record<string, unknown>]
		expect(input['source']).toBe('manual')
		// Nor may it claim a URDB page it did not come from.
		expect(input['urdbLabel'] ?? null).toBeNull()
	})

	it('refuses a correction to a date that already carries a manual rate', async () => {
		// The insert is ON CONFLICT DO NOTHING and the form's date field lands
		// every entry for a day on the same midnight, so a typo noticed a minute
		// later collides with the row it meant to replace. Ignoring the null and
		// reading back through `rateAt` answered 201 Created with the OLD price,
		// and the page — which treats any ok response as success and reloads —
		// showed the number the operator had just tried to correct, as though
		// that were what they typed.
		insertRate.mockResolvedValue(null)
		rateAt.mockResolvedValue(
			row({
				id: 'already',
				pricePerKwh: 0.199,
				currency: 'USD',
				source: 'manual',
				effectiveFrom: new Date(VALID.effectiveFrom)
			})
		)

		const e = await thrownBy(() => post(VALID))
		expect(isHttpError(e, 409)).toBe(true)
		// The sentence has to carry the date and the number that is in the way,
		// or it is a refusal the operator cannot act on: the page prints it
		// verbatim and there is no edit and no delete to reach for.
		const message = (e as { body: { message: string } }).body.message
		expect(message).toContain('2026-09-07')
		expect(message).toContain('0.199')
		expect(message).toMatch(/later date/i)
	})

	it('answers a repeated submission of the same rate with the row already stored', async () => {
		// A double-clicked button is not a correction, and refusing it would
		// teach the operator that the form is broken. Same price, same currency,
		// same day: nothing to say beyond the row that is there.
		insertRate.mockResolvedValue(null)
		rateAt.mockResolvedValue(
			row({
				id: 'already',
				pricePerKwh: 0.2314,
				currency: 'USD',
				source: 'manual',
				effectiveFrom: new Date(VALID.effectiveFrom)
			})
		)

		const res = await post(VALID)
		expect(res.status).toBe(201)
		expect(await res.json()).toMatchObject({ pricePerKwh: 0.2314, source: 'manual' })
	})

	it('refuses a price that is not a number', async () => {
		expect(await refusal({ ...VALID, pricePerKwh: 'cheap' })).toMatch(/price/i)
	})

	it('refuses a missing price', async () => {
		expect(await refusal({ currency: 'USD', effectiveFrom: VALID.effectiveFrom })).toMatch(
			/price/i
		)
	})

	it('refuses a zero or negative price', async () => {
		// Zero is the dangerous one: it stores cleanly and prices every home charge
		// at nothing, which reads on the charges page as free rather than as wrong.
		expect(await refusal({ ...VALID, pricePerKwh: 0 })).toMatch(/greater than zero/i)
		vi.clearAllMocks()
		expect(await refusal({ ...VALID, pricePerKwh: -0.2 })).toMatch(/greater than zero/i)
	})

	it('refuses a price the column cannot hold', async () => {
		// NUMERIC(10,5) has five digits ahead of the point. A wider value is a
		// Postgres overflow error at insert, which reaches the page as a 500 and
		// a stack trace instead of a sentence naming the field.
		expect(await refusal({ ...VALID, pricePerKwh: 100000 })).toMatch(/price/i)
	})

	it('refuses a price that is not finite', async () => {
		// JSON has no Infinity, so this arrives as the string 'Infinity' or as a
		// raw token — both of which must land on the same refusal.
		expect(await refusal('{"pricePerKwh":1e999,"currency":"USD","effectiveFrom":"2026-09-07"}'))
			.toMatch(/price/i)
	})

	it('refuses a currency that is not a three-letter code', async () => {
		expect(await refusal({ ...VALID, currency: 'dollars' })).toMatch(/currency/i)
		vi.clearAllMocks()
		expect(await refusal({ ...VALID, currency: '' })).toMatch(/currency/i)
	})

	it('refuses a date it cannot read', async () => {
		expect(await refusal({ ...VALID, effectiveFrom: 'last tuesday' })).toMatch(/date/i)
		vi.clearAllMocks()
		expect(await refusal({ pricePerKwh: 0.2, currency: 'USD' })).toMatch(/date/i)
	})

	it('refuses a body that is not an object', async () => {
		expect(await refusal('not json at all')).toMatch(/\S/)
	})

	it('refuses an unauthenticated write', async () => {
		const e = await thrownBy(() => post(VALID, {}))
		expect(isHttpError(e, 401)).toBe(true)
		expect(insertRate).not.toHaveBeenCalled()
	})

	it('exposes no way to change or remove a rate', async () => {
		// A rate someone charged at is a historical fact: correcting it means
		// inserting a newer row, which leaves the old price visible next to the
		// charges it explains. An edit would silently re-price closed history.
		expect(Object.keys(routes).sort()).toEqual(['GET', 'POST'])
	})
})

describe('the manual-rate parser', () => {
	it('normalises a currency typed in lower case', async () => {
		// The operator types 'usd'; Intl.NumberFormat wants 'USD', and the column
		// is compared against Tesla's own currency codes elsewhere.
		const parsed = parseManualRate({ ...VALID, currency: 'usd' })
		expect(parsed.ok && parsed.value.currency).toBe('USD')
	})

	it('accepts a price typed as a string, because a form field is one', () => {
		const parsed = parseManualRate({ ...VALID, pricePerKwh: '0.199' })
		expect(parsed.ok && parsed.value.pricePerKwh).toBeCloseTo(0.199, 5)
	})

	it('accepts a bare date, and reads it as the start of that day in UTC', () => {
		// A rate takes effect on a day, not at an instant. `new Date('2026-09-07')`
		// is midnight UTC, which is the only reading that does not move the row by
		// a day depending on which pod parsed it.
		const parsed = parseManualRate({ ...VALID, effectiveFrom: '2026-09-07' })
		expect(parsed.ok && parsed.value.effectiveFrom.toISOString()).toBe(
			'2026-09-07T00:00:00.000Z'
		)
	})
})

describe('the energy settings page load', () => {
	it('hands the page the rates and the clock it renders ages against', async () => {
		rateAt.mockResolvedValue(row())
		listRates.mockResolvedValue([row()])

		const data = (await load({ locals: { user: { sub: 'operator' } } } as never)) as {
			current: { pricePerKwh: number } | null
			history: unknown[]
			now: string
		}

		expect(data.current?.pricePerKwh).toBe(0.199)
		expect(data.history).toHaveLength(1)
		// Fixed at render, so an age is computed against one instant rather than
		// against a `Date.now()` inside a `$derived`, which is not a reactive
		// dependency and freezes at its first read.
		expect(Number.isNaN(Date.parse(data.now))).toBe(false)
	})
})
