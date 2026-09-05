<script lang="ts">
	interface Props {
		from?: string | null
		to?: string | null
		/** Where "Clear" goes. Passed in because `location` does not exist during
		 *  server-side rendering, and reading it there throws. */
		basePath: string
	}

	let { from = null, to = null, basePath }: Props = $props()

	// A plain GET form: the filter lives in the URL, so a filtered list is
	// linkable and survives a reload, and it works with JavaScript disabled.
	//
	// Both inputs submit on every Apply, so a page reached by pressing Apply
	// with nothing picked has `?from=&to=` and the loads hand us '' rather than
	// null. Testing `!= null` alone therefore offered "Clear" on an unfiltered
	// list — a control that does nothing, which reads as a filter silently
	// stuck on. Empty is unfiltered.
	let active = $derived((from ?? '') !== '' || (to ?? '') !== '')
</script>

<form method="GET" class="filter">
	<label>
		<span class="eyebrow">From</span>
		<input type="date" name="from" value={from ?? ''} />
	</label>
	<label>
		<span class="eyebrow">To</span>
		<input type="date" name="to" value={to ?? ''} />
	</label>
	<button type="submit">Apply</button>
	{#if active}
		<a class="link clear" href={basePath}>Clear</a>
	{/if}
</form>

<style>
	.filter {
		display: flex;
		align-items: flex-end;
		gap: 10px;
		flex-wrap: wrap;
	}

	label {
		display: grid;
		gap: 3px;
	}

	input {
		font: inherit;
		font-size: 0.85rem;
		padding: 5px 9px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border-strong);
		background: var(--surface);
		color: var(--text);
		color-scheme: inherit;
	}

	button {
		border: 1px solid var(--border-strong);
		background: var(--surface);
		border-radius: var(--radius-sm);
		padding: 6px 14px;
		font-size: 0.85rem;
		cursor: pointer;
	}

	button:hover {
		border-color: var(--accent);
		color: var(--accent-text);
	}

	.clear {
		padding-bottom: 7px;
	}
</style>
