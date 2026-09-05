<script lang="ts">
	import { DASH, formatDistance, formatPct } from '$lib/format.js'

	interface Props {
		socPct: number | null
		rangeKm?: number | null
		/** Adds the bolt and the amber fill. Drives the colour, not the value. */
		charging?: boolean
		size?: 'sm' | 'lg'
	}

	let { socPct, rangeKm = null, charging = false, size = 'lg' }: Props = $props()

	// A null SoC draws an EMPTY track, never a 0% fill: "the car has not told us"
	// and "the car is flat" must not look the same on a card someone glances at.
	let known = $derived(socPct != null && Number.isFinite(socPct))
	let clamped = $derived(known ? Math.min(100, Math.max(0, socPct as number)) : 0)
	let tone = $derived(charging ? 'charging' : clamped <= 10 ? 'low' : 'ok')
</script>

<div class="gauge {size}">
	<div class="row">
		<div
			class="track"
			role="meter"
			aria-valuemin="0"
			aria-valuemax="100"
			aria-valuenow={known ? clamped : undefined}
			aria-label="State of charge"
		>
			{#if known}
				<div class="fill {tone}" style="width: {clamped}%"></div>
			{:else}
				<div class="unknown-track"></div>
			{/if}
			<span class="cap"></span>
		</div>
		<div class="readout num">
			{#if charging}<span class="bolt" aria-hidden="true">⚡</span>{/if}
			<strong>{formatPct(socPct)}</strong>
		</div>
	</div>
	<div class="sub num">
		{#if known}
			{formatDistance(rangeKm, 0)} range
		{:else}
			{DASH} no state of charge recorded
		{/if}
	</div>
</div>

<style>
	.gauge {
		display: grid;
		gap: 6px;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.track {
		position: relative;
		flex: 1;
		background: var(--surface-inset);
		border: 1px solid var(--border-strong);
		border-radius: 5px;
		overflow: hidden;
	}

	.lg .track {
		height: 22px;
	}
	.sm .track {
		height: 12px;
	}

	.fill {
		height: 100%;
		border-radius: 4px 2px 2px 4px;
		transition: width 400ms ease;
		background: linear-gradient(180deg, var(--accent), color-mix(in srgb, var(--accent) 78%, #000));
	}

	.fill.charging {
		background: linear-gradient(
			180deg,
			var(--charging),
			color-mix(in srgb, var(--charging) 78%, #000)
		);
	}

	.fill.low {
		background: linear-gradient(180deg, var(--danger), color-mix(in srgb, var(--danger) 78%, #000));
	}

	/* Diagonal hatching reads as "no reading" at a glance, where an empty bar
	   would read as "empty battery". */
	.unknown-track {
		height: 100%;
		background: repeating-linear-gradient(
			45deg,
			transparent,
			transparent 5px,
			var(--border) 5px,
			var(--border) 10px
		);
	}

	.cap {
		position: absolute;
		top: 50%;
		right: -4px;
		transform: translateY(-50%);
		width: 3px;
		height: 40%;
		background: var(--border-strong);
		border-radius: 0 2px 2px 0;
	}

	.readout {
		display: flex;
		align-items: baseline;
		gap: 3px;
		min-width: 62px;
		justify-content: flex-end;
	}

	.lg .readout strong {
		font-size: 1.35rem;
		font-weight: 640;
		letter-spacing: -0.02em;
	}

	.sm .readout strong {
		font-size: 0.95rem;
	}

	.bolt {
		color: var(--charging);
		font-size: 0.85em;
	}

	.sub {
		font-size: 0.8rem;
		color: var(--text-muted);
	}
</style>
