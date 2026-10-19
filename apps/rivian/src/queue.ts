import {
  ENVELOPE_VERSION,
  cleanStrings,
  rivianTopic,
  type RivianEnvelope,
  type RivianStream,
} from '@ev/rivian'

/**
 * THE BUFFER BETWEEN THE SOCKET AND THE BROKER (design §5.5).
 *
 * The socket reader hands every frame to this queue and carries on, and the
 * publisher takes frames off it at the broker's pace. That separation is the
 * point. The reader may never wait on MQTT, because Rivian closes a consumer
 * that reads slowly, and a close costs far more than a dropped frame: it sends
 * the connector into the 30 s backoff and loses everything the car says while
 * it waits. So when the broker is slow or gone, the queue absorbs the frames,
 * and when the queue is full, it throws the OLDEST away. Oldest, because the
 * newest frames are the ones that describe the car now, and the resubscribe
 * the connector does after any drop (the snapshot re-sends current values)
 * makes up the difference for what was lost.
 *
 * The bound is in BYTES of serialised envelope, not frames: the streams differ
 * widely in how big a frame is (a `cloud` connection flag against a whole
 * `charging` or `parallax` payload), so a frame count would let the memory in
 * use swing with whichever stream happened to be busy. 32 MiB is the cap the
 * design settled on (§5.5): a bounded cost for an outage, however long it
 * runs, and the honest limit of a car that does not buffer for itself.
 */
export const QUEUE_CAP_BYTES = 32 * 1024 * 1024

/**
 * One envelope, serialised and ready to publish. `bytes` is the UTF-8 length of
 * `body`, measured once when the frame is built so the queue's accounting never
 * has to re-measure (or re-serialise) a frame it is only moving.
 */
export interface QueuedFrame {
  topic: string
  body: string
  bytes: number
}

/**
 * A FIFO bounded by bytes. It does no I/O and has no timers, so what it does
 * with an overflow is what its caller is told: `push` returns how many frames
 * it had to drop, and a non-zero answer is the signal the connector acts on
 * (count the drops, resubscribe everything). Nothing else reports a drop, and
 * a drop that goes unreported is a hole in the tape that nothing would ever
 * explain.
 */
export class PublishQueue {
  // Frames are stored in an array read from `#head`, rather than shifted off
  // the front. `Array.prototype.shift` moves every remaining element, which is
  // cheap for a handful and not for the hundred thousand small frames 32 MiB
  // can hold, and this queue drops one frame per push for as long as an outage
  // lasts. Taken slots are cleared so the frame can be collected at once, and
  // the array is cut down when the dead prefix is as long as the live part.
  #frames: Array<QueuedFrame | undefined> = []
  #head = 0
  #bytes = 0

  constructor(private readonly capBytes: number = QUEUE_CAP_BYTES) {}

  /** Frames waiting. */
  get length(): number {
    return this.#frames.length - this.#head
  }

  /** The serialised size of the frames waiting. */
  get bytes(): number {
    return this.#bytes
  }

  /**
   * Add a frame at the tail, dropping the oldest frames until the total fits
   * the cap again, and return how many were dropped.
   *
   * The newest frame is never the one dropped. A single frame larger than the
   * whole cap is accepted on its own, with everything else dropped to make room:
   * refusing it would drop the freshest data to keep the stalest, and one frame
   * that size is one frame of memory, not the unbounded growth the cap is for.
   */
  push(frame: QueuedFrame): number {
    this.#frames.push(frame)
    this.#bytes += frame.bytes

    let dropped = 0
    while (this.#bytes > this.capBytes && this.length > 1) {
      this.#take()
      dropped += 1
    }
    return dropped
  }

  /** Remove and return the oldest frame, or undefined if there is none. */
  shift(): QueuedFrame | undefined {
    return this.#take()
  }

  /**
   * Put a frame back at the head: the one the publisher took, whose publish
   * then failed. It must go back AHEAD of everything behind it, or a broker
   * blip would reorder the tape.
   *
   * It never drops anything. While the frame was out of the queue its bytes
   * were not counted, so the queue may have filled to the cap behind it, and
   * putting it back can overshoot the cap by that one frame. The overshoot
   * stands until the next `push`, which drops from the head (this frame, the
   * oldest) and reports it as it reports any drop. Dropping here instead would
   * lose a frame with no way to tell the caller, since `unshift` is not where
   * the connector looks for drops.
   */
  unshift(frame: QueuedFrame): void {
    if (this.#head > 0) {
      this.#head -= 1
      this.#frames[this.#head] = frame
    } else {
      this.#frames.unshift(frame)
    }
    this.#bytes += frame.bytes
  }

  #take(): QueuedFrame | undefined {
    const frame = this.#frames[this.#head]
    if (frame === undefined) return undefined

    this.#frames[this.#head] = undefined
    this.#head += 1
    this.#bytes -= frame.bytes

    if (this.#head === this.#frames.length) {
      this.#frames = []
      this.#head = 0
    } else if (this.#head >= 1024 && this.#head * 2 >= this.#frames.length) {
      this.#frames = this.#frames.slice(this.#head)
      this.#head = 0
    }
    return frame
  }
}

/**
 * Build the frame for one thing the connector has to publish: the v1 envelope
 * (design §5.5), cleaned, serialised and measured.
 *
 * `receivedAt` is the connector's clock when the frame ARRIVED, passed in by
 * the caller and not read here, so it is the arrival time even if the frame
 * sits in the queue for an hour. That is the one honest answer to "when did we
 * learn this" once a backlog is draining.
 *
 * The clean is `cleanStrings` over the WHOLE envelope, not just `body`: the VIN
 * and the stream are strings too, and the rule is that no string reaches the
 * broker that Postgres JSONB would reject. A taped frame it rejects rolls its
 * transaction back, is never acknowledged, and is redelivered for ever. Ingest
 * cleans again before taping, so neither side can be the one that wedges the
 * other. The topic is built from the cleaned VIN, so it and the envelope can
 * never disagree about which car this is.
 *
 * `bytes` is measured on the serialised text, in UTF-8, because that is what
 * the queue's cap stands in for: the memory the text takes and the bytes
 * the broker is sent. A character count would undercount every non-ASCII
 * name in a frame.
 */
export function frameFor(
  vin: string,
  stream: RivianStream,
  receivedAt: Date,
  body: unknown,
): QueuedFrame {
  const envelope = cleanStrings<RivianEnvelope>({
    v: ENVELOPE_VERSION,
    stream,
    vin,
    receivedAt: receivedAt.toISOString(),
    body,
  })
  const text = JSON.stringify(envelope)
  return {
    topic: rivianTopic(envelope.vin, stream),
    body: text,
    bytes: Buffer.byteLength(text, 'utf8'),
  }
}
