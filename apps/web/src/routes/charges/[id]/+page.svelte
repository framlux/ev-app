<script lang="ts">
	import type { PageData } from './$types.js'
	import {
		DASH,
		formatCost,
		formatDateTime,
		formatDuration,
		formatKw,
		formatKwh,
		formatPct,
		formatRatePerKwh,
		formatText,
		formatTime,
		formatUnpricedCost,
		formatVolts,
		hasCoords,
		ESTIMATED_COST_TITLE
	} from '$lib/format.js'
	import ChargeCurve from '$lib/components/ChargeCurve.svelte'
	import Map from '$lib/components/Map.svelte'
	import StatTile from '$lib/components/StatTile.svelte'

	let { data }: { data: PageData } = $props()

	let s = $derived(data.detail.session)
	let points = $derived(data.detail.points)

	let socAdded = $derived(
		s.startSocPct != null && s.endSocPct != null ? s.endSocPct - s.startSocPct : null
	)

	// The cost tile is unconditional on a charge. An absent tile answers a
	// different question from an empty one: it says the app has nothing to say
	// about money, when what is true is that THIS charge has no figure and there
	// is a reason. So a priced charge shows the money and an unpriced one shows
	// the reason in words — never a "$0.00", which would be the one reading
	// that is actually false.
	let priced = $derived(s.cost != null && s.costCurrency != null)

	/**
	 * The arithmetic under the figure, which is why the rate is stored on the
	 * session at all rather than looked up when the page renders: a cost nobody
	 * can check against a rate is a cost nobody can argue with when the tariff
	 * changes underneath it.
	 *
	 * The two bases read differently on purpose. A home charge really was priced
	 * by multiplying, so it shows the multiplication. A Tesla-billed stop was
	 * priced by Tesla — idle and congestion fees inside one total — so its rate
	 * is something we divided back out, and "effective" is the word that stops
	 * it being read as a price anyone was quoted.
	 *
	 * Null rather than a line of dashes when either half is missing: a hint that
	 * says "— × —" under a real figure looks like the figure is broken too.
	 */
	let costHint = $derived.by(() => {
		if (!priced || s.costRatePerKwh == null) return null
		const rate = formatRatePerKwh(s.costRatePerKwh, s.costCurrency)
		const arithmetic =
			s.costBasis === 'tesla' ? `${rate} effective`
			: s.energyKwh == null ? null
			: `${formatKwh(s.energyKwh)} × ${rate}`
		if (arithmetic == null) return null
		// A backfilled figure was priced at TODAY's rate, not the one in force
		// when the car was plugged in, so for anything older than the last
		// tariff change the number is invented. Rendered identically to a real
		// figure it would be indistinguishable from one.
		return s.costSource === 'backfill-estimate' ?
				`${arithmetic} · estimated at a later rate`
			:	arithmetic
	})

	let located = $derived(hasCoords(s.startLat, s.startLon))

	/**
	 * What the car was plugged into (spec §3.8), read back from the samples
	 * inside the session.
	 *
	 * null — not four dashes — when the car said nothing about the charger,
	 * which is every charge recorded before the telemetry config asking for
	 * these fields was accepted. A panel of em dashes reads as a broken page
	 * rather than as a signal that has not arrived yet.
	 */
	let setup = $derived(data.detail.chargeSetup)

	// 1-phase or 3-phase on AC; a DC charger reports no phases at all, which is
	// a dash rather than "0-phase".
	let phases = $derived(
		setup?.chargerPhases == null ? DASH : `${setup.chargerPhases}-phase`
	)
</script>

<svelte:head>
	<title>Charge {formatDateTime(s.startedAt)} · Coulomb</title>
</svelte:head>

<div class="page">
	<div class="head">
		<a class="link" href="/vehicles/{data.vehicle.id}/charges">← Charges</a>
		<h1>{formatDateTime(s.startedAt)}</h1>
		<p class="muted">
			{data.vehicle.displayName}
			<span class="sep">·</span>
			{#if s.isOpen}
				<span class="live">charging now</span>
			{:else}
				{formatTime(s.startedAt)} → {formatTime(s.endedAt)}
			{/if}
		</p>
	</div>

	<div class="tiles">
		<StatTile label="Energy added" value={formatKwh(s.energyKwh)} tone="charging" />
		<StatTile label="Peak power" value={formatKw(s.maxChargePowerKw)} />
		<StatTile
			label="Duration"
			value={s.isOpen ? DASH : formatDuration(s.durationS)}
			hint={s.isOpen ? 'still charging' : null}
		/>
		<StatTile
			label="State of charge"
			value="{formatPct(s.startSocPct)} → {formatPct(s.endSocPct)}"
			hint={socAdded != null ? `${formatPct(socAdded)} added` : null}
		/>
		<StatTile
			label="Cost"
			value={priced ?
				formatCost(s.cost, s.costCurrency)
			:	formatUnpricedCost(s.costBasis, s.energyKwh)}
			hint={costHint}
			title={priced && s.costSource === 'backfill-estimate' ? ESTIMATED_COST_TITLE : null}
		/>
	</div>

	{#if setup}
		<section>
			<div class="section-title">
				<h2>Charging equipment</h2>
				<span class="faint">as reported during this charge</span>
			</div>
			<div class="card pad">
				<div class="tiles equipment">
					<StatTile label="Supply voltage" value={formatVolts(setup.chargerVoltage)} />
					<StatTile label="Phases" value={phases} />
					<!-- The vendor's own enum names, verbatim: we have not observed
					     most of these payloads, so a friendlier label would be a
					     translation nothing can check. -->
					<StatTile label="Charger" value={formatText(setup.fastChargerType)} />
					<StatTile label="Cable" value={formatText(setup.chargingCableType)} />
				</div>
			</div>
		</section>
	{/if}

	<section>
		<div class="section-title">
			<h2>Power against state of charge</h2>
			{#if data.detail.downsampled}
				<span class="faint">series thinned for display — it still spans the whole charge</span>
			{/if}
		</div>
		<div class="card pad">
			<ChargeCurve {points} />
		</div>
	</section>

	<section>
		<div class="section-title"><h2>Where</h2></div>
		<Map
			marker={located ? { lat: s.startLat as number, lon: s.startLon as number } : null}
			height="300px"
			emptyTitle="No location for this charge"
			emptyDetail="The car did not report coordinates while it was plugged in. Everything above was still recorded."
		/>
	</section>
</div>

<style>
	.head {
		margin-bottom: 18px;
	}

	.head h1 {
		margin-top: 6px;
	}

	.head p {
		margin: 4px 0 0;
		font-size: 0.88rem;
	}

	.sep {
		color: var(--text-faint);
		margin: 0 4px;
	}

	.live {
		color: var(--charging);
		font-weight: 600;
	}

	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 10px;
		margin-bottom: 26px;
	}

	/* Inside a card, so the bottom margin the header tiles need would show as
	   a gap under the last row. */
	.tiles.equipment {
		margin-bottom: 0;
	}

	section {
		margin-bottom: 26px;
	}

	.pad {
		padding: 16px;
	}
</style>
