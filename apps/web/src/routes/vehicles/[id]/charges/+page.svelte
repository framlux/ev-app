<script lang="ts">
	import type { PageData } from './$types.js'
	import DateRangeFilter from '$lib/components/DateRangeFilter.svelte'
	import PaginatedSessions from '$lib/components/PaginatedSessions.svelte'

	let { data }: { data: PageData } = $props()

	let vehicleId = $derived(data.entry.vehicle.id)
	let filtered = $derived(data.from != null || data.to != null)
</script>

<svelte:head>
	<title>Charges · {data.entry.vehicle.displayName} · Coulomb</title>
</svelte:head>

<div class="bar">
	<div class="section-title">
		<h2>Charges</h2>
	</div>
	<DateRangeFilter from={data.from} to={data.to} basePath="/vehicles/{vehicleId}/charges" />
</div>

<!-- Keyed on the filter: a new range is a new list, so the component is
     recreated rather than accumulating pages across two different queries. -->
{#key `${data.from ?? ''}|${data.to ?? ''}`}
	<PaginatedSessions
		{vehicleId}
		kind="charge"
		initial={data.page.sessions}
		initialCursor={data.page.nextCursor}
		from={data.from}
		to={data.to}
		emptyTitle={filtered ? 'No charges in that range' : 'No charges recorded yet'}
		emptyDetail={filtered
			? 'Nothing was recorded between those dates. Widen the range, or clear the filter to see everything.'
			: 'A charge is segmented from the sample stream when the car reports charging. One at home is priced at the energy rate in force when it started; a Supercharger stop waits on Tesla to invoice it. A charge with no figure says which — it is never shown as zero.'}
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
