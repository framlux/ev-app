import { getPool } from '$lib/server/db.js'

/**
 * Readiness, backed by a real query rather than a constant.
 *
 * Plain text, not JSON: the kubelet reads the status code and nothing else,
 * and a JSON body here would only be read by a human tailing curl.
 *
 * Liveness stays unconditional (see ../live/+server.ts). A database outage
 * should take this pod out of the load balancer, not restart it in a loop —
 * restarting a healthy process because its dependency is down turns a partial
 * outage into a crash loop that is slower to recover when the database returns.
 */
export async function GET(): Promise<Response> {
	try {
		await getPool().query('SELECT 1')
		return new Response('ok', { headers: { 'content-type': 'text/plain' } })
	} catch {
		return new Response('database unavailable', {
			status: 503,
			headers: { 'content-type': 'text/plain' }
		})
	}
}
