<script lang="ts">
	import type { SessionListItem } from '$lib/api-types.js'
	import {
		DASH,
		formatCoords,
		formatCost,
		formatDateTime,
		formatDuration,
		formatDistance,
		formatKw,
		formatKwh,
		formatPct,
		formatTime,
		formatEfficiency,
		formatUnpricedCost
	} from '$lib/format.js'

	interface Props {
		sessions: SessionListItem[]
		/** 'mixed' is the recent-activity block: drives, charges and idles together. */
		mode: 'drive' | 'charge' | 'mixed'
	}

	let { sessions, mode }: Props = $props()

	// The gate is the BASIS, not the currency, and the difference is a whole
	// page: a month of Supercharging arrives as rows that are all still waiting
	// on Tesla's invoice, none of which carries a currency yet. Gating on the
	// currency would hide the column on exactly the page whose blank cells most
	// need explaining, and leave four unexplained charges looking free.
	let showCost = $derived(mode === 'charge' && sessions.some((s) => s.costBasis != null))

	function href(s: SessionListItem): string | null {
		if (s.kind === 'drive') return `/drives/${s.id}`
		if (s.kind === 'charge') return `/charges/${s.id}`
		// An idle has no detail page: there is nothing to plot and no route.
		return null
	}

	function place(lat: number | null, lon: number | null): string {
		return formatCoords(lat, lon)
	}

	function socRange(s: SessionListItem): string {
		if (s.startSocPct == null && s.endSocPct == null) return DASH
		return `${formatPct(s.startSocPct)} → ${formatPct(s.endSocPct)}`
	}
</script>

<div class="wrap">
	<table>
		<thead>
			<tr>
				<th scope="col">When</th>
				{#if mode === 'mixed'}
					<th scope="col">Activity</th>
					<th scope="col" class="r">Distance</th>
					<th scope="col" class="r">Energy</th>
				{:else if mode === 'drive'}
					<th scope="col" class="hide-sm">Route</th>
					<th scope="col" class="r">Distance</th>
					<th scope="col" class="r">Energy</th>
					<th scope="col" class="r hide-sm">Efficiency</th>
				{:else}
					<th scope="col" class="hide-sm">Location</th>
					<th scope="col" class="r">Added</th>
					<th scope="col" class="r hide-sm">State of charge</th>
					<th scope="col" class="r">Peak</th>
					{#if showCost}<th scope="col" class="r">Cost</th>{/if}
				{/if}
				<th scope="col" class="r">Duration</th>
			</tr>
		</thead>
		<tbody>
			{#each sessions as s (s.id)}
				{@const link = href(s)}
				<tr class:open={s.isOpen}>
					<th scope="row">
						{#if link}
							<a href={link} class="when">
								<span class="date">{formatDateTime(s.startedAt)}</span>
								{#if s.isOpen}<span class="live">live</span>{/if}
							</a>
						{:else}
							<span class="when">
								<span class="date">{formatDateTime(s.startedAt)}</span>
								{#if s.isOpen}<span class="live">live</span>{/if}
							</span>
						{/if}
					</th>

					{#if mode === 'mixed'}
						<td><span class="kind {s.kind}">{s.kind}</span></td>
						<td class="r num">{formatDistance(s.distanceKm)}</td>
						<td class="r num">{formatKwh(s.energyKwh)}</td>
					{:else if mode === 'drive'}
						<td class="hide-sm route">
							<span class="num">{place(s.startLat, s.startLon)}</span>
							<span class="arrow" aria-hidden="true">→</span>
							<span class="num">{place(s.endLat, s.endLon)}</span>
						</td>
						<td class="r num">{formatDistance(s.distanceKm)}</td>
						<td class="r num">{formatKwh(s.energyKwh)}</td>
						<td class="r num hide-sm">{formatEfficiency(s.efficiencyWhPerKm)}</td>
					{:else}
						<td class="hide-sm num">{place(s.startLat, s.startLon)}</td>
						<td class="r num">{formatKwh(s.energyKwh)}</td>
						<td class="r num hide-sm">{socRange(s)}</td>
						<td class="r num">{formatKw(s.maxChargePowerKw)}</td>
						{#if showCost}
							<!-- The title carries the reason, and only when there is no
							     figure: a dash on its own is ambiguous between a charge
							     that was free and one we cannot price, and those are
							     opposite facts. A priced row gets no title, so hovering
							     one is never a dead end. -->
							<td
								class="r num"
								title={s.cost == null ? formatUnpricedCost(s.costBasis, s.energyKwh) : null}
								>{formatCost(s.cost, s.costCurrency)}</td
							>
						{/if}
					{/if}

					<td class="r num">
						{#if s.isOpen}
							<span class="muted">since {formatTime(s.startedAt)}</span>
						{:else}
							{formatDuration(s.durationS)}
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	.wrap {
		overflow-x: auto;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.88rem;
	}

	th,
	td {
		padding: 9px 12px;
		text-align: left;
		border-bottom: 1px solid var(--border);
		white-space: nowrap;
	}

	thead th {
		font-size: 0.7rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-faint);
		border-bottom-color: var(--border-strong);
	}

	tbody tr:last-child th,
	tbody tr:last-child td {
		border-bottom: 0;
	}

	tbody tr:hover {
		background: var(--surface-2);
	}

	tbody th {
		font-weight: 550;
	}

	.r {
		text-align: right;
	}

	.when {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}

	a.when:hover .date {
		color: var(--accent-text);
		text-decoration: underline;
	}

	.live {
		font-size: 0.66rem;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		font-weight: 700;
		color: var(--driving);
		background: var(--driving-soft);
		border-radius: 999px;
		padding: 1px 7px;
	}

	.route {
		color: var(--text-muted);
		font-size: 0.8rem;
	}

	.arrow {
		margin: 0 6px;
		color: var(--text-faint);
	}

	.kind {
		font-size: 0.74rem;
		text-transform: capitalize;
		padding: 2px 9px;
		border-radius: 999px;
		background: var(--offline-soft);
		color: var(--text-muted);
	}

	.kind.drive {
		background: var(--driving-soft);
		color: var(--driving);
	}

	.kind.charge {
		background: var(--charging-soft);
		color: var(--charging);
	}

	@media (max-width: 720px) {
		.hide-sm {
			display: none;
		}
	}
</style>
