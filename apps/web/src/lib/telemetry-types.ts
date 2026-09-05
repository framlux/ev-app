/**
 * The shapes the two telemetry actions answer with (spec §3.8).
 *
 * They live OUTSIDE `$lib/server` because both sides of the wire need them:
 * `$lib/server/telemetry.ts` produces them, and the settings page — which runs
 * in the browser once it has hydrated — consumes them from `fetch`. A page
 * importing them from the server module would be reaching into `$lib/server`
 * from client code, which SvelteKit forbids for a good reason: the same import
 * that carries a type today carries a database pool tomorrow.
 *
 * `telemetry.ts` re-exports these, so nothing that already imports them from
 * there has to change and there is still exactly one definition of each.
 */

/** The §3.7 cached row as JSON: the same fields, with the two instants as ISO. */
export interface TelemetryStatusDto {
	vehicleId: string
	/**
	 * EVERY field here is independently nullable, and null is not false. A row
	 * created by a push alone has never been checked, so `synced` is null — "the
	 * car says no" and "nobody has asked" are different facts and the page
	 * renders the second as a dash rather than as a negative answer.
	 */
	synced: boolean | null
	fieldCount: number | null
	caPresent: boolean | null
	firmware: string | null
	keyPaired: boolean | null
	streamingEnabled: boolean | null
	checkedAt: string | null
	pushedAt: string | null
}

export interface TelemetryCheckResult {
	vin: string
	status: TelemetryStatusDto
	/** Preflight blockers. A CHECK reports them; only a push refuses on them. */
	blockers: string[]
	warnings: string[]
	/** Whether the applied config is the one the catalogue would push (§3.6). */
	matches: boolean
	differences: string[]
	/** Fields the catalogue would push, against `status.fieldCount` applied. */
	desiredFieldCount: number
}

export interface TelemetryPushResult {
	vin: string
	pushed: boolean
	/** True when the car already had exactly this configuration (§3.6). */
	alreadyApplied: boolean
	desiredFieldCount: number
	warnings: string[]
	differences: string[]
	/**
	 * Both null when nothing was pushed: that path writes nothing at all, so
	 * there is no fresh row to hand back and the page keeps showing the cached
	 * one rather than blanking the panel.
	 */
	pushedAt: string | null
	status: TelemetryStatusDto | null
}
