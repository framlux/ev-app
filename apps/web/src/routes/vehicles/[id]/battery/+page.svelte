<script lang="ts">
	import type { PageData } from './$types.js'
	import BatteryTrend from '$lib/components/BatteryTrend.svelte'
	import StatTile from '$lib/components/StatTile.svelte'
	import { DASH, formatDate, formatKwh, formatNumber, formatPct, formatTemp } from '$lib/format.js'

	let { data }: { data: PageData } = $props()

	let health = $derived(data.health)
	let lifetime = $derived(data.stats.lifetime)

	/**
	 * The pack's own readings, from the latest sample.
	 *
	 * Load-time state, not the live stream: these are pack internals nothing
	 * else on the page updates in place, and streaming five more columns per
	 * notification to every open tab to keep them ticking is not a trade this
	 * page needs (spec §3.8's projection). A refresh is what moves them.
	 */
	let pack = $derived(data.entry.state)

	// Estimates only. `samples` now also carries the days that have only the
	// car's own measurement, and "one per day at most" was never a count of
	// rows — it was a count of estimates.
	let estimateCount = $derived(
		health.samples.filter((s) => s.estimatedCapacityKwh != null).length
	)

	/**
	 * Brick spread in MILLIVOLTS, because that is the scale it lives at: the
	 * cells in a healthy pack sit within a few tens of millivolts of each other
	 * and a figure in volts would round the whole signal away. Null unless BOTH
	 * ends are reported — half a spread is not a spread.
	 */
	let brickSpreadMv = $derived.by(() => {
		if (pack?.brickVoltageMin == null || pack.brickVoltageMax == null) return null
		return Math.round((pack.brickVoltageMax - pack.brickVoltageMin) * 1000)
	})

	let brickHint = $derived(
		pack?.brickVoltageMin != null && pack.brickVoltageMax != null
			? `${formatNumber(pack.brickVoltageMin, 3)} – ${formatNumber(pack.brickVoltageMax, 3)} V`
			: null
	)

	// Both ends or neither: a range with one end reported reads as a pack whose
	// coldest module is unknown, which the dash says better than half a range.
	let moduleRange = $derived(
		pack?.moduleTempMin != null && pack.moduleTempMax != null
			? `${formatTemp(pack.moduleTempMin)} → ${formatTemp(pack.moduleTempMax)}`
			: DASH
	)

	// degradationPct is null unless BOTH a baseline and a latest sample exist:
	// one measurement is not a trend, and rendering 0% would claim a healthy
	// battery on the strength of no evidence at all.
	let degradation = $derived(
		health.degradationPct == null ? DASH : formatPct(health.degradationPct, 1)
	)

	let spread = $derived.by(() => {
		if (health.samples.length < 2) return null
		const first = health.samples[0]!
		const last = health.samples[health.samples.length - 1]!
		return `${formatDate(first.observedOn)} → ${formatDate(last.observedOn)}`
	})
</script>

<svelte:head>
	<title>Battery · {data.entry.vehicle.displayName} · EV</title>
</svelte:head>

<section>
	<div class="section-title">
		<h2>Battery health</h2>
		{#if spread}<span class="faint">{spread}</span>{/if}
	</div>

	<div class="card pad">
		<div class="tiles">
			<StatTile
				label="Latest estimate"
				value={health.latest ? formatKwh(health.latest.estimatedCapacityKwh) : DASH}
				hint={health.latest ? formatDate(health.latest.observedOn) : 'no estimate yet'}
				tone="accent"
			/>
			<StatTile
				label="Baseline"
				value={health.baselineCapacityKwh != null
					? formatKwh(health.baselineCapacityKwh)
					: DASH}
				hint="best measurement, not a nameplate figure"
			/>
			<StatTile label="Degradation" value={degradation} hint="against the baseline" />
			<StatTile
				label="Estimates"
				value={formatNumber(estimateCount, 0)}
				hint="one per day at most"
			/>
		</div>

		<div class="chart">
			<BatteryTrend samples={health.samples} baselineCapacityKwh={health.baselineCapacityKwh} />
		</div>

		<p class="faint note">
			Capacity is inferred from charge sessions: energy added divided by the state-of-charge span
			it covered. A narrow charge measures the same battery less precisely, so each point is drawn
			at the opacity of its confidence rather than as an equally trustworthy dot. There is no
			manufacturer capacity in this database, so "new" means the best measurement ever taken.
		</p>
	</div>
</section>

<section>
	<div class="section-title">
		<h2>The car's own measurement</h2>
		<span class="faint">NominalFullPackEnergyKwh, recorded once a day</span>
	</div>
	<div class="card pad">
		<div class="tiles">
			<StatTile
				label="Measured capacity"
				value={health.latestMeasured
					? formatKwh(health.latestMeasured.measuredCapacityKwh)
					: DASH}
				hint={health.latestMeasured
					? formatDate(health.latestMeasured.observedOn)
					: 'nothing recorded yet'}
				tone="accent"
			/>
			<StatTile
				label="Best measured"
				value={health.measuredBaselineCapacityKwh != null
					? formatKwh(health.measuredBaselineCapacityKwh)
					: DASH}
				hint="the reference below"
			/>
			<StatTile
				label="Degradation"
				value={health.measuredDegradationPct == null
					? DASH
					: formatPct(health.measuredDegradationPct, 1)}
				hint="against the best measurement"
			/>
		</div>
		<p class="faint note">
			This is the battery management system's own figure for a full pack, not an inference from a
			charge — so it needs no confidence and no wide charge to appear. It is still measured against
			the best reading ever taken rather than against a nameplate capacity: there is no
			manufacturer figure anywhere in this database, and inventing one would make every number
			above a guess dressed as a fact.
		</p>
	</div>
</section>

<section>
	<div class="section-title">
		<h2>The pack right now</h2>
		{#if pack}<span class="faint">as of the last sample</span>{/if}
	</div>
	<div class="card pad">
		<div class="tiles">
			<StatTile
				label="Energy remaining"
				value={formatKwh(pack?.energyRemaining)}
				hint="what is in the pack, not what it holds when full"
			/>
			<StatTile
				label="Module temperature"
				value={moduleRange}
				hint="coldest to warmest module"
			/>
			<StatTile
				label="Brick voltage spread"
				value={brickSpreadMv == null ? DASH : `${formatNumber(brickSpreadMv, 0)} mV`}
				hint={brickHint}
			/>
		</div>
	</div>
</section>

<section>
	<div class="section-title"><h2>Lifetime charging</h2></div>
	<div class="card pad">
		<div class="tiles">
			<StatTile
				label="Energy added"
				value={formatKwh(lifetime.chargeEnergyKwh)}
				hint="{lifetime.chargeCount} completed charges"
				tone="charging"
			/>
			<StatTile
				label="Peak power seen"
				value={lifetime.maxChargePowerKw != null
					? `${formatNumber(lifetime.maxChargePowerKw, 1)} kW`
					: DASH}
			/>
			<StatTile
				label="Recording since"
				value={data.stats.recordingSince ? formatDate(data.stats.recordingSince) : DASH}
			/>
		</div>
	</div>
</section>

<style>
	section {
		margin-bottom: 26px;
	}

	.pad {
		padding: 16px;
	}

	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 10px;
	}

	.chart {
		margin-top: 16px;
	}

	.note {
		margin: 14px 0 0;
		font-size: 0.78rem;
		max-width: 78ch;
	}
</style>
