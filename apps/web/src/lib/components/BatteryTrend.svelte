<script lang="ts">
	import type { BatteryHealthPoint } from '$lib/api-types.js'
	import { extent, linePath, niceTicks, padExtent, scaleLinear, toPoints } from '$lib/chart.js'
	import { formatDate, formatNumber } from '$lib/format.js'
	import EmptyState from './EmptyState.svelte'

	interface Props {
		samples: BatteryHealthPoint[]
		/** Drawn as the dashed reference the degradation figure is measured from. */
		baselineCapacityKwh?: number | null
		height?: number
	}

	let { samples, baselineCapacityKwh = null, height = 260 }: Props = $props()

	const PAD = { top: 16, right: 16, bottom: 26, left: 48 }
	const WIDTH = 720

	// observedOn is a calendar date, not a timestamp: 'YYYY-MM-DD' parses as
	// UTC midnight, which is what the API means by it.
	let data = $derived(
		toPoints(
			samples,
			(s) => Date.parse(s.observedOn),
			(s) => s.estimatedCapacityKwh,
			(s) => s.sampleConfidence
		)
	)

	let plotW = $derived(WIDTH - PAD.left - PAD.right)
	let plotH = $derived(height - PAD.top - PAD.bottom)

	let xDomain = $derived.by(() => {
		const e = extent(data.map((p) => p.x))
		return e ? padExtent(e, 0.03) : null
	})

	// The baseline belongs inside the domain even when no sample reaches it,
	// otherwise the dashed reference line silently leaves the frame.
	let yDomain = $derived.by(() => {
		const values = data.map((p) => p.y)
		if (baselineCapacityKwh != null) values.push(baselineCapacityKwh)
		const e = extent(values)
		return e ? padExtent(e, 0.15) : null
	})

	let x = $derived(xDomain ? scaleLinear(xDomain, [PAD.left, PAD.left + plotW]) : () => PAD.left)
	let y = $derived(
		yDomain ? scaleLinear(yDomain, [PAD.top + plotH, PAD.top]) : () => PAD.top + plotH
	)

	let projected = $derived(data.map((p) => ({ x: x(p.x), y: y(p.y) })))
	let yTicks = $derived(yDomain ? niceTicks(yDomain.min, yDomain.max, 4) : [])
	let xTicks = $derived(xDomain ? niceTicks(xDomain.min, xDomain.max, 4) : [])

	/**
	 * Confidence becomes opacity, so a narrow charge visibly counts for less.
	 * Floored at 0.25 because a 0.05-confidence estimate that renders invisible
	 * looks like a gap in the record rather than a weak measurement.
	 */
	function dotOpacity(confidence: unknown): number {
		const c = typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : 0
		return Math.min(1, Math.max(0.25, c))
	}
</script>

{#if data.length === 0}
	<EmptyState
		title="No capacity estimates yet"
		detail="An estimate needs one charge session wide enough to measure across — roughly 20 percentage points of state of charge. The first long charge will start this chart."
		icon="◍"
	/>
{:else}
	<svg viewBox="0 0 {WIDTH} {height}" role="img" aria-label="Estimated usable capacity over time">
		{#each yTicks as t (t)}
			<line class="grid" x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} />
			<text class="tick" x={PAD.left - 6} y={y(t)} text-anchor="end" dominant-baseline="middle"
				>{formatNumber(t, 1)}</text
			>
		{/each}

		{#each xTicks as t (t)}
			<text class="tick" x={x(t)} y={height - 8} text-anchor="middle"
				>{new Date(t).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })}</text
			>
		{/each}

		{#if baselineCapacityKwh != null}
			<line
				class="baseline"
				x1={PAD.left}
				x2={PAD.left + plotW}
				y1={y(baselineCapacityKwh)}
				y2={y(baselineCapacityKwh)}
			/>
			<text class="baseline-label" x={PAD.left + plotW} y={y(baselineCapacityKwh) - 5} text-anchor="end"
				>baseline {formatNumber(baselineCapacityKwh, 1)} kWh</text
			>
		{/if}

		{#if projected.length > 1}
			<path d={linePath(projected)} fill="none" stroke="var(--accent)" stroke-width="1.6" opacity="0.55" />
		{/if}

		{#each data as p, i (p.x + ':' + i)}
			<circle
				cx={x(p.x)}
				cy={y(p.y)}
				r="4"
				fill="var(--accent)"
				opacity={dotOpacity(p.meta)}
				role="img"
				aria-label="{formatDate(new Date(p.x).toISOString())}: {formatNumber(p.y, 2)} kWh"
			/>
		{/each}

		<text class="tick" x={PAD.left} y={11}>kWh</text>
	</svg>
{/if}

<style>
	svg {
		width: 100%;
		height: auto;
		display: block;
	}

	.grid {
		stroke: var(--grid);
		stroke-width: 1;
		vector-effect: non-scaling-stroke;
	}

	.baseline {
		stroke: var(--text-faint);
		stroke-width: 1;
		stroke-dasharray: 4 4;
		vector-effect: non-scaling-stroke;
	}

	.tick,
	.baseline-label {
		fill: var(--text-faint);
		font-size: 10px;
		font-family: var(--font);
	}
</style>
