<script lang="ts">
	import type { PageData } from './$types.js'
	import BatteryTrend from '$lib/components/BatteryTrend.svelte'
	import StatTile from '$lib/components/StatTile.svelte'
	import { DASH, formatDate, formatKwh, formatNumber, formatPct } from '$lib/format.js'

	let { data }: { data: PageData } = $props()

	let health = $derived(data.health)
	let lifetime = $derived(data.stats.lifetime)

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
				value={formatNumber(health.samples.length, 0)}
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
