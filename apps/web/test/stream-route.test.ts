import { describe, expect, it } from 'vitest'
// The underscore prefixes are not a convention: SvelteKit fails `vite build`
// on any other export from a +server.ts. See the note in the route itself.
import {
	GET,
	_assertDatabaseReachable,
	_formatEvent,
	_openStream,
	_HEARTBEAT_MS,
	_RETRY_MS
} from '../src/routes/api/v1/stream/+server.js'
import type { Hub, LiveSubscriber } from '../src/lib/server/live.js'

function fakeHub(): Hub & { subs: LiveSubscriber[]; unsubscribed: number } {
	const subs: LiveSubscriber[] = []
	const hub = {
		subs,
		unsubscribed: 0,
		add(sub: LiveSubscriber) {
			subs.push(sub)
			return () => { hub.unsubscribed++ }
		},
		size: () => subs.length,
		stats: () => ({ dropped: 0, sent: 0 }),
		handle: () => undefined,
		resync: () => undefined,
		snapshot: async (sub: LiveSubscriber) => {
			sub.send('vehicle', { vehicle: { id: 'v1' } })
		}
	}
	return hub as Hub & { subs: LiveSubscriber[]; unsubscribed: number }
}

async function read(stream: ReadableStream<Uint8Array>, chunks: number): Promise<string> {
	const reader = stream.getReader()
	const decoder = new TextDecoder()
	let out = ''
	for (let i = 0; i < chunks; i++) {
		const { value, done } = await reader.read()
		if (done) break
		out += decoder.decode(value)
	}
	reader.releaseLock()
	return out
}

describe('_formatEvent', () => {
	it('emits a well-formed SSE frame', () => {
		expect(_formatEvent('vehicle', { a: 1 })).toBe('event: vehicle\ndata: {"a":1}\n\n')
	})

	it('never emits a bare newline inside data, which would split the frame', () => {
		const frame = _formatEvent('vehicle', { note: 'line1\nline2' })
		expect(frame.split('\n').filter((l) => l.startsWith('data: '))).toHaveLength(1)
	})
})

describe('_openStream', () => {
	it('opens with a retry hint, because the 3s browser default is too short for a restart', async () => {
		const hub = fakeHub()
		const { stream } = _openStream(hub, { setInterval: () => 0 as never, clearInterval: () => undefined })
		expect(await read(stream, 1)).toBe(`retry: ${_RETRY_MS}\n\n`)
	})

	it('sends the current fleet before anything incremental', async () => {
		const hub = fakeHub()
		const { stream } = _openStream(hub, { setInterval: () => 0 as never, clearInterval: () => undefined })
		const text = await read(stream, 2)
		expect(text).toContain('event: vehicle')
		expect(text).toContain('"id":"v1"')
	})

	it('heartbeats as a NAMED EVENT so the client can see it', async () => {
		const hub = fakeHub()
		let beat: (() => void) | undefined
		const { stream } = _openStream(hub, {
			setInterval: (fn: () => void) => { beat = fn; return 1 as never },
			clearInterval: () => undefined
		})
		await read(stream, 2)
		beat!()
		// A comment frame (': hb') is invisible to EventSource, so a dead-but-open
		// connection would be undetectable by the client.
		expect(await read(stream, 1)).toContain('event: heartbeat')
	})

	it('unregisters from the hub and stops the heartbeat when the client goes away', async () => {
		const hub = fakeHub()
		const cleared: ReturnType<typeof setInterval>[] = []
		const { stream } = _openStream(hub, {
			setInterval: () => 7 as never,
			clearInterval: (id) => cleared.push(id)
		})
		await read(stream, 1)
		await stream.cancel()
		expect(hub.unsubscribed).toBe(1)
		expect(cleared).toEqual([7])
	})

	it('heartbeats well inside a proxy idle timeout', () => {
		expect(_HEARTBEAT_MS).toBeLessThanOrEqual(30_000)
	})
})

describe('GET', () => {
	/**
	 * The handler's own refusal, not just the gate's. hooks.server.ts already
	 * turns an unauthenticated /api/ request away, but this route is the one
	 * place a stream could be opened, and a future change to the gate must not
	 * silently make it public.
	 */
	it('refuses a request with no session', async () => {
		await expect(GET({ locals: {} } as never)).rejects.toMatchObject({ status: 401 })
	})

})

describe('_assertDatabaseReachable', () => {
	/**
	 * The check GET runs before it hands back a stream. Tested through its
	 * injected probe rather than by re-importing the route with the pool
	 * mocked: the probe's outcome is the whole of the behaviour, and it is the
	 * same answer whether or not the suite happens to be running with PG*
	 * pointing at a live database.
	 */
	it('returns 503 rather than an open stream when the database is unreachable', async () => {
		await expect(
			_assertDatabaseReachable(() => Promise.reject(new Error('down')))
		).rejects.toMatchObject({ status: 503 })
	})

	it('lets the stream open when the database answers', async () => {
		await expect(_assertDatabaseReachable(async () => undefined)).resolves.toBeUndefined()
	})
})
