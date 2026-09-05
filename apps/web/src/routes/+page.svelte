<script lang="ts">
	import type { VehicleWithState } from '$lib/api-types.js'
	import EmptyState from '$lib/components/EmptyState.svelte'
	import VehicleCard from '$lib/components/VehicleCard.svelte'

	interface Props {
		data: { vehicles: VehicleWithState[] }
	}

	let { data }: Props = $props()
</script>

<svelte:head><title>Garage</title></svelte:head>

<header class="page-head">
	<h1>Garage</h1>
	<p class="muted">Every car this install knows about.</p>
</header>

{#if data.vehicles.length === 0}
	<!-- The state of a freshly deployed install, and the one this page is most
	     likely to be seen in. It says what is missing and what would fix it,
	     because "no data" sends the reader to the logs for no reason. -->
	<EmptyState
		title="No vehicles yet"
		icon="⬡"
		detail="Nothing has been recorded. A car appears here once its telemetry
		configuration has been accepted and the first message has arrived."
	/>
{:else}
	<!-- auto-fit rather than a fixed column count: this install has one car and
	     may have two, and a one-car grid should not leave a hole beside it. -->
	<div class="grid">
		{#each data.vehicles as entry (entry.vehicle.id)}
			<VehicleCard {entry} />
		{/each}
	</div>
{/if}

<style>
	.page-head {
		margin-bottom: 1.5rem;
	}

	h1 {
		margin: 0 0 0.25rem;
		font-size: 1.65rem;
		letter-spacing: -0.02em;
	}

	.muted {
		margin: 0;
		color: var(--text-muted);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr));
		gap: 1.25rem;
	}
</style>
