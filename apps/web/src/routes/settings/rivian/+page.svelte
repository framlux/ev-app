<script lang="ts">
	// Type-only, so nothing of the database package reaches the browser bundle.
	// It is here so that STATES below is checked against the connector's own list.
	import type { RivianConnectorState } from '@ev/db'
	import type { PageData } from './$types.js'
	import { errorMessageFrom } from '$lib/api-error.js'
	import EmptyState from '$lib/components/EmptyState.svelte'
	import StatTile from '$lib/components/StatTile.svelte'
	import { DASH, formatDateTime, formatRelative, formatText } from '$lib/format.js'

	let { data }: { data: PageData } = $props()

	/**
	 * Signing in to Rivian, and what the connector is doing about it (§4.3, §5.7).
	 *
	 * Two things are on this page and they are kept apart on purpose. WHO is
	 * signed in is the web's own doing: a row this app wrote when Rivian accepted
	 * a password. WHAT THE CONNECTOR IS DOING is the connector's report, written
	 * best-effort by a different process, so it can lag, be absent, or disagree
	 * ("signed in as X" above a status of `credential_invalid` is the very
	 * situation the page is for). Neither is derived from the other.
	 *
	 * Null is not zero or empty anywhere below. Every observation the connector
	 * has not made is a dash, and the one list that CAN be empty (dropped
	 * properties) says "None" for `[]` rather than dashing it, because an empty
	 * list is an observation and a dash is the absence of one. Before the
	 * connector has subscribed to anything it is not an observation either, and
	 * says "not probed yet" (`BEFORE_SUBSCRIBING`).
	 *
	 * THE PASSWORD IS NEVER KEPT HERE. It is sent once, and the field is emptied
	 * the moment Rivian has answered with anything but a refusal. A refusal keeps
	 * it so a typo in the email does not mean retyping it; a reload empties it
	 * either way.
	 */

	interface Outcome {
		status: 'signed_in' | 'otp_required' | 'error'
		message?: string
		/** The half-made sign-in is gone on the server: no code can finish it. */
		restart?: boolean
	}

	let email = $state('')
	let password = $state('')
	let code = $state('')
	let busy = $state<'signin' | 'code' | 'signout' | null>(null)
	let failure = $state<string | null>(null)
	/** Set by an `otp_required` answer, so the code box appears without a reload. */
	let sentCode = $state(false)
	/**
	 * Set when the server says the attempt is gone (its token expired, or ten
	 * minutes passed). It overrides `data.pendingOtp`, which is only as fresh as
	 * the last load and would otherwise keep a code box on screen that no code
	 * can work in.
	 */
	let codeEnded = $state(false)

	let clock = $derived(new Date(Date.parse(data.now)))
	let credential = $derived(data.credential)
	let status = $derived(data.status)

	/**
	 * The code box shows when this page has just been told a code is needed, or
	 * when the server says a sign-in is waiting for one. The second is what lets
	 * the box survive a reload, and a second tab: the attempt lives in the pod's
	 * memory, not in this component.
	 */
	let showCode = $derived(!codeEnded && (sentCode || data.pendingOtp))

	/**
	 * The connector's states (§5.2) in words, each with the one sentence that
	 * says what to DO about it, or that nothing needs doing. The two that need a
	 * new sign-in say "sign out, then sign in again" and not just "sign in":
	 * while a credential row exists this page shows the account and a Sign out
	 * button, and the sign-in form is hidden, so the first half of that is the
	 * step that actually has to be taken.
	 *
	 * Keyed by the connector's own state type, so a state added to it and not
	 * written here is a compile error and not a page that prints the identifier.
	 * That is all the type buys: a row a NEWER connector wrote is still looked up
	 * as a string in `stateWords`, and a state this page has not heard of is
	 * shown as it came, so it reads as itself instead of as a blank.
	 *
	 * `subscribed` and `signed_out` are the two whose words depend on more than
	 * the state, and `stateWords` says how.
	 */
	const STATES: Record<RivianConnectorState, { label: string; hint: string | null }> = {
		signed_out: { label: 'Signed out', hint: 'no credential is stored, so nothing is streaming' },
		starting: { label: 'Starting', hint: 'reading the credential and opening an app session' },
		credential_invalid: {
			label: 'Credential unreadable',
			hint:
				"the stored credential does not open with the connector's key — sign out, then sign in again. " +
				"If it persists after a fresh sign-in, the web's public key and the connector's private key " +
				'come from different keygen runs'
		},
		finding_vehicle: { label: 'Finding the vehicle', hint: 'looking for the VIN on the account' },
		waiting_for_vehicle: {
			label: 'Waiting for the vehicle',
			hint: 'the VIN is not on the account yet — asked again every hour'
		},
		connecting: { label: 'Connecting', hint: 'opening the live stream' },
		// The state alone only says the socket was acknowledged. It stays
		// `subscribed` when the server then ends or refuses every subscription,
		// so a frame is the evidence of a stream, and `STREAMING` is for that.
		subscribed: {
			label: 'Subscribed',
			hint: 'no frame yet — Last error says if Rivian refused a subscription'
		},
		backing_off: { label: 'Backing off', hint: 'the stream dropped — retrying with a growing delay' },
		unauthenticated: {
			label: 'Session refused',
			hint: 'Rivian no longer accepts the saved session — sign out, then sign in again'
		}
	}

	/**
	 * `subscribed` with a frame on record. `last_frame_at` is kept across a
	 * restart, so the frame may be an earlier run's: all the sentence claims is
	 * that the car has been heard from, and the Last frame tile says when.
	 */
	const STREAMING = { label: 'Streaming', hint: 'subscribed, and the car has been heard from' }

	/**
	 * What a stored credential changes about `signed_out`. The row says the
	 * connector last saw no credential, and the connector reports on its own
	 * schedule: the web wrote the credential, and the connector reads it on its
	 * next poll, so for up to fifteen seconds this page shows an account above a
	 * report that predates it. "No credential is stored" would be false.
	 */
	const SIGNED_OUT_WITH_CREDENTIAL = {
		label: 'Signed out',
		hint: 'a sign-in is stored and the connector has not picked it up yet — it looks every 15 seconds'
	}

	/**
	 * The states in which the connector has not yet subscribed to anything, so
	 * an empty dropped list is not an answer: Rivian has not been asked, and
	 * "None" would say it had been and accepted everything. The list is saved
	 * and survives a restart, so a name in it is shown whatever the state; only
	 * an EMPTY list is read this way. `connecting` is not here: a reconnecting
	 * connector may already have a plan whose empty list is an answer.
	 */
	const BEFORE_SUBSCRIBING: ReadonlySet<RivianConnectorState> = new Set([
		'signed_out',
		'starting',
		'credential_invalid',
		'finding_vehicle',
		'waiting_for_vehicle'
	])

	let streaming = $derived(status?.state === 'subscribed' && status.lastFrameAt !== null)
	let probed = $derived(status ? !BEFORE_SUBSCRIBING.has(status.state) : false)

	let stateWords = $derived.by(() => {
		if (!status) return null
		if (streaming) return STREAMING
		if (status.state === 'signed_out' && credential) return SIGNED_OUT_WITH_CREDENTIAL
		const known: Record<string, { label: string; hint: string | null } | undefined> = STATES
		return known[status.state] ?? { label: status.state, hint: null }
	})

	/** An instant as its age, which is the only thing that makes it useful. */
	const age = (iso: string | null | undefined) => formatRelative(iso, clock)

	/**
	 * What the sign-out button asks first, and its title, so the wording can be
	 * read before pressing and asserted in a test (a `confirm()` is invisible to
	 * a server render). Nothing on Rivian's side buffers, so every minute signed
	 * out is a minute of the car's data that does not exist anywhere.
	 */
	const SIGN_OUT_PROMPT =
		'Sign out of Rivian? The connector stops streaming until someone signs in again, and ' +
		'nothing is recorded in between.'

	/**
	 * POST and read the outcome, or set `failure` and return null.
	 *
	 * A refusal from Rivian is a 200 with `status: 'error'` and a message; only a
	 * request that is not a sign-in at all (the session ended behind this open
	 * page, say) is an HTTP error. Those answer as `text/plain` with the bare
	 * sentence, so they are read as TEXT through `errorMessageFrom` and never as
	 * JSON, which would throw on the very failures that most need a message.
	 */
	async function send(path: string, body: unknown): Promise<Outcome | null> {
		failure = null
		try {
			const res = await fetch(`/api/v1/rivian/${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			})
			if (!res.ok) {
				failure = errorMessageFrom(
					res.status,
					res.headers.get('content-type'),
					await res.text().catch(() => '')
				)
				return null
			}
			return (await res.json()) as Outcome
		} catch (e) {
			failure = e instanceof Error ? e.message : 'the request could not be sent'
			return null
		}
	}

	async function signIn(event: SubmitEvent) {
		event.preventDefault()
		if (busy !== null) return
		busy = 'signin'
		try {
			const outcome = await send('login', { email, password })
			if (!outcome) return
			if (outcome.status === 'error') {
				failure = outcome.message ?? 'Rivian did not accept the sign-in'
				return
			}
			// Answered with anything but a refusal: the password has done its job.
			password = ''
			if (outcome.status === 'otp_required') {
				sentCode = true
				codeEnded = false
				return
			}
			// A reload rather than splicing the account in: who is signed in, the
			// connector's report and the form itself all come from the load, and
			// re-deriving them here is how two sources of truth start.
			location.reload()
		} finally {
			busy = null
		}
	}

	async function submitCode(event: SubmitEvent) {
		event.preventDefault()
		if (busy !== null) return
		busy = 'code'
		try {
			const outcome = await send('otp', { code })
			if (!outcome) return
			if (outcome.status === 'error') {
				// The attempt survives a wrong code on the server, so the box stays
				// and the user can type it again.
				failure = outcome.message ?? 'Rivian did not accept the code'
				if (outcome.restart) {
					code = ''
					codeEnded = true
				}
				return
			}
			code = ''
			location.reload()
		} finally {
			busy = null
		}
	}

	async function signOut() {
		if (busy !== null) return
		if (!globalThis.confirm(SIGN_OUT_PROMPT)) return
		busy = 'signout'
		try {
			const outcome = await send('logout', {})
			if (outcome) location.reload()
		} finally {
			busy = null
		}
	}
</script>

<svelte:head><title>Rivian · Coulomb</title></svelte:head>

<header class="page-head">
	<a class="back link" href="/">← Garage</a>
	<h1>Rivian</h1>
	<p class="muted">
		Sign in so the connector can hold a session open and record what the car reports. This app
		reads from Rivian and sends nothing to the car.
	</p>
</header>

<section>
	<div class="section-title">
		<h2>Account</h2>
		{#if credential}<span class="faint">signed in</span>{/if}
	</div>

	<div class="card pad">
		{#if credential}
			<p class="conn">
				Signed in as <strong class="account">{credential.account}</strong> since
				{formatDateTime(credential.updatedAt)}
				<span class="faint">({age(credential.updatedAt)})</span>.
			</p>
			<div class="actions">
				<button
					type="button"
					class="danger"
					title={SIGN_OUT_PROMPT}
					onclick={signOut}
					disabled={busy !== null}
				>
					Sign out
				</button>
				{#if busy === 'signout'}<span class="faint">working…</span>{/if}
			</div>
			{#if failure}
				<p class="failure" role="alert">{failure}</p>
			{/if}
			<p class="faint note">
				Signing out deletes the saved session. The connector notices within about fifteen
				seconds and closes the stream.
			</p>
		{:else}
			<form onsubmit={signIn}>
				<div class="fields">
					<label>
						<span>Email</span>
						<input
							name="email"
							type="email"
							autocomplete="username"
							required
							bind:value={email}
						/>
					</label>
					<label>
						<span>Password</span>
						<input
							name="password"
							type="password"
							autocomplete="current-password"
							required
							bind:value={password}
						/>
					</label>
					<button type="submit" disabled={busy !== null}>
						{busy === 'signin' ? 'Signing in…' : 'Sign in'}
					</button>
				</div>
			</form>

			{#if showCode}
				<form class="code-form" onsubmit={submitCode}>
					<div class="fields">
						<label>
							<span>Code from Rivian</span>
							<input
								class="num"
								name="code"
								inputmode="numeric"
								autocomplete="one-time-code"
								required
								bind:value={code}
							/>
						</label>
						<button type="submit" disabled={busy !== null}>
							{busy === 'code' ? 'Checking…' : 'Confirm code'}
						</button>
					</div>
					<p class="faint note">
						Rivian has asked for a one-time code. It is good for ten minutes, and a wrong one can be
						retyped without signing in again.
					</p>
				</form>
			{/if}

			{#if failure}
				<p class="failure" role="alert">{failure}</p>
			{/if}
			{#if codeEnded}
				<p class="faint note">
					That sign-in attempt has ended. Enter your email and password again to get a new code.
				</p>
			{/if}

			<p class="faint note">
				The password goes to Rivian and is not stored. What is kept is the session Rivian returns,
				sealed so that this web app can write it and cannot read it back.
			</p>
		{/if}
	</div>
</section>

<section>
	<div class="section-title">
		<h2>Connector</h2>
		{#if status}
			<span class="faint">reported {age(status.updatedAt)}</span>
		{/if}
	</div>

	<div class="card pad">
		{#if !status}
			<!-- Not a negative answer: the connector has never written a status, which
			     is different from it reporting that nobody is signed in. -->
			<EmptyState
				title="The connector has not reported"
				icon="◍"
				detail="Nothing has written a status yet. Until the connector has started and reached
				the database, this page can say who is signed in and nothing more."
			/>
		{/if}

		<div class="tiles" class:spaced={!status}>
			<StatTile
				label="State"
				value={stateWords?.label ?? DASH}
				hint={stateWords?.hint ?? 'the connector has not reported'}
				tone={streaming ? 'accent' : 'default'}
			/>
			<StatTile
				label="VIN"
				value={formatText(status?.vin)}
				hint="the VIN the connector looks for"
			/>
			<StatTile
				label="Last frame"
				value={age(status?.lastFrameAt)}
				hint={status?.lastFrameAt ? formatDateTime(status.lastFrameAt) : 'no frame received'}
			/>
			<StatTile
				label="Backing off until"
				value={status?.backoffUntil ? formatDateTime(status.backoffUntil) : DASH}
				hint={status?.backoffUntil ? age(status.backoffUntil) : 'not waiting to retry'}
			/>
		</div>

		<dl class="details">
			<div>
				<dt>Last error</dt>
				<dd>
					{#if status?.lastError}
						<code class="error-text">{status.lastError}</code>
					{:else}
						{DASH}
					{/if}
				</dd>
			</div>
			<div>
				<dt>Dropped properties</dt>
				<dd>
					{#if !status}
						{DASH}
					{:else if status.droppedProperties.length === 0}
						{probed ? 'None' : 'not probed yet'}
					{:else}
						<ul class="props">
							{#each status.droppedProperties as property (property)}
								<li><code>{property}</code></li>
							{/each}
						</ul>
					{/if}
				</dd>
			</div>
		</dl>
		<p class="faint note">
			A dropped property is one Rivian rejected by name when the connector subscribed. It is left
			out of the stream and the rest are unaffected, and it is asked for again about a day later. A
			rejection of every group at once is read as a fault in the request, not in the fields: nothing
			is dropped, and Last error says so.
		</p>
	</div>
</section>

<section>
	<div class="section-title">
		<h2>Which account</h2>
	</div>
	<div class="card pad">
		<p class="advice">
			Use the owner account until the car is delivered. Whether a secondary-driver account can see
			an undelivered car is unknown. After delivery, a secondary-driver account can be revoked from
			the Rivian app without changing the owner's password.
		</p>
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

	.conn {
		margin: 0 0 14px;
		font-size: 0.9rem;
		max-width: 78ch;
	}

	.account {
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	.fields {
		display: flex;
		align-items: flex-end;
		flex-wrap: wrap;
		gap: 12px;
	}

	.code-form {
		margin-top: 18px;
		padding-top: 16px;
		border-top: 1px solid var(--border);
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
		width: 15rem;
		max-width: 100%;
	}

	input:focus {
		outline: none;
		border-color: var(--accent);
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

	/* The one button that stops the stream reads as one. */
	.danger:not(:disabled) {
		border-color: var(--danger);
		color: var(--danger);
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

	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 10px;
	}

	.tiles.spaced {
		margin-top: 14px;
	}

	.details {
		margin: 16px 0 0;
		display: grid;
		gap: 12px;
	}

	.details dt {
		font-size: 0.72rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-faint);
		margin-bottom: 4px;
	}

	.details dd {
		margin: 0;
		font-size: 0.88rem;
	}

	code {
		font-family: var(--font-mono);
		font-size: 0.8rem;
	}

	.error-text {
		overflow-wrap: anywhere;
	}

	.props {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.props li {
		padding: 2px 8px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border);
		background: var(--surface-2);
	}

	.advice {
		margin: 0;
		font-size: 0.9rem;
		max-width: 78ch;
	}
</style>
