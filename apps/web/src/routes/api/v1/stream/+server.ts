import { error } from '@sveltejs/kit'
import type { RequestHandler } from './$types.js'
import { getLiveHub } from '$lib/server/notify-listener.js'
import { getPool } from '$lib/server/db.js'
import type { Hub, LiveSubscriber } from '$lib/server/live.js'

/**
 * The live stream: one connection per browser tab, every vehicle on it.
 *
 * One account-wide endpoint rather than one per vehicle because the garage
 * page shows every car — per-vehicle endpoints would open N connections there
 * to deliver what one can. The app is single-tenant (one ALLOWED_SUBJECT, no
 * tenancy), so "every vehicle" and "every vehicle this viewer may see" are the
 * same set and nothing has to be filtered.
 */

/**
 * Under a proxy's idle timeout, and under the client's own dead-connection
 * threshold, with room for one to be missed.
 */
export const HEARTBEAT_MS = 20_000

/**
 * What the browser waits before retrying a dropped stream.
 *
 * The default is 3s, and a single-replica deployment's restart window is
 * comfortably longer than that — every retry landing inside it gets Traefik's
 * 503, which closes an EventSource permanently. The client owns its own
 * reconnect for that reason (see lib/live.svelte.ts); this only tightens the
 * built-in retry for the ordinary case of a clean drop.
 */
export const RETRY_MS = 2_000

/** One SSE frame. `data` is JSON, so it can never contain a raw newline. */
export function formatEvent(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

interface Timers {
	setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval>
	clearInterval(id: ReturnType<typeof setInterval>): void
}

/**
 * Build the response body. Separated from the handler so the framing, the
 * heartbeat and the teardown can be tested without a SvelteKit runtime.
 */
export function openStream(
	hub: Hub,
	timers: Timers = { setInterval, clearInterval }
): { stream: ReadableStream<Uint8Array> } {
	const encoder = new TextEncoder()
	let unsubscribe: (() => void) | undefined
	let beat: ReturnType<typeof setInterval> | undefined

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const write = (chunk: string): void => {
				try {
					controller.enqueue(encoder.encode(chunk))
				} catch {
					// The client vanished between the check and the write. Nothing to
					// do: cancel() has run or is about to.
				}
			}

			write(`retry: ${RETRY_MS}\n\n`)

			const subscriber: LiveSubscriber = {
				send: (event, data) => write(formatEvent(event, data))
			}
			unsubscribe = hub.add(subscriber)

			// The current fleet before anything incremental, so a client that
			// reconnects after missing updates cannot sit on a stale value: what it
			// missed is exactly what this replaces.
			void hub.snapshot(subscriber)

			// A NAMED event, not an SSE comment. A comment keeps proxies from
			// timing the connection out but is invisible to EventSource, so the
			// client could not distinguish "quiet" from "dead" — which is half of
			// what the live/stale indicator has to answer.
			beat = timers.setInterval(() => write(formatEvent('heartbeat', { t: Date.now() })), HEARTBEAT_MS)
		},
		cancel() {
			unsubscribe?.()
			if (beat !== undefined) timers.clearInterval(beat)
		}
	})

	return { stream }
}

/**
 * Refuse rather than hand back a stream that cannot carry anything. One cheap
 * query at open — not per event — and it is what makes the client's reconnect
 * loop meaningful: a 503 is a definite answer it can back off against, where
 * an open-but-silent stream is indistinguishable from a parked car.
 *
 * The probe is a parameter so the failure path is testable without an
 * unreachable database, and without the answer depending on whether the suite
 * happens to be running with PG* set.
 */
export async function assertDatabaseReachable(
	probe: () => Promise<unknown> = () => getPool().query('SELECT 1')
): Promise<void> {
	try {
		await probe()
	} catch {
		throw error(503, 'database unavailable')
	}
}

export const GET: RequestHandler = async ({ locals }) => {
	// Same refusal as every other /api/v1 route. Note this is checked once, at
	// open: an authenticated stream stays open until it drops, and the session
	// expiring is caught on the client's next reconnect (lib/live.svelte.ts).
	if (!locals.user) throw error(401, 'unauthorized')

	await assertDatabaseReachable()

	const { stream } = openStream(getLiveHub())

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			// No store, no transform: an intermediary that buffered this would
			// defeat the whole point, and one that "helpfully" compressed it would
			// hold frames until its window filled.
			'cache-control': 'no-store',
			connection: 'keep-alive',
			// Harmless under Traefik, which does not buffer; correct if anything
			// nginx-shaped is ever put in front.
			'x-accel-buffering': 'no'
		}
	})
}
