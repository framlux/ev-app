import mqtt from 'mqtt'
import type { PublishQueue, QueuedFrame } from './queue.js'

/**
 * THE MQTT SIDE OF THE CONNECTOR (design §5.5).
 *
 * `Publisher` empties the `PublishQueue` into the broker, one frame at a time,
 * each acknowledged before the next goes out. It owns no policy beyond that:
 * what a failure means (a counter, an alert) is the connector's, and arrives
 * through the hooks; what to do about a full queue is the connector's, and
 * arrives through `PublishQueue.push`. Nothing in here throws, and nothing in
 * here logs, because a frame body is the car's data and an MQTT error can name
 * the broker.
 */

/**
 * How long to wait after a failed publish before trying that frame again.
 *
 * Fixed and short, unlike the 30 s floor on Rivian (design §2.3): that floor
 * exists because Rivian rate-limits and flags accounts, and this is our own
 * broker, where waiting longer only lets the queue fill.
 *
 * A "failed publish" is narrower than it sounds, and an outage is NOT one.
 * With QoS 1 and `reconnectPeriod` set, mqtt.js keeps an unacknowledged
 * publish in its own store and resends it, with the DUP flag, once it has
 * reconnected; the callback simply does not fire until the broker answers. So
 * with the broker down the frame stays in flight, the queue grows behind it,
 * and nothing here is called (against an unreachable broker, mqtt.js 5.15.2
 * held one frame in flight for five seconds and called `onFailure` zero times). The
 * callback gets an error only when the client throws synchronously, when
 * mqtt.js reports "Connection closed" for a publish made while it was
 * replaying its store as the connection dropped, and with "client
 * disconnecting" for one made after `end`. Those can all come back at once,
 * so the wait is what keeps a client that fails every publish from spinning;
 * one second is short enough that it costs almost no ordering delay.
 */
const RETRY_MS = 1_000

/**
 * How long a graceful `end` may take before `Publisher.end` gives up on it.
 *
 * A graceful end sends DISCONNECT and then waits for the connection to close
 * from the broker's side. A connection that is already dead without anyone
 * having noticed (a broker that vanished without a FIN, a network that
 * dropped) never completes that, and mqtt.js has no limit of its own. The
 * shutdown that calls this has already spent its 5 s draining (design §5.2)
 * and is racing the orchestrator's grace period, so the step that finishes it
 * cannot be the one with no bound. Five seconds is generous for a DISCONNECT
 * to a broker on the same network, and still leaves the grace period most of
 * its room.
 */
const END_GRACE_MS = 5_000

/**
 * The part of an mqtt.js client the publisher drives, which is what keeps the
 * tests off a real broker: they hand in a fake that answers when told to.
 */
export interface MqttLike {
  /** `cb` gets an error if the publish failed, nothing once the broker has acknowledged it. */
  publish(
    topic: string,
    body: string,
    opts: { qos: 1; retain: false },
    cb: (err?: Error) => void,
  ): void
  end(force?: boolean, cb?: () => void): void
}

export interface PublisherHooks {
  /** One frame was acknowledged by the broker. */
  onPublished(): void
  /**
   * One publish failed. The frame is back at the head of the queue and will be
   * retried. This is NOT how a broker outage shows up (see `RETRY_MS`): during
   * one the frame stays in flight and no failure is reported.
   */
  onFailure(err: unknown): void
}

export interface ConnectionHooks {
  /**
   * The connection came up (`true`) or went away (`false`). A drop calls it
   * with `false` more than once (mqtt.js emits `close` and `offline`), so a
   * listener must be idempotent.
   */
  onConnectionChange?(connected: boolean): void
}

export class Publisher {
  /**
   * The frame that has been handed to the client and not yet answered. It is
   * out of the queue (the queue's byte count does not include it) but still
   * owed to the broker, so `drain` counts it as left and a failure puts it back.
   */
  #inFlight: QueuedFrame | null = null
  /** The pending retry after a failure. While it is set, `pump` publishes nothing. */
  #retry: ReturnType<typeof setTimeout> | null = null
  #ending = false
  #ended: Promise<void> | null = null
  readonly #emptyListeners: Array<() => void> = []
  /** One per `drain` that is waiting; each resolves its own promise and clears its own timer. */
  readonly #drainWaiters = new Set<() => void>()

  constructor(
    private readonly client: MqttLike,
    private readonly queue: PublishQueue,
    private readonly hooks: PublisherHooks,
  ) {}

  /**
   * Publish the frame at the head of the queue, if nothing is already out and
   * no retry is pending. Each acknowledgement calls this again, so one call is
   * enough to empty the queue; the connector calls it after every frame it
   * queues, which is why it has to be a no-op in the two cases above. A pump
   * during the retry wait that published anyway would turn the 1 s pause into
   * a retry per incoming frame.
   *
   * One frame at a time, never a window of them, because the order is the
   * tape's order: with several in flight a failure of the first would let the
   * second land ahead of it. The cost is a round trip per frame to a broker
   * on the same network, and the queue is what absorbs it.
   *
   * It never throws. A client that throws synchronously is handled as a failed
   * publish.
   */
  pump(): void {
    if (this.#ending || this.#inFlight !== null || this.#retry !== null) return
    const frame = this.queue.shift()
    if (frame === undefined) return

    this.#inFlight = frame
    // The client is meant to answer each publish once. Anything after the
    // first answer is ignored: a second would clear the in-flight marker of
    // whichever frame is out by then and start another publish alongside it,
    // which is the reordering that one-at-a-time exists to rule out.
    let answered = false
    const answer = (err?: Error): void => {
      if (answered) return
      answered = true
      this.#inFlight = null
      if (err) this.#failed(frame, err)
      else this.#acknowledged()
    }
    try {
      this.client.publish(frame.topic, frame.body, { qos: 1, retain: false }, answer)
    } catch (err) {
      // A fixed message: what was thrown can carry the topic or the payload.
      answer(err instanceof Error ? err : new Error('mqtt publish threw'))
    }
  }

  /**
   * Wait until every queued frame has been acknowledged, or `timeoutMs` has
   * passed, and say how many frames are still owed (the one in flight
   * included). This is the shutdown's 5 s (design §5.2): the caller has
   * already stopped reading the socket, so the queue only shrinks, and the
   * count it gets back is the frames to report as dropped.
   *
   * It starts the pump, so it works whether or not anything had pumped since
   * the last frame was queued. Resolving early, the moment the queue empties,
   * is what keeps a clean shutdown from always costing the full timeout.
   */
  drain(timeoutMs: number): Promise<number> {
    if (this.#left() === 0) return Promise.resolve(0)

    return new Promise((resolve) => {
      const empty = (): void => {
        clearTimeout(timer)
        this.#drainWaiters.delete(empty)
        resolve(0)
      }
      const timer = setTimeout(() => {
        this.#drainWaiters.delete(empty)
        resolve(this.#left())
      }, timeoutMs)
      // Registered before the pump starts, so a client that answers at once
      // cannot empty the queue in a gap where nobody is listening.
      this.#drainWaiters.add(empty)
      this.pump()
    })
  }

  /**
   * End the MQTT client, and resolve once it says it has. Publishing stops
   * and a pending retry is cancelled, so nothing can start after this returns.
   *
   * It ends the client gracefully (a DISCONNECT, after waiting for the broker)
   * unless a publish is still unacknowledged, in which case it forces the
   * close. mqtt.js's graceful end waits for every outstanding publish to be
   * acknowledged, with no limit, and the usual reason for ending with one still
   * out is that `drain` gave up on a broker that is not answering. Waiting
   * for it here would hang the shutdown until the orchestrator killed the
   * process, losing the `complete` frames and the status write that come after.
   * The session is clean, so a forced close leaves no state behind on the
   * broker, and the frame that was out is still counted as left. A graceful
   * end that has not finished within `END_GRACE_MS` is forced the same way, so
   * this always resolves.
   *
   * Safe to call more than once: later calls get the first call's answer.
   */
  end(): Promise<void> {
    if (this.#ended === null) {
      // `#ending` is set before the client is touched: ending a client can
      // fail its outstanding publishes at once, and those failures must find
      // the publisher already stopped rather than schedule a retry.
      this.#ending = true
      if (this.#retry !== null) {
        clearTimeout(this.#retry)
        this.#retry = null
      }
      const force = this.#inFlight !== null
      this.#ended = new Promise<void>((resolve) => {
        // Only a graceful end can hang, so only it gets the timer. It is set
        // before the client is called, so a client that answers at once
        // finds a timer to clear. When it fires, the close is forced and this
        // resolves without waiting for the client to say so: a bound that
        // waited on the thing that just overran it would not be one. (mqtt.js
        // ignores a second `end` while one is under way, so the forced call
        // may not tear the connection down itself. What matters is that the
        // shutdown gets to go on and the process gets to exit.)
        let timer: ReturnType<typeof setTimeout> | undefined
        const finished = (): void => {
          clearTimeout(timer)
          resolve()
        }
        if (!force) {
          timer = setTimeout(() => {
            this.#guard(() => this.client.end(true))
            resolve()
          }, END_GRACE_MS)
        }
        this.client.end(force, finished)
      })
    }
    return this.#ended
  }

  /**
   * Call `fn` whenever the queue becomes empty: the last frame in it has been
   * acknowledged, with nothing in flight and nothing behind it. It does not
   * fire between frames, for a failed publish, or when pumped with nothing to
   * send. The connector uses it to schedule the renewal that follows a drop
   * (the resubscribe's snapshot frames have all reached the broker by then).
   * Listeners are added, not replaced, and never removed.
   */
  onEmpty(fn: () => void): void {
    this.#emptyListeners.push(fn)
  }

  /** Frames still owed to the broker: those in the queue and the one in flight. */
  #left(): number {
    return this.queue.length + (this.#inFlight === null ? 0 : 1)
  }

  #acknowledged(): void {
    this.#guard(() => this.hooks.onPublished())
    if (this.queue.length > 0) {
      this.pump()
      return
    }
    for (const resolve of [...this.#drainWaiters]) resolve()
    for (const fn of this.#emptyListeners) this.#guard(fn)
  }

  #failed(frame: QueuedFrame, err: unknown): void {
    // Back at the head, ahead of the frames queued behind it, so a failure
    // does not reorder the tape. The frame is not lost however many times it
    // fails: it waits here, the queue fills behind it, and the queue's cap is
    // what finally decides whether anything is dropped.
    this.queue.unshift(frame)
    // After `end` there is nothing to retry against: the failure is the
    // shutdown itself (a forced close fails the publish that was out).
    if (!this.#ending) {
      this.#retry = setTimeout(() => {
        this.#retry = null
        this.pump()
      }, RETRY_MS)
    }
    this.#guard(() => this.hooks.onFailure(err))
  }

  /**
   * Run a callback the caller supplied, and swallow what it throws. The state
   * is always settled before a callback runs, so one that throws cannot strand
   * a frame in flight, but it would still unwind through mqtt.js's own event
   * handling, and one broken metrics hook should not take the publisher (and
   * with it the whole connector's output) down. There is nowhere to report it:
   * the hooks are the reporting.
   */
  #guard(fn: () => void): void {
    try {
      fn()
    } catch {
      // See above.
    }
  }
}

/**
 * Connect to the broker as the connector.
 *
 * `clientId` is the connector's own `ev-rivian` and no other process's: MQTT
 * permits one live connection per client id, so a collision has the broker
 * disconnect the incumbent, which reconnects and disconnects the other, for ever.
 *
 * `clean: true` is right here, and it is the opposite of what ingest does
 * (`clean: false`, a durable session). A durable session is the broker keeping
 * what a client is SUBSCRIBED to, and queueing messages for it while it is
 * away. The connector only publishes and has no subscriptions to keep, so
 * there is nothing for the broker to hold, and a persistent session would
 * just leave state on the broker under `ev-rivian` for no reader. The
 * durability that matters is elsewhere: the publish queue here, and the
 * broker's queue for ingest's session.
 *
 * The `error` listener is here because without one an mqtt.js error (a refused
 * connection, a keepalive timeout) is an `error` event nobody handles, which
 * Node turns into an uncaught exception that kills the process. A broker that
 * is down must cost frames waiting in the queue, not the connector. The
 * listener discards the error itself, and so does everything below it: it can
 * name the broker, and this is a connection that carries a password.
 *
 * An outage is NOT reported through `Publisher`'s `onFailure` (see `RETRY_MS`):
 * mqtt.js holds the frame in flight and resends it after reconnecting. While
 * the broker is away the queue grows behind that frame, and `PublishQueue.push`'s
 * drop count is the only queue-side signal. Whether the connection is up is
 * what `hooks.onConnectionChange` is for, and it carries a boolean and nothing
 * else.
 */
export function connectMqtt(
  opts: {
    url: string
    username: string
    password: string
    clientId: string
  },
  hooks: ConnectionHooks = {},
): MqttLike {
  const client = mqtt.connect(opts.url, {
    clientId: opts.clientId,
    username: opts.username,
    password: opts.password,
    clean: true,
    reconnectPeriod: 2000,
  })
  client.on('error', () => {})

  // Called as mqtt.js emits, with no attempt to collapse repeats: a drop emits
  // both `close` and `offline`, and a failed reconnect emits `close` again, so
  // a listener has to be idempotent (a gauge being set is). A hook that throws
  // is swallowed, since it would otherwise unwind through mqtt.js's emitter.
  const changed = (connected: boolean): void => {
    try {
      hooks.onConnectionChange?.(connected)
    } catch {
      // See above.
    }
  }
  client.on('connect', () => changed(true))
  client.on('close', () => changed(false))
  client.on('offline', () => changed(false))
  return client
}
