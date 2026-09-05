<script lang="ts">
	import { page } from '$app/state'

	// Kit's error page. The API's messages are deliberately specific
	// ('no samples for vehicle' is an ingestion problem, 'vehicle not found' is
	// a bad URL), so it shows the message rather than replacing it with "Oops".
	let status = $derived(page.status)
	let message = $derived(page.error?.message ?? 'Something went wrong')
</script>

<div class="page">
	<div class="card box">
		<p class="code num">{status}</p>
		<h1>{message}</h1>
		{#if status === 404}
			<p class="muted">That page does not exist, or the vehicle id in the URL is not one this
				server knows about.</p>
		{:else if status === 401 || status === 403}
			<p class="muted">Your session is not valid. Reload the page to sign in again.</p>
		{:else}
			<p class="muted">The database may be unavailable. Readiness is reported at /healthz/ready.</p>
		{/if}
		<a class="link" href="/">← Back to the garage</a>
	</div>
</div>

<style>
	.box {
		padding: 40px;
		display: grid;
		gap: 8px;
		justify-items: start;
		max-width: 560px;
	}

	.code {
		margin: 0;
		font-size: 0.8rem;
		font-weight: 700;
		letter-spacing: 0.1em;
		color: var(--text-faint);
	}

	p {
		margin: 0;
	}

	a {
		margin-top: 10px;
	}
</style>
