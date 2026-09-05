import type { SessionUser } from '$lib/server/session.js'

/**
 * App.Locals — what hooks.server.ts puts on every request.
 *
 * This file was still SvelteKit's commented-out stub while hooks.server.ts was
 * already assigning to `locals.session` and `locals.user` and nine API routes
 * were reading `locals.user`. Nothing caught it locally: `svelte-kit sync`
 * regenerates ./$types from this file, and the generated types were stale, so
 * the mismatch only appeared in CI, which syncs from clean — as eleven
 * "Property 'user' does not exist on type 'Locals'" errors.
 *
 * `session` and `user` are the SAME object under two names, and both are kept
 * deliberately rather than one being renamed away: `session` is what the gate
 * and guards read, `user` is what the route handlers read, and unifying them
 * would touch every one of those files for no behavioural gain. Null means
 * unauthenticated — the gate refuses before a handler runs, so a handler
 * seeing null is a bug in the gate rather than an anonymous request.
 */
declare global {
	namespace App {
		interface Locals {
			session: SessionUser | null
			user: SessionUser | null
		}
		// interface Error {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {}
