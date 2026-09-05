<script lang="ts">
	import { areaPath, extent, linePath, niceTicks, padExtent, scaleLinear } from '$lib/chart.js'
	import type { ChartSeries, Point } from '$lib/chart.js'
	import { formatDateTime, formatNumber } from '$lib/format.js'
	import EmptyState from './EmptyState.svelte'

	interface Props {
		series: ChartSeries[]
		height?: number
		emptyTitle?: string
		emptyDetail?: string
	}

	let {
		series,
		height = 240,
		emptyTitle = 'Nothing recorded in this window',
		emptyDetail = 'Samples appear here as soon as the car reports them.'
	}: Props = $props()

	const PAD = { top: 12, right: 46, bottom: 24, left: 44 }
	const WIDTH = 720 // viewBox units; the SVG scales to its container.

	let drawn = $derived(series.filter((s) => s.points.length > 0))
	// One point still draws: a dot on a padded axis is a truthful chart of one
	// reading, and this app spends its first days with exactly that.
	let hasData = $derived(drawn.length > 0)

	let plotW = $derived(WIDTH - PAD.left - PAD.right)
	let plotH = $derived(height - PAD.top - PAD.bottom)

	let xDomain = $derived.by(() => {
		const e = extent(drawn.flatMap((s) => s.points.map((p) => p.x)))
		return e ? padExtent(e, 0.01) : null
	})

	function axisDomain(side: 'left' | 'right') {
		const pts = drawn.filter((s) => (s.axis ?? 'left') === side).flatMap((s) => s.points)
		if (pts.length === 0) return null
		return padExtent(extent(pts.map((p) => p.y))!, 0.12)
	}

	let leftDomain = $derived(axisDomain('left'))
	let rightDomain = $derived(axisDomain('right'))

	let x = $derived(xDomain ? scaleLinear(xDomain, [PAD.left, PAD.left + plotW]) : () => PAD.left)
	let yLeft = $derived(
		leftDomain ? scaleLinear(leftDomain, [PAD.top + plotH, PAD.top]) : () => PAD.top + plotH
	)
	let yRight = $derived(
		rightDomain ? scaleLinear(rightDomain, [PAD.top + plotH, PAD.top]) : () => PAD.top + plotH
	)

	function project(s: ChartSeries): Point[] {
		const y = (s.axis ?? 'left') === 'right' ? yRight : yLeft
		return s.points.map((p) => ({ x: x(p.x), y: y(p.y) }))
	}

	let leftTicks = $derived(leftDomain ? niceTicks(leftDomain.min, leftDomain.max, 4) : [])
	let rightTicks = $derived(rightDomain ? niceTicks(rightDomain.min, rightDomain.max, 4) : [])
	let xTicks = $derived(xDomain ? niceTicks(xDomain.min, xDomain.max, 4) : [])

	function tickLabel(ms: number): string {
		const span = xDomain ? xDomain.max - xDomain.min : 0
		const d = new Date(ms)
		// Under a day, the date is noise repeated on every tick; over a day, the
		// clock time is.
		return span < 36 * 3600 * 1000
			? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
			: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
	}

	/* Hover readout ------------------------------------------------------- */
	let hoverX = $state<number | null>(null)

	function onMove(event: PointerEvent) {
		const svg = event.currentTarget as SVGSVGElement
		const rect = svg.getBoundingClientRect()
		if (rect.width === 0) return
		hoverX = ((event.clientX - rect.left) / rect.width) * WIDTH
	}

	function nearest(s: ChartSeries, atViewX: number): Point | null {
		let best: Point | null = null
		let bestD = Infinity
		for (const p of s.points) {
			const d = Math.abs(x(p.x) - atViewX)
			if (d < bestD) {
				bestD = d
				best = p
			}
		}
		// Ignore a pointer parked far off the end of a short series.
		return best && bestD <= 40 ? best : null
	}

	let readout = $derived.by(() => {
		if (hoverX == null || !hasData) return null
		const rows = drawn
			.map((s) => ({ s, p: nearest(s, hoverX as number) }))
			.filter((r): r is { s: ChartSeries; p: Point } => r.p != null)
		if (rows.length === 0) return null
		return { ts: rows[0]!.p.x, rows }
	})
</script>

{#if !hasData}
	<EmptyState title={emptyTitle} detail={emptyDetail} icon="◠" />
{:else}
	<div class="chart">
		<div class="legend">
			{#each drawn as s (s.key)}
				<span class="key"><i style="background: {s.color}"></i>{s.label}</span>
			{/each}
		</div>

		<svg
			viewBox="0 0 {WIDTH} {height}"
			role="img"
			aria-label={drawn.map((s) => s.label).join(', ')}
			onpointermove={onMove}
			onpointerleave={() => (hoverX = null)}
		>
			{#each leftTicks as t (t)}
				<line class="grid" x1={PAD.left} x2={PAD.left + plotW} y1={yLeft(t)} y2={yLeft(t)} />
				<text class="tick" x={PAD.left - 6} y={yLeft(t)} text-anchor="end" dominant-baseline="middle"
					>{formatNumber(t, Math.abs(t) < 10 ? 1 : 0)}</text
				>
			{/each}

			{#each rightTicks as t (t)}
				<text
					class="tick"
					x={PAD.left + plotW + 6}
					y={yRight(t)}
					text-anchor="start"
					dominant-baseline="middle">{formatNumber(t, Math.abs(t) < 10 ? 1 : 0)}</text
				>
			{/each}

			{#each xTicks as t (t)}
				<text class="tick" x={x(t)} y={height - 6} text-anchor="middle">{tickLabel(t)}</text>
			{/each}

			{#each drawn as s (s.key)}
				{@const projected = project(s)}
				{#if s.fill}
					<path d={areaPath(projected, PAD.top + plotH)} fill={s.color} opacity="0.10" />
				{/if}
				<path
					d={linePath(projected)}
					fill="none"
					stroke={s.color}
					stroke-width="2"
					stroke-linejoin="round"
					stroke-linecap="round"
				/>
				{#if projected.length === 1}
					<circle cx={projected[0]!.x} cy={projected[0]!.y} r="3.5" fill={s.color} />
				{/if}
			{/each}

			{#if readout}
				<line
					class="crosshair"
					x1={x(readout.ts)}
					x2={x(readout.ts)}
					y1={PAD.top}
					y2={PAD.top + plotH}
				/>
				{#each readout.rows as row (row.s.key)}
					<circle
						cx={x(row.p.x)}
						cy={(row.s.axis ?? 'left') === 'right' ? yRight(row.p.y) : yLeft(row.p.y)}
						r="4"
						fill={row.s.color}
						stroke="var(--surface)"
						stroke-width="1.5"
					/>
				{/each}
			{/if}
		</svg>

		<div class="readout" aria-live="off">
			{#if readout}
				<span class="when">{formatDateTime(new Date(readout.ts).toISOString())}</span>
				{#each readout.rows as row (row.s.key)}
					<span class="val num"
						><i style="background: {row.s.color}"></i>{formatNumber(row.p.y, row.s.dp ?? 0)}{row.s
							.unit}</span
					>
				{/each}
			{:else}
				<span class="faint">Hover the chart for values</span>
			{/if}
		</div>
	</div>
{/if}

<style>
	.chart {
		display: grid;
		gap: 6px;
	}

	svg {
		width: 100%;
		height: auto;
		display: block;
		touch-action: pan-y;
	}

	.grid {
		stroke: var(--grid);
		stroke-width: 1;
		vector-effect: non-scaling-stroke;
	}

	.crosshair {
		stroke: var(--border-strong);
		stroke-width: 1;
		stroke-dasharray: 3 3;
		vector-effect: non-scaling-stroke;
	}

	/* Chart text takes its colour from the theme tokens so it reads in both
	   light and dark, rather than being baked to one of them. */
	.tick {
		fill: var(--text-faint);
		font-size: 10px;
		font-family: var(--font);
	}

	.legend,
	.readout {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
		align-items: center;
		font-size: 0.78rem;
		color: var(--text-muted);
		min-height: 20px;
	}

	.key,
	.val {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	i {
		width: 9px;
		height: 3px;
		border-radius: 2px;
		display: inline-block;
	}

	.when {
		color: var(--text);
		font-weight: 560;
	}
</style>
