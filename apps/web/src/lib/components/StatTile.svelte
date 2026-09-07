<script lang="ts">
	interface Props {
		label: string
		/** Already formatted by $lib/format — tiles never round or dash-check. */
		value: string
		hint?: string | null
		/**
		 * Hovered, for a value that is not what it appears to be — an estimate
		 * rather than a measurement. Null on every ordinary tile, so a tooltip
		 * anywhere on this page means something.
		 */
		title?: string | null
		tone?: 'default' | 'accent' | 'charging' | 'driving'
	}

	let { label, value, hint = null, title = null, tone = 'default' }: Props = $props()
</script>

<div class="tile {tone}" {title}>
	<div class="label">{label}</div>
	<div class="value num">{value}</div>
	{#if hint}<div class="hint">{hint}</div>{/if}
</div>

<style>
	.tile {
		padding: 12px 14px;
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		border: 1px solid var(--border);
		min-width: 0;
	}

	.label {
		font-size: 0.72rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.value {
		margin-top: 3px;
		font-size: 1.15rem;
		font-weight: 620;
		letter-spacing: -0.02em;
		/* A tile is 140px of content box and some values are single unbroken
		   tokens far wider than that - a Tesla enum name overflowed by 33px
		   before the labels were shortened. `anywhere` rather than `break-word`
		   so a long token also stops the tile itself from widening the grid. */
		overflow-wrap: anywhere;
	}

	.hint {
		font-size: 0.75rem;
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}

	.accent .value {
		color: var(--accent-text);
	}
	.charging .value {
		color: var(--charging);
	}
	.driving .value {
		color: var(--driving);
	}
</style>
