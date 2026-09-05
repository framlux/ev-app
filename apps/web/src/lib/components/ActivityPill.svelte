<script lang="ts">
	import type { VehicleActivity } from '$lib/api-types.js'

	interface Props {
		activity: VehicleActivity
		/** Set only for 'driving' and 'charging'; makes the pill a deep link. */
		openSessionId?: string | null
		compact?: boolean
	}

	let { activity, openSessionId = null, compact = false }: Props = $props()

	// State is encoded in colour AND shape AND word (plan Task 15 Step 1: a
	// status pill, not just a word) so the garage is scannable without reading.
	const LABEL: Record<VehicleActivity, string> = {
		driving: 'Driving',
		charging: 'Charging',
		parked: 'Parked',
		asleep: 'Asleep',
		offline: 'Offline',
		// 'unknown' is the day-one state of this whole app: the vehicle row
		// exists because the Fleet API listed it, but no sample has landed.
		unknown: 'No data yet'
	}

	let label = $derived(LABEL[activity] ?? 'Unknown')
	let href = $derived(
		openSessionId && activity === 'driving'
			? `/drives/${openSessionId}`
			: openSessionId && activity === 'charging'
				? `/charges/${openSessionId}`
				: null
	)
</script>

{#snippet body()}
	<span class="dot" class:pulse={activity === 'driving' || activity === 'charging'}></span>
	<span>{label}</span>
{/snippet}

{#if href}
	<a class="pill {activity}" class:compact {href}>{@render body()}</a>
{:else}
	<span class="pill {activity}" class:compact>{@render body()}</span>
{/if}

<style>
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		padding: 4px 11px 4px 9px;
		border-radius: 999px;
		font-size: 0.78rem;
		font-weight: 580;
		letter-spacing: 0.01em;
		white-space: nowrap;
		border: 1px solid transparent;
	}

	.compact {
		font-size: 0.72rem;
		padding: 2px 9px 2px 7px;
	}

	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: currentColor;
		flex: none;
	}

	.pulse {
		animation: pulse 2s ease-in-out infinite;
	}

	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.35;
		}
	}

	a.pill:hover {
		border-color: currentColor;
	}

	.driving {
		color: var(--driving);
		background: var(--driving-soft);
	}
	.charging {
		color: var(--charging);
		background: var(--charging-soft);
	}
	.parked {
		color: var(--accent-text);
		background: var(--accent-soft);
	}
	.asleep {
		color: var(--asleep);
		background: var(--asleep-soft);
	}
	.offline,
	.unknown {
		color: var(--text-muted);
		background: var(--offline-soft);
	}
</style>
