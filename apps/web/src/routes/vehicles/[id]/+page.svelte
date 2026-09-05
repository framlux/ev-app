<script lang="ts">
	import type { PageData } from './$types.js'
	import { decimate, toPoints } from '$lib/chart.js'
	import type { ChartSeries } from '$lib/chart.js'
	import {
		DASH,
		formatDuration,
		formatKm,
		formatKw,
		formatKwh,
		formatKph,
		formatOdometer,
		formatPct,
		formatRelative,
		formatBar,
		formatTempC,
		formatWhPerKm,
		hasCoords
	} from '$lib/format.js'
	import BatteryGauge from '$lib/components/BatteryGauge.svelte'
	import EmptyState from '$lib/components/EmptyState.svelte'
	import Map from '$lib/components/Map.svelte'
	import SessionList from '$lib/components/SessionList.svelte'
	import StatTile from '$lib/components/StatTile.svelte'
	import TimeSeriesChart from '$lib/components/TimeSeriesChart.svelte'

	let { data }: { data: PageData } = $props()

	let entry = $derived(data.entry)
	let s = $derived(entry.state)
	let charging = $derived(entry.activity === 'charging')
	let located = $derived(s != null && hasCoords(s.lat, s.lon))

	// 'fl' | 'fr' | 'rl' | 'rr' — a vendor reporting only some wheels gives a
	// partial object, so the grid is built from what is there, not from a fixed
	// list padded with zeros.
	const WHEELS: [string, string][] = [
		['fl', 'Front left'],
		['fr', 'Front right'],
		['rl', 'Rear left'],
		['rr', 'Rear right']
	]
	let tyres = $derived(
		s?.tpms ? WHEELS.filter(([k]) => typeof s!.tpms![k] === 'number') : []
	)

	// The chart is decimated a second time on the way in: the API caps a series
	// at 5000 rows, which is far more vertices than a 720-unit-wide SVG needs.
	let rows = $derived(decimate(data.samples.samples, 900))

	let series = $derived<ChartSeries[]>(
		[
			{
				key: 'soc',
				label: 'State of charge',
				color: 'var(--accent)',
				unit: '%',
				dp: 0,
				fill: true,
				axis: 'left' as const,
				points: toPoints(
					rows,
					(r) => Date.parse(r.ts),
					(r) => r.socPct ?? null
				)
			},
			{
				key: 'inside',
				label: 'Inside',
				color: 'var(--charging)',
				unit: '°C',
				dp: 0,
				axis: 'right' as const,
				points: toPoints(
					rows,
					(r) => Date.parse(r.ts),
					(r) => r.insideTempC ?? null
				)
			},
			{
				key: 'outside',
				label: 'Outside',
				color: 'var(--driving)',
				unit: '°C',
				dp: 0,
				axis: 'right' as const,
				points: toPoints(
					rows,
					(r) => Date.parse(r.ts),
					(r) => r.outsideTempC ?? null
				)
			}
		].filter((sr) => sr.points.length > 0)
	)

	let period = $derived(data.stats.period)
	let lifetime = $derived(data.stats.lifetime)
</script>

<section class="split">
	<div class="card status">
		<div class="section-title">
			<h2>Right now</h2>
			{#if s}<span class="faint stamp">{formatRelative(s.ts)}</span>{/if}
		</div>

		{#if s}
			<BatteryGauge socPct={s.socPct} rangeKm={s.rangeKm} {charging} />

			<div class="tiles">
				<StatTile label="Odometer" value={formatOdometer(s.odometerKm)} />
				{#if entry.activity === 'driving'}
					<StatTile label="Speed" value={formatKph(s.speedKph)} tone="driving" />
				{:else if charging}
					<StatTile
						label="Charging at"
						value={formatKw(s.chargePowerKw)}
						hint={s.chargeEnergyAddedKwh != null
							? `${formatKwh(s.chargeEnergyAddedKwh)} added`
							: null}
						tone="charging"
					/>
				{:else}
					<StatTile label="Inside" value={formatTempC(s.insideTempC)} />
				{/if}
				<StatTile label="Outside" value={formatTempC(s.outsideTempC)} />
				<StatTile
					label="Locked"
					value={s.locked == null ? DASH : s.locked ? 'Locked' : 'Unlocked'}
					hint={s.doorsOpen == null ? null : s.doorsOpen ? 'A door is open' : 'Doors closed'}
				/>
			</div>

			{#if tyres.length > 0}
				<div class="tyres">
					<p class="eyebrow">Tyre pressure</p>
					<div class="tyre-grid">
						{#each tyres as [key, label] (key)}
							<div>
								<span class="faint">{label}</span>
								<strong class="num">{formatBar(s.tpms?.[key])}</strong>
							</div>
						{/each}
					</div>
				</div>
			{/if}
		{:else}
			<EmptyState
				title="No reading has ever arrived"
				detail="This car is in the database but has never reported a sample. Until it does, there is no state of charge, position or temperature to show."
				icon="⬡"
			/>
		{/if}
	</div>

	<div class="card map-card">
		<div class="section-title"><h2>Last known position</h2></div>
		<Map
			marker={located ? { lat: s!.lat as number, lon: s!.lon as number } : null}
			height="304px"
			emptyTitle="No position recorded"
			emptyDetail="Either no sample has arrived yet, or the last one carried no coordinates — vehicle_location is a separate permission from the rest of the telemetry."
		/>
	</div>
</section>

<section>
	<div class="section-title">
		<h2>Totals</h2>
		<span class="faint">Last 30 days, and everything ever recorded</span>
	</div>
	<div class="card pad">
		<div class="tiles wide">
			<StatTile
				label="Distance (30d)"
				value={formatKm(period.distanceKm)}
				hint="{period.driveCount} drives"
			/>
			<StatTile label="Used (30d)" value={formatKwh(period.driveEnergyKwh)} />
			<StatTile label="Charged (30d)" value={formatKwh(period.chargeEnergyKwh)} hint="{period.chargeCount} charges" />
			<StatTile label="Efficiency (30d)" value={formatWhPerKm(period.efficiencyWhPerKm)} tone="accent" />
			<StatTile label="Driving time (30d)" value={formatDuration(period.drivingTimeS)} />
			<StatTile label="Lifetime distance" value={formatKm(lifetime.distanceKm)} />
			<StatTile label="Lifetime charged" value={formatKwh(lifetime.chargeEnergyKwh)} />
			<StatTile
				label="Peak charge power"
				value={formatKw(lifetime.maxChargePowerKw)}
				tone="charging"
			/>
		</div>
		<p class="faint note">
			Only completed sessions count. A window with nothing in it reports {DASH}, not zero —
			"nothing recorded" and "the car did not move" are different claims.
		</p>
	</div>
</section>

<section>
	<div class="section-title">
		<h2>Last {data.chartDays} days</h2>
		{#if data.samples.downsampled}
			<span class="faint">thinned for display</span>
		{/if}
	</div>
	<div class="card pad">
		<TimeSeriesChart
			{series}
			emptyTitle="No samples in the last {data.chartDays} days"
			emptyDetail="The car has not reported during this window. If it should have, check the ingest worker and the vehicle's telemetry configuration."
		/>
	</div>
</section>

<section>
	<div class="section-title">
		<h2>Recent activity</h2>
		<a class="link" href="/vehicles/{entry.vehicle.id}/drives">All drives →</a>
	</div>
	<div class="card">
		{#if data.recent.length === 0}
			<EmptyState
				title="No sessions recorded"
				detail="Drives, charges and idles are segmented from the sample stream as it arrives. The first one shows up here within a minute of the car parking."
				icon="◫"
			/>
		{:else}
			<SessionList sessions={data.recent} mode="mixed" />
		{/if}
	</div>
</section>

<style>
	section {
		margin-bottom: 26px;
	}

	.split {
		display: grid;
		grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
		gap: 18px;
	}

	.status,
	.map-card {
		padding: 16px;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.status .section-title,
	.map-card .section-title {
		margin: 0;
	}

	.stamp {
		font-size: 0.8rem;
	}

	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
		gap: 10px;
	}

	.tiles.wide {
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
	}

	.pad {
		padding: 16px;
	}

	.note {
		margin: 12px 0 0;
		font-size: 0.76rem;
	}

	.tyres {
		border-top: 1px solid var(--border);
		padding-top: 12px;
	}

	.tyre-grid {
		margin-top: 6px;
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 8px;
	}

	.tyre-grid div {
		display: grid;
		gap: 1px;
		font-size: 0.78rem;
	}

	.tyre-grid strong {
		font-size: 0.9rem;
	}

	@media (max-width: 900px) {
		.split {
			grid-template-columns: minmax(0, 1fr);
		}
		.tyre-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
</style>
