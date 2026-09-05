<script lang="ts">
	import type { Snippet } from 'svelte'
	import type { LayoutData } from './$types.js'
	import { page } from '$app/state'
	import ActivityPill from '$lib/components/ActivityPill.svelte'
	import { DASH } from '$lib/format.js'

	let { data, children }: { data: LayoutData; children: Snippet } = $props()

	let v = $derived(data.entry.vehicle)
	let base = $derived(`/vehicles/${v.id}`)

	let tabs = $derived([
		{ href: base, label: 'Overview' },
		{ href: `${base}/drives`, label: 'Drives' },
		{ href: `${base}/charges`, label: 'Charges' },
		{ href: `${base}/battery`, label: 'Battery' }
	])

	let subtitle = $derived(
		[v.modelYear != null ? String(v.modelYear) : null, v.model].filter(Boolean).join(' ') || DASH
	)
</script>

<svelte:head>
	<title>{v.displayName} · EV</title>
</svelte:head>

<div class="page">
	<div class="head">
		<div class="ident">
			<a class="back link" href="/">← Garage</a>
			<h1>{v.displayName}</h1>
			<p class="muted">
				{subtitle} <span class="sep">·</span>
				<span class="vin num" title="Vendor vehicle identifier">{v.vendorVehicleId}</span>
			</p>
		</div>
		<ActivityPill activity={data.entry.activity} openSessionId={data.entry.openSessionId} />
	</div>

	<nav class="tabs">
		{#each tabs as tab (tab.href)}
			<a href={tab.href} class:active={page.url.pathname === tab.href}>{tab.label}</a>
		{/each}
	</nav>

	{@render children()}
</div>

<style>
	.head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
	}

	.back {
		display: inline-block;
		margin-bottom: 6px;
	}

	.ident p {
		margin: 4px 0 0;
		font-size: 0.86rem;
	}

	.sep {
		color: var(--text-faint);
		margin: 0 4px;
	}

	.vin {
		font-family: var(--font-mono);
		font-size: 0.8rem;
	}

	.tabs {
		display: flex;
		gap: 2px;
		margin: 18px 0 22px;
		border-bottom: 1px solid var(--border);
	}

	.tabs a {
		padding: 8px 14px;
		font-size: 0.88rem;
		color: var(--text-muted);
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
	}

	.tabs a:hover {
		color: var(--text);
	}

	.tabs a.active {
		color: var(--text);
		border-bottom-color: var(--accent);
		font-weight: 560;
	}
</style>
