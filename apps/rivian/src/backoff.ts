/**
 * HOW LONG TO WAIT BEFORE TRYING RIVIAN AGAIN (design §2.3, §5.2).
 *
 * Every way the connection can fail ends in this one schedule: 30 s doubling
 * with each consecutive failure, plus up to 30 s of random jitter, capped at
 * 900 s. The reference client uses the same numbers, and its latest fix was
 * for a reconnect storm that came from ignoring a rate limit, so the floor is a
 * hard rule, not a starting point. No failure path may reconnect faster than
 * twice a minute, and "no ack", "rate limited" and "closed for no stated
 * reason" all share the floor with no exceptions made for the ones that look
 * harmless.
 *
 * The jitter is what keeps a fleet of restarted connectors (after a deploy, or
 * a Rivian outage ending) from knocking on the door in the same second.
 */

/** The first wait, and the width of the jitter added to every wait. */
export const BACKOFF_FLOOR_MS = 30_000

/** No wait is longer than this, however many failures in a row. */
export const BACKOFF_CAP_MS = 900_000

export class Backoff {
  #attempt = 0

  /**
   * `random` is the jitter source, `Math.random` unless a test says otherwise.
   * It is expected to return a number from 0 up to (not including) 1.
   */
  constructor(private readonly random: () => number = Math.random) {}

  /** How many waits have been handed out since the last `reset`. */
  get attempt(): number {
    return this.#attempt
  }

  /**
   * The next wait, in ms: `floor * 2^attempt + random() * floor`, capped. Each
   * call counts as a failed attempt, so the next one is longer.
   *
   * The result is never below the floor, whatever the jitter source returns.
   * A source that gave NaN or a negative would make a timer fire at once (a
   * timer of NaN does), which is the reconnect storm this class exists to rule
   * out, so the draw is forced into 0..1 before it is used. `2 ** attempt`
   * overflows to Infinity near attempt 1024; Infinity plus a finite jitter is
   * still Infinity, and the cap turns it back into 900 s.
   */
  next(): number {
    const draw = this.random()
    const jitter = Number.isFinite(draw) ? Math.min(1, Math.max(0, draw)) : 0
    const wait = BACKOFF_FLOOR_MS * 2 ** this.#attempt + jitter * BACKOFF_FLOOR_MS
    this.#attempt += 1
    return Math.min(BACKOFF_CAP_MS, wait)
  }

  /**
   * Forget the failures. The connector calls this when data flows (the first
   * `next` after a connect), not on `connection_ack`: a server that acknowledges
   * and then closes in the same breath has not recovered, and resetting on the
   * ack would turn that into a 30 s reconnect loop.
   */
  reset(): void {
    this.#attempt = 0
  }
}
