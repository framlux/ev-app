<script lang="ts">
	import { untrack } from 'svelte'
	import type { SessionListItem, SessionListResponse } from '$lib/api-types.js'
	import { qs } from '$lib/api.js'
	import EmptyState from './EmptyState.svelte'
	import SessionList from './SessionList.svelte'

	interface Props {
		vehicleId: string
		kind: 'drive' | 'charge'
		/** First page, rendered server-side so the list is there without JS. */
		initial: SessionListItem[]
		initialCursor: string | null
		from?: string | null
		to?: string | null
		emptyTitle: string
		emptyDetail: string
	}

	let {
		vehicleId,
		kind,
		initial,
		initialCursor,
		from = null,
		to = null,
		emptyTitle,
		emptyDetail
	}: Props = $props()

	const PAGE_SIZE = 50

	// Seeded from the props ONCE and owned locally thereafter — `untrack` says
	// so deliberately, rather than leaving the compiler to warn about it. The
	// pages key this component on the date filter, so a changed filter builds a
	// new component with a new seed instead of mutating this one underneath.
	let sessions = $state<SessionListItem[]>(untrack(() => [...initial]))
	let cursor = $state<string | null>(untrack(() => initialCursor))
	let loading = $state(false)
	let failed = $state<string | null>(null)

	// Note for the caller: a changed date filter must RESET this list rather
	// than append to whatever "load more" had accumulated under the old filter.
	// The pages wrap this component in a {#key} on the filter for that reason —
	// resetting from an effect here would fight the component's own writes.

	async function loadMore() {
		if (loading || cursor == null) return
		loading = true
		failed = null
		try {
			// The cursor is opaque: passed back verbatim, never parsed or built
			// here. nextCursor === null is the only end-of-list signal, because a
			// full page can still be the last one.
			const res = await fetch(
				`/api/v1/vehicles/${encodeURIComponent(vehicleId)}/sessions` +
					qs({ kind, limit: PAGE_SIZE, cursor, from, to })
			)
			if (!res.ok) throw new Error(`request failed (${res.status})`)
			const page = (await res.json()) as SessionListResponse
			sessions = [...sessions, ...page.sessions]
			cursor = page.nextCursor
		} catch (e) {
			failed = e instanceof Error ? e.message : 'could not load more'
		} finally {
			loading = false
		}
	}
</script>

{#if sessions.length === 0}
	<EmptyState title={emptyTitle} detail={emptyDetail} icon="◫" />
{:else}
	<div class="card">
		<SessionList {sessions} mode={kind} />
	</div>

	<div class="foot">
		{#if cursor != null}
			<button type="button" onclick={loadMore} disabled={loading}>
				{loading ? 'Loading…' : 'Load more'}
			</button>
		{:else}
			<span class="faint">End of the record — {sessions.length} shown.</span>
		{/if}
		{#if failed}
			<span class="error">{failed}</span>
		{/if}
	</div>
{/if}

<style>
	.foot {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-top: 14px;
		font-size: 0.83rem;
	}

	button {
		border: 1px solid var(--border-strong);
		background: var(--surface);
		border-radius: 999px;
		padding: 7px 18px;
		cursor: pointer;
		font-size: 0.86rem;
		font-weight: 550;
	}

	button:hover:not(:disabled) {
		border-color: var(--accent);
		color: var(--accent-text);
	}

	button:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.error {
		color: var(--danger);
	}
</style>
