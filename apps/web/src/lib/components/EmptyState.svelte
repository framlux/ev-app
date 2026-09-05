<script lang="ts">
	import type { Snippet } from 'svelte'

	interface Props {
		title: string
		/** Say WHY it is empty and what would fill it. "No data" helps nobody. */
		detail?: string | null
		icon?: string
		children?: Snippet
	}

	let { title, detail = null, icon = '◍', children }: Props = $props()
</script>

<div class="empty">
	<div class="icon" aria-hidden="true">{icon}</div>
	<p class="title">{title}</p>
	{#if detail}<p class="detail">{detail}</p>{/if}
	{#if children}<div class="extra">{@render children()}</div>{/if}
</div>

<style>
	.empty {
		display: grid;
		place-items: center;
		gap: 4px;
		padding: 40px 24px;
		text-align: center;
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
		background: var(--surface-inset);
		color: var(--text-muted);
	}

	.icon {
		font-size: 1.5rem;
		color: var(--text-faint);
		line-height: 1;
		margin-bottom: 4px;
	}

	.title {
		margin: 0;
		font-weight: 600;
		color: var(--text);
	}

	.detail {
		margin: 0;
		max-width: 46ch;
		font-size: 0.88rem;
	}

	.extra {
		margin-top: 10px;
	}
</style>
