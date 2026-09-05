<script lang="ts">
	import type { SessionPointDto } from '$lib/api-types.js'
	import { areaPath, extent, linePath, niceTicks, padExtent, scaleLinear, toPoints } from '$lib/chart.js'
	import { formatKw, formatNumber } from '$lib/format.js'
	import EmptyState from './EmptyState.svelte'

	interface Props {
		points: SessionPointDto[]
		height?: number
	}

	let { points, height = 260 }: Props = $props()

	const PAD = { top: 14, right: 16, bottom: 26, left: 44 }
	const WIDTH = 720

	// Power against SoC, not against time: what a charge curve is FOR is seeing
	// where the taper begins, and that is a property of the state of charge.
	// Rows missing either half are dropped rather than plotted at zero.
	let data = $derived(
		toPoints(
			points,
			(p) => p.socPct,
			(p) => p.powerKw
		).sort((a, b) => a.x - b.x)
	)

	let plotW = $derived(WIDTH - PAD.left - PAD.right)
	let plotH = $derived(height - PAD.top - PAD.bottom)

	let xDomain = $derived.by(() => {
		const e = extent(data.map((p) => p.x))
		return e ? padExtent(e, 0.04) : null
	})

	// The power axis is anchored at zero: a curve floating on a 30-45 kW window
	// exaggerates a gentle taper into a cliff.
	let yDomain = $derived.by(() => {
		const e = extent(data.map((p) => p.y))
		return e ? padExtent({ min: Math.min(0, e.min), max: e.max }, 0.08) : null
	})

	let x = $derived(xDomain ? scaleLinear(xDomain, [PAD.left, PAD.left + plotW]) : () => PAD.left)
	let y = $derived(
		yDomain ? scaleLinear(yDomain, [PAD.top + plotH, PAD.top]) : () => PAD.top + plotH
	)

	let projected = $derived(data.map((p) => ({ x: x(p.x), y: y(p.y) })))
	let xTicks = $derived(xDomain ? niceTicks(xDomain.min, xDomain.max, 5) : [])
	let yTicks = $derived(yDomain ? niceTicks(yDomain.min, yDomain.max, 4) : [])

	let peak = $derived.by(() => {
		let best: { x: number; y: number } | null = null
		for (const p of data) if (!best || p.y > best.y) best = p
		return best
	})
</script>

{#if data.length === 0}
	<EmptyState
		title="No power curve for this charge"
		detail="A curve needs points carrying both a state of charge and a charging power. This session was recorded without them — the totals above are still correct."
		icon="◠"
	/>
{:else}
	<svg viewBox="0 0 {WIDTH} {height}" role="img" aria-label="Charging power against state of charge">
		{#each yTicks as t (t)}
			<line class="grid" x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} />
			<text class="tick" x={PAD.left - 6} y={y(t)} text-anchor="end" dominant-baseline="middle"
				>{formatNumber(t, 0)}</text
			>
		{/each}

		{#each xTicks as t (t)}
			<text class="tick" x={x(t)} y={height - 8} text-anchor="middle">{formatNumber(t, 0)}%</text>
		{/each}

		<path d={areaPath(projected, PAD.top + plotH)} fill="var(--charging)" opacity="0.14" />
		<path
			d={linePath(projected)}
			fill="none"
			stroke="var(--charging)"
			stroke-width="2.4"
			stroke-linejoin="round"
			stroke-linecap="round"
		/>

		{#if projected.length === 1}
			<circle cx={projected[0]!.x} cy={projected[0]!.y} r="4" fill="var(--charging)" />
		{/if}

		{#if peak}
			<circle cx={x(peak.x)} cy={y(peak.y)} r="3.5" fill="var(--charging)" />
			<text
				class="peak"
				x={x(peak.x)}
				y={Math.max(12, y(peak.y) - 9)}
				text-anchor={x(peak.x) > PAD.left + plotW - 70 ? 'end' : 'middle'}
				>peak {formatKw(peak.y)}</text
			>
		{/if}

		<text class="axis-label" x={PAD.left} y={12}>kW</text>
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

	.tick,
	.axis-label {
		fill: var(--text-faint);
		font-size: 10px;
		font-family: var(--font);
	}

	.peak {
		fill: var(--text);
		font-size: 11px;
		font-weight: 600;
		font-family: var(--font);
	}
</style>
