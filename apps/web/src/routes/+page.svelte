<script lang="ts">
	import { onMount } from 'svelte'
	import type { VehicleWithState } from '$lib/api-types.js'
	import EmptyState from '$lib/components/EmptyState.svelte'
	import LiveIndicator from '$lib/components/LiveIndicator.svelte'
	import VehicleCard from '$lib/components/VehicleCard.svelte'
	import { live } from '$lib/live.svelte.js'

	interface Props {
		data: { vehicles: VehicleWithState[] }
	}

	let { data }: Props = $props()

	// Browser only, and idempotent: the store is app-wide, so navigating between
	// tabs must not open a second stream.
	onMount(() => live.start())

	// Each card independently: a vehicle with no live update yet keeps its
	// load-time card rather than the whole list waiting for the first event.
	let vehicles = $derived(data.vehicles.map((v) => live.get(v.vehicle.id) ?? v))
</script>

<svelte:head><title>Garage</title></svelte:head>

<header class="page-head">
	<div class="title">
		<h1>Garage</h1>
		<!-- The garage shows live data too, so it needs the same way to tell that
		     it is live — and to say so when it is not. -->
		<LiveIndicator connection={live.connection} lastEventAt={live.lastEventAt} />
	</div>
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
		{#each vehicles as entry (entry.vehicle.id)}
			<VehicleCard {entry} />
		{/each}
	</div>
{/if}

<style>
	.page-head {
		margin-bottom: 1.5rem;
	}

	.title {
		display: flex;
		align-items: baseline;
		gap: 12px;
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
