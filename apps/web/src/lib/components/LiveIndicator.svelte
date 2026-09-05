<script lang="ts">
	import type { ConnectionState } from '$lib/live.svelte.js'
	import { formatRelative } from '$lib/format.js'

	interface Props {
		connection: ConnectionState
		/** The `ts` of the newest sample being displayed — the age of the DATA,
		 *  not of the connection. Null when no sample has ever landed. */
		sampleTs?: string | null
		/** The live store's self-advancing clock. Passed in rather than read as
		 *  `Date.now()`: a bare Date.now() inside `$derived` is not a reactive
		 *  dependency, so the freshness below would be computed once and then held
		 *  forever — the indicator would say Live over an hour-old reading, which
		 *  is the one thing it exists to prevent. */
		clock: number
	}

	let { connection, sampleTs = null, clock }: Props = $props()

	/**
	 * How recently the car must have reported for "Live" to be true.
	 *
	 * Comfortably past the ingest pipeline's own ceiling — it emits a sample at
	 * least every 30s while a car is reporting at all — so a driving or charging
	 * car reads as live continuously, and a car that has genuinely stopped
	 * reporting stops claiming to be.
	 */
	const FRESH_MS = 90_000

	let sampleAt = $derived(sampleTs === null ? null : Date.parse(sampleTs))
	let fresh = $derived(sampleAt !== null && Number.isFinite(sampleAt) && clock - sampleAt < FRESH_MS)

	/**
	 * Two independent things can be wrong and this must not conflate them: the
	 * stream can be down (a fault), or the car can simply be quiet (normal for a
	 * parked car). 'down' wins when both are true, because a reconnecting stream
	 * cannot know whether the car is reporting.
	 */
	let state = $derived(connection !== 'open' ? 'down' : fresh ? 'live' : 'quiet')
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
	{:else if sampleTs !== null}
		Last update {formatRelative(sampleTs)}
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
