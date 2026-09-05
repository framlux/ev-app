import { describe, expect, it, vi } from 'vitest'
import {
	ApiProblem,
	deriveActivity,
	decodeCursor,
	degradationPct,
	encodeCursor,
	getBatteryHealth,
	getSampleSeries,
	getSessionDetail,
	getVehicle,
	getVehicleState,
	getVehicleStats,
	listSessions,
	listVehicles,
	parseRangeQuery,
	parseSampleQuery,
	parseSessionQuery,
	planDecimation,
	round,
	selectBaseline,
	SAMPLE_SERIES_CAP,
	SESSION_POINT_CAP,
	type Queryable
} from '../src/lib/server/queries.js'
import type { BatteryHealthPoint, VehicleState } from '../src/lib/api-types.js'

type Row = Record<string, unknown>

/**
 * A stand-in for `pg.Pool` that answers by matching the SQL text.
 *
 * The point of the seam is that "what does the API do when the database is
 * empty" is answerable without a database — and today the database IS empty,
 * so the empty case is the normal case, not an edge case. The real-Postgres
 * tests in api-db.test.ts cover the other half: that this SQL is valid and
 * that the column names exist.
 */
function fakeDb(
	answers: Array<[RegExp, Row[]]>
): Queryable & { calls: Array<{ sql: string; values: unknown[] }> } {
	const calls: Array<{ sql: string; values: unknown[] }> = []
	return {
		calls,
		async query(sql: string, values: unknown[] = []) {
			calls.push({ sql, values })
			for (const [pattern, rows] of answers) {
				if (pattern.test(sql)) return { rows }
			}
			return { rows: [] }
		}
	}
}

/** A vehicle row with no sample and no open session joined to it. */
const VEHICLE_ROW: Row = {
	vehicle_id: 'v1',
	vendor: 'tesla',
	vendor_vehicle_id: 'VIN1',
	display_name: 'Blue',
	model: 'Model Y',
	model_year: 2023,
	created_at: new Date('2026-01-01T00:00:00Z'),
	ts: null,
	soc_pct: null,
	range_km: null,
	odometer_km: null,
	lat: null,
	lon: null,
	speed_kph: null,
	power_state: null,
	charge_state: null,
	charge_power_kw: null,
	charge_energy_added_kwh: null,
	inside_temp_c: null,
	outside_temp_c: null,
	locked: null,
	doors_open: null,
	tpms: null,
	open_drive_id: null,
	open_charge_id: null
}

const EXISTS: [RegExp, Row[]] = [/SELECT 1 FROM vehicle/, [{ '?column?': 1 }]]

function state(overrides: Partial<VehicleState> = {}): VehicleState {
	return {
		vehicleId: 'v1',
		ts: '2026-09-04T00:00:00.000Z',
		socPct: null,
		rangeKm: null,
		odometerKm: null,
		lat: null,
		lon: null,
		speedKph: null,
		powerState: null,
		chargeState: null,
		chargePowerKw: null,
		chargeEnergyAddedKwh: null,
		insideTempC: null,
		outsideTempC: null,
		locked: null,
		doorsOpen: null,
		tpms: null,
		...overrides
	}
}

function bhp(capacity: number, confidence: number, day = '2026-01-01'): BatteryHealthPoint {
	return {
		observedOn: day,
		estimatedCapacityKwh: capacity,
		ratedRangeAt100Km: null,
		sampleConfidence: confidence
	}
}

/* ------------------------------------------------------------------ *
 * Query-parameter validation
 * ------------------------------------------------------------------ */

describe('parseSessionQuery', () => {
	it('defaults to a bounded page size', () => {
		expect(parseSessionQuery(new URLSearchParams()).limit).toBe(50)
	})

	it('caps limit so a client cannot request the whole archive', () => {
		expect(parseSessionQuery(new URLSearchParams('limit=100000')).limit).toBe(500)
	})

	// The clamp is one comparison. These four rows are what stop it being
	// quietly widened, or turned into a rejection, without a test noticing.
	it.each([
		['limit=1', 1],
		['limit=49', 49],
		['limit=50', 50],
		['limit=500', 500],
		['limit=501', 500]
	])('clamps %s to %i', (qs, expected) => {
		expect(parseSessionQuery(new URLSearchParams(qs)).limit).toBe(expected)
	})

	it.each(['limit=abc', 'limit=', 'limit=0', 'limit=-1', 'limit=1.5', 'limit=NaN'])(
		'rejects %s rather than falling back to the default',
		(qs) => {
			expect(() => parseSessionQuery(new URLSearchParams(qs))).toThrow(ApiProblem)
		}
	)

	it('rejects an unknown kind rather than silently ignoring it', () => {
		expect(() => parseSessionQuery(new URLSearchParams('kind=teleport'))).toThrow()
	})

	it.each(['drive', 'charge', 'idle'])('accepts kind=%s', (kind) => {
		expect(parseSessionQuery(new URLSearchParams(`kind=${kind}`)).kind).toBe(kind)
	})

	it('omits kind entirely when it was not asked for', () => {
		expect(parseSessionQuery(new URLSearchParams()).kind).toBeUndefined()
	})

	it('parses an ISO date range', () => {
		const q = parseSessionQuery(new URLSearchParams('from=2026-09-01&to=2026-09-30'))
		expect(q.from?.toISOString()).toBe('2026-09-01T00:00:00.000Z')
		expect(q.to?.toISOString()).toBe('2026-09-30T00:00:00.000Z')
	})

	it('parses a full datetime as well as a bare date', () => {
		const q = parseSessionQuery(new URLSearchParams('from=2026-09-01T07:31:00.000Z'))
		expect(q.from?.toISOString()).toBe('2026-09-01T07:31:00.000Z')
	})

	it('rejects an unparseable date rather than treating it as absent', () => {
		expect(() => parseSessionQuery(new URLSearchParams('from=last-tuesday'))).toThrow(ApiProblem)
	})

	it('rejects a range whose end precedes its start', () => {
		expect(() => parseSessionQuery(new URLSearchParams('from=2026-09-30&to=2026-09-01'))).toThrow()
	})

	it('allows an empty but coherent range where to equals from', () => {
		expect(() =>
			parseSessionQuery(new URLSearchParams('from=2026-09-01&to=2026-09-01'))
		).not.toThrow()
	})

	it('passes a cursor through untouched', () => {
		const c = encodeCursor('2026-09-01T00:00:00.000Z', 's1')
		expect(parseSessionQuery(new URLSearchParams(`cursor=${c}`)).cursor).toBe(c)
	})
})

describe('parseSampleQuery', () => {
	const base = 'from=2026-01-01&to=2026-01-02'

	it('requires from, to and fields', () => {
		expect(() => parseSampleQuery(new URLSearchParams('to=2026-01-02&fields=socPct'))).toThrow(
			ApiProblem
		)
		expect(() => parseSampleQuery(new URLSearchParams('from=2026-01-01&fields=socPct'))).toThrow(
			ApiProblem
		)
		expect(() => parseSampleQuery(new URLSearchParams(base))).toThrow(ApiProblem)
		expect(() => parseSampleQuery(new URLSearchParams(`${base}&fields=`))).toThrow(ApiProblem)
	})

	it('accepts a comma-separated subset in request order', () => {
		const q = parseSampleQuery(new URLSearchParams(`${base}&fields=outsideTempC,socPct`))
		expect(q.fields).toEqual(['outsideTempC', 'socPct'])
	})

	it('de-duplicates repeated fields so the SELECT list stays well formed', () => {
		const q = parseSampleQuery(new URLSearchParams(`${base}&fields=socPct,socPct`))
		expect(q.fields).toEqual(['socPct'])
	})

	it('rejects a field name outside the contract', () => {
		expect(() => parseSampleQuery(new URLSearchParams(`${base}&fields=socPct,batteryTempC`))).toThrow(
			ApiProblem
		)
	})

	// A window this wide over a partitioned table with a row every few seconds
	// is a request for the whole archive. 90 days in, 90 days plus a
	// millisecond out — the comparison itself is what these rows pin.
	const DAY = 24 * 60 * 60 * 1000
	it.each([
		[89 * DAY, true],
		[90 * DAY, true],
		[90 * DAY + 1, false],
		[91 * DAY, false]
	])('accepts a %i ms window: %s', (span, allowed) => {
		const from = new Date('2026-01-01T00:00:00.000Z')
		const to = new Date(from.getTime() + span)
		const qs = new URLSearchParams({
			from: from.toISOString(),
			to: to.toISOString(),
			fields: 'socPct'
		})
		if (allowed) {
			expect(parseSampleQuery(qs).fields).toEqual(['socPct'])
		} else {
			expect(() => parseSampleQuery(qs)).toThrow(/range too large/)
		}
	})

	it('rejects a range whose end precedes its start', () => {
		expect(() =>
			parseSampleQuery(new URLSearchParams('from=2026-01-02&to=2026-01-01&fields=socPct'))
		).toThrow(ApiProblem)
	})
})

describe('parseRangeQuery', () => {
	it('leaves both bounds undefined when neither is given', () => {
		expect(parseRangeQuery(new URLSearchParams())).toEqual({})
	})

	it('rejects an inverted range', () => {
		expect(() => parseRangeQuery(new URLSearchParams('from=2026-02-01&to=2026-01-01'))).toThrow(
			ApiProblem
		)
	})
})

/* ------------------------------------------------------------------ *
 * Cursors
 * ------------------------------------------------------------------ */

describe('cursors', () => {
	it('round-trips a timestamp and an id', () => {
		const c = encodeCursor('2026-09-01T07:31:00.000Z', 'sess-1')
		expect(decodeCursor(c)).toEqual({
			startedAt: new Date('2026-09-01T07:31:00.000Z'),
			id: 'sess-1'
		})
	})

	it('keeps an id containing the separator intact', () => {
		const c = encodeCursor('2026-09-01T07:31:00.000Z', 'a|b')
		expect(decodeCursor(c).id).toBe('a|b')
	})

	it.each(['', 'not-base64!!', 'Zm9v', encodeCursor('not-a-date', 's1')])(
		'rejects the malformed cursor %s instead of silently serving page one',
		(bad) => {
			expect(() => decodeCursor(bad)).toThrow(ApiProblem)
		}
	)
})

/* ------------------------------------------------------------------ *
 * Decimation
 * ------------------------------------------------------------------ */

describe('planDecimation', () => {
	// The cap is a single `<=`. Off by one here means a 2001-point drive is
	// served whole while claiming it was not thinned, or a 2000-point one is
	// thinned while claiming it was.
	it.each([
		[0, SESSION_POINT_CAP, 1, false],
		[1999, SESSION_POINT_CAP, 1, false],
		[2000, SESSION_POINT_CAP, 1, false],
		[2001, SESSION_POINT_CAP, 2, true],
		[4001, SESSION_POINT_CAP, 3, true],
		[4999, SAMPLE_SERIES_CAP, 1, false],
		[5000, SAMPLE_SERIES_CAP, 1, false],
		[5001, SAMPLE_SERIES_CAP, 2, true]
	])('total %i against cap %i keeps every %i (downsampled: %s)', (total, cap, step, flag) => {
		expect(planDecimation(total, cap)).toEqual({ step, downsampled: flag })
	})

	it('never returns a step of zero, which would divide the whole series away', () => {
		for (const total of [1, 10, 12345, 1_000_000]) {
			expect(planDecimation(total, SESSION_POINT_CAP).step).toBeGreaterThanOrEqual(1)
		}
	})
})

/* ------------------------------------------------------------------ *
 * Rounding and null preservation
 * ------------------------------------------------------------------ */

describe('round', () => {
	it('preserves null rather than producing zero', () => {
		expect(round(null, 2)).toBeNull()
	})

	it('keeps a genuine zero', () => {
		expect(round(0, 2)).toBe(0)
	})

	it('erases float4 widening noise at the stated precision', () => {
		expect(round(12.199999809265137, 1)).toBe(12.2)
		expect(round(12.199999809265137, 2)).toBe(12.2)
	})
})

/* ------------------------------------------------------------------ *
 * Activity derivation
 * ------------------------------------------------------------------ */

describe('deriveActivity', () => {
	it.each([
		['no sample ever', null, null, null, 'unknown', null],
		['open drive', state(), 'd1', null, 'driving', 'd1'],
		['open charge', state(), null, 'c1', 'charging', 'c1'],
		['open drive wins over open charge', state(), 'd1', 'c1', 'driving', 'd1'],
		[
			'charging by state with no session yet',
			state({ chargeState: 'charging' }),
			null,
			null,
			'charging',
			null
		],
		['asleep', state({ powerState: 'asleep' }), null, null, 'asleep', null],
		['offline', state({ powerState: 'offline' }), null, null, 'offline', null],
		['online and idle', state({ powerState: 'online' }), null, null, 'parked', null],
		[
			'plugged in but not charging is parked',
			state({ powerState: 'online', chargeState: 'connected' }),
			null,
			null,
			'parked',
			null
		],
		['a sample that says nothing at all', state(), null, null, 'parked', null]
	])('%s', (_name, st, drive, charge, activity, openSessionId) => {
		expect(deriveActivity(st as VehicleState | null, drive as string | null, charge as string | null)).toEqual({
			activity,
			openSessionId
		})
	})

	it('never deep-links a session id for a pill that is not a session', () => {
		for (const st of [
			state({ powerState: 'asleep' }),
			state({ chargeState: 'charging' }),
			null
		]) {
			expect(deriveActivity(st, null, null).openSessionId).toBeNull()
		}
	})
})

/* ------------------------------------------------------------------ *
 * Battery health arithmetic
 * ------------------------------------------------------------------ */

describe('selectBaseline', () => {
	// The confidence floor is the guard that stops a 3% top-up, whose implied
	// capacity is mostly rounding error, from defining "new".
	it.each([
		[0.49, null],
		[0.5, 70],
		[0.51, 70]
	])('a lone sample with confidence %s yields baseline %s', (confidence, expected) => {
		expect(selectBaseline([bhp(70, confidence)])).toBe(expected)
	})

	it('ignores a high but untrustworthy reading in favour of a lower trusted one', () => {
		expect(selectBaseline([bhp(99, 0.49), bhp(70, 0.9)])).toBe(70)
	})

	it('takes the best trusted reading, not the first or the last', () => {
		expect(selectBaseline([bhp(68, 0.9), bhp(72, 0.9), bhp(70, 0.9)])).toBe(72)
	})

	it('is null when nothing clears the floor', () => {
		expect(selectBaseline([bhp(70, 0.1), bhp(71, 0.2)])).toBeNull()
	})

	it('is null for an empty history', () => {
		expect(selectBaseline([])).toBeNull()
	})
})

describe('degradationPct', () => {
	it('is null with a baseline but no latest sample', () => {
		expect(degradationPct(70, null)).toBeNull()
	})

	it('is null with a latest sample but no baseline: one measurement is not a trend', () => {
		expect(degradationPct(null, bhp(70, 0.1))).toBeNull()
	})

	it('reports the loss against the baseline to 1 dp', () => {
		expect(degradationPct(75, bhp(70, 0.9))).toBe(6.7)
	})

	it('clamps at zero rather than reporting a battery that grew', () => {
		expect(degradationPct(70, bhp(72, 0.3))).toBe(0)
	})

	it('is null rather than Infinity when the baseline is not a usable divisor', () => {
		expect(degradationPct(0, bhp(70, 0.9))).toBeNull()
	})
})

/* ------------------------------------------------------------------ *
 * Behaviour against an empty database — today's normal case
 * ------------------------------------------------------------------ */

describe('empty database', () => {
	it('lists no vehicles instead of failing', async () => {
		await expect(listVehicles(fakeDb([]))).resolves.toEqual({ vehicles: [] })
	})

	it('404s an unknown vehicle', async () => {
		await expect(getVehicle('nope', fakeDb([]))).rejects.toMatchObject({
			status: 404,
			message: 'vehicle not found'
		})
	})

	it('404s an unknown vehicle on the state endpoint before blaming ingestion', async () => {
		await expect(getVehicleState('nope', fakeDb([]))).rejects.toMatchObject({
			status: 404,
			message: 'vehicle not found'
		})
	})

	it('distinguishes a known vehicle that has never reported', async () => {
		await expect(getVehicleState('v1', fakeDb([EXISTS]))).rejects.toMatchObject({
			status: 404,
			message: 'no samples for vehicle'
		})
	})

	it('returns an empty session page with no cursor', async () => {
		await expect(listSessions('v1', { limit: 50 }, fakeDb([]))).resolves.toEqual({
			sessions: [],
			nextCursor: null
		})
	})

	it('404s an unknown session', async () => {
		await expect(getSessionDetail('nope', fakeDb([]))).rejects.toMatchObject({
			status: 404,
			message: 'session not found'
		})
	})

	it('returns a known vehicle with no battery estimates as 200 with an empty trend', async () => {
		await expect(getBatteryHealth('v1', {}, fakeDb([EXISTS]))).resolves.toEqual({
			vehicleId: 'v1',
			samples: [],
			baselineCapacityKwh: null,
			latest: null,
			degradationPct: null
		})
	})

	it('404s battery health for an unknown vehicle', async () => {
		await expect(getBatteryHealth('nope', {}, fakeDb([]))).rejects.toMatchObject({ status: 404 })
	})

	it('serves an empty sample series without inventing points', async () => {
		const res = await getSampleSeries(
			'v1',
			{
				from: new Date('2026-09-01T00:00:00Z'),
				to: new Date('2026-09-02T00:00:00Z'),
				fields: ['socPct']
			},
			fakeDb([EXISTS])
		)
		expect(res.samples).toEqual([])
		expect(res.downsampled).toBe(false)
		expect(res.fields).toEqual(['socPct'])
		expect(res.from).toBe('2026-09-01T00:00:00.000Z')
	})

	it('reports null totals over an empty window, never zero', async () => {
		const empty: Row = {
			drive_count: '0',
			charge_count: '0',
			distance_km: null,
			drive_energy_kwh: null,
			charge_energy_kwh: null,
			driving_time_s: null,
			charging_time_s: null,
			max_charge_power_kw: null
		}
		const res = await getVehicleStats(
			'v1',
			{},
			fakeDb([EXISTS, [/FROM session/, [empty]]])
		)
		// Counts are genuinely zero — we counted, and there were none. Totals are
		// null — we have nothing to total, which is not the same as a car that
		// travelled no distance.
		expect(res.period.driveCount).toBe(0)
		expect(res.period.chargeCount).toBe(0)
		expect(res.period.distanceKm).toBeNull()
		expect(res.period.driveEnergyKwh).toBeNull()
		expect(res.period.chargeEnergyKwh).toBeNull()
		expect(res.period.efficiencyWhPerKm).toBeNull()
		expect(res.period.drivingTimeS).toBeNull()
		expect(res.period.chargingTimeS).toBeNull()
		expect(res.period.maxChargePowerKw).toBeNull()
		expect(res.odometerKm).toBeNull()
		expect(res.recordingSince).toBeNull()
	})

	it('defaults the stats window to the last 30 days', async () => {
		const res = await getVehicleStats('v1', {}, fakeDb([EXISTS]))
		const span = new Date(res.period.to).getTime() - new Date(res.period.from).getTime()
		expect(span).toBe(30 * 24 * 60 * 60 * 1000)
	})
})

/* ------------------------------------------------------------------ *
 * Mapping: nulls, activity, pagination
 * ------------------------------------------------------------------ */

describe('vehicle mapping', () => {
	it('lists a vehicle that has never reported rather than hiding it', async () => {
		const res = await listVehicles(fakeDb([[/FROM vehicle v/, [VEHICLE_ROW]]]))
		expect(res.vehicles).toHaveLength(1)
		expect(res.vehicles[0]?.state).toBeNull()
		expect(res.vehicles[0]?.activity).toBe('unknown')
		expect(res.vehicles[0]?.openSessionId).toBeNull()
		expect(res.vehicles[0]?.vehicle.displayName).toBe('Blue')
	})

	it('carries the open drive id through to the pill', async () => {
		const row: Row = {
			...VEHICLE_ROW,
			ts: new Date('2026-09-04T07:31:00Z'),
			power_state: 'online',
			open_drive_id: 'd1'
		}
		const res = await listVehicles(fakeDb([[/FROM vehicle v/, [row]]]))
		expect(res.vehicles[0]?.activity).toBe('driving')
		expect(res.vehicles[0]?.openSessionId).toBe('d1')
	})

	it('keeps every unreported sample field null instead of zero', async () => {
		const row: Row = { ...VEHICLE_ROW, ts: new Date('2026-09-04T07:31:00Z') }
		const res = await listVehicles(fakeDb([[/FROM vehicle v/, [row]]]))
		const s = res.vehicles[0]?.state
		expect(s?.ts).toBe('2026-09-04T07:31:00.000Z')
		for (const key of [
			'socPct',
			'rangeKm',
			'odometerKm',
			'lat',
			'lon',
			'speedKph',
			'chargePowerKw',
			'chargeEnergyAddedKwh',
			'insideTempC',
			'outsideTempC'
		] as const) {
			expect(s?.[key], key).toBeNull()
		}
		expect(s?.locked).toBeNull()
		expect(s?.doorsOpen).toBeNull()
		expect(s?.tpms).toBeNull()
	})

	it('passes a partial tpms object through without filling in zeros', async () => {
		const row: Row = {
			...VEHICLE_ROW,
			ts: new Date('2026-09-04T07:31:00Z'),
			tpms: { fl: 2.9, fr: 2.8 }
		}
		const res = await listVehicles(fakeDb([[/FROM vehicle v/, [row]]]))
		expect(res.vehicles[0]?.state?.tpms).toEqual({ fl: 2.9, fr: 2.8 })
	})

	it('rounds a real column to the precision the contract promises', async () => {
		const row: Row = {
			...VEHICLE_ROW,
			ts: new Date('2026-09-04T07:31:00Z'),
			inside_temp_c: 21.299999237060547,
			soc_pct: 0
		}
		const res = await listVehicles(fakeDb([[/FROM vehicle v/, [row]]]))
		expect(res.vehicles[0]?.state?.insideTempC).toBe(21.3)
		// A genuine zero survives: the car really is at 0%.
		expect(res.vehicles[0]?.state?.socPct).toBe(0)
	})
})

describe('session mapping', () => {
	const OPEN_DRIVE: Row = {
		id: 's1',
		vehicle_id: 'v1',
		kind: 'drive',
		started_at: new Date('2026-09-04T07:00:00Z'),
		ended_at: null,
		is_open: true,
		start_odometer_km: null,
		end_odometer_km: null,
		start_soc_pct: null,
		end_soc_pct: null,
		energy_kwh: null,
		distance_km: null,
		efficiency_wh_per_km: null,
		avg_speed_kph: null,
		max_charge_power_kw: null,
		start_lat: null,
		start_lon: null,
		end_lat: null,
		end_lon: null,
		cost: null,
		cost_currency: null
	}

	it('reports a null duration for an open session rather than measuring to now', async () => {
		const res = await listSessions('v1', { limit: 50 }, fakeDb([[/FROM session/, [OPEN_DRIVE]]]))
		expect(res.sessions[0]?.durationS).toBeNull()
		expect(res.sessions[0]?.isOpen).toBe(true)
		expect(res.sessions[0]?.endedAt).toBeNull()
	})

	it('computes whole-second durations for a closed session', async () => {
		const closed: Row = {
			...OPEN_DRIVE,
			ended_at: new Date('2026-09-04T07:30:30Z'),
			is_open: false
		}
		const res = await listSessions('v1', { limit: 50 }, fakeDb([[/FROM session/, [closed]]]))
		expect(res.sessions[0]?.durationS).toBe(1830)
	})

	it('never reports a currency without an amount', async () => {
		const orphaned: Row = { ...OPEN_DRIVE, cost: null, cost_currency: 'GBP' }
		const res = await listSessions('v1', { limit: 50 }, fakeDb([[/FROM session/, [orphaned]]]))
		expect(res.sessions[0]?.cost).toBeNull()
		expect(res.sessions[0]?.costCurrency).toBeNull()
	})

	it('reads a numeric cost back as a number, not a string', async () => {
		const priced: Row = { ...OPEN_DRIVE, cost: '12.34', cost_currency: 'GBP' }
		const res = await listSessions('v1', { limit: 50 }, fakeDb([[/FROM session/, [priced]]]))
		expect(res.sessions[0]?.cost).toBe(12.34)
		expect(res.sessions[0]?.costCurrency).toBe('GBP')
	})
})

describe('session pagination', () => {
	function sessionRow(id: string, startedAt: string): Row {
		return {
			id,
			vehicle_id: 'v1',
			kind: 'drive',
			started_at: new Date(startedAt),
			ended_at: new Date(startedAt),
			is_open: false,
			start_odometer_km: null,
			end_odometer_km: null,
			start_soc_pct: null,
			end_soc_pct: null,
			energy_kwh: null,
			distance_km: null,
			efficiency_wh_per_km: null,
			avg_speed_kph: null,
			max_charge_power_kw: null,
			start_lat: null,
			start_lon: null,
			end_lat: null,
			end_lon: null,
			cost: null,
			cost_currency: null
		}
	}

	it('asks for one row more than the page so the last page is detectable', async () => {
		const db = fakeDb([])
		await listSessions('v1', { limit: 50 }, db)
		expect(db.calls[0]?.values.at(-1)).toBe(51)
	})

	it('returns a null cursor when the extra probe row does not come back', async () => {
		const rows = [sessionRow('s2', '2026-09-02T00:00:00Z'), sessionRow('s1', '2026-09-01T00:00:00Z')]
		const res = await listSessions('v1', { limit: 2 }, fakeDb([[/FROM session/, rows]]))
		expect(res.sessions).toHaveLength(2)
		expect(res.nextCursor).toBeNull()
	})

	it('trims the probe row and emits a cursor naming the last row served', async () => {
		const rows = [
			sessionRow('s3', '2026-09-03T00:00:00Z'),
			sessionRow('s2', '2026-09-02T00:00:00Z'),
			sessionRow('s1', '2026-09-01T00:00:00Z')
		]
		const res = await listSessions('v1', { limit: 2 }, fakeDb([[/FROM session/, rows]]))
		expect(res.sessions.map((s) => s.id)).toEqual(['s3', 's2'])
		expect(decodeCursor(res.nextCursor as string)).toEqual({
			startedAt: new Date('2026-09-02T00:00:00Z'),
			id: 's2'
		})
	})

	it('applies a cursor as a row-value comparison matching the sort order', async () => {
		const db = fakeDb([])
		const cursor = encodeCursor('2026-09-02T00:00:00.000Z', 's2')
		await listSessions('v1', { limit: 50, cursor }, db)
		const call = db.calls[0]
		expect(call?.sql).toMatch(/\(started_at, id\) < \(\$\d+, \$\d+\)/)
		expect(call?.sql).toMatch(/ORDER BY started_at DESC, id DESC/)
		expect(call?.values).toContain('s2')
	})

	it('rejects a malformed cursor rather than serving an unfiltered first page', async () => {
		await expect(
			listSessions('v1', { limit: 50, cursor: 'garbage' }, fakeDb([]))
		).rejects.toMatchObject({ status: 400 })
	})

	it('binds kind and the date range as parameters, never as SQL text', async () => {
		const db = fakeDb([])
		const from = new Date('2026-09-01T00:00:00Z')
		const to = new Date('2026-10-01T00:00:00Z')
		await listSessions('v1', { limit: 10, kind: 'charge', from, to }, db)
		const call = db.calls[0]
		expect(call?.sql).not.toMatch(/'charge'/)
		expect(call?.values).toEqual(['v1', 'charge', from, to, 11])
		// from inclusive, to exclusive, so consecutive windows tile.
		expect(call?.sql).toMatch(/started_at >= \$3/)
		expect(call?.sql).toMatch(/started_at < \$4/)
	})
})

describe('session detail', () => {
	const SESSION: Row = {
		id: 's1',
		vehicle_id: 'v1',
		kind: 'idle',
		started_at: new Date('2026-09-04T07:00:00Z'),
		ended_at: new Date('2026-09-04T08:00:00Z'),
		is_open: false,
		start_odometer_km: null,
		end_odometer_km: null,
		start_soc_pct: null,
		end_soc_pct: null,
		energy_kwh: null,
		distance_km: null,
		efficiency_wh_per_km: null,
		avg_speed_kph: null,
		max_charge_power_kw: null,
		start_lat: null,
		start_lon: null,
		end_lat: null,
		end_lon: null,
		cost: null,
		cost_currency: null
	}

	it('treats a session with no points as a valid answer, not a 404', async () => {
		const res = await getSessionDetail('s1', fakeDb([[/FROM session WHERE id/, [SESSION]]]))
		expect(res.points).toEqual([])
		expect(res.downsampled).toBe(false)
	})

	it('reports downsampled from the pre-decimation total, not the rows served', async () => {
		const point: Row = {
			ts: new Date('2026-09-04T07:00:00Z'),
			lat: null,
			lon: null,
			soc_pct: null,
			speed_kph: null,
			power_kw: null,
			total: SESSION_POINT_CAP + 1
		}
		const res = await getSessionDetail(
			's1',
			fakeDb([
				[/FROM session WHERE id/, [SESSION]],
				[/FROM numbered/, [point]]
			])
		)
		expect(res.downsampled).toBe(true)
	})

	it('keeps a drive with no coordinates as a drive, not an error', async () => {
		const point: Row = {
			ts: new Date('2026-09-04T07:00:00Z'),
			lat: null,
			lon: null,
			soc_pct: 80,
			speed_kph: 42.5,
			power_kw: null,
			total: 1
		}
		const res = await getSessionDetail(
			's1',
			fakeDb([
				[/FROM session WHERE id/, [SESSION]],
				[/FROM numbered/, [point]]
			])
		)
		expect(res.points[0]?.lat).toBeNull()
		expect(res.points[0]?.speedKph).toBe(42.5)
		expect(res.downsampled).toBe(false)
	})
})

describe('sample series', () => {
	it('includes a requested field as null and omits one that was not requested', async () => {
		const row: Row = {
			ts: new Date('2026-09-04T07:00:00Z'),
			soc_pct: null,
			inside_temp_c: 21.299999237060547,
			total: 1
		}
		const res = await getSampleSeries(
			'v1',
			{
				from: new Date('2026-09-01T00:00:00Z'),
				to: new Date('2026-09-02T00:00:00Z'),
				fields: ['socPct', 'insideTempC']
			},
			fakeDb([EXISTS, [/FROM numbered/, [row]]])
		)
		const p = res.samples[0]
		expect(p).toBeDefined()
		expect('socPct' in (p as object)).toBe(true)
		expect(p?.socPct).toBeNull()
		expect(p?.insideTempC).toBe(21.3)
		// Not asked for, so absent — which is a different statement from null.
		expect('speedKph' in (p as object)).toBe(false)
	})

	it('binds the vehicle, the window and the cap as parameters', async () => {
		const db = fakeDb([EXISTS])
		const from = new Date('2026-09-01T00:00:00Z')
		const to = new Date('2026-09-02T00:00:00Z')
		await getSampleSeries('v1', { from, to, fields: ['socPct'] }, db)
		const call = db.calls.at(-1)
		expect(call?.values).toEqual(['v1', from, to, SAMPLE_SERIES_CAP])
	})
})

describe('battery health', () => {
	function row(day: string, capacity: number, confidence: number): Row {
		return {
			observed_on: day,
			estimated_capacity_kwh: capacity,
			rated_range_at_100_km: null,
			sample_confidence: confidence
		}
	}

	it('takes the baseline from all history so panning the chart cannot move it', async () => {
		const res = await getBatteryHealth(
			'v1',
			{ from: new Date('2026-06-01T00:00:00Z') },
			fakeDb([
				EXISTS,
				[
					/FROM battery_health_sample/,
					[row('2026-01-01', 75, 0.9), row('2026-07-01', 70, 0.9)]
				]
			])
		)
		// The window excludes the January reading, but it is still the baseline.
		expect(res.samples.map((s) => s.observedOn)).toEqual(['2026-07-01'])
		expect(res.baselineCapacityKwh).toBe(75)
		expect(res.latest?.observedOn).toBe('2026-07-01')
		expect(res.degradationPct).toBe(6.7)
	})

	it('reports a single measurement without pretending it is a trend', async () => {
		const res = await getBatteryHealth(
			'v1',
			{},
			fakeDb([EXISTS, [/FROM battery_health_sample/, [row('2026-01-01', 70, 0.2)]]])
		)
		expect(res.samples).toHaveLength(1)
		expect(res.baselineCapacityKwh).toBeNull()
		expect(res.degradationPct).toBeNull()
	})

	it('excludes the to bound and includes the from bound', async () => {
		const res = await getBatteryHealth(
			'v1',
			{ from: new Date('2026-01-02T00:00:00Z'), to: new Date('2026-01-04T00:00:00Z') },
			fakeDb([
				EXISTS,
				[
					/FROM battery_health_sample/,
					[
						row('2026-01-01', 70, 0.9),
						row('2026-01-02', 70, 0.9),
						row('2026-01-03', 70, 0.9),
						row('2026-01-04', 70, 0.9)
					]
				]
			])
		)
		expect(res.samples.map((s) => s.observedOn)).toEqual(['2026-01-02', '2026-01-03'])
	})
})

/* ------------------------------------------------------------------ *
 * Readiness
 * ------------------------------------------------------------------ */

const queryMock = vi.fn()
vi.mock('$lib/server/db.js', () => ({ getPool: () => ({ query: queryMock }) }))

describe('healthz/ready', () => {
	it('reports ready when the database answers', async () => {
		queryMock.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
		const { GET } = await import('../src/routes/healthz/ready/+server.js')
		const res = await GET()
		expect(res.status).toBe(200)
		expect(await res.text()).toBe('ok')
	})

	it('reports 503 rather than 200 when the database is unreachable', async () => {
		queryMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
		const { GET } = await import('../src/routes/healthz/ready/+server.js')
		const res = await GET()
		expect(res.status).toBe(503)
		expect(await res.text()).toBe('database unavailable')
	})

	it('runs a real query rather than returning a constant', async () => {
		queryMock.mockResolvedValueOnce({ rows: [] })
		const { GET } = await import('../src/routes/healthz/ready/+server.js')
		await GET()
		expect(queryMock).toHaveBeenCalledWith('SELECT 1')
	})
})
