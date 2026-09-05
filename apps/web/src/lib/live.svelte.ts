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

/**
 * How often the store's clock advances.
 *
 * Staleness is a function of elapsed time, and nothing else in this store
 * changes while a car sits parked: no events arrive, so no assignment happens,
 * so no `$derived` anywhere recomputes. Without a ticking value in the reactive
 * graph, an indicator reading `Date.now()` would compute "fresh" once and hold
 * that answer forever — claiming Live over an hour-old number, which is exactly
 * what the design forbids. This is that value.
 */
export const CLOCK_MS = 15_000

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
	/** The repeating clock tick. Separate seam so tests can drive it by hand. */
	tick?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
	untick?: (id: ReturnType<typeof setInterval>) => void
	now?: () => number
	/** Returns the status code of an authenticated probe request. */
	probe?: () => Promise<number>
	redirect?: (to: string) => void
}

export interface LiveStore {
	readonly vehicles: Record<string, VehicleWithState>
	readonly connection: ConnectionState
	/** When the last VEHICLE update landed. Heartbeats do not move this: they
	 *  prove the stream is alive, not that the car said anything.
	 *
	 *  ARRIVAL time, so it answers "is the stream delivering", not "how old is
	 *  this reading" — a snapshot on reconnect delivers a six-hour-old sample
	 *  and moves this. Staleness of the DATA is judged from the sample's own
	 *  `state.ts` against `clock`; see LiveIndicator. */
	readonly lastEventAt: number | null
	/** A value that advances on its own, so time-based derivations recompute.
	 *  Read it in any `$derived` that compares against a timestamp. */
	readonly clock: number
	start(): void
	stop(): void
	get(id: string): VehicleWithState | undefined
}

export function createLiveStore(opts: LiveStoreOptions = {}): LiveStore {
	const createSource = opts.createSource ?? ((url: string) => new EventSource(url))
	const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms))
	const scheduleWatchdog = opts.scheduleWatchdog ?? schedule
	const unschedule = opts.unschedule ?? ((id) => clearTimeout(id))
	const tick = opts.tick ?? ((fn, ms) => setInterval(fn, ms))
	const untick = opts.untick ?? ((id) => clearInterval(id))
	const browser = opts.browser ?? typeof window !== 'undefined'
	const now = opts.now ?? (() => Date.now())
	const probe = opts.probe ?? (async () => (await fetch('/api/v1/vehicles')).status)
	const redirect = opts.redirect ?? ((to: string) => { window.location.href = to })

	let vehicles = $state<Record<string, VehicleWithState>>({})
	let connection = $state<ConnectionState>('connecting')
	let lastEventAt = $state<number | null>(null)
	let clock = $state(0)

	let source: EventSource | null = null
	let failures = 0
	let stopped = false
	let watchdog: ReturnType<typeof setTimeout> | undefined
	let ticker: ReturnType<typeof setInterval> | undefined
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
		// Also advances the clock, so an arriving event refreshes a staleness
		// derivation immediately rather than at the next tick. Note that setting
		// `connection` alone would NOT: Svelte's `$state` compares with `===` and
		// assigning 'open' over 'open' schedules nothing.
		clock = now()
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
				// Never go backwards in time.
				//
				// The stream carries two kinds of frame and they can overtake each
				// other: incremental updates, and the whole-fleet snapshot sent on
				// connect and after a listener reconnect. The subscriber is
				// registered before the snapshot's query returns, so an update can
				// be written while that query is still in flight and then be
				// followed by the snapshot's older row. Dropping anything older than
				// what we already hold makes the order they arrive in irrelevant.
				const current = vehicles[id]
				const incomingTs = Date.parse(entry.state?.ts ?? '')
				const currentTs = Date.parse(current?.state?.ts ?? '')
				if (current && Number.isFinite(incomingTs) && Number.isFinite(currentTs) && incomingTs < currentTs) {
					return
				}
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
		get clock() { return clock },
		start(): void {
			// Browser only. During SSR there is no EventSource, and a page that
			// constructed one while rendering on the server would throw on every
			// request.
			if (!browser || source || stopped) return
			clock = now()
			ticker = tick(() => { clock = now() }, CLOCK_MS)
			connect()
		},
		stop(): void {
			stopped = true
			source?.close()
			source = null
			if (watchdog !== undefined) unschedule(watchdog)
			if (ticker !== undefined) untick(ticker)
		},
		get: (id: string) => vehicles[id]
	}
}

/** The app-wide instance. Components read this; nothing else builds one. */
export const live = createLiveStore()
