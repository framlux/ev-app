import {
	createChangeListener,
	parseVehicleChange,
	VEHICLE_CHANGED_CHANNEL,
	type ChangeListener
} from '@ev/db'
import { createHub, type Hub } from './live.js'
import { getVehicleLive, listVehiclesLive } from './queries.js'

/**
 * The process-wide bridge from Postgres notifications to open streams.
 *
 * Started lazily, on the first stream to open, rather than at module load. A
 * pod that nobody is watching should not hold a database connection open, and
 * more practically: module load happens during `vite build`'s SSR analysis and
 * in unit tests, neither of which has a database to connect to.
 *
 * There is deliberately no `stop()`. The listener lives as long as the process,
 * and the process is killed by Kubernetes; adding a teardown path would create
 * a second state ("stopped but a stream is open") that nothing needs.
 */
let hub: Hub | undefined
let listener: ChangeListener | undefined

export function getLiveHub(): Hub {
	if (hub) return hub

	// The PROJECTED queries, not the REST ones (spec §3.8). A full VehicleState
	// is ~204 fields and this hub sends one per notification and one per vehicle
	// per snapshot, to every open tab; the pages that render a streamed entry
	// read about thirty of them. Swapping these back for getVehicle/listVehicles
	// would still pass every test about what the pages show.
	hub = createHub({
		getVehicle: (id) => getVehicleLive(id),
		listVehicles: () => listVehiclesLive(),
		onError: (err) => console.error('live hub', err)
	})

	listener = createChangeListener(VEHICLE_CHANGED_CHANNEL, {
		onPayload: (raw) => {
			const change = parseVehicleChange(raw)
			// A payload we cannot read is dropped, never thrown: it crosses a
			// process boundary from a worker that may be a different version, and
			// the next sample repairs the miss.
			if (change) hub!.handle(change)
			else console.warn('live: unparseable notification payload')
		},
		// Fires on the first connect and on every reconnect. Resyncing on the
		// first is harmless; resyncing on the rest is essential, because
		// notifications that arrived while disconnected are gone and Postgres
		// does not replay them.
		onConnected: () => hub!.resync(),
		onError: (err) => console.error('live listener', err)
	})
	listener.start()

	return hub
}
