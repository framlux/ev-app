import type { VehicleWithState } from '$lib/api-types.js'

/**
 * The browser's end of the live stream. One EventSource for the whole app.
 *
 * WHY THIS OWNS ITS RECONNECT, when EventSource has one built in: the built-in
 * retry covers a connection that DROPS. A retry that gets a response back does
 * not retry again — per the HTML spec, a non-200 status or the wrong
 * content-type fails the connection permanently: readyState goes to CLOSED and
 * that is the end of it. This app produces exactly those responses on exactly
 * this endpoint: a text/plain 401 when the session expires behind an open tab,
 * a 503 when the database is down, and — on a single-replica deployment —
 * Traefik's own 503 for the seconds a pod takes to restart, which the 3-second
 * default retry lands squarely inside. Left to the browser, one deploy would
 * silently kill live updates in every open tab until someone reloaded, which is
 * the exact failure this feature exists to remove.
 */

/** No heartbeat and no event for this long means the connection is dead. */
export const STREAM_DEAD_MS = 45_000

/** Consecutive failures before we suspect the session rather than the pod. */
export const PROBE_AFTER_FAILURES = 3

const STREAM_URL = '/api/v1/stream'
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000]

export type ConnectionState = 'connecting' | 'open' | 'reconnecting'

export interface LiveStoreOptions {
	/** Defaults to `typeof window !== 'undefined'`. Tests drive the store directly. */
	browser?: boolean
	createSource?: (url: string) => EventSource
	schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
	/** The watchdog's timer, separate so a test can inspect the reconnect queue alone. */
	scheduleWatchdog?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
	unschedule?: (id: ReturnType<typeof setTimeout>) => void
	now?: () => number
	/** Returns the status code of an authenticated probe request. */
	probe?: () => Promise<number>
	redirect?: (to: string) => void
}

export interface LiveStore {
	readonly vehicles: Record<string, VehicleWithState>
	readonly connection: ConnectionState
	/** When the last VEHICLE update landed. Heartbeats do not move this: they
	 *  prove the stream is alive, not that the car said anything. */
	readonly lastEventAt: number | null
	start(): void
	stop(): void
	get(id: string): VehicleWithState | undefined
}

export function createLiveStore(opts: LiveStoreOptions = {}): LiveStore {
	const createSource = opts.createSource ?? ((url: string) => new EventSource(url))
	const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms))
	const scheduleWatchdog = opts.scheduleWatchdog ?? schedule
	const unschedule = opts.unschedule ?? ((id) => clearTimeout(id))
	const browser = opts.browser ?? typeof window !== 'undefined'
	const now = opts.now ?? (() => Date.now())
	const probe = opts.probe ?? (async () => (await fetch('/api/v1/vehicles')).status)
	const redirect = opts.redirect ?? ((to: string) => { window.location.href = to })

	let vehicles = $state<Record<string, VehicleWithState>>({})
	let connection = $state<ConnectionState>('connecting')
	let lastEventAt = $state<number | null>(null)

	let source: EventSource | null = null
	let failures = 0
	let stopped = false
	let watchdog: ReturnType<typeof setTimeout> | undefined
	let lastAnyAt = 0

	const armWatchdog = (): void => {
		if (watchdog !== undefined) unschedule(watchdog)
		watchdog = scheduleWatchdog(() => {
			// Open but silent for longer than two heartbeats: the socket is up as
			// far as the browser knows and nothing is coming through it. Treat it
			// as a failure so the ordinary reconnect path runs.
			if (!stopped && now() - lastAnyAt >= STREAM_DEAD_MS) onFailure()
			else armWatchdog()
		}, STREAM_DEAD_MS)
	}

	const alive = (): void => {
		lastAnyAt = now()
		failures = 0
		connection = 'open'
	}

	const connect = (): void => {
		if (stopped) return
		// A used EventSource is never reused: close it, build a new one. Leaving
		// the old one attached would double every event if it ever recovered.
		source?.close()
		const next = createSource(STREAM_URL)
		source = next

		next.addEventListener('open', () => alive())
		next.addEventListener('heartbeat', () => alive())
		next.addEventListener('vehicle', (e) => {
			alive()
			try {
				const entry = JSON.parse((e as MessageEvent).data) as VehicleWithState
				const id = entry?.vehicle?.id
				if (!id) return
				// Reassigned rather than mutated: $state tracks the assignment, and a
				// deep mutation of a value that arrived as JSON would not notify.
				vehicles = { ...vehicles, [id]: entry }
				lastEventAt = now()
			} catch {
				// A frame we cannot read is a dropped update, not a broken stream.
			}
		})
		next.addEventListener('error', () => onFailure())

		lastAnyAt = now()
		armWatchdog()
	}

	const onFailure = (): void => {
		if (stopped) return
		connection = 'reconnecting'
		source?.close()
		source = null
		const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]!
		failures++
		if (failures >= PROBE_AFTER_FAILURES) void checkSession()
		schedule(connect, wait)
	}

	/**
	 * Is the stream failing because we are signed out?
	 *
	 * It cannot be read off the error event — that is a bare Event with no
	 * status — so after enough consecutive failures we ask an endpoint that
	 * answers plainly. Retrying forever against a gate that will keep refusing
	 * is the alternative, and it looks identical to an outage.
	 */
	const checkSession = async (): Promise<void> => {
		try {
			if ((await probe()) === 401) redirect('/auth/login')
		} catch {
			// The probe failing is itself uninformative — the network is down, which
			// the reconnect loop already handles.
		}
	}

	return {
		get vehicles() { return vehicles },
		get connection() { return connection },
		get lastEventAt() { return lastEventAt },
		start(): void {
			// Browser only. During SSR there is no EventSource, and a page that
			// constructed one while rendering on the server would throw on every
			// request.
			if (!browser || source || stopped) return
			connect()
		},
		stop(): void {
			stopped = true
			source?.close()
			source = null
			if (watchdog !== undefined) unschedule(watchdog)
		},
		get: (id: string) => vehicles[id]
	}
}

/** The app-wide instance. Components read this; nothing else builds one. */
export const live = createLiveStore()
