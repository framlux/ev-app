<script lang="ts">
	import type { PageData } from './$types.js'
	import { decimate, toLngLatPath, toPoints } from '$lib/chart.js'
	import type { ChartSeries } from '$lib/chart.js'
	import {
		DASH,
		formatDateTime,
		formatDistance,
		formatDuration,
		formatEfficiency,
		formatKwh,
		formatPct,
		formatSpeed,
		formatTime,
		kmToMi
	} from '$lib/format.js'
	import Map from '$lib/components/Map.svelte'
	import StatTile from '$lib/components/StatTile.svelte'
	import TimeSeriesChart from '$lib/components/TimeSeriesChart.svelte'

	let { data }: { data: PageData } = $props()

	let s = $derived(data.detail.session)
	let points = $derived(data.detail.points)

	// A drive recorded without the vehicle_location scope has a complete speed
	// and SoC series and no coordinates at all. That is a valid drive with no
	// map — never an error, and never a map at (0, 0).
	let path = $derived(toLngLatPath(points))

	let rows = $derived(decimate(points, 900))
	let series = $derived<ChartSeries[]>(
		[
			{
				key: 'speed',
				label: 'Speed',
				color: 'var(--driving)',
				unit: ' mph',
				dp: 0,
				fill: true,
				axis: 'left' as const,
				points: toPoints(
					rows,
					(p) => Date.parse(p.ts),
					// Converted here, not in the chart: the axis ticks are computed
					// from the data, so a series left in km/h under an mph label
					// would be wrong and look entirely plausible.
					(p) => kmToMi(p.speedKph)
				)
			},
			{
				key: 'soc',
				label: 'State of charge',
				color: 'var(--accent)',
				unit: '%',
				dp: 0,
				axis: 'right' as const,
				points: toPoints(
					rows,
					(p) => Date.parse(p.ts),
					(p) => p.socPct
				)
			}
		].filter((sr) => sr.points.length > 0)
	)

	let socUsed = $derived(
		s.startSocPct != null && s.endSocPct != null ? s.startSocPct - s.endSocPct : null
	)
</script>

<svelte:head>
	<title>Drive {formatDateTime(s.startedAt)} · Coulomb</title>
</svelte:head>

<div class="page">
	<div class="head">
		<div>
			<a class="link" href="/vehicles/{data.vehicle.id}/drives">← Drives</a>
			<h1>{formatDateTime(s.startedAt)}</h1>
			<p class="muted">
				{data.vehicle.displayName}
				<span class="sep">·</span>
				{#if s.isOpen}
					<span class="live">in progress</span>
				{:else}
					{formatTime(s.startedAt)} → {formatTime(s.endedAt)}
				{/if}
			</p>
		</div>
	</div>

	<div class="tiles">
		<StatTile label="Distance" value={formatDistance(s.distanceKm)} tone="driving" />
		<StatTile
			label="Duration"
			value={s.isOpen ? DASH : formatDuration(s.durationS)}
			hint={s.isOpen ? 'still driving' : null}
		/>
		<StatTile label="Energy" value={formatKwh(s.energyKwh)} />
		<StatTile label="Efficiency" value={formatEfficiency(s.efficiencyWhPerKm)} tone="accent" />
		<StatTile label="Average speed" value={formatSpeed(s.avgSpeedKph)} />
		<StatTile
			label="State of charge"
			value="{formatPct(s.startSocPct)} → {formatPct(s.endSocPct)}"
			hint={socUsed != null ? `${formatPct(socUsed)} used` : null}
		/>
	</div>

	<section>
		<div class="section-title">
			<h2>Route</h2>
			{#if data.detail.downsampled}
				<span class="faint">series thinned for display — it still spans the whole drive</span>
			{/if}
		</div>
		<Map
			{path}
			height="380px"
			emptyTitle="This drive has no route"
			emptyDetail="No point in this drive carried coordinates. Location is granted by a separate permission (vehicle_location) from the rest of the telemetry, so the distance, energy and speed above are unaffected."
		/>
	</section>

	<section>
		<div class="section-title"><h2>Speed and state of charge</h2></div>
		<div class="card pad">
			<TimeSeriesChart
				{series}
				emptyTitle="No series for this drive"
				emptyDetail="The drive was recorded, but no point carried a speed or a state of charge — usually an ingest gap across the session."
			/>
		</div>
	</section>
</div>

<style>
	.head {
		margin-bottom: 18px;
	}

	.head h1 {
		margin-top: 6px;
	}

	.head p {
		margin: 4px 0 0;
		font-size: 0.88rem;
	}

	.sep {
		color: var(--text-faint);
		margin: 0 4px;
	}

	.live {
		color: var(--driving);
		font-weight: 600;
	}

	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 10px;
		margin-bottom: 26px;
	}

	section {
		margin-bottom: 26px;
	}

	.pad {
		padding: 16px;
	}
</style>
