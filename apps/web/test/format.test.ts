import { describe, expect, it } from 'vitest'
import {
	DASH,
	barToPsi,
	cToF,
	formatCoords,
	formatCost,
	formatEstimatedCost,
	formatDate,
	formatDateTime,
	formatDistance,
	formatDuration,
	formatEfficiency,
	formatInteger,
	formatKwh,
	formatNumber,
	formatOdometer,
	formatOnOff,
	formatPct,
	formatPressure,
	formatRatePerKwh,
	formatRelative,
	formatUnpricedCost,
	formatSpeed,
	formatTemp,
	formatText,
	formatVolts,
	hasCoords,
	kmToMi,
	whPerKmToWhPerMi
} from '../src/lib/format.js'

/**
 * The null discipline, tested where it can actually fail.
 *
 * Every one of these guards the same mistake: `value || DASH`, or `value ?? 0`,
 * or a `if (!x)` guard — each of which turns a real zero into "not recorded" or
 * a "not recorded" into a zero. The pages have no other line of defence,
 * because with an empty database every one of these formatters is called with
 * null on every render and nothing looks wrong.
 */
describe('null versus zero', () => {
	// A truthiness check would fail exactly the 0 rows and pass everything else.
	const cases: [string, unknown, string][] = [
		['formatNumber(0, 1)', formatNumber(0, 1), '0.0'],
		['formatNumber(null)', formatNumber(null), DASH],
		['formatNumber(undefined)', formatNumber(undefined), DASH],
		['formatNumber(NaN)', formatNumber(NaN), DASH],
		['formatNumber(Infinity)', formatNumber(Infinity), DASH],
		['formatDistance(0)', formatDistance(0), '0.0 mi'],
		['formatDistance(null)', formatDistance(null), DASH],
		['formatKwh(0)', formatKwh(0), '0.00 kWh'],
		['formatKwh(null)', formatKwh(null), DASH],
		['formatPct(0)', formatPct(0), '0%'],
		['formatPct(null)', formatPct(null), DASH],
		// 0°C is 32°F, not 0°F: the one unit here with an offset, so a
		// zero that survives conversion is a real reading, not a passthrough.
		['formatTemp(0)', formatTemp(0), '32°F'],
		['formatTemp(-3)', formatTemp(-3), '27°F'],
		['formatTemp(null)', formatTemp(null), DASH],
		['formatPressure(0)', formatPressure(0), '0.0 psi'],
		['formatPressure(null)', formatPressure(null), DASH],
		['formatSpeed(0)', formatSpeed(0), '0 mph'],
		['formatSpeed(null)', formatSpeed(null), DASH],
		['formatEfficiency(0)', formatEfficiency(0), '0 Wh/mi'],
		['formatEfficiency(null)', formatEfficiency(null), DASH],
		['formatOdometer(0)', formatOdometer(0), '0 mi'],
		['formatOdometer(null)', formatOdometer(null), DASH],
		['formatInteger(0)', formatInteger(0), '0'],
		['formatInteger(null)', formatInteger(null), DASH]
	]

	for (const [name, actual, expected] of cases) {
		it(`${name} is ${expected}`, () => {
			expect(actual).toBe(expected)
		})
	}
})

/**
 * The conversions themselves, separately from the formatters.
 *
 * These exist because the charts need converted NUMBERS rather than formatted
 * strings — a series plotted in km/h under an axis labelled mph is wrong in a
 * way no formatter test would catch, and the axis is drawn from the data.
 */
describe('unit conversion', () => {
	it('converts kilometres to miles', () => {
		expect(kmToMi(100)).toBeCloseTo(62.1371, 4)
		expect(kmToMi(0)).toBe(0)
	})

	it('converts Celsius to Fahrenheit, offset included', () => {
		// A scale-only conversion (the plausible mistake) passes 100 and fails
		// both of the others, which is why all three are here.
		expect(cToF(100)).toBeCloseTo(212, 6)
		expect(cToF(0)).toBeCloseTo(32, 6)
		expect(cToF(-40)).toBeCloseTo(-40, 6)
	})

	it('converts bar to psi', () => {
		expect(barToPsi(1)).toBeCloseTo(14.5038, 4)
	})

	/**
	 * Wh/km -> Wh/mi MULTIPLIES by km per mile. Efficiency is energy per unit
	 * distance, so it scales the opposite way to a distance: a mile is longer
	 * than a kilometre, so it costs MORE watt-hours. Dividing (the instinct
	 * carried over from kmToMi) would report a Model Y as half as thirsty as it
	 * is, which is plausible enough on screen never to be questioned.
	 */
	it('converts Wh/km to Wh/mi by scaling up, not down', () => {
		expect(whPerKmToWhPerMi(100)).toBeCloseTo(160.934, 3)
		expect(whPerKmToWhPerMi(100)).toBeGreaterThan(100)
	})

	it('passes null through every converter', () => {
		for (const f of [kmToMi, cToF, barToPsi, whPerKmToWhPerMi]) {
			expect(f(null)).toBeNull()
			expect(f(undefined)).toBeNull()
		}
	})
})

describe('imperial rendering', () => {
	it('renders distance in miles', () => {
		expect(formatDistance(100)).toBe('62.1 mi')
	})

	it('renders an odometer in whole, grouped miles', () => {
		expect(formatOdometer(160934)).toBe('100,000 mi')
	})

	it('renders speed in mph', () => {
		expect(formatSpeed(100)).toBe('62 mph')
	})

	it('renders efficiency in Wh/mi', () => {
		expect(formatEfficiency(150)).toBe('241 Wh/mi')
	})

	it('renders temperature in Fahrenheit', () => {
		expect(formatTemp(21)).toBe('70°F')
	})

	it('renders tyre pressure in psi', () => {
		expect(formatPressure(2.9)).toBe('42.1 psi')
	})

	it('leaves energy and power alone: they are the same in both systems', () => {
		expect(formatKwh(12.5)).toBe('12.50 kWh')
	})
})

describe('formatInteger', () => {
	it('groups thousands so a six-digit odometer stays readable', () => {
		expect(formatInteger(123456)).toBe('123,456')
	})
})

describe('formatDuration', () => {
	// Table-driven around every boundary in the function: one flipped
	// comparison or one wrong divisor shows up as a named failure here.
	const cases: [number | null, string][] = [
		[0, '0s'],
		[1, '1s'],
		[59, '59s'],
		[60, '1m'],
		[61, '1m'],
		[3599, '59m'],
		[3600, '1h 00m'],
		[3660, '1h 01m'],
		[7199, '1h 59m'],
		[7200, '2h 00m'],
		[86399, '23h 59m'],
		// An open session carries null by contract; a negative duration is clock
		// skew, and "-1h 00m" would present broken data as a fact about the car.
		[null, DASH],
		[-1, DASH]
	]

	for (const [input, expected] of cases) {
		it(`${input} seconds -> ${expected}`, () => {
			expect(formatDuration(input)).toBe(expected)
		})
	}
})

describe('formatCost', () => {
	it('renders a currency amount when both halves are present', () => {
		expect(formatCost(12.5, 'GBP')).toBe('£12.50')
	})

	it('is a dash when the currency is missing, even with an amount', () => {
		// costCurrency is null whenever cost is null, but the reverse pairing is
		// the one that would render a bare "12.5" with no unit.
		expect(formatCost(12.5, null)).toBe(DASH)
	})

	it('is a dash when the amount is missing', () => {
		expect(formatCost(null, 'GBP')).toBe(DASH)
	})

	it('renders zero cost rather than hiding it', () => {
		expect(formatCost(0, 'GBP')).toBe('£0.00')
	})

	it('survives an unknown ISO code instead of taking the page down', () => {
		expect(formatCost(3, 'NOTACURRENCY')).toBe('3.00 NOTACURRENCY')
	})
})

describe('formatEstimatedCost', () => {
	it('marks a backfilled figure, which is arithmetic rather than money paid', () => {
		// The charges list is a column of numbers and nothing else, so without
		// the marker an estimate computed at today's tariff reads exactly like a
		// price that was actually charged.
		expect(formatEstimatedCost(8.2, 'USD', 'backfill-estimate')).toBe('≈US$8.20')
	})

	it('leaves a measured figure alone whatever priced it', () => {
		for (const source of ['urdb', 'manual', 'tesla-invoice', null] as const) {
			expect(formatEstimatedCost(8.2, 'USD', source)).toBe('US$8.20')
		}
	})

	it('never approximates a dash', () => {
		// "≈—" would be a marker on the absence of a figure, which is not an
		// estimate of anything.
		expect(formatEstimatedCost(null, null, 'backfill-estimate')).toBe(DASH)
	})
})

describe('formatRatePerKwh', () => {
	it('keeps the tenth of a cent a tariff is actually quoted in', () => {
		// Intl's currency style defaults to the currency's own 2 digits, which
		// rounds a 19.9c/kWh tariff to 20c and makes the charge page's own
		// arithmetic fail to multiply out. The rate column stores 5 decimals, so
		// the formatter shows up to 5 and never invents precision it wasn't given.
		// The locale is formatCost's, so the two money strings on a charge page
		// agree with each other rather than one saying $ and the other US$.
		expect(formatRatePerKwh(0.199, 'USD')).toBe('US$0.199/kWh')
	})

	it('still reads as money at whole cents', () => {
		expect(formatRatePerKwh(0.12, 'GBP')).toBe('£0.12/kWh')
	})

	it('renders a free tariff as free rather than as unknown', () => {
		// Same rule formatCost lives by: a rate of zero is a fact about the
		// tariff, and hiding it behind a dash would read as an outage.
		expect(formatRatePerKwh(0, 'GBP')).toBe('£0.00/kWh')
	})

	it('is a dash when either half is missing', () => {
		expect(formatRatePerKwh(null, 'USD')).toBe(DASH)
		expect(formatRatePerKwh(0.199, null)).toBe(DASH)
	})

	it('survives an unknown ISO code instead of taking the charge page down', () => {
		expect(formatRatePerKwh(0.199, 'NOTACURRENCY')).toBe('0.199 NOTACURRENCY/kWh')
	})
})

describe('formatUnpricedCost', () => {
	/**
	 * There are FOUR ways a charge ends up without a figure, not three, and the
	 * two that share a basis are the ones that get dropped: a home charge with
	 * no rate row covering its date and a home charge the car never reported
	 * energy for are both `home`, and both would otherwise render an empty
	 * title next to a dash that looks like a bug in the page.
	 */
	it('names a home charge no rate row covers', () => {
		expect(formatUnpricedCost('home', 30)).toBe('No rate for this date')
	})

	it('names a home charge the car reported no energy for', () => {
		// Checked before the rate, because with no kWh there is nothing to
		// multiply and the rate is beside the point.
		expect(formatUnpricedCost('home', null)).toBe('Energy not measured')
	})

	it('says a Supercharger stop is waiting on Tesla, not that it was free', () => {
		expect(formatUnpricedCost('pending', 42)).toBe('Awaiting Tesla invoice')
	})

	it('says an unknown charger is unpriced', () => {
		expect(formatUnpricedCost('unknown', 42)).toBe('Not priced')
	})

	it('answers for a session with no basis at all rather than returning nothing', () => {
		// Drives and idles carry a null basis, and so does every charge closed
		// before pricing shipped. The rendered page may never contain the words
		// "null" or "undefined" (components.test.ts), so every input has words.
		expect(formatUnpricedCost(null, null)).toBe('Not priced')
	})
})

describe('timestamps', () => {
	const iso = '2026-09-04T07:31:00.000Z'

	it('formats a UTC instant in the requested zone', () => {
		// The month abbreviation is ICU's ('Sep' or 'Sept' depending on the
		// Node build), so the assertion pins the parts that are ours: the right
		// day, the right year, and the requested zone rather than the host's.
		expect(formatDateTime(iso, { timeZone: 'UTC' })).toMatch(/^4 Sept? 2026, 07:31$/)
	})

	it('formats a bare calendar date, which is what observedOn is', () => {
		expect(formatDate('2026-09-04', { timeZone: 'UTC' })).toMatch(/^4 Sept? 2026$/)
	})

	it('dashes null rather than rendering "Invalid Date"', () => {
		expect(formatDateTime(null)).toBe(DASH)
		expect(formatDate(undefined)).toBe(DASH)
	})

	it('dashes an unparseable string rather than throwing', () => {
		expect(formatDateTime('not a timestamp')).toBe(DASH)
	})
})

describe('formatRelative', () => {
	const now = new Date('2026-09-04T12:00:00.000Z')

	it('reports minutes for a recent reading', () => {
		expect(formatRelative('2026-09-04T11:56:00.000Z', now)).toBe('4 minutes ago')
	})

	it('reports hours once past an hour', () => {
		expect(formatRelative('2026-09-04T09:00:00.000Z', now)).toBe('3 hours ago')
	})

	it('reports days once past a day, which is what an ingest outage looks like', () => {
		expect(formatRelative('2026-09-01T12:00:00.000Z', now)).toBe('3 days ago')
	})

	it('dashes a missing timestamp', () => {
		expect(formatRelative(null, now)).toBe(DASH)
	})
})

describe('coordinates', () => {
	// (0, 0) is a real place in the Gulf of Guinea. A truthiness check on lat
	// and lon would treat the equator and the prime meridian as "no position",
	// and a null-to-zero coercion would put a parked car there.
	it('accepts a genuine zero coordinate', () => {
		expect(hasCoords(0, 0)).toBe(true)
	})

	it('rejects a half-present pair', () => {
		expect(hasCoords(51.5, null)).toBe(false)
		expect(hasCoords(null, -0.12)).toBe(false)
	})

	it('rejects a pair with no coordinates at all', () => {
		expect(hasCoords(null, null)).toBe(false)
	})

	it('formats a pair to four decimals, and a missing pair to a dash', () => {
		expect(formatCoords(51.50123456, -0.12654321)).toBe('51.5012, -0.1265')
		expect(formatCoords(null, null)).toBe(DASH)
	})
})

/**
 * The formatters spec §3.8's tiles needed.
 *
 * Every one of the signals behind them is null until the car reports it, which
 * is the state on the day the columns ship — so the null case is the one that
 * renders first and the one worth pinning.
 */
describe('the new tiles\' formatters', () => {
	it('renders whole volts, and a dash for no reading', () => {
		expect(formatVolts(232.4)).toBe('232 V')
		// A supply genuinely reading zero is not a supply we know nothing about.
		expect(formatVolts(0)).toBe('0 V')
		expect(formatVolts(null)).toBe(DASH)
	})

	it('renders an enum name verbatim rather than guessing at it', () => {
		// Stored as the vendor's own string (spec §2), and we have not observed
		// most of these payloads: prettifying 'ACSingleWireCAN' into something
		// friendlier would be inventing a mapping we cannot check.
		expect(formatText('ACSingleWireCAN')).toBe('ACSingleWireCAN')
		expect(formatText(null)).toBe(DASH)
		// A blank string is a column that was written with nothing in it, which
		// is "not recorded" rather than a value whose name is empty.
		expect(formatText('   ')).toBe(DASH)
	})

	it('renders a tri-state boolean without turning unknown into off', () => {
		expect(formatOnOff(true)).toBe('On')
		expect(formatOnOff(false)).toBe('Off')
		// The whole point: a car that has not said whether sentry is on is not
		// a car with sentry off.
		expect(formatOnOff(null)).toBe(DASH)
		expect(formatOnOff(true, 'Open', 'Closed')).toBe('Open')
		expect(formatOnOff(false, 'Open', 'Closed')).toBe('Closed')
	})
})
