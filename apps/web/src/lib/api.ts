/**
 * The one query-string builder shared by the pages.
 *
 * Page loads do NOT go through the HTTP API: they call the helpers in
 * `$lib/server/queries.ts` directly (plan Task 15), which is why there is no
 * fetch wrapper here. The HTTP API remains the contract for external clients
 * and for the browser — "load more" on a session list runs in the browser,
 * where there is no database connection, and builds its URL with this.
 */
export function qs(params: Record<string, string | number | null | undefined>): string {
	const sp = new URLSearchParams()
	for (const [k, v] of Object.entries(params)) {
		if (v == null || v === '') continue
		sp.set(k, String(v))
	}
	const s = sp.toString()
	return s ? `?${s}` : ''
}
