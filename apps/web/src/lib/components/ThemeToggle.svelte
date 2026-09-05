<script lang="ts">
	import { onMount } from 'svelte'

	type Theme = 'light' | 'dark' | 'system'

	// Starts at 'system' on the server, where there is no viewer to ask. The
	// inline script in app.html has already applied any saved choice to <html>,
	// so this only has to catch up with it after hydration.
	let theme = $state<Theme>('system')

	onMount(() => {
		try {
			const saved = localStorage.getItem('ev-theme')
			if (saved === 'light' || saved === 'dark') theme = saved
		} catch {
			// Site data blocked: the toggle still works for this page view.
		}
	})

	const OPTIONS: { id: Theme; glyph: string; label: string }[] = [
		{ id: 'light', glyph: '☀', label: 'Light' },
		{ id: 'dark', glyph: '☾', label: 'Dark' },
		{ id: 'system', glyph: '◐', label: 'System' }
	]

	function apply(next: Theme) {
		theme = next
		const root = document.documentElement
		if (next === 'system') {
			delete root.dataset.theme
		} else {
			root.dataset.theme = next
		}
		try {
			if (next === 'system') localStorage.removeItem('ev-theme')
			else localStorage.setItem('ev-theme', next)
		} catch {
			// Non-fatal: the choice simply does not survive a reload.
		}
	}
</script>

<div class="toggle" role="group" aria-label="Colour theme">
	{#each OPTIONS as option (option.id)}
		<button
			type="button"
			class:active={theme === option.id}
			aria-pressed={theme === option.id}
			title={option.label}
			onclick={() => apply(option.id)}
		>
			<span aria-hidden="true">{option.glyph}</span>
			<span class="sr">{option.label}</span>
		</button>
	{/each}
</div>

<style>
	.toggle {
		display: inline-flex;
		border: 1px solid var(--border);
		background: var(--surface-2);
		border-radius: 999px;
		padding: 2px;
	}

	button {
		border: 0;
		background: none;
		border-radius: 999px;
		padding: 3px 9px;
		cursor: pointer;
		color: var(--text-faint);
		line-height: 1.3;
	}

	button:hover {
		color: var(--text);
	}

	.active {
		background: var(--surface);
		color: var(--text);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
	}

	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
