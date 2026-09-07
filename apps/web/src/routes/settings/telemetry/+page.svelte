<script lang="ts">
	import type { PageData } from './$types.js'
	import { errorMessageFrom } from '$lib/api-error.js'
	import EmptyState from '$lib/components/EmptyState.svelte'
	import StatTile from '$lib/components/StatTile.svelte'
	import TelemetryOutcome from '$lib/components/TelemetryOutcome.svelte'
	import {
		DASH,
		formatDateTime,
		formatNumber,
		formatOnOff,
		formatRelative,
		formatText
	} from '$lib/format.js'
	import type {
		TelemetryCheckResult,
		TelemetryPushResult,
		TelemetryStatusDto
	} from '$lib/telemetry-types.js'

	let { data }: { data: PageData } = $props()

	/**
	 * Operations, not driving (§3.8). The question this page answers is whether
	 * the car has applied the telemetry configuration the catalogue defines, and
	 * it has to answer it in three states that all occur: no row has ever been
	 * written, a row written days ago with nobody consented to Tesla, and a live
	 * session. Only the third can act; the first two still have to be readable,
	 * because they are what an operator sees almost every time.
	 *
	 * Null is not false anywhere below. A row created by a push alone has never
	 * been checked, so `synced` is null — "the car says no" and "nobody has
	 * asked" call for different actions, and every tile renders the second as a
	 * dash rather than as a negative answer.
	 */

	/**
	 * What a check or a push last answered, or null before either has run.
	 *
	 * Held rather than derived so the panel survives without a reload, and
	 * seeded from nothing rather than from `data`: the load's row is the CACHED
	 * answer and this is the LIVE one, and collapsing them would make a page
	 * that has just been reloaded look like it had just been checked.
	 */
	let live = $state<TelemetryStatusDto | null>(null)
	let outcome = $state<Outcome | null>(null)
	let busy = $state<'check' | 'push' | null>(null)

	/** Advanced when an action answers, so "just now" is true when it says so. */
	let clockOverride = $state<number | null>(null)

	interface Outcome {
		ok: boolean
		headline: string
		detail: string | null
		blockers: string[]
		warnings: string[]
		differences: string[]
	}

	let vehicle = $derived(data.vehicle)
	let status = $derived(live ?? data.status)
	let clock = $derived(new Date(clockOverride ?? Date.parse(data.now)))

	/** An instant as its age, which is the only thing that makes it useful. */
	function age(iso: string | null | undefined): string {
		return iso ? formatRelative(iso, clock) : 'Never'
	}

	let connected = $derived(data.tesla.connected)
	let canCheck = $derived(connected && busy === null)
	// Nothing to push to, and — more to the point — no VIN to name in the
	// confirmation, which is the safety device this button is behind.
	let canPush = $derived(connected && vehicle !== null && busy === null)

	const CHECK_PROMPT = 'Ask the car what telemetry configuration it has applied. Nothing is changed.'

	/**
	 * The sentence the browser asks before anything is sent, rendered as the
	 * button's title as well.
	 *
	 * Naming the VIN is the point (§3.8): this reconfigures a physical car, and
	 * the failure it guards against is a mis-click, not an attack. Being able to
	 * read it before pressing is worth as much as being asked afterwards — and
	 * it is what makes the wording assertable in a test at all, since a
	 * `confirm()` dialog is invisible to a server render.
	 */
	let pushPrompt = $derived(
		vehicle
			? `Push the telemetry configuration to VIN ${vehicle.vin} (${vehicle.displayName}). ` +
				'This reconfigures a physical car.'
			: 'No vehicle is registered, so there is nothing to push to.'
	)

	/**
	 * The applied field count against the catalogue's, without any Tesla session.
	 *
	 * The count is all the cached row holds — WHICH fields differ needs the
	 * applied configuration itself, which only a live check has. So the count is
	 * the standing answer and the list below it appears once a check has run.
	 */
	let fieldGap = $derived(
		status?.fieldCount != null && status.fieldCount !== data.catalogue.fieldCount
	)

	/** Hand the consent back now rather than waiting for it to run out. */
	async function disconnect() {
		if (busy !== null) return
		busy = 'check'
		try {
			await fetch('/api/v1/telemetry/disconnect', { method: 'POST' })
			// A reload rather than local state: the connection banner, both
			// buttons and the expiry all read from the load, and re-deriving them
			// by hand here is how two sources of truth start.
			location.reload()
		} finally {
			busy = null
		}
	}

	async function act(kind: 'check' | 'push') {
		if (busy !== null) return
		// The API refuses independently of this (§5) — the button being enabled is
		// never the check — but asking Tesla for something we know it cannot do is
		// a slower way to say the same thing.
		if (kind === 'check' ? !canCheck : !canPush) return
		if (kind === 'push' && !globalThis.confirm(pushPrompt)) return

		busy = kind
		outcome = null
		try {
			const res = await fetch(`/api/v1/telemetry/${kind}`, { method: 'POST' })
			if (!res.ok) {
				// Read as TEXT, not JSON. These endpoints answer errors with
				// `content-type: text/plain` and the bare sentence, so the previous
				// `res.json()` threw on every failure and threw away the message with
				// it - including Tesla's own account of what it refused. See
				// `errorMessageFrom`, which handles both shapes and refuses to put a
				// gateway's HTML on the screen.
				outcome = {
					ok: false,
					headline: errorMessageFrom(
						res.status,
						res.headers.get('content-type'),
						await res.text().catch(() => '')
					),
					detail: null,
					blockers: [],
					warnings: [],
					differences: []
				}
				return
			}
			const body: unknown = await res.json()
			clockOverride = Date.now()
			if (kind === 'check') applyCheck(body as TelemetryCheckResult)
			else applyPush(body as TelemetryPushResult)
		} catch (e) {
			outcome = {
				ok: false,
				headline: e instanceof Error ? e.message : 'the request could not be sent',
				detail: null,
				blockers: [],
				warnings: [],
				differences: []
			}
		} finally {
			busy = null
		}
	}

	function applyCheck(result: TelemetryCheckResult) {
		live = result.status
		outcome = {
			ok: true,
			headline: result.matches
				? 'The car has exactly the configuration the catalogue defines.'
				: 'The car does not have the configuration the catalogue defines.',
			// `synced: false` right after a push is the NORMAL case, not a fault:
			// the car applies on its next check-in, which can be hours (§5). Saying
			// so here is what stops it being read as a failed push.
			detail:
				result.status.synced === true
					? null
					: 'The car reports the configuration as not yet applied. It applies on its next ' +
						'check-in, which can take hours — the push time above is how long it has been.',
			blockers: result.blockers,
			warnings: result.warnings,
			differences: result.differences
		}
	}

	function applyPush(result: TelemetryPushResult) {
		// The already-applied path writes nothing at all, so it hands back no row
		// and the cached one stays on screen rather than being blanked.
		if (result.status) live = result.status
		outcome = {
			ok: true,
			headline: result.alreadyApplied
				? 'Already applied — nothing was sent to the car.'
				: `Configuration sent to VIN ${result.vin}: ${result.desiredFieldCount} fields.`,
			// The list under a PUSH is what this push changed, not what is still
			// wrong — the same sentences, describing the car a moment ago. Saying so
			// is the difference between a record of the change and a fresh complaint.
			detail: result.alreadyApplied
				? null
				: 'The differences below are what this push changed. The car applies them on its ' +
					'next check-in, so "applied" can stay no for hours — check again later rather ' +
					'than pushing again.',
			blockers: [],
			warnings: result.warnings,
			differences: result.differences
		}
	}
</script>

<svelte:head><title>Telemetry · Coulomb</title></svelte:head>

<header class="page-head">
	<a class="back link" href="/">← Garage</a>
	<h1>Telemetry configuration</h1>
	<p class="muted">
		What the car has been told to stream, and whether it has applied it. This is the same check
		and the same push the break-glass scripts perform, against the same field catalogue.
	</p>
	{#if vehicle}
		<p class="ident muted">
			{vehicle.displayName}
			<span class="sep">·</span>
			<span class="vin num">{vehicle.vin}</span>
		</p>
	{/if}
</header>

<section>
	<div class="section-title">
		<h2>What the car has applied</h2>
		{#if status?.checkedAt}
			<span class="faint">checked {age(status.checkedAt)}</span>
		{/if}
	</div>

	{#if !vehicle}
		<!-- The day-one state of the whole install: the ingest worker registers the
		     vehicle it is configured for, and nothing else creates a vehicle row. -->
		<EmptyState
			title="No vehicle is registered yet"
			icon="⬡"
			detail="The ingest worker registers the car it is configured for. Until it has, there is
			no VIN to check and nothing to push a configuration to."
		/>
	{:else if !status}
		<!-- A third state, not a negative answer: nobody has ever asked the car. -->
		<EmptyState
			title="Never checked"
			icon="◍"
			detail="Nothing has ever asked this car what telemetry configuration it has applied.
			Connect to Tesla below and check — the answer is cached, so the page can show it
			afterwards without a connection."
		/>
	{:else}
		<div class="card pad">
			<div class="tiles">
				<StatTile
					label="Applied"
					value={formatOnOff(status.synced, 'Yes', 'Not yet')}
					hint={status.synced === false ? 'the car applies on its next check-in' : null}
					tone={status.synced === true ? 'accent' : 'default'}
				/>
				<StatTile
					label="Fields applied"
					value={status.fieldCount == null ? DASH : formatNumber(status.fieldCount, 0)}
					hint="of {data.catalogue.fieldCount} in the catalogue"
				/>
				<StatTile
					label="Certificate"
					value={formatOnOff(status.caPresent, 'Present', 'Missing')}
					hint="the CA the car pins"
				/>
				<StatTile
					label="Last checked"
					value={age(status.checkedAt)}
					hint={status.checkedAt ? formatDateTime(status.checkedAt) : 'no check has ever run'}
				/>
				<StatTile
					label="Last pushed"
					value={age(status.pushedAt)}
					hint={status.pushedAt ? formatDateTime(status.pushedAt) : 'no push from here'}
				/>
			</div>

			{#if fieldGap}
				<p class="gap">
					The car has {formatNumber(status.fieldCount, 0)} fields applied and the catalogue
					defines {data.catalogue.fieldCount}. Pushing brings it to the catalogue.
				</p>
			{/if}
		</div>
	{/if}
</section>

<section>
	<div class="section-title">
		<h2>Preflight</h2>
		<span class="faint">as of the last check</span>
	</div>
	<div class="card pad">
		<div class="tiles">
			<StatTile
				label="Firmware"
				value={formatText(status?.firmware)}
				hint="2024.26 or newer applies a configuration"
			/>
			<StatTile
				label="Virtual key"
				value={formatOnOff(status?.keyPaired, 'Paired', 'Not paired')}
				hint="an unpaired car accepts a configuration and applies none of it"
			/>
			<StatTile
				label="Data streaming toggle"
				value={formatOnOff(status?.streamingEnabled, 'Enabled', 'Disabled')}
				hint="the owner's own consent, on the car's screen"
			/>
		</div>
		<p class="faint note">
			Tesla accepts a configuration a car cannot apply, reports no error, and leaves it unapplied
			indefinitely — which looks exactly like a sleeping car. So a push refuses on an unpaired
			virtual key or firmware below the floor rather than sending anything, and a disabled
			streaming toggle is reported as a warning.
		</p>
	</div>
</section>

<section>
	<div class="section-title">
		<h2>Tesla connection</h2>
		<span class="faint">{connected ? 'Connected' : 'Not connected'}</span>
	</div>
	<div class="card pad">
		<p class="conn">
			{#if connected && data.tesla.expiresAt}
				Connected. The consent expires {formatRelative(data.tesla.expiresAt, clock)}
				<span class="faint">({formatDateTime(data.tesla.expiresAt)})</span>. There is no renewal:
				when it runs out, or when this pod restarts, connect again.
			{:else}
				Not connected. The Tesla credential is held in this process only and is gone on every
				deploy, so checking or pushing starts with a consent. It authorises this app to reach
				the car; it is not a way into this app.
			{/if}
		</p>

		<div class="actions">
			<button type="button" title={CHECK_PROMPT} onclick={() => act('check')} disabled={!canCheck}>
				Check now
			</button>
			<button
				type="button"
				class="push"
				title={pushPrompt}
				onclick={() => act('push')}
				disabled={!canPush}
			>
				Push configuration
			</button>
			<a class="connect" href="/settings/telemetry/connect">
				{connected ? 'Reconnect to Tesla' : 'Connect to Tesla'}
			</a>
			{#if connected}
				<!-- The design says the credential dies on expiry, on disconnect, or
				     on a restart. Without this the earliest of those was eight hours
				     away, which made "disconnect" a sentence rather than a thing. -->
				<button class="link" onclick={disconnect} disabled={busy !== null}>Disconnect</button>
			{/if}
			{#if busy}<span class="faint">working…</span>{/if}
		</div>

		{#if outcome}
			<TelemetryOutcome {...outcome} />
		{/if}
	</div>
</section>

<section>
	<div class="section-title">
		<h2>What a push would send</h2>
		<span class="faint num">{data.catalogue.hostname}:{data.catalogue.port}</span>
	</div>
	<div class="card pad">
		<div class="tiles">
			<StatTile
				label="Fields in the catalogue"
				value={formatNumber(data.catalogue.fieldCount, 0)}
				hint="the field set this build would push"
				tone="accent"
			/>
			<StatTile label="Endpoint" value={data.catalogue.hostname} hint="port {data.catalogue.port}" />
		</div>
		<p class="faint note">
			The field set is code with tests behind it, shared with the break-glass scripts so the two
			cannot push different configurations. It is not editable from here: this page pushes what
			the catalogue says.
		</p>
	</div>
</section>

<p class="faint note">
	<!-- The way in to the rates page. The vehicle tab bar is pinned to five
	     entries and a sixth would push settings that most visits never open into
	     the same rank as Drives and Charges, so settings reach each other from
	     here instead. -->
	What a home charge costs per kWh is configured separately:
	<a class="link" href="/settings/energy">Energy rates</a>.
</p>

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

	.ident {
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

	.gap {
		margin: 14px 0 0;
		font-size: 0.86rem;
	}

	.note {
		margin: 14px 0 0;
		font-size: 0.78rem;
		max-width: 78ch;
	}

	.conn {
		margin: 0 0 14px;
		font-size: 0.9rem;
		max-width: 78ch;
	}

	.actions {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 10px;
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

	/* The one button that changes a physical car reads as one. */
	.push:not(:disabled) {
		border-color: var(--danger);
		color: var(--danger);
	}

	.connect {
		color: var(--accent-text);
		font-weight: 550;
		font-size: 0.88rem;
	}

	.connect:hover {
		text-decoration: underline;
	}
</style>
