<script lang="ts">
	import type { PageData } from './$types.js'
	import DateRangeFilter from '$lib/components/DateRangeFilter.svelte'
	import PaginatedSessions from '$lib/components/PaginatedSessions.svelte'

	let { data }: { data: PageData } = $props()

	let vehicleId = $derived(data.entry.vehicle.id)
	let filtered = $derived(data.from != null || data.to != null)
</script>

<svelte:head>
	<title>Drives · {data.entry.vehicle.displayName} · EV</title>
</svelte:head>

<div class="bar">
	<div class="section-title">
		<h2>Drives</h2>
	</div>
	<DateRangeFilter from={data.from} to={data.to} basePath="/vehicles/{vehicleId}/drives" />
</div>

<!-- Keyed on the filter: a new range is a new list, so the component is
     recreated rather than accumulating pages across two different queries. -->
{#key `${data.from ?? ''}|${data.to ?? ''}`}
	<PaginatedSessions
		{vehicleId}
		kind="drive"
		initial={data.page.sessions}
		initialCursor={data.page.nextCursor}
		from={data.from}
		to={data.to}
		emptyTitle={filtered ? 'No drives in that range' : 'No drives recorded yet'}
		emptyDetail={filtered
			? 'Nothing was recorded between those dates. Widen the range, or clear the filter to see everything.'
			: 'A drive is segmented from the sample stream once the car starts moving, and appears here within a minute of it parking.'}
	/>
{/key}

<style>
	.bar {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
		margin-bottom: 14px;
	}

	.section-title {
		margin: 0;
	}
</style>
