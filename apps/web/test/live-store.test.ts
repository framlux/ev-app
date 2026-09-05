import { describe, expect, it, vi } from 'vitest'
import { createLiveStore, STREAM_DEAD_MS, PROBE_AFTER_FAILURES } from '../src/lib/live.svelte.js'

class FakeSource {
	static made: FakeSource[] = []
	static readonly CLOSED = 2
	static readonly OPEN = 1
	readyState = 1
	closed = false
	listeners = new Map<string, Array<(e: unknown) => void>>()

	constructor(public url: string) {
		FakeSource.made.push(this)
	}

	addEventListener(type: string, fn: (e: unknown) => void): void {
		const l = this.listeners.get(type) ?? []
		l.push(fn)
		this.listeners.set(type, l)
	}

	close(): void {
		this.closed = true
		this.readyState = 2
	}

	emit(type: string, data?: unknown): void {
		for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) })
	}

	fail(): void {
		this.readyState = 2
		for (const fn of this.listeners.get('error') ?? []) fn({})
	}
}

const entry = (id: string, soc: number) =>
	({ vehicle: { id }, state: { vehicleId: id, socPct: soc }, activity: 'driving', openSessionId: 's1' })

function harness(over: Record<string, unknown> = {}) {
	FakeSource.made = []
	const scheduled: Array<{ fn: () => void; ms: number }> = []
	const store = createLiveStore({
		// The web project runs in vitest's `node` environment, so `window` is
		// undefined and the real browser guard would make start() a no-op.
		browser: true,
		createSource: (url: string) => new FakeSource(url) as never,
		schedule: (fn: () => void, ms: number) => { scheduled.push({ fn, ms }); return 0 as never },
		// Separate from `schedule` so `scheduled` holds reconnect attempts only —
		// the watchdog arms itself on every connect and would otherwise be the
		// first entry in the array these tests index into.
		scheduleWatchdog: () => 0 as never,
		unschedule: () => undefined,
		now: () => 1_000_000,
		probe: async () => 200,
		...over
	})
	return { store, scheduled }
}

describe('createLiveStore', () => {
	it('records vehicles by id from the vehicle event', () => {
		const h = harness()
		h.store.start()
		FakeSource.made[0]!.emit('vehicle', entry('v1', 61))
		expect(h.store.get('v1')?.state?.socPct).toBe(61)
		expect(h.store.connection).toBe('open')
	})

	it('reconnects with a NEW EventSource after a failure, because a closed one never retries', () => {
		const h = harness()
		h.store.start()
		FakeSource.made[0]!.fail()
		expect(h.store.connection).toBe('reconnecting')
		expect(h.scheduled).toHaveLength(1)
		h.scheduled[0]!.fn()
		expect(FakeSource.made).toHaveLength(2)
	})

	it('backs off between attempts rather than hammering a pod that is restarting', () => {
		const h = harness()
		h.store.start()
		FakeSource.made[0]!.fail()
		h.scheduled[0]!.fn()
		FakeSource.made[1]!.fail()
		expect(h.scheduled[1]!.ms).toBeGreaterThan(h.scheduled[0]!.ms)
	})

	it('resets the backoff once a connection succeeds', () => {
		const h = harness()
		h.store.start()
		FakeSource.made[0]!.fail()
		h.scheduled[0]!.fn()
		FakeSource.made[1]!.emit('vehicle', entry('v1', 50))
		FakeSource.made[1]!.fail()
		expect(h.scheduled[1]!.ms).toBe(h.scheduled[0]!.ms)
	})

	it('closes the old source before opening a new one, so they cannot both run', () => {
		const h = harness()
		h.store.start()
		FakeSource.made[0]!.fail()
		h.scheduled[0]!.fn()
		expect(FakeSource.made[0]!.closed).toBe(true)
		// And the replacement is live, not closed — otherwise this passes on a
		// store that simply gave up.
		expect(FakeSource.made[1]!.closed).toBe(false)
	})

	it('treats a heartbeat as liveness without touching vehicle state', () => {
		const h = harness()
		h.store.start()
		FakeSource.made[0]!.emit('vehicle', entry('v1', 50))
		const before = h.store.lastEventAt
		FakeSource.made[0]!.emit('heartbeat', { t: 1 })
		expect(h.store.lastEventAt).toBe(before)
		expect(h.store.get('v1')?.state?.socPct).toBe(50)
	})

	it('probes for a lost session after repeated failures and redirects on 401', async () => {
		const redirects: string[] = []
		const h = harness({
			probe: async () => 401,
			redirect: (to: string) => redirects.push(to)
		})
		h.store.start()
		for (let i = 0; i < PROBE_AFTER_FAILURES; i++) {
			FakeSource.made[FakeSource.made.length - 1]!.fail()
			h.scheduled[h.scheduled.length - 1]!.fn()
		}
		await new Promise((r) => setTimeout(r, 0))
		expect(redirects).toEqual(['/auth/login'])
	})

	it('stops cleanly', () => {
		const h = harness()
		h.store.start()
		h.store.stop()
		expect(FakeSource.made[0]!.closed).toBe(true)
		FakeSource.made[0]!.fail()
		expect(FakeSource.made).toHaveLength(1)
	})

	it('declares a silent connection dead well inside two heartbeats', () => {
		expect(STREAM_DEAD_MS).toBeGreaterThan(40_000)
		expect(STREAM_DEAD_MS).toBeLessThan(60_000)
	})
})
