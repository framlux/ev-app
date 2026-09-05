import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePool, getPool, runMigrationsUnderGate } from '@ev/db'
import {
	getBatteryHealth,
	getSampleSeries,
	getSessionDetail,
	getVehicle,
	getVehicleState,
	getVehicleStats,
	listSessions,
	listVehicles,
	SAMPLE_SERIES_CAP,
	SESSION_POINT_CAP
} from '../src/lib/server/queries.js'

/**
 * The half of the read API that only Postgres can check.
 *
 * api.test.ts drives every branch with a stub, which proves the mapping and the
 * validation but says nothing about whether the SQL parses, whether the column
 * names exist, or whether the SQL-side decimation actually keeps the first and
 * last row. A stub that answers a query with the wrong column name silently
 * passes, so those things have to run against a real database.
 *
 * Locally, point them at a throwaway one:
 *
 *   docker run --rm -d -e POSTGRES_PASSWORD=ev -e POSTGRES_USER=ev \
 *     -e POSTGRES_DB=ev -p 55432:5432 postgres:17-alpine
 *   PGHOST=localhost PGPORT=55432 PGUSER=ev PGPASSWORD=ev PGDATABASE=ev \
 *     pnpm vitest run apps/web/test/api-db.test.ts
 */
const hasDb = Boolean(process.env['PGHOST'])

if (!hasDb && process.env['CI']) {
	throw new Error(
		'PGHOST is unset in CI: the read API tests must run against a real Postgres. ' +
			'See the postgres service in .github/workflows/test.yml.'
	)
}

// Ids are prefixed so this file and packages/db/test/migrate.test.ts can share
// a database in CI without either one seeing the other's rows.
const V1 = 'web-test-v1'
const V2 = 'web-test-v2'
/**
 * A third car that exists only to carry more raw samples than the series cap.
 *
 * It cannot be V1 (whose three samples are asserted one by one) and it cannot
 * be V2 (which is asserted to have never reported), and the decimation has to
 * be exercised over real rows because it is done by the SQL, not by Node.
 */
const V3 = 'web-test-v3'

/** Start of the current UTC month: the window 002_partitions guarantees exists. */
const BASE = (() => {
	const now = new Date()
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0))
})()

function at(minutes: number): Date {
	return new Date(BASE.getTime() + minutes * 60_000)
}

/** The 2500 points on the long drive, which must be decimated to fit the cap. */
const LONG_DRIVE_POINTS = 2500

/**
 * Raw samples on V3, one per second.
 *
 * 5002 and not 5001: the step is ceil(total/5000) = 2 either way, but only an
 * even count puts the LAST row at an odd index, where `rn % step = 0` misses it
 * and the series survives solely because of the `OR rn = total - 1` clause. At
 * 5001 that clause is dead weight and deleting it fails nothing.
 */
const LONG_SAMPLE_COUNT = 5002

describe.skipIf(!hasDb)('read API against Postgres', () => {
	beforeAll(async () => {
		await runMigrationsUnderGate()
		const p = getPool()
		await cleanup()
		await p.query(`SELECT ensure_month_partitions($1::date)`, [BASE])

		await p.query(
			`INSERT INTO vehicle (id, vendor, vendor_vehicle_id, display_name, model, model_year)
			 VALUES ($1,'tesla','WEBVIN1','Zulu Blue','Model Y',2023),
			        ($2,'tesla','WEBVIN2','Alpha Amber',NULL,NULL),
			        ($3,'tesla','WEBVIN3','Mike Dense',NULL,NULL)`,
			[V1, V2, V3]
		)

		// Three samples. The middle one is deliberately all-null beyond ts to
		// prove a gap in reporting survives the round trip as null.
		await p.query(
			`INSERT INTO sample (vehicle_id, ts, soc_pct, range_km, odometer_km, lat, lon,
			                     speed_kph, power_state, charge_state, inside_temp_c, locked, tpms)
			 VALUES ($1,$2, 80, 320, 10000, 51.5, -0.12, 0,'online','disconnected', 21.3, true,
			         '{"fl":2.9,"fr":2.8}'::jsonb),
			        ($1,$3, NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
			        ($1,$4, 62, 250, 10120, 51.6, -0.13, 45,'online','disconnected', 22.0, false, NULL)`,
			[V1, at(0), at(30), at(60)]
		)

		// One sample a second, which is what a real ingest looks like and what
		// the SQL-side decimation exists for. soc_pct descends by a known amount
		// per row so a test can tell WHICH rows survived, not merely how many.
		await p.query(
			`INSERT INTO sample (vehicle_id, ts, soc_pct)
			 SELECT $1, $2::timestamptz + (g || ' seconds')::interval, 90 - g::real / 1000
			   FROM generate_series(0, $3::int - 1) AS g`,
			[V3, at(0), LONG_SAMPLE_COUNT]
		)

		await p.query(
			`INSERT INTO session (id, vehicle_id, kind, started_at, ended_at, is_open,
			                      distance_km, energy_kwh, efficiency_wh_per_km, avg_speed_kph,
			                      start_soc_pct, end_soc_pct, max_charge_power_kw)
			 VALUES ('web-test-d1',$1,'drive',$2,$3,false, 120.0, 18.0, 150, 60.0, 80, 62, NULL),
			        ('web-test-c1',$1,'charge',$4,$5,false, NULL, 30.5, NULL, NULL, 20, 80, 120.4),
			        ('web-test-i1',$1,'idle',$6,$7,false, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
			        ('web-test-o1',$1,'drive',$8,NULL,true, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
			[V1, at(0), at(120), at(200), at(260), at(300), at(330), at(400)]
		)

		await p.query(
			`INSERT INTO session_point (session_id, ts, lat, lon, soc_pct, speed_kph, power_kw)
			 SELECT 'web-test-d1', $1::timestamptz + (g || ' seconds')::interval,
			        NULL, NULL, 80 - g::real / 100, 60, NULL
			   FROM generate_series(0, $2::int - 1) AS g`,
			[at(0), LONG_DRIVE_POINTS]
		)

		await p.query(
			`INSERT INTO battery_health_sample
			   (vehicle_id, observed_on, estimated_capacity_kwh, rated_range_at_100_km, sample_confidence)
			 VALUES ($1,'2026-01-01', 75.0, 480, 0.9),
			        ($1,'2026-02-01', 99.0, 500, 0.2),
			        ($1,'2026-03-01', 70.0, 450, 0.8)`,
			[V1]
		)
	})

	afterAll(async () => {
		await cleanup()
		await closePool()
	})

	async function cleanup(): Promise<void> {
		const p = getPool()
		await p.query(`DELETE FROM session_point WHERE session_id LIKE 'web-test-%'`)
		await p.query(`DELETE FROM session WHERE vehicle_id = ANY($1)`, [[V1, V2, V3]])
		await p.query(`DELETE FROM battery_health_sample WHERE vehicle_id = ANY($1)`, [[V1, V2, V3]])
		await p.query(`DELETE FROM sample WHERE vehicle_id = ANY($1)`, [[V1, V2, V3]])
		await p.query(`DELETE FROM vehicle WHERE id = ANY($1)`, [[V1, V2, V3]])
	}

	it('lists vehicles ordered by display name, including one that never reported', async () => {
		const { vehicles } = await listVehicles()
		const ours = vehicles.filter((v) => v.vehicle.id === V1 || v.vehicle.id === V2)
		expect(ours.map((v) => v.vehicle.displayName)).toEqual(['Alpha Amber', 'Zulu Blue'])

		const amber = ours[0]
		expect(amber?.state).toBeNull()
		expect(amber?.activity).toBe('unknown')
		expect(amber?.vehicle.model).toBeNull()
		expect(amber?.vehicle.modelYear).toBeNull()

		// The open drive wins the pill and carries its id for the deep link.
		expect(ours[1]?.activity).toBe('driving')
		expect(ours[1]?.openSessionId).toBe('web-test-o1')
	})

	it('reads the latest sample, preserving the columns the car did not report', async () => {
		const s = await getVehicleState(V1)
		expect(s.ts).toBe(at(60).toISOString())
		expect(s.socPct).toBe(62)
		expect(s.odometerKm).toBe(10120)
		expect(s.locked).toBe(false)
		// The newest sample has no tpms; the older one does. The API returns one
		// row rather than the newest non-null value per field, so this is null.
		expect(s.tpms).toBeNull()
	})

	it('404s a vehicle that is not there', async () => {
		await expect(getVehicle('web-test-missing')).rejects.toMatchObject({ status: 404 })
		await expect(getVehicleState(V2)).rejects.toMatchObject({
			status: 404,
			message: 'no samples for vehicle'
		})
	})

	it('filters sessions by kind and paginates without duplicating or skipping', async () => {
		const first = await listSessions(V1, { limit: 2 })
		expect(first.sessions).toHaveLength(2)
		expect(first.nextCursor).not.toBeNull()

		const second = await listSessions(V1, { limit: 2, cursor: first.nextCursor as string })
		const ids = [...first.sessions, ...second.sessions].map((s) => s.id)
		expect(new Set(ids).size).toBe(ids.length)
		expect(ids).toHaveLength(4)
		// Newest first.
		expect(ids[0]).toBe('web-test-o1')

		const drives = await listSessions(V1, { limit: 50, kind: 'drive' })
		expect(drives.sessions.map((s) => s.id).sort()).toEqual(['web-test-d1', 'web-test-o1'])
		expect(drives.nextCursor).toBeNull()
	})

	it('applies from inclusively and to exclusively', async () => {
		const q = await listSessions(V1, { limit: 50, from: at(200), to: at(300) })
		// Catches the charge starting exactly at from; excludes the idle at to.
		expect(q.sessions.map((s) => s.id)).toEqual(['web-test-c1'])
	})

	it('reports a null duration for the open session and seconds for a closed one', async () => {
		const { sessions } = await listSessions(V1, { limit: 50 })
		const open = sessions.find((s) => s.id === 'web-test-o1')
		const closed = sessions.find((s) => s.id === 'web-test-d1')
		expect(open?.durationS).toBeNull()
		expect(open?.isOpen).toBe(true)
		expect(closed?.durationS).toBe(120 * 60)
		expect(closed?.efficiencyWhPerKm).toBe(150)
		// Nothing writes cost yet, but the key exists so the UI can render the
		// column as absent rather than as a zero cost.
		expect(closed?.cost).toBeNull()
		expect(closed?.costCurrency).toBeNull()
	})

	it('decimates a long series in SQL, keeping the first and last point', async () => {
		const detail = await getSessionDetail('web-test-d1')
		expect(detail.downsampled).toBe(true)
		expect(detail.points.length).toBeLessThanOrEqual(SESSION_POINT_CAP)
		expect(detail.points.length).toBeGreaterThan(1)
		expect(detail.points[0]?.ts).toBe(at(0).toISOString())
		expect(detail.points.at(-1)?.ts).toBe(
			new Date(at(0).getTime() + (LONG_DRIVE_POINTS - 1) * 1000).toISOString()
		)
		// Thinned, not truncated: the series still spans the whole session.
		const ts = detail.points.map((p) => new Date(p.ts).getTime())
		expect(ts).toEqual([...ts].sort((a, b) => a - b))
		expect(detail.points[0]?.lat).toBeNull()
	})

	it('serves an idle with no points as a 200, not a 404', async () => {
		const detail = await getSessionDetail('web-test-i1')
		expect(detail.points).toEqual([])
		expect(detail.downsampled).toBe(false)
		await expect(getSessionDetail('web-test-nope')).rejects.toMatchObject({ status: 404 })
	})

	it('returns the requested sample fields and omits the rest', async () => {
		const res = await getSampleSeries(V1, {
			from: at(-1),
			to: at(61),
			fields: ['socPct', 'insideTempC']
		})
		expect(res.samples).toHaveLength(3)
		expect(res.downsampled).toBe(false)
		expect(res.samples[0]?.socPct).toBe(80)
		expect(res.samples[0]?.insideTempC).toBe(21.3)
		// The middle sample reported nothing: null, present, and not zero.
		expect(res.samples[1]?.socPct).toBeNull()
		expect('speedKph' in (res.samples[0] as object)).toBe(false)
	})

	it('decimates a long sample series in SQL, keeping the first and last reading', async () => {
		// The twin of the session-detail decimation test. The two SQL statements
		// are byte-identical in their WHERE clause, and only one of them was
		// covered: deleting or breaking the GREATEST(...) in getSampleSeries
		// failed nothing, so the chart could have started streaming 5001 rows —
		// or dropping the end of the day — without a red test.
		const res = await getSampleSeries(V3, {
			from: at(-1),
			to: at(1000),
			fields: ['socPct']
		})
		expect(res.downsampled).toBe(true)
		expect(res.samples.length).toBeLessThanOrEqual(SAMPLE_SERIES_CAP)
		expect(res.samples.length).toBeGreaterThan(1)
		expect(res.samples[0]?.ts).toBe(at(0).toISOString())
		// Thinned, not truncated: the window's last reading is still the last
		// point, which is what stops a chart implying the car stopped reporting.
		expect(res.samples.at(-1)?.ts).toBe(
			new Date(at(0).getTime() + (LONG_SAMPLE_COUNT - 1) * 1000).toISOString()
		)
		const ts = res.samples.map((p) => new Date(p.ts).getTime())
		expect(ts).toEqual([...ts].sort((a, b) => a - b))
		// Values come from the row that survived, not from a re-derived index.
		expect(res.samples[0]?.socPct).toBe(90)
	})

	it('reports a series that fits under the cap as not downsampled', async () => {
		// The other side of the `total <= cap` comparison, over real rows: with a
		// step of 1 every row is kept and nothing claims to have been thinned.
		const res = await getSampleSeries(V3, {
			from: at(0),
			to: new Date(at(0).getTime() + 10_000),
			fields: ['socPct']
		})
		expect(res.samples).toHaveLength(10)
		expect(res.downsampled).toBe(false)
	})

	it('404s an unknown vehicle on the series and stats endpoints', async () => {
		// Both go through assertVehicleExists. Without it a mistyped id answers
		// 200 with an empty series and a stats block full of nulls, which is
		// indistinguishable from a real car that has never reported — so the
		// operator debugs the ingest instead of the URL.
		await expect(
			getSampleSeries('web-test-missing', { from: at(0), to: at(60), fields: ['socPct'] })
		).rejects.toMatchObject({ status: 404, message: 'vehicle not found' })
		await expect(getVehicleStats('web-test-missing', {})).rejects.toMatchObject({
			status: 404,
			message: 'vehicle not found'
		})
		await expect(getBatteryHealth('web-test-missing', {})).rejects.toMatchObject({ status: 404 })

		// And a real vehicle with no rows in the window is NOT a 404: the guard
		// must distinguish "no such car" from "no data", or the fix for one
		// breaks the other.
		const empty = await getSampleSeries(V2, { from: at(0), to: at(60), fields: ['socPct'] })
		expect(empty.samples).toEqual([])
	})

	it('takes the battery baseline from the best trusted reading, not the highest', async () => {
		const res = await getBatteryHealth(V1, {})
		expect(res.samples.map((s) => s.observedOn)).toEqual([
			'2026-01-01',
			'2026-02-01',
			'2026-03-01'
		])
		// 99.0 kWh was measured at 0.2 confidence and must not define "new".
		expect(res.baselineCapacityKwh).toBe(75)
		expect(res.latest?.observedOn).toBe('2026-03-01')
		expect(res.degradationPct).toBe(6.7)
	})

	it('reports a known vehicle with no estimates as an empty trend', async () => {
		const res = await getBatteryHealth(V2, {})
		expect(res.samples).toEqual([])
		expect(res.baselineCapacityKwh).toBeNull()
		expect(res.degradationPct).toBeNull()
	})

	it('aggregates only completed sessions', async () => {
		const res = await getVehicleStats(V1, { from: at(-1), to: at(1000) })
		expect(res.period.driveCount).toBe(1) // the open drive is excluded
		expect(res.period.chargeCount).toBe(1)
		expect(res.period.distanceKm).toBe(120)
		expect(res.period.driveEnergyKwh).toBe(18)
		expect(res.period.chargeEnergyKwh).toBe(30.5)
		expect(res.period.efficiencyWhPerKm).toBe(150)
		expect(res.period.drivingTimeS).toBe(120 * 60)
		expect(res.period.chargingTimeS).toBe(60 * 60)
		expect(res.period.maxChargePowerKw).toBe(120.4)
		expect(res.odometerKm).toBe(10120)
		expect(res.recordingSince).toBe(at(0).toISOString())
	})

	it('reports null totals for a window containing nothing', async () => {
		const res = await getVehicleStats(V1, { from: at(100000), to: at(200000) })
		expect(res.period.driveCount).toBe(0)
		expect(res.period.distanceKm).toBeNull()
		expect(res.period.driveEnergyKwh).toBeNull()
		expect(res.period.efficiencyWhPerKm).toBeNull()
		// Lifetime ignores the window, so it still has the real totals.
		expect(res.lifetime.distanceKm).toBe(120)
	})

	it('reports nulls throughout for a vehicle that has never reported', async () => {
		const res = await getVehicleStats(V2, {})
		expect(res.period.driveCount).toBe(0)
		expect(res.period.distanceKm).toBeNull()
		expect(res.lifetime.chargeEnergyKwh).toBeNull()
		expect(res.odometerKm).toBeNull()
		expect(res.recordingSince).toBeNull()
	})
})
