import { describe, expect, it } from 'vitest'
import { render } from 'svelte/server'
import type {
	BatteryHealthResponse,
	SampleSeriesResponse,
	SessionDetail,
	SessionListItem,
	VehicleStatsResponse,
	VehicleWithState
} from '../src/lib/api-types.js'

import ActivityPill from '../src/lib/components/ActivityPill.svelte'
import BatteryGauge from '../src/lib/components/BatteryGauge.svelte'
import BatteryTrend from '../src/lib/components/BatteryTrend.svelte'
import ChargeCurve from '../src/lib/components/ChargeCurve.svelte'
import DateRangeFilter from '../src/lib/components/DateRangeFilter.svelte'
import EmptyState from '../src/lib/components/EmptyState.svelte'
import MapView from '../src/lib/components/Map.svelte'
import PaginatedSessions from '../src/lib/components/PaginatedSessions.svelte'
import SessionList from '../src/lib/components/SessionList.svelte'
import StatTile from '../src/lib/components/StatTile.svelte'
import TimeSeriesChart from '../src/lib/components/TimeSeriesChart.svelte'
import VehicleCard from '../src/lib/components/VehicleCard.svelte'

import GaragePage from '../src/routes/+page.svelte'
import VehiclePage from '../src/routes/vehicles/[id]/+page.svelte'
import DrivesPage from '../src/routes/vehicles/[id]/drives/+page.svelte'
import ChargesPage from '../src/routes/vehicles/[id]/charges/+page.svelte'
import BatteryPage from '../src/routes/vehicles/[id]/battery/+page.svelte'
import DriveDetailPage from '../src/routes/drives/[id]/+page.svelte'
import ChargeDetailPage from '../src/routes/charges/[id]/+page.svelte'

/**
 * Empty and null are the EXPECTED inputs on this site, not edge cases.
 *
 * The database is empty until the car's telemetry configuration is accepted,
 * and stays sparse for weeks after: no vehicles, then a vehicle with no
 * samples, then drives with no coordinates because vehicle_location is a
 * separate permission. Every one of those renders a page. A component that
 * throws on null would therefore ship without anyone seeing it fail, because
 * there is no data to see it fail with — which is exactly why these render
 * every component and every page against nothing at all.
 *
 * Rendering is server-side (`svelte/server`), the same path SvelteKit takes for
 * the first paint of every request, so a crash here is a 500 in production.
 */

const VEHICLE = {
	id: 'veh-1',
	vendor: 'tesla' as const,
	vendorVehicleId: '5YJ3E1EA1PF000000',
	displayName: 'Model Y',
	model: null,
	modelYear: null,
	createdAt: '2026-09-01T00:00:00.000Z'
}

/** A registered car that has never reported: the day-one state. */
const NO_STATE: VehicleWithState = {
	vehicle: VEHICLE,
	state: null,
	activity: 'unknown',
	openSessionId: null
}

/** A car that reported a sample in which every optional field was missing. */
const ALL_NULL_STATE: VehicleWithState = {
	vehicle: VEHICLE,
	state: {
		vehicleId: VEHICLE.id,
		ts: '2026-09-04T07:31:00.000Z',
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
		tpms: null
	},
	activity: 'parked',
	openSessionId: null
}

function session(overrides: Partial<SessionListItem> = {}): SessionListItem {
	return {
		id: 'ses-1',
		vehicleId: VEHICLE.id,
		kind: 'drive',
		startedAt: '2026-09-04T07:31:00.000Z',
		endedAt: null,
		durationS: null,
		isOpen: false,
		startOdometerKm: null,
		endOdometerKm: null,
		startSocPct: null,
		endSocPct: null,
		energyKwh: null,
		distanceKm: null,
		efficiencyWhPerKm: null,
		avgSpeedKph: null,
		maxChargePowerKw: null,
		startLat: null,
		startLon: null,
		endLat: null,
		endLon: null,
		cost: null,
		costCurrency: null,
		...overrides
	}
}

const EMPTY_PERIOD = {
	from: '2026-08-05T00:00:00.000Z',
	to: '2026-09-04T00:00:00.000Z',
	driveCount: 0,
	chargeCount: 0,
	distanceKm: null,
	driveEnergyKwh: null,
	chargeEnergyKwh: null,
	efficiencyWhPerKm: null,
	drivingTimeS: null,
	chargingTimeS: null,
	maxChargePowerKw: null
}

const EMPTY_STATS: VehicleStatsResponse = {
	vehicleId: VEHICLE.id,
	period: EMPTY_PERIOD,
	lifetime: { ...EMPTY_PERIOD, from: '2026-09-01T00:00:00.000Z' },
	odometerKm: null,
	recordingSince: null
}

const EMPTY_SAMPLES: SampleSeriesResponse = {
	vehicleId: VEHICLE.id,
	from: '2026-08-28T00:00:00.000Z',
	to: '2026-09-04T00:00:00.000Z',
	fields: ['socPct', 'insideTempC', 'outsideTempC'],
	samples: [],
	downsampled: false
}

const EMPTY_HEALTH: BatteryHealthResponse = {
	vehicleId: VEHICLE.id,
	samples: [],
	baselineCapacityKwh: null,
	latest: null,
	degradationPct: null
}

/** A drive with a complete series and no coordinates anywhere in it. */
const DRIVE_WITHOUT_LOCATION: SessionDetail = {
	session: session({
		id: 'drv-1',
		endedAt: '2026-09-04T08:01:00.000Z',
		durationS: 1800,
		distanceKm: 22.4,
		energyKwh: 3.9,
		efficiencyWhPerKm: 174,
		avgSpeedKph: 44.8,
		startSocPct: 71,
		endSocPct: 63
	}),
	points: [
		{ ts: '2026-09-04T07:31:00.000Z', lat: null, lon: null, socPct: 71, speedKph: 0, powerKw: 0 },
		{ ts: '2026-09-04T07:46:00.000Z', lat: null, lon: null, socPct: 67, speedKph: 48, powerKw: 12 },
		{ ts: '2026-09-04T08:01:00.000Z', lat: null, lon: null, socPct: 63, speedKph: 0, powerKw: 0 }
	],
	downsampled: false
}

/** A session that produced no points at all — an ingest gap, or an idle. */
const SESSION_WITHOUT_POINTS: SessionDetail = {
	session: session({ id: 'drv-2', kind: 'drive' }),
	points: [],
	downsampled: false
}

const CHARGE_WITHOUT_POINTS: SessionDetail = {
	session: session({ id: 'chg-1', kind: 'charge' }),
	points: [],
	downsampled: false
}

/**
 * Nothing rendered from missing data may contain these. Every one of them is
 * what a specific mistake looks like in the output: `${value}` on a null,
 * arithmetic on a null, or a scale that divided by a zero span.
 */
function assertNoBrokenValues(body: string) {
	expect(body).not.toContain('NaN')
	expect(body).not.toContain('undefined')
	expect(body).not.toContain('Infinity')
	expect(body).not.toContain('null')
	expect(body).not.toContain('[object Object]')
}

describe('components render against empty and null data', () => {
	const cases: [string, unknown, Record<string, unknown>][] = [
		['EmptyState', EmptyState, { title: 'Nothing yet' }],
		['StatTile with a dashed value', StatTile, { label: 'Distance', value: '—' }],
		['ActivityPill, unknown activity', ActivityPill, { activity: 'unknown' }],
		['BatteryGauge with no state of charge', BatteryGauge, { socPct: null, rangeKm: null }],
		['SessionList with no rows', SessionList, { sessions: [], mode: 'mixed' }],
		[
			'SessionList with an all-null row',
			SessionList,
			{ sessions: [session()], mode: 'drive' }
		],
		[
			'SessionList of charges with no cost',
			SessionList,
			{ sessions: [session({ kind: 'charge' })], mode: 'charge' }
		],
		['TimeSeriesChart with no series', TimeSeriesChart, { series: [] }],
		[
			'TimeSeriesChart with an empty series',
			TimeSeriesChart,
			{ series: [{ key: 'a', label: 'A', color: 'red', unit: '%', points: [] }] }
		],
		[
			'TimeSeriesChart with a single point',
			TimeSeriesChart,
			{ series: [{ key: 'a', label: 'A', color: 'red', unit: '%', points: [{ x: 1, y: 2 }] }] }
		],
		['ChargeCurve with no points', ChargeCurve, { points: [] }],
		[
			'ChargeCurve whose points carry no power',
			ChargeCurve,
			{ points: [{ ts: '2026-09-04T07:31:00.000Z', lat: null, lon: null, socPct: 40, speedKph: null, powerKw: null }] }
		],
		['BatteryTrend with no samples', BatteryTrend, { samples: [] }],
		[
			'BatteryTrend with a single sample and no baseline',
			BatteryTrend,
			{
				samples: [
					{
						observedOn: '2026-09-04',
						estimatedCapacityKwh: 72.5,
						ratedRangeAt100Km: null,
						sampleConfidence: 0.4
					}
				],
				baselineCapacityKwh: null
			}
		],
		['Map with nothing to show', MapView, { path: [], marker: null }],
		['DateRangeFilter with no range set', DateRangeFilter, { basePath: '/vehicles/veh-1/drives' }],
		[
			'PaginatedSessions with no sessions',
			PaginatedSessions,
			{
				vehicleId: VEHICLE.id,
				kind: 'drive',
				initial: [],
				initialCursor: null,
				emptyTitle: 'No drives recorded yet',
				emptyDetail: 'A drive appears here once the car moves.'
			}
		],
		['VehicleCard for a car that has never reported', VehicleCard, { entry: NO_STATE }],
		['VehicleCard whose every field is null', VehicleCard, { entry: ALL_NULL_STATE }]
	]

	for (const [name, component, props] of cases) {
		it(`${name} renders`, () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const out = render(component as any, { props: props as any })
			expect(out.body.length).toBeGreaterThan(0)
			assertNoBrokenValues(out.body)
		})
	}
})

describe('pages render against an empty database', () => {
	it('the garage explains that nothing has been recorded rather than showing a blank grid', () => {
		const out = render(GaragePage as never, { props: { data: { vehicles: [] } } as never })
		expect(out.body).toContain('No vehicles yet')
		assertNoBrokenValues(out.body)
	})

	it('the garage lists a car that has never reported instead of omitting it', () => {
		const out = render(GaragePage as never, {
			props: { data: { vehicles: [NO_STATE] } } as never
		})
		expect(out.body).toContain('Model Y')
		expect(out.body).toContain('Waiting for the first reading')
		// A vehicle with no sample must not be drawn as a flat battery.
		expect(out.body).not.toContain('0%')
		assertNoBrokenValues(out.body)
	})

	it('the vehicle page renders with no samples, no sessions and no stats', () => {
		const out = render(VehiclePage as never, {
			props: {
				data: {
					entry: NO_STATE,
					stats: EMPTY_STATS,
					samples: EMPTY_SAMPLES,
					recent: [],
					chartDays: 7
				}
			} as never
		})
		expect(out.body).toContain('No reading has ever arrived')
		expect(out.body).toContain('No sessions recorded')
		assertNoBrokenValues(out.body)
	})

	it('the vehicle page renders an all-null sample as dashes, never as zeros', () => {
		const out = render(VehiclePage as never, {
			props: {
				data: {
					entry: ALL_NULL_STATE,
					stats: EMPTY_STATS,
					samples: EMPTY_SAMPLES,
					recent: [session()],
					chartDays: 7
				}
			} as never
		})
		// An empty 30-day window reports nothing, not 0 mi / 0.00 kWh: those are
		// claims about the car that the data does not support.
		expect(out.body).toContain('—')
		expect(out.body).not.toContain('0.0 mi')
		expect(out.body).not.toContain('0.00 kWh')
		assertNoBrokenValues(out.body)
	})

	it('the drives list renders its empty state', () => {
		const out = render(DrivesPage as never, {
			props: {
				data: { entry: NO_STATE, page: { sessions: [], nextCursor: null }, from: null, to: null }
			} as never
		})
		expect(out.body).toContain('No drives recorded yet')
		assertNoBrokenValues(out.body)
	})

	it('the charges list renders its empty state', () => {
		const out = render(ChargesPage as never, {
			props: {
				data: { entry: NO_STATE, page: { sessions: [], nextCursor: null }, from: null, to: null }
			} as never
		})
		expect(out.body).toContain('No charges recorded yet')
		assertNoBrokenValues(out.body)
	})

	it('the battery page explains the absence rather than drawing an empty chart', () => {
		const out = render(BatteryPage as never, {
			props: { data: { entry: NO_STATE, health: EMPTY_HEALTH, stats: EMPTY_STATS } } as never
		})
		expect(out.body).toContain('No capacity estimates yet')
		// With no samples there is no baseline and no trend: a 0.0% degradation
		// figure would be a claim of a perfectly healthy battery from no data.
		expect(out.body).not.toContain('0.0%')
		assertNoBrokenValues(out.body)
	})

	it('a drive with no coordinates renders as a drive, with no map', () => {
		const out = render(DriveDetailPage as never, {
			props: { data: { detail: DRIVE_WITHOUT_LOCATION, vehicle: VEHICLE } } as never
		})
		expect(out.body).toContain('This drive has no route')
		// The numbers are unaffected by the missing location scope. The fixture
		// is in contract units (22.4 km, 174 Wh/km); the page displays imperial.
		expect(out.body).toContain('13.9 mi')
		expect(out.body).toContain('280 Wh/mi')
		assertNoBrokenValues(out.body)
	})

	it('a session with no points at all renders both the map and the chart empty states', () => {
		const out = render(DriveDetailPage as never, {
			props: { data: { detail: SESSION_WITHOUT_POINTS, vehicle: VEHICLE } } as never
		})
		expect(out.body).toContain('This drive has no route')
		expect(out.body).toContain('No series for this drive')
		assertNoBrokenValues(out.body)
	})

	it('a charge with no points renders without a curve and without a cost', () => {
		const out = render(ChargeDetailPage as never, {
			props: { data: { detail: CHARGE_WITHOUT_POINTS, vehicle: VEHICLE } } as never
		})
		expect(out.body).toContain('No power curve for this charge')
		// Nothing writes cost yet. An unknown cost must not render as free.
		expect(out.body).not.toContain('£0.00')
		expect(out.body).not.toContain('Cost')
		assertNoBrokenValues(out.body)
	})
})

describe('pages render real data too, so the empty-state tests are not the only path exercised', () => {
	it('a populated garage card shows the state of charge and the activity', () => {
		const entry: VehicleWithState = {
			vehicle: { ...VEHICLE, model: 'Model Y Long Range', modelYear: 2026 },
			state: {
				...ALL_NULL_STATE.state!,
				socPct: 62,
				rangeKm: 288,
				odometerKm: 18234,
				insideTempC: 21,
				outsideTempC: 9,
				locked: true,
				lat: 51.5074,
				lon: -0.1278,
				tpms: { fl: 2.9, fr: 2.9, rl: 2.8, rr: 2.8 }
			},
			activity: 'charging',
			openSessionId: 'chg-9'
		}
		const out = render(GaragePage as never, { props: { data: { vehicles: [entry] } } as never })
		expect(out.body).toContain('62%')
		// 288 km of range and an 18,234 km odometer, in miles.
		expect(out.body).toContain('179 mi')
		expect(out.body).toContain('11,330 mi')
		// The pill deep-links to the open session.
		expect(out.body).toContain('/charges/chg-9')
		assertNoBrokenValues(out.body)
	})

	it('a charge with a curve draws a path with real coordinates in it', () => {
		const detail: SessionDetail = {
			session: session({
				id: 'chg-2',
				kind: 'charge',
				endedAt: '2026-09-04T09:00:00.000Z',
				durationS: 3600,
				energyKwh: 42.5,
				maxChargePowerKw: 150.2,
				startSocPct: 18,
				endSocPct: 80
			}),
			points: [
				{ ts: '2026-09-04T08:00:00.000Z', lat: null, lon: null, socPct: 18, speedKph: null, powerKw: 150.2 },
				{ ts: '2026-09-04T08:30:00.000Z', lat: null, lon: null, socPct: 55, speedKph: null, powerKw: 90.1 },
				// A taper that reaches exactly zero: the row a truthiness filter eats.
				{ ts: '2026-09-04T09:00:00.000Z', lat: null, lon: null, socPct: 80, speedKph: null, powerKw: 0 }
			],
			downsampled: false
		}
		const out = render(ChargeDetailPage as never, {
			props: { data: { detail, vehicle: VEHICLE } } as never
		})
		expect(out.body).toContain('42.50 kWh')
		expect(out.body).toContain('peak 150.2 kW')
		expect(out.body).toMatch(/<path d="M[\d.]+ [\d.]+ L/)
		assertNoBrokenValues(out.body)
	})
})

/**
 * The two conditionals below are invisible in a "does it render" test: both
 * arms produce valid HTML with no NaN in it, so the render-everything suite
 * above passes whichever arm runs. Each case here therefore pins BOTH arms —
 * the null arm and the real-value arm — because an assertion that only ever
 * sees one arm cannot tell the branch from a constant.
 */
describe('the null branches that a render-only assertion cannot see', () => {
	it('BatteryGauge draws a hatched track for a null SoC, not a 0% fill', () => {
		const out = render(BatteryGauge as never, {
			props: { socPct: null, rangeKm: null } as never
		})
		// "not reported" and "flat" must not look the same: a fill of width 0 is
		// the picture of an empty battery, which is a claim the data does not make.
		expect(out.body).toContain('unknown-track')
		expect(out.body).not.toMatch(/class="fill\b/)
		expect(out.body).not.toContain('width: 0%')
		expect(out.body).not.toContain('0%')
		// A meter with no value must not announce one to a screen reader either.
		expect(out.body).not.toContain('aria-valuenow')
		assertNoBrokenValues(out.body)
	})

	it('BatteryGauge draws a real 0% as a fill, so the null case is a branch and not a constant', () => {
		const out = render(BatteryGauge as never, { props: { socPct: 0, rangeKm: null } as never })
		// A genuine zero IS a flat battery and must be drawn as one.
		expect(out.body).toMatch(/class="fill\b/)
		expect(out.body).toContain('width: 0%')
		expect(out.body).toContain('aria-valuenow="0"')
		expect(out.body).not.toContain('unknown-track')
		assertNoBrokenValues(out.body)
	})

	it('SessionList omits the Cost column entirely when no charge carries a currency', () => {
		const out = render(SessionList as never, {
			props: {
				sessions: [session({ kind: 'charge', cost: null, costCurrency: null })],
				mode: 'charge'
			} as never
		})
		// A Cost header over a column of dashes is a column claiming there is a
		// cost to know. Nothing writes cost yet, so the header must not exist.
		expect(out.body).not.toContain('Cost')
		assertNoBrokenValues(out.body)
	})

	it('SessionList shows the Cost column once a charge carries a currency', () => {
		const out = render(SessionList as never, {
			props: {
				sessions: [
					session({ id: 'chg-a', kind: 'charge', cost: 12.5, costCurrency: 'GBP' }),
					session({ id: 'chg-b', kind: 'charge', cost: null, costCurrency: null })
				],
				mode: 'charge'
			} as never
		})
		expect(out.body).toContain('Cost')
		expect(out.body).toContain('£12.50')
		// The row that has no cost shows a dash, never a fabricated £0.00.
		expect(out.body).not.toContain('£0.00')
		assertNoBrokenValues(out.body)
	})

	it('SessionList never shows a Cost column outside charge mode', () => {
		for (const mode of ['drive', 'mixed'] as const) {
			const out = render(SessionList as never, {
				props: {
					sessions: [session({ kind: 'charge', cost: 12.5, costCurrency: 'GBP' })],
					mode
				} as never
			})
			expect(out.body).not.toContain('Cost')
			expect(out.body).not.toContain('£12.50')
		}
	})
})
