import type { VehicleChange } from '@ev/db'
import type { VehicleWithState } from '$lib/api-types.js'

/**
 * The fan-out: notifications in, rendered vehicle state out to open streams.
 *
 * Deliberately knows nothing about Postgres and nothing about HTTP. Its
 * dependencies are two query functions and its subscribers are anything with a
 * `send`, which is what lets the whole of it be tested without a database or a
 * server — and what keeps the SSE route down to plumbing.
 */

export interface LiveSubscriber {
	send(event: string, data: unknown): void
}

export interface HubDeps {
	getVehicle(id: string): Promise<VehicleWithState>
	listVehicles(): Promise<VehicleWithState[]>
	onError?(err: unknown): void
}

export interface HubStats {
	/** Notifications whose query failed, so the update was dropped. */
	dropped: number
	/** Vehicle updates written to at least one subscriber. */
	sent: number
}

export interface Hub {
	/** Register a stream. Returns the unsubscribe. */
	add(sub: LiveSubscriber): () => void
	size(): number
	/** Counted, not just logged: a listener that is quietly dropping every
	 *  update looks identical to a quiet car in the logs. */
	stats(): HubStats
	/** A change landed: query once, send to everyone. */
	handle(change: VehicleChange): void
	/** Push the whole fleet to everyone. Used after a listener reconnect. */
	resync(): void
	/** Push the whole fleet to one subscriber. Used when a stream opens. */
	snapshot(sub: LiveSubscriber): Promise<void>
}

/** The one event name a vehicle update is sent under. */
export const VEHICLE_EVENT = 'vehicle'

export function createHub(deps: HubDeps): Hub {
	const subscribers = new Set<LiveSubscriber>()
	/**
	 * Vehicles with a query in flight, and whether another change arrived while
	 * it was running.
	 *
	 * Without this, a car reporting faster than the query returns would queue an
	 * unbounded number of identical queries, each answering the same question.
	 * Collapsing them to "one in flight, one pending" means the extra
	 * notifications cost nothing and the last one is still honoured — the state
	 * sent is always at least as fresh as the newest notification seen.
	 */
	const inFlight = new Map<string, { pending: boolean }>()

	const stats = { dropped: 0, sent: 0 }

	const fail = (err: unknown): void => {
		// A failed query is a dropped update, not a broken stream: the next
		// sample produces another notification within seconds, and the heartbeat
		// keeps clients from concluding the connection is dead meanwhile.
		stats.dropped++
		deps.onError?.(err)
	}

	const broadcast = (entry: VehicleWithState): void => {
		if (subscribers.size > 0) stats.sent++
		for (const sub of subscribers) {
			try {
				sub.send(VEHICLE_EVENT, entry)
			} catch (err) {
				// One wedged stream must not stop the others being served.
				fail(err)
			}
		}
	}

	const pump = (vehicleId: string): void => {
		const state = inFlight.get(vehicleId)
		if (state) {
			state.pending = true
			return
		}
		inFlight.set(vehicleId, { pending: false })
		void deps
			.getVehicle(vehicleId)
			.then(broadcast, fail)
			.finally(() => {
				const again = inFlight.get(vehicleId)?.pending ?? false
				inFlight.delete(vehicleId)
				if (again) pump(vehicleId)
			})
	}

	return {
		add(sub: LiveSubscriber): () => void {
			subscribers.add(sub)
			return () => subscribers.delete(sub)
		},
		size: () => subscribers.size,
		stats: () => ({ ...stats }),
		handle(change: VehicleChange): void {
			if (subscribers.size === 0) return
			pump(change.vehicleId)
		},
		resync(): void {
			if (subscribers.size === 0) return
			void deps.listVehicles().then((all) => all.forEach(broadcast), fail)
		},
		async snapshot(sub: LiveSubscriber): Promise<void> {
			// Awaited, unlike resync: the caller is opening a stream and wants the
			// current state on it before anything incremental arrives.
			try {
				for (const entry of await deps.listVehicles()) sub.send(VEHICLE_EVENT, entry)
			} catch (err) {
				fail(err)
			}
		}
	}
}
