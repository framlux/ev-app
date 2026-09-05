<script lang="ts">
	import type { ConnectionState } from '$lib/live.svelte.js'
	import { formatRelative } from '$lib/format.js'

	interface Props {
		connection: ConnectionState
		lastEventAt: number | null
	}

	let { connection, lastEventAt }: Props = $props()

	/**
	 * How recently an update must have landed for "Live" to be true.
	 *
	 * Comfortably past the ingest pipeline's own ceiling (a sample is emitted at
	 * least every 30s while a car is reporting at all), so a driving or charging
	 * car reads as live continuously, and a car that has genuinely stopped
	 * reporting stops claiming to be.
	 */
	const FRESH_MS = 90_000

	let fresh = $derived(lastEventAt !== null && Date.now() - lastEventAt < FRESH_MS)
	let state = $derived(
		connection !== 'open' ? 'down' : fresh ? 'live' : 'quiet'
	)
</script>

<span class="indicator" class:live={state === 'live'} class:down={state === 'down'} title={
	state === 'live'
		? 'Receiving updates'
		: state === 'down'
			? 'Not connected to the live stream — showing the last values received'
			: 'Connected, but the vehicle has not reported recently'
}>
	<span class="dot"></span>
	{#if state === 'live'}
		Live
	{:else if state === 'down'}
		Reconnecting…
	{:else if lastEventAt !== null}
		Last update {formatRelative(new Date(lastEventAt).toISOString())}
	{:else}
		Waiting for data
	{/if}
</span>

<style>
	.indicator {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 0.8rem;
		color: var(--text-muted);
	}

	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--text-muted);
	}

	.live .dot {
		background: var(--accent);
	}

	.down .dot {
		background: var(--text-muted);
		opacity: 0.5;
	}
</style>
