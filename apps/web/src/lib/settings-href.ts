import type { Vendor } from '@ev/core'

/**
 * Where a vehicle's Settings tab leads.
 *
 * There is no per-vehicle settings route: the Settings tab is a second door to
 * an install-wide page about the plumbing, not about the car (spec §3.8). What
 * differs by vendor is WHICH plumbing. A Tesla is configured by pushing a
 * telemetry configuration to the car, which `/settings/telemetry` does; a Rivian
 * has no such step and instead needs an account signed in for the connector to
 * hold a session open, which `/settings/rivian` does.
 *
 * Anything that is not Rivian goes to the telemetry page, so a vendor added to
 * the union later lands on a page that exists rather than on a 404.
 *
 * A function of its own, and not a ternary in `vehicles/[id]/+layout.svelte`,
 * because that layout reads `$app/state` and the live store and so cannot be
 * rendered by the component tests. This is the part of it that is a decision,
 * and a decision wants a test.
 *
 * Browser-safe: a type-only import and a string, so the layout can use it.
 */
export function settingsHref(vendor: Vendor): string {
	return vendor === 'rivian' ? '/settings/rivian' : '/settings/telemetry'
}
