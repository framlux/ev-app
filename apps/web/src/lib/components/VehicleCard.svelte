<script lang="ts">
	import type { VehicleWithState } from '$lib/api-types.js'
	import { DASH, formatOdometer, formatRelative, formatTempC } from '$lib/format.js'
	import { hasCoords } from '$lib/format.js'
	import ActivityPill from './ActivityPill.svelte'
	import BatteryGauge from './BatteryGauge.svelte'
	import Map from './Map.svelte'

	interface Props {
		entry: VehicleWithState
	}

	let { entry }: Props = $props()

	let v = $derived(entry.vehicle)
	let s = $derived(entry.state)
	let charging = $derived(entry.activity === 'charging')
	let located = $derived(s != null && hasCoords(s.lat, s.lon))

	let subtitle = $derived(
		[v.modelYear != null ? String(v.modelYear) : null, v.model].filter(Boolean).join(' ') || DASH
	)
</script>

<article class="card vehicle">
	<a class="head" href="/vehicles/{v.id}">
		<div>
			<h2>{v.displayName}</h2>
			<p class="muted sub">{subtitle}</p>
		</div>
		<ActivityPill activity={entry.activity} openSessionId={entry.openSessionId} />
	</a>

	<div class="body">
		{#if s}
			<BatteryGauge socPct={s.socPct} rangeKm={s.rangeKm} {charging} />

			<dl class="facts">
				<div>
					<dt>Odometer</dt>
					<dd class="num">{formatOdometer(s.odometerKm)}</dd>
				</div>
				<div>
					<dt>Inside</dt>
					<dd class="num">{formatTempC(s.insideTempC)}</dd>
				</div>
				<div>
					<dt>Outside</dt>
					<dd class="num">{formatTempC(s.outsideTempC)}</dd>
				</div>
				<div>
					<dt>Locked</dt>
					<!-- Tri-state on purpose: a car that has not reported its locks is
					     not an unlocked car. -->
					<dd>{s.locked == null ? DASH : s.locked ? 'Yes' : 'No'}</dd>
				</div>
			</dl>

			{#if located}
				<div class="map">
					<Map
						marker={{ lat: s.lat as number, lon: s.lon as number }}
						height="150px"
						interactive={false}
					/>
				</div>
			{/if}

			<p class="stamp faint">Last reading {formatRelative(s.ts)}</p>
		{:else}
			<!-- The expected state on day one: the vehicle row exists because the
			     Fleet API listed the car, but no telemetry has landed yet. -->
			<div class="waiting">
				<p class="title">Waiting for the first reading</p>
				<p class="muted">
					This car is registered but has never reported. Telemetry starts once the vehicle's
					streaming config is accepted and the car is awake.
				</p>
			</div>
		{/if}
	</div>

	<a class="more link" href="/vehicles/{v.id}">Open vehicle →</a>
</article>

<style>
	.vehicle {
		display: flex;
		flex-direction: column;
		padding: 16px 16px 12px;
		gap: 14px;
	}

	.head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
	}

	.head:hover h2 {
		color: var(--accent-text);
	}

	.sub {
		margin: 2px 0 0;
		font-size: 0.83rem;
	}

	.body {
		display: grid;
		gap: 14px;
		flex: 1;
	}

	.facts {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 10px;
		margin: 0;
	}

	.facts div {
		min-width: 0;
	}

	dt {
		font-size: 0.68rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-faint);
	}

	dd {
		margin: 1px 0 0;
		font-size: 0.92rem;
		font-weight: 560;
	}

	.map {
		margin-top: 2px;
	}

	.stamp {
		margin: 0;
		font-size: 0.76rem;
	}

	.waiting {
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius-sm);
		background: var(--surface-inset);
		padding: 18px;
	}

	.waiting .title {
		margin: 0 0 4px;
		font-weight: 600;
	}

	.waiting p {
		font-size: 0.85rem;
	}

	.waiting p:last-child {
		margin: 0;
	}

	.more {
		align-self: flex-start;
	}

	@media (max-width: 520px) {
		.facts {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
</style>
