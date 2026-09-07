import { insertRate, listRates, rateAt, type EnergyRate } from '@ev/db'
import { getPool, withTransaction } from '$lib/server/db.js'

/**
 * The energy-rate history, read and appended to by the settings page (§4).
 *
 * A module of its own rather than three more functions in `queries.ts`, and
 * that is a boundary rather than tidiness: `queries.ts` is the read contract
 * the vehicle, session and sample APIs are built from, its `SESSION_COLUMNS`
 * list is shared by two queries that must not drift, and it writes nothing.
 * Rates are the opposite shape — a tiny table, one insert, no join to anything
 * — so they get their own door.
 *
 * DATABASE ACCESS GOES THROUGH THE @ev/db REPO LAYER, not through
 * hand-written SQL on a `Queryable` the way `queries.ts` does. Both
 * conventions are live in this app (`readTelemetryStatus` is the other one),
 * so the choice needs a reason: the rate lookup is not a plain "newest row"
 * query. It has a tiebreak — a manual row beats a fetched one on the same date
 * (§3.2) — and it is the SAME lookup the ingest worker prices a charge with.
 * A second copy of that ORDER BY here would be a second answer to "what did
 * this charge cost", and the first time the two disagreed the page would be
 * explaining a price nothing had used.
 *
 * The pool still comes from `$lib/server/db.js`, which exists so the app opens
 * exactly one; only the three rate functions are imported from @ev/db direct,
 * because listing them in db.ts's re-export block would put the rates story in
 * two files.
 */

/** A rate row as the wire and the page see it: instants as ISO, price as a number. */
export interface EnergyRateDto {
	effectiveFrom: string
	pricePerKwh: number
	currency: string
	source: string
	/** The URDB page a fetched value came from; null on a manual row. */
	urdbLabel: string | null
	fetchedAt: string
}

export interface EnergyRatesResponse {
	/**
	 * The rate in effect NOW, which is not `history[0]`.
	 *
	 * A row dated next month sorts to the top of the history and is not in
	 * effect, and a manual override wins a same-date tie. Both live in the repo
	 * lookup, and this field is what asking it produces.
	 */
	current: EnergyRateDto | null
	/** Newest first. Every row carries its source and date, or it explains nothing. */
	history: EnergyRateDto[]
}

/** What an insert needs. `source` is not in it: this page only writes manual rows. */
export interface ManualRateInput {
	effectiveFrom: Date
	pricePerKwh: number
	currency: string
}

export type ParseResult =
	| { ok: true; value: ManualRateInput }
	| { ok: false; message: string }

/**
 * Enough history to see the shape of a tariff without pretending to paginate.
 *
 * PSE changes its residential rate once or twice a year and the URDB fetch
 * inserts only on a change (§3.3), so fifty rows is decades. A page that grew
 * past it would want a real pager, not a bigger number.
 */
const HISTORY_LIMIT = 50

/**
 * The widest value `NUMERIC(10,5)` holds: five digits ahead of the point.
 *
 * Checked here rather than left to Postgres because an overflow at insert
 * arrives as a 500 with a driver message, and the page reads a failure as the
 * sentence to show the operator — "numeric field overflow" names no field.
 */
const MAX_PRICE = 100_000

export async function readEnergyRates(): Promise<EnergyRatesResponse> {
	const { current, history } = await withTransaction(getPool(), async (c) => ({
		current: await rateAt(c, new Date()),
		history: await listRates(c, HISTORY_LIMIT)
	}))
	return {
		current: current ? toDto(current) : null,
		history: history.map(toDto)
	}
}

/**
 * Append a manual rate.
 *
 * The only write on this surface. Nothing here edits or deletes a row, and
 * that is the design rather than an omission: a rate is what a charge was
 * actually priced at, and every closed session carries the number it was
 * computed with. Correcting a mistake means inserting a newer row — which
 * leaves the wrong price visible next to the charges that were priced by it,
 * where an edit would silently re-price closed history and leave nothing to
 * notice.
 */
export async function addManualRate(input: ManualRateInput): Promise<EnergyRateDto> {
	const stored = await withTransaction(getPool(), async (c) => {
		await insertRate(c, {
			effectiveFrom: input.effectiveFrom,
			pricePerKwh: input.pricePerKwh,
			currency: input.currency,
			// Not taken from the request under any circumstances. `source` is what
			// §3.2's tiebreak reads to decide a human meant this row, so a body that
			// could set it to 'urdb' would let a typed override lose to the fetched
			// value it was typed to replace.
			source: 'manual',
			urdbLabel: null
		})
		// Read back rather than echo the input, and read back through the SAME
		// lookup that prices a charge. `insertRate` answers with an id or with
		// null — null meaning a row for this instant and source was already
		// there, since the insert is ON CONFLICT DO NOTHING — so the input is not
		// evidence of what is stored, and `fetchedAt` is a column default this
		// tier never sees. Asking `rateAt` for the row in force at the instant
		// just written returns exactly this row (a manual row wins its own tie),
		// which means the page shows what a charge at that moment would be priced
		// at rather than what was typed.
		return await rateAt(c, input.effectiveFrom)
	})
	if (!stored) {
		// Unreachable short of the row being deleted inside the transaction that
		// wrote it, and loud rather than silent because the alternative is a 201
		// describing a rate that is not there.
		throw new Error('the rate was written but could not be read back')
	}
	return toDto(stored)
}

/**
 * Validate a posted rate, as a pure function.
 *
 * Returns a message rather than throwing so the route decides the status code
 * and this stays testable without a Kit runtime — and the messages are written
 * as sentences on purpose. The page reads a failed response as TEXT
 * (`errorMessageFrom`), so what is written here is verbatim what the operator
 * reads; "invalid input" would be a 400 that tells nobody which box to fix.
 */
export function parseManualRate(body: unknown): ParseResult {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		return { ok: false, message: 'A rate must be sent as a JSON object with a price, a currency and an effective-from date.' }
	}
	const raw = body as Record<string, unknown>

	// A string is the normal case, not a fallback: the form field this arrives
	// from is text, and coercing here is cheaper than trusting every caller to
	// have parsed it. `Number('')` is 0 and `Number(null)` is 0, so both are
	// rejected explicitly rather than sliding through as a free tariff.
	const priceRaw = raw['pricePerKwh']
	if (priceRaw === null || priceRaw === undefined || priceRaw === '') {
		return { ok: false, message: 'A rate needs a price per kWh, such as 0.199.' }
	}
	const price = typeof priceRaw === 'number' ? priceRaw : Number(String(priceRaw).trim())
	if (!Number.isFinite(price)) {
		return { ok: false, message: `The price per kWh must be a number — "${String(priceRaw)}" is not one.` }
	}
	if (price <= 0) {
		// Zero is the dangerous value here, not a negative one. It stores cleanly
		// and prices every home charge at nothing, which the charges page renders
		// as free rather than as wrong.
		return { ok: false, message: 'The price per kWh must be greater than zero.' }
	}
	if (price >= MAX_PRICE) {
		return { ok: false, message: `The price per kWh must be below ${MAX_PRICE}, which is the largest value the column stores.` }
	}

	const currencyRaw = raw['currency']
	const currency = typeof currencyRaw === 'string' ? currencyRaw.trim().toUpperCase() : ''
	// Three letters because that is what `Intl.NumberFormat` accepts, and
	// `formatCost` is what renders every priced charge. A code it rejects would
	// put the fallback "0.20 DOLLARS" on the charges page for good.
	if (!/^[A-Z]{3}$/.test(currency)) {
		return { ok: false, message: 'The currency must be a three-letter code such as USD or GBP.' }
	}

	const fromRaw = raw['effectiveFrom']
	if (typeof fromRaw !== 'string' || fromRaw.trim() === '') {
		return { ok: false, message: 'A rate needs an effective-from date, such as 2026-09-07.' }
	}
	// `new Date('2026-09-07')` is midnight UTC — a bare date read in the pod's
	// zone would move the row by a day depending on where it was parsed, and a
	// charge either side of midnight would be priced at the wrong rate.
	const effectiveFrom = new Date(fromRaw.trim())
	if (Number.isNaN(effectiveFrom.getTime())) {
		return { ok: false, message: `The effective-from date could not be read as a date — "${fromRaw}" is not one. Use a date such as 2026-09-07.` }
	}

	return { ok: true, value: { effectiveFrom, pricePerKwh: price, currency } }
}

/**
 * A row to the shape the page renders.
 *
 * The price is coerced rather than passed through. `pg` returns NUMERIC as a
 * string and this repo installs no `setTypeParser`, so a value that reached
 * the page unconverted would multiply correctly, add by concatenation, and
 * render `0.1990` where the number says 0.199.
 */
function toDto(r: EnergyRate): EnergyRateDto {
	return {
		effectiveFrom: instant(r.effectiveFrom),
		pricePerKwh: Number(r.pricePerKwh),
		currency: r.currency,
		source: r.source,
		urdbLabel: r.urdbLabel ?? null,
		fetchedAt: instant(r.fetchedAt)
	}
}

function instant(v: Date | string): string {
	return v instanceof Date ? v.toISOString() : new Date(v).toISOString()
}
