<script lang="ts">
	interface Props {
		/** False for a refusal — a preflight blocker, a 409, a dead consent. */
		ok: boolean
		headline: string
		detail?: string | null
		/** Why a push would be refused. Reported by a check, acted on by a push. */
		blockers?: string[]
		warnings?: string[]
		/** §3.8's "a list when they differ": which fields, not merely how many. */
		differences?: string[]
	}

	let { ok, headline, detail = null, blockers = [], warnings = [], differences = [] }: Props =
		$props()

	/**
	 * The answer to the last check or push, as its own component for one reason:
	 * it is the only part of the page that exists solely AFTER a button press,
	 * so as markup inside the page it could never be rendered by a test — and
	 * "which fields differ" is the half of §3.8 that a field COUNT cannot say.
	 *
	 * Empty lists render as nothing rather than as an empty heading: a
	 * "Blockers" heading over no blockers reads as a fault that was found.
	 */
	let lists = $derived(
		[
			['Blockers', blockers],
			['Warnings', warnings],
			['Differences', differences]
		] as const
	)
</script>

<div class="outcome" class:bad={!ok}>
	<p class="headline">{headline}</p>
	{#if detail}<p class="faint detail">{detail}</p>{/if}
	{#each lists as [heading, lines] (heading)}
		{#if lines.length > 0}
			<p class="eyebrow">{heading}</p>
			<ul>
				{#each lines as line, i (i)}<li>{line}</li>{/each}
			</ul>
		{/if}
	{/each}
</div>

<style>
	.outcome {
		margin-top: 14px;
		padding: 12px 14px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border);
		background: var(--surface-inset);
	}

	.outcome.bad {
		border-color: var(--danger);
	}

	.headline {
		margin: 0;
		font-weight: 560;
	}

	.detail {
		margin: 6px 0 0;
		font-size: 0.86rem;
		max-width: 78ch;
	}

	.eyebrow {
		margin: 10px 0 0;
	}

	ul {
		margin: 4px 0 0;
		padding-left: 1.1rem;
		font-size: 0.86rem;
	}
</style>
