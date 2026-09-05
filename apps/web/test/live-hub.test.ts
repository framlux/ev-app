import { describe, expect, it, vi } from 'vitest'
import { createHub } from '../src/lib/server/live.js'
import type { VehicleWithState } from '../src/lib/api-types.js'

const entry = (id: string, soc = 50): VehicleWithState =>
	({
		vehicle: { id, displayName: id } as never,
		state: { vehicleId: id, ts: '2026-09-05T10:00:00.000Z', socPct: soc } as never,
		activity: 'parked',
		openSessionId: null
	}) as VehicleWithState

function sub() {
	const sent: Array<{ event: string; data: unknown }> = []
	return { sent, send: (event: string, data: unknown) => sent.push({ event, data }) }
}

const change = (vehicleId = 'v1') =>
	({ vehicleId, ts: '2026-09-05T10:00:00.000Z', kind: 'sample' }) as const

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('createHub', () => {
	it('queries once per notification and sends to every subscriber', async () => {
		const getVehicle = vi.fn(async (id: string) => entry(id))
		const hub = createHub({ getVehicle, listVehicles: async () => [entry('v1')] })
		const a = sub()
		const b = sub()
		hub.add(a)
		hub.add(b)

		hub.handle(change())
		await settle()

		// One query, N writes — the reason the payload is fetched server-side
		// rather than by each client.
		expect(getVehicle).toHaveBeenCalledTimes(1)
		expect(a.sent).toEqual([{ event: 'vehicle', data: entry('v1') }])
		expect(b.sent).toEqual([{ event: 'vehicle', data: entry('v1') }])
	})

	it('collapses a burst of notifications for one vehicle into one trailing query', async () => {
		let resolve!: (v: VehicleWithState) => void
		const getVehicle = vi.fn(
			() => new Promise<VehicleWithState>((r) => { resolve = r })
		)
		const hub = createHub({ getVehicle, listVehicles: async () => [] })
		hub.add(sub())

		hub.handle(change())
		hub.handle(change())
		hub.handle(change())
		expect(getVehicle).toHaveBeenCalledTimes(1)

		resolve(entry('v1'))
		await settle()
		// One re-query for everything that arrived while the first was in flight,
		// not one per notification.
		expect(getVehicle).toHaveBeenCalledTimes(2)
	})

	it('keeps vehicles independent', async () => {
		const getVehicle = vi.fn(async (id: string) => entry(id))
		const hub = createHub({ getVehicle, listVehicles: async () => [] })
		hub.add(sub())
		hub.handle(change('v1'))
		hub.handle(change('v2'))
		await settle()
		expect(getVehicle).toHaveBeenCalledTimes(2)
	})

	it('drops a notification whose query fails, without disturbing subscribers', async () => {
		const errors: unknown[] = []
		const hub = createHub({
			getVehicle: async () => { throw new Error('db down') },
			listVehicles: async () => [],
			onError: (e) => errors.push(e)
		})
		const s = sub()
		hub.add(s)
		hub.handle(change())
		await settle()
		expect(s.sent).toEqual([])
		expect(errors).toHaveLength(1)
		expect(hub.size()).toBe(1)
		// Counted, so a hub dropping everything is distinguishable from a quiet
		// fleet without reading the logs.
		expect(hub.stats().dropped).toBe(1)
	})

	it('unsubscribes exactly one subscriber', async () => {
		const hub = createHub({ getVehicle: async (id) => entry(id), listVehicles: async () => [] })
		const a = sub()
		const b = sub()
		const off = hub.add(a)
		hub.add(b)
		off()
		expect(hub.size()).toBe(1)
		hub.handle(change())
		await settle()
		expect(a.sent).toEqual([])
		expect(b.sent).toHaveLength(1)
	})

	it('resync sends every vehicle to every subscriber', async () => {
		const hub = createHub({
			getVehicle: async (id) => entry(id),
			listVehicles: async () => [entry('v1'), entry('v2')]
		})
		const s = sub()
		hub.add(s)
		hub.resync()
		await settle()
		expect(s.sent.map((m) => m.event)).toEqual(['vehicle', 'vehicle'])
	})

	it('snapshot sends the current fleet to one subscriber only', async () => {
		const hub = createHub({
			getVehicle: async (id) => entry(id),
			listVehicles: async () => [entry('v1'), entry('v2')]
		})
		const a = sub()
		const b = sub()
		hub.add(a)
		hub.add(b)
		await hub.snapshot(a)
		expect(a.sent).toHaveLength(2)
		expect(b.sent).toHaveLength(0)
	})
})
