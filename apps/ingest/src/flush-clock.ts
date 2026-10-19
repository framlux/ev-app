/**
 * The clock the flush timer asks "is the pending burst due?" in.
 *
 * Emission is arrival-triggered, and the timer exists for the burst nothing
 * follows: it flushes what has sat quiet for QUIET_PERIOD_MS. "Quiet" is judged
 * between a burst's stamp and "now", so the two have to be in the same
 * timeline.
 *
 * For Tesla they are: the stamp IS our arrival time, so wall time is the right
 * "now". For Rivian the stamp is the CONNECTOR's clock (spec §6.2), and while a
 * backlog drains it runs minutes or hours behind ours. Against our wall clock
 * every pending burst would look overdue the moment it was accumulated, and each
 * would be written alone, splitting what should have been one sample into one
 * per message.
 *
 * So the clock keeps how far behind the newest message it was seen to be, and
 * reports wall time minus that. It is the stamp's timeline, advanced by our own
 * elapsed time: during a drain it moves with the drain, and once the backlog is
 * gone the skew shrinks to the connector-to-ingest latency and it is wall time
 * again. Tesla's skew is the few milliseconds between the handler stamping a
 * message and this observing it, which is nothing, so nothing changes there.
 *
 * Shutdown's forced flush does not use it: force ignores the quiet period, so no
 * timeline is being asked about.
 */
export interface FlushClock {
  /** Note a message's stamp: the skew becomes how far behind it we are right now. */
  observe(receivedAt: Date): void
  /** "Now", in the timeline of the stamps `observe` has seen. */
  now(): Date
}

/** `now` is injectable for tests; it is milliseconds since the epoch, as `Date.now`. */
export function flushClock(now: () => number = () => Date.now()): FlushClock {
  let skewMs = 0
  return {
    observe(receivedAt) {
      const stamp = receivedAt.getTime()
      // An invalid date would make the skew NaN, every later `now()` an Invalid
      // Date, and the flush timer would compare against it and never fire: the
      // last burst before the car parks would sit in memory for good. The
      // handlers never hand one over (they fall back to arrival time), but the
      // clock is the last thing that should be able to stop a flush.
      if (Number.isNaN(stamp)) return
      skewMs = now() - stamp
    },
    now() {
      return new Date(now() - skewMs)
    },
  }
}
