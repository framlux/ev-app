import { describe, expect, it } from 'vitest'
import {
	areaPath,
	coordBounds,
	decimate,
	extent,
	linePath,
	niceTicks,
	padExtent,
	scaleLinear,
	toLngLatPath,
	toPoints
} from '../src/lib/chart.js'

/**
 * The degenerate inputs are the normal inputs here.
 *
 * With an empty database every chart is called with zero points; with one
 * reading it is called with one; with a parked car it is called with a series
 * that never changes value. Each of those divides by a zero span if written
 * naively, and NaN inside an SVG `d` attribute draws nothing at all with no
 * error logged anywhere. These tests are the only thing standing between that
 * and a page that looks styled-wrong rather than data-empty.
 */

describe('extent', () => {
	it('is null for an empty series, so callers can show an empty state', () => {
		expect(extent([])).toBeNull()
	})

	it('is null when every value is missing', () => {
		expect(extent([null, undefined, null])).toBeNull()
	})

	it('skips nulls rather than reading them as zero', () => {
		// A dropped-to-zero minimum is how a SoC chart grows a spike to the floor
		// for every gap in the record.
		expect(extent([54, null, 61])).toEqual({ min: 54, max: 61 })
	})

	it('keeps a genuine zero in range', () => {
		expect(extent([0, 12])).toEqual({ min: 0, max: 12 })
	})

	it('handles negatives, which outside temperature reaches every winter', () => {
		expect(extent([-4, 3])).toEqual({ min: -4, max: 3 })
	})

	it('ignores NaN and Infinity', () => {
		expect(extent([NaN, Infinity, 7])).toEqual({ min: 7, max: 7 })
	})
})

describe('padExtent', () => {
	it('gives a zero-span extent a real span so the scale cannot divide by zero', () => {
		const padded = padExtent({ min: 62, max: 62 })
		expect(padded.max).toBeGreaterThan(padded.min)
	})

	it('gives a zero-span extent at zero a span too', () => {
		// min === max === 0 defeats a percentage-of-value pad specifically.
		const padded = padExtent({ min: 0, max: 0 })
		expect(padded.max).toBeGreaterThan(padded.min)
	})

	it('widens a normal extent symmetrically', () => {
		expect(padExtent({ min: 0, max: 100 }, 0.1)).toEqual({ min: -10, max: 110 })
	})
})

describe('scaleLinear', () => {
	it('maps the domain onto the range', () => {
		const s = scaleLinear({ min: 0, max: 100 }, [0, 200])
		expect(s(0)).toBe(0)
		expect(s(50)).toBe(100)
		expect(s(100)).toBe(200)
	})

	it('inverts for a screen y-axis, where the range runs downward', () => {
		const s = scaleLinear({ min: 0, max: 100 }, [200, 0])
		expect(s(100)).toBe(0)
		expect(s(0)).toBe(200)
	})

	it('returns the range midpoint for a zero-span domain, never Infinity', () => {
		// Without the guard this is (v - min) / 0 -> NaN or Infinity, and every
		// point in the series lands outside the viewBox.
		const s = scaleLinear({ min: 5, max: 5 }, [0, 100])
		expect(s(5)).toBe(50)
		expect(Number.isFinite(s(5))).toBe(true)
	})
})

describe('toPoints', () => {
	type Row = { ts: number; v: number | null }

	it('drops rows whose value is missing', () => {
		const rows: Row[] = [
			{ ts: 1, v: 10 },
			{ ts: 2, v: null },
			{ ts: 3, v: 30 }
		]
		expect(toPoints(rows, (r) => r.ts, (r) => r.v)).toEqual([
			{ x: 1, y: 10 },
			{ x: 3, y: 30 }
		])
	})

	it('KEEPS a value of exactly zero', () => {
		// The taper at the end of a charge is a run of near-zero and zero kW
		// readings. A truthiness filter deletes precisely the interesting part.
		const rows: Row[] = [
			{ ts: 1, v: 50 },
			{ ts: 2, v: 0 }
		]
		expect(toPoints(rows, (r) => r.ts, (r) => r.v)).toHaveLength(2)
	})

	it('drops a row whose x is missing, not just its y', () => {
		const rows = [{ ts: null as number | null, v: 5 }]
		expect(toPoints(rows, (r) => r.ts, (r) => r.v)).toEqual([])
	})

	it('drops NaN, which is what Date.parse of a bad timestamp produces', () => {
		const rows = [{ ts: Number.NaN, v: 5 }]
		expect(toPoints(rows, (r) => r.ts, (r) => r.v)).toEqual([])
	})

	it('carries meta through for per-point confidence opacity', () => {
		const rows = [{ ts: 1, v: 2, c: 0.4 }]
		expect(toPoints(rows, (r) => r.ts, (r) => r.v, (r) => r.c)[0]?.meta).toBe(0.4)
	})
})

describe('linePath and areaPath', () => {
	it('are empty strings for no points, not undefined and not NaN', () => {
		expect(linePath([])).toBe('')
		expect(areaPath([], 100)).toBe('')
	})

	it('draws a single point as a moveto, which a lone reading is', () => {
		expect(linePath([{ x: 1, y: 2 }])).toBe('M1 2')
	})

	it('has no area to fill under a single point', () => {
		expect(areaPath([{ x: 1, y: 2 }], 10)).toBe('')
	})

	it('joins points and closes the area to the baseline', () => {
		const pts = [
			{ x: 0, y: 10 },
			{ x: 10, y: 0 }
		]
		expect(linePath(pts)).toBe('M0 10 L10 0')
		expect(areaPath(pts, 20)).toBe('M0 10 L10 0 L10 20 L0 20 Z')
	})

	it('never emits NaN into the d attribute', () => {
		expect(linePath([{ x: 1, y: 2 }, { x: 3, y: 4 }])).not.toMatch(/NaN/)
	})
})

describe('niceTicks', () => {
	it('returns no ticks for a non-finite domain instead of looping forever', () => {
		expect(niceTicks(NaN, 10)).toEqual([])
		expect(niceTicks(0, Infinity)).toEqual([])
	})

	it('returns a single tick for a zero-span domain', () => {
		expect(niceTicks(7, 7)).toEqual([7])
	})

	it('keeps every tick inside the domain, so no label names a value the chart never reaches', () => {
		for (const [min, max] of [
			[0, 100],
			[-4, 3],
			[12.4, 12.9],
			[0, 0.4],
			[1000, 100000]
		] as [number, number][]) {
			const ticks = niceTicks(min, max, 5)
			expect(ticks.length).toBeGreaterThan(0)
			for (const t of ticks) {
				expect(t).toBeGreaterThanOrEqual(min)
				expect(t).toBeLessThanOrEqual(max)
			}
		}
	})

	it('produces round numbers rather than float noise', () => {
		// Repeated addition of a fractional step accumulates error straight into
		// the axis label text.
		for (const t of niceTicks(0, 1, 5)) {
			expect(String(t).length).toBeLessThan(6)
		}
	})

	it('tolerates a reversed domain', () => {
		expect(niceTicks(10, 0)).toEqual(niceTicks(0, 10))
	})
})

describe('decimate', () => {
	const rows = (n: number) => Array.from({ length: n }, (_, i) => i)

	// The caps are the numbers the API uses; each boundary is a comparison an
	// implementer can flip without any other test noticing.
	const cases: [number, number, number][] = [
		[1999, 2000, 1999],
		[2000, 2000, 2000],
		[2001, 2000, 2000],
		[4999, 5000, 4999],
		[5000, 5000, 5000],
		[5001, 5000, 5000]
	]

	for (const [input, cap, expected] of cases) {
		it(`${input} rows capped at ${cap} yields ${expected}`, () => {
			expect(decimate(rows(input), cap)).toHaveLength(expected)
		})
	}

	it('is a copy, not the same array, when under the cap', () => {
		const source = rows(3)
		expect(decimate(source, 10)).not.toBe(source)
	})

	it('always keeps the first and last row, so the series still spans the window', () => {
		const out = decimate(rows(10000), 100)
		expect(out[0]).toBe(0)
		expect(out[out.length - 1]).toBe(9999)
	})

	it('thins evenly rather than truncating the tail', () => {
		// Truncation ("take the first N") is the easy wrong implementation and
		// would show a drive stopping halfway with no indication that it had.
		const out = decimate(rows(1000), 10)
		expect(out[5]).toBeGreaterThan(400)
	})

	it('handles an empty series', () => {
		expect(decimate([], 100)).toEqual([])
	})

	it('handles a cap below two without producing an empty chart from real data', () => {
		expect(decimate(rows(5), 1)).toEqual([0])
	})
})

describe('coordinates', () => {
	it('has no bounds when nothing is locatable', () => {
		expect(coordBounds([])).toBeNull()
		expect(coordBounds([{ lat: null, lon: null }])).toBeNull()
	})

	it('has no bounds when only one half of every pair is present', () => {
		// Bounds from lat alone would centre a map on the prime meridian.
		expect(coordBounds([{ lat: 51.5, lon: null }])).toBeNull()
	})

	it('bounds a real path', () => {
		expect(
			coordBounds([
				{ lat: 51.5, lon: -0.1 },
				{ lat: 52.0, lon: 0.2 }
			])
		).toEqual({ minLat: 51.5, maxLat: 52.0, minLon: -0.1, maxLon: 0.2 })
	})

	it('drops half-null pairs from a path rather than plotting them at zero', () => {
		expect(
			toLngLatPath([
				{ lat: 51.5, lon: -0.1 },
				{ lat: 51.6, lon: null },
				{ lat: null, lon: 0.3 },
				{ lat: 51.7, lon: -0.2 }
			])
		).toEqual([
			[-0.1, 51.5],
			[-0.2, 51.7]
		])
	})

	it('emits lon,lat order — MapLibre takes them the other way round from the DTO', () => {
		expect(toLngLatPath([{ lat: 51.5, lon: -0.12 }])).toEqual([[-0.12, 51.5]])
	})

	it('is empty for a drive recorded without the location scope', () => {
		expect(toLngLatPath([{ lat: null, lon: null }, { lat: null, lon: null }])).toEqual([])
	})
})
