<script lang="ts">
	import { untrack } from 'svelte'
	import type { PageData } from './$types.js'
	import { errorMessageFrom } from '$lib/api-error.js'
	import EmptyState from '$lib/components/EmptyState.svelte'
	import StatTile from '$lib/components/StatTile.svelte'
	import { DASH, formatDate, formatDateTime, formatRelative } from '$lib/format.js'

	let { data }: { data: PageData } = $props()

	/**
	 * The tariff a home charge is priced at, and the history behind it (§4).
	 *
	 * The page exists because a price on a charge is only trustworthy if the
	 * number behind it is visible. A charge closed in January was priced at
	 * January's rate and keeps that figure forever, so "what does electricity
	 * cost" is a question with as many answers as there are rows here — and the
	 * history is what makes an old figure legible rather than looking stale.
	 *
	 * NOTHING ON THIS PAGE EDITS OR DELETES A ROW. A rate is what a charge was
	 * actually billed at; correcting it means adding a newer row, which leaves
	 * the old price sitting next to the charges it explains. An edit would
	 * silently re-price closed history and leave nothing behind to notice.
	 */

	let submitting = $state(false)
	let failure = $state<string | null>(null)

	let clock = $derived(new Date(Date.parse(data.now)))
	let current = $derived(data.current)

	/**
	 * The form's fields, seeded from what is already in effect.
	 *
	 * The currency is copied from the current rate rather than hard-coded: this
	 * app stores a currency per row precisely so a tariff change abroad is not a
	 * global relabelling, and typing it again every time is how a mismatched
	 * code gets in.
	 */
	let price = $state('')
	// `untrack` because these are SEEDS, not mirrors. Reading a prop inside a
	// `$state` initialiser otherwise warns that only the initial value is
	// captured — which is exactly what is wanted here: a half-typed currency
	// must not be overwritten if the load re-runs underneath it.
	let currency = $state(untrack(() => data.current?.currency ?? 'USD'))
	let effectiveFrom = $state(untrack(() => today()))

	/** Today as `YYYY-MM-DD` in UTC, which is how the server reads a bare date. */
	function today(): string {
		return new Date(Date.parse(data.now)).toISOString().slice(0, 10)
	}

	/**
	 * A per-kWh price, at the precision a tariff is actually quoted in.
	 *
	 * `Intl` defaults a currency to two fraction digits, which renders a
	 * 19.9¢ rate as $0.20 — a number that is wrong by half a cent on every
	 * charge and looks deliberate. Three to five digits keeps 0.199 and 0.11234
	 * both readable without padding a round figure with zeros.
	 */
	function formatRate(value: number | null | undefined, code: string | null): string {
		if (value == null || !Number.isFinite(value) || !code) return DASH
		try {
			return new Intl.NumberFormat('en-GB', {
				style: 'currency',
				currency: code,
				minimumFractionDigits: 3,
				maximumFractionDigits: 5
			}).format(value)
		} catch {
			// An unrecognised code must not take the page down with it.
			return `${value.toFixed(3)} ${code}`
		}
	}

	/** Where a row came from, in words. 'urdb' means nothing to a reader. */
	function sourceLabel(source: string): string {
		if (source === 'manual') return 'Entered here'
		if (source === 'urdb') return 'Fetched from URDB'
		return source
	}

	async function add(event: SubmitEvent) {
		// Not a SvelteKit form action: every mutation in this app is a POST to
		// /api/v1 fetched from the page, so there is one place refusals are
		// worded and one way they reach the screen.
		event.preventDefault()
		if (submitting) return

		submitting = true
		failure = null
		try {
			const res = await fetch('/api/v1/energy-rates', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ pricePerKwh: price, currency, effectiveFrom })
			})
			if (!res.ok) {
				// Read as TEXT, never `res.json()`. These endpoints answer a refusal
				// with `content-type: text/plain` and the bare sentence — which names
				// the field that was wrong — and a JSON parse would throw that away
				// and leave "the request failed (400)" on screen.
				failure = errorMessageFrom(
					res.status,
					res.headers.get('content-type'),
					await res.text().catch(() => '')
				)
				return
			}
			// A reload rather than splicing the new row in: the current rate, the
			// history and the form's own seed all come from the load, and
			// re-deriving them here is how two sources of truth start.
			location.reload()
		} catch (e) {
			failure = e instanceof Error ? e.message : 'the request could not be sent'
		} finally {
			submitting = false
		}
	}
</script>

<svelte:head><title>Energy rates · Coulomb</title></svelte:head>

<header class="page-head">
	<a class="back link" href="/settings/telemetry">← Telemetry</a>
	<h1>Energy rates</h1>
	<p class="muted">
		What a kilowatt-hour costs at home. A charge is priced at the rate in effect when it started
		and keeps that figure, so this is a history rather than a setting — adding a rate changes
		what future charges cost, and never what a closed one did.
	</p>
</header>

<section>
	<div class="section-title">
		<h2>In effect now</h2>
		{#if current}
			<span class="faint">since {formatRelative(current.effectiveFrom, clock)}</span>
		{/if}
	</div>

	{#if !current}
		<!-- The day-one state, and a real one: without a rate a home charge is
		     recorded and left unpriced, which the charges page says in words
		     rather than rendering as free. -->
		<EmptyState
			title="No rate is in effect"
			icon="◍"
			detail="Home charges are being recorded and left unpriced until there is a rate covering
			the day they started. Add one below, or wait for the daily fetch to find one."
		/>
	{:else}
		<div class="card pad">
			<div class="tiles">
				<StatTile
					label="Price per kWh"
					value={formatRate(current.pricePerKwh, current.currency)}
					hint="the energy charge only — not the basic charge, riders or taxes"
					tone="accent"
				/>
				<StatTile
					label="In effect from"
					value={formatDate(current.effectiveFrom)}
					hint={formatDateTime(current.effectiveFrom)}
				/>
				<StatTile
					label="Source"
					value={sourceLabel(current.source)}
					hint={current.urdbLabel ?? 'typed on this page'}
				/>
				<StatTile
					label="Recorded"
					value={formatRelative(current.fetchedAt, clock)}
					hint={formatDateTime(current.fetchedAt)}
				/>
			</div>
		</div>
	{/if}
</section>

<section>
	<div class="section-title">
		<h2>Add a rate</h2>
		<span class="faint">appends; nothing is replaced</span>
	</div>
	<div class="card pad">
		<form onsubmit={add}>
			<div class="fields">
				<label>
					<span>Price per kWh</span>
					<input
						class="num"
						name="pricePerKwh"
						inputmode="decimal"
						placeholder="0.199"
						bind:value={price}
					/>
				</label>
				<label>
					<span>Currency</span>
					<input class="num code" name="currency" maxlength="3" bind:value={currency} />
				</label>
				<label>
					<span>In effect from</span>
					<input class="num" name="effectiveFrom" type="date" bind:value={effectiveFrom} />
				</label>
				<button type="submit" disabled={submitting}>
					{submitting ? 'Adding…' : 'Add rate'}
				</button>
			</div>
		</form>

		{#if failure}
			<p class="failure" role="alert">{failure}</p>
		{/if}

		<p class="faint note">
			The date is the day the tariff took effect, not today — a rate typed in late still prices
			the charges it should, because a charge is priced by its own start time. Charges that
			have already closed keep the figure they were priced at; a new row does not reach back.
		</p>
	</div>
</section>

<section>
	<div class="section-title">
		<h2>History</h2>
		<span class="faint">newest first</span>
	</div>
	<div class="card">
		{#if data.history.length === 0}
			<div class="pad">
				<EmptyState
					title="No rates recorded"
					icon="⬡"
					detail="Nothing has been typed here and the daily fetch has not found a rate yet."
				/>
			</div>
		{:else}
			<div class="wrap">
				<table>
					<thead>
						<tr>
							<th scope="col">In effect from</th>
							<th scope="col" class="r">Price per kWh</th>
							<th scope="col">Source</th>
							<th scope="col" class="hide-sm">Recorded</th>
						</tr>
					</thead>
					<tbody>
						{#each data.history as rate (rate.effectiveFrom + rate.source)}
							<tr class:in-effect={current?.effectiveFrom === rate.effectiveFrom &&
								current?.source === rate.source}>
								<th scope="row">
									{formatDate(rate.effectiveFrom)}
									{#if Date.parse(rate.effectiveFrom) > clock.getTime()}
										<!-- A future row is in the history and is not in effect. Saying
										     so is the difference between a scheduled change and a bug. -->
										<span class="tag">scheduled</span>
									{/if}
								</th>
								<td class="r num">{formatRate(rate.pricePerKwh, rate.currency)}</td>
								<td>
									{sourceLabel(rate.source)}
									{#if rate.urdbLabel}<span class="faint label">{rate.urdbLabel}</span>{/if}
								</td>
								<td class="hide-sm faint">{formatDateTime(rate.fetchedAt)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</section>

<style>
	.page-head {
		margin-bottom: 1.5rem;
	}

	.back {
		display: inline-block;
		margin-bottom: 6px;
	}

	.page-head p {
		margin: 6px 0 0;
		max-width: 72ch;
	}

	section {
		margin-bottom: 26px;
	}

	.pad {
		padding: 16px;
	}

	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 10px;
	}

	.fields {
		display: flex;
		align-items: flex-end;
		flex-wrap: wrap;
		gap: 12px;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	label span {
		font-size: 0.72rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-faint);
	}

	input {
		padding: 8px 10px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border-strong);
		background: var(--surface-2);
		color: inherit;
		font-size: 0.88rem;
		width: 10rem;
	}

	input:focus {
		outline: none;
		border-color: var(--accent);
	}

	.code {
		width: 5rem;
		text-transform: uppercase;
	}

	button {
		padding: 8px 14px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border-strong);
		background: var(--surface-2);
		font-size: 0.88rem;
		font-weight: 550;
		cursor: pointer;
	}

	button:hover:not(:disabled) {
		border-color: var(--accent);
		color: var(--accent-text);
	}

	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.failure {
		margin: 14px 0 0;
		font-size: 0.86rem;
		color: var(--danger);
		max-width: 78ch;
	}

	.note {
		margin: 14px 0 0;
		font-size: 0.78rem;
		max-width: 78ch;
	}

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

	tbody th {
		font-weight: 550;
	}

	tbody tr.in-effect th {
		color: var(--accent-text);
	}

	.r {
		text-align: right;
	}

	.tag {
		margin-left: 7px;
		font-size: 0.66rem;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		font-weight: 700;
		color: var(--text-muted);
		background: var(--offline-soft);
		border-radius: 999px;
		padding: 1px 7px;
	}

	.label {
		margin-left: 7px;
		font-size: 0.78rem;
	}

	/* The recorded-at column is the least useful one on a phone: it answers
	   "when did we learn this", where the other three answer what the rate is. */
	@media (max-width: 720px) {
		.hide-sm {
			display: none;
		}
	}
</style>
