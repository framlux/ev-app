<script lang="ts">
	import favicon from '$lib/assets/favicon.svg'
	import BrandMark from '$lib/components/BrandMark.svelte'
	import ThemeToggle from '$lib/components/ThemeToggle.svelte'
	import '../app.css'

	let { children } = $props()
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<div class="shell">
	<nav>
		<a class="brand" href="/">
			<BrandMark size={22} />
			<span class="wordmark">Coulomb</span>
		</a>
		<div class="spacer"></div>
		<!-- The one operational page on a site that is otherwise about driving.
		     It belongs in the header rather than on a vehicle page because it is
		     about this install's plumbing, not about the car (spec §3.8). -->
		<a class="navlink" href="/settings/telemetry">Telemetry</a>
		<ThemeToggle />
	</nav>

	<main>
		{@render children()}
	</main>
</div>

<style>
	.shell {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
	}

	nav {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.85rem 1.25rem;
		border-bottom: 1px solid var(--border);
		background: var(--surface);
	}

	.brand {
		display: inline-flex;
		align-items: center;
		gap: 0.55rem;
		color: var(--text);
		text-decoration: none;
	}

	.wordmark {
		font-family: var(--font-display);
		font-size: 1.06rem;
		font-weight: 600;
		letter-spacing: -0.015em;
	}

	.spacer {
		flex: 1;
	}

	.navlink {
		font-size: 0.86rem;
		color: var(--text-muted);
	}

	.navlink:hover {
		color: var(--text);
	}

	main {
		flex: 1;
		width: 100%;
		max-width: 72rem;
		margin: 0 auto;
		padding: 1.5rem 1.25rem 3rem;
	}
</style>
