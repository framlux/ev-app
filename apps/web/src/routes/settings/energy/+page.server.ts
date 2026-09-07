import type { PageServerLoad } from './$types.js'
import { readEnergyRates } from '$lib/server/rates.js'

/**
 * Everything the rates page shows, which is two local reads and a clock (§4).
 *
 * No Tesla session, no outbound HTTP, nothing scheduled. The URDB fetch that
 * fills this table runs in the ingest worker on its own coarse timer (§3.3),
 * and the web tier deliberately makes no outbound call from a request path —
 * so this page is a window onto a table rather than a trigger for anything.
 *
 * The load reads directly rather than fetching its own JSON endpoint, which is
 * the convention throughout: one implementation means the page and the API
 * cannot answer differently, which is exactly what happens when a load grows
 * its own query.
 *
 * There is no session check here. The gate refuses an unauthenticated page
 * with a 302 to the IdP before a load runs, and the redundant guard belongs on
 * the /api/ route, where the refusal has to be a status a `fetch()` can read.
 */
export const load: PageServerLoad = async () => {
	const { current, history } = await readEnergyRates()

	return {
		current,
		history,
		/**
		 * The server's clock at render, so ages are computed against a fixed
		 * instant rather than against `Date.now()` inside a `$derived` — which is
		 * not a reactive dependency and would freeze at its first read.
		 */
		now: new Date().toISOString()
	}
}
