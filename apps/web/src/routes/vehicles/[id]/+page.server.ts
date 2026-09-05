import type { PageServerLoad } from './$types.js'
import { run } from '$lib/server/http.js'
import {
	getSampleSeries,
	getVehicleStats,
	listSessions,
	parseSampleQuery,
	parseSessionQuery
} from '$lib/server/queries.js'

/** The overview's chart window, per the contract's page description. */
const CHART_DAYS = 7

export const load: PageServerLoad = async ({ params }) => {
	const to = new Date()
	const from = new Date(to.getTime() - CHART_DAYS * 24 * 3600 * 1000)

	// Three independent reads, issued together rather than in sequence.
	//
	// The window and field list are built as a query string and handed to the
	// same validators the HTTP routes use, rather than constructing the query
	// objects by hand: one parser means the page cannot ask for something the
	// API would have rejected. They run inside `run` so that if they ever did
	// reject, it would surface as the 400 it is rather than as a 500.
	const [stats, samples, sessions] = await run(() =>
		Promise.all([
			getVehicleStats(params.id, {}),
			getSampleSeries(
				params.id,
				parseSampleQuery(
					new URLSearchParams({
						from: from.toISOString(),
						to: to.toISOString(),
						fields: 'socPct,insideTempC,outsideTempC'
					})
				)
			),
			listSessions(params.id, parseSessionQuery(new URLSearchParams({ limit: '5' })))
		])
	)

	return { stats, samples, recent: sessions.sessions, chartDays: CHART_DAYS }
}
