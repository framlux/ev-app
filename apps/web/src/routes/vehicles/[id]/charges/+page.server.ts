import type { PageServerLoad } from './$types.js'
import { run } from '$lib/server/http.js'
import { listSessions, parseSessionQuery } from '$lib/server/queries.js'

const PAGE_SIZE = '50'

/**
 * First page only. Subsequent pages are fetched in the browser with the opaque
 * cursor, so "load more" does not re-run this load or re-render the page.
 *
 * from/to come off the URL and go through the same parser the HTTP route uses,
 * so an unparseable date is a 400 with a message rather than a filter that was
 * silently ignored — a list quietly showing everything when the user asked for
 * one week is worse than an error.
 */
export const load: PageServerLoad = async ({ params, url }) => {
	const search = new URLSearchParams(url.searchParams)
	search.set('kind', 'charge')
	search.set('limit', PAGE_SIZE)

	const page = await run(() => listSessions(params.id, parseSessionQuery(search)))

	return { page, from: url.searchParams.get('from'), to: url.searchParams.get('to') }
}
