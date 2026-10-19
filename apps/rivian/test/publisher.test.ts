import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Publisher, connectMqtt, type MqttLike } from '../src/publisher.js'
import { PublishQueue, frameFor } from '../src/queue.js'

// connectMqtt is the one function here that would reach for a real broker, so
// `mqtt` is replaced for the whole file. The fake client is a real
// EventEmitter on purpose: whether an 'error' with no listener throws is
// exactly the behaviour under test, and a plain object would not have it.
const mqttMock = vi.hoisted(() => ({
  connect: vi.fn(),
}))
vi.mock('mqtt', () => ({ default: mqttMock }))

interface PublishCall {
  topic: string
  body: string
  opts: { qos: 1; retain: false }
  cb: (err?: Error) => void
}

/** An MQTT client that does nothing until the test says the broker answered. */
class FakeMqtt implements MqttLike {
  readonly published: PublishCall[] = []
  readonly ends: (boolean | undefined)[] = []
  throwOnPublish: Error | null = null

  publish(
    topic: string,
    body: string,
    opts: { qos: 1; retain: false },
    cb: (err?: Error) => void,
  ): void {
    if (this.throwOnPublish) throw this.throwOnPublish
    this.published.push({ topic, body, opts, cb })
  }

  end(force?: boolean, cb?: () => void): void {
    this.ends.push(force)
    cb?.()
  }

  /** The broker PUBACKs the nth publish. */
  ack(n: number): void {
    this.published[n]!.cb()
  }

  /** The nth publish fails, the way a closed connection fails it. */
  fail(n: number, message = 'Connection closed'): void {
    this.published[n]!.cb(new Error(message))
  }
}

const AT = new Date('2026-10-19T17:03:11.482Z')

/** Queue a frame whose body is `{ n }`, so a published body says which it was. */
function enqueue(queue: PublishQueue, n: number): void {
  queue.push(frameFor('VIN1', 'state', AT, { n }))
}

/** The `body.n` of the nth thing the fake client was asked to publish. */
function nOf(fake: FakeMqtt, index: number): number {
  return JSON.parse(fake.published[index]!.body).body.n
}

describe('Publisher', () => {
  let fake: FakeMqtt
  let queue: PublishQueue
  let hooks: { onPublished: ReturnType<typeof vi.fn>; onFailure: ReturnType<typeof vi.fn> }
  let publisher: Publisher

  beforeEach(() => {
    vi.useFakeTimers()
    fake = new FakeMqtt()
    queue = new PublishQueue()
    hooks = { onPublished: vi.fn(), onFailure: vi.fn() }
    publisher = new Publisher(fake, queue, hooks)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('publishes frames in order, at QoS 1 and not retained, one at a time', () => {
    enqueue(queue, 1)
    enqueue(queue, 2)
    enqueue(queue, 3)

    publisher.pump()
    expect(fake.published).toHaveLength(1)
    expect(fake.published[0]!.topic).toBe('rivian/VIN1/state')
    expect(fake.published[0]!.opts).toEqual({ qos: 1, retain: false })
    expect(nOf(fake, 0)).toBe(1)

    // Nothing more goes out while the first is unacknowledged, however often
    // the connector calls pump (it does, after every frame it queues).
    publisher.pump()
    publisher.pump()
    expect(fake.published).toHaveLength(1)
    expect(hooks.onPublished).not.toHaveBeenCalled()

    fake.ack(0)
    expect(hooks.onPublished).toHaveBeenCalledTimes(1)
    expect(fake.published).toHaveLength(2)
    expect(nOf(fake, 1)).toBe(2)

    fake.ack(1)
    expect(nOf(fake, 2)).toBe(3)
    fake.ack(2)

    expect(hooks.onPublished).toHaveBeenCalledTimes(3)
    expect(hooks.onFailure).not.toHaveBeenCalled()
    expect(queue.length).toBe(0)
  })

  it('does nothing when the queue is empty', () => {
    publisher.pump()
    expect(fake.published).toHaveLength(0)
  })

  it('publishes a frame that arrives after the queue ran dry when pumped again', () => {
    enqueue(queue, 1)
    publisher.pump()
    fake.ack(0)
    expect(fake.published).toHaveLength(1)

    enqueue(queue, 2)
    publisher.pump()
    expect(fake.published).toHaveLength(2)
    expect(nOf(fake, 1)).toBe(2)
  })

  describe('a failed publish', () => {
    it('reports the failure, keeps the frame at the head, and retries after 1 s', async () => {
      enqueue(queue, 1)
      enqueue(queue, 2)
      publisher.pump()

      const err = new Error('Connection closed')
      fake.published[0]!.cb(err)

      expect(hooks.onFailure).toHaveBeenCalledTimes(1)
      expect(hooks.onFailure).toHaveBeenCalledWith(err)
      expect(hooks.onPublished).not.toHaveBeenCalled()
      // Not lost, and still ahead of the frame behind it.
      expect(queue.length).toBe(2)
      expect(fake.published).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(999)
      expect(fake.published).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(1)
      expect(fake.published).toHaveLength(2)
      expect(fake.published[1]!.body).toBe(fake.published[0]!.body)
      expect(nOf(fake, 1)).toBe(1)

      fake.ack(1)
      expect(nOf(fake, 2)).toBe(2)
      fake.ack(2)
      expect(queue.length).toBe(0)
      expect(hooks.onPublished).toHaveBeenCalledTimes(2)
    })

    it('waits the full second on every failure, not just the first', async () => {
      enqueue(queue, 1)
      publisher.pump()

      for (let attempt = 0; attempt < 3; attempt++) {
        fake.fail(attempt)
        await vi.advanceTimersByTimeAsync(999)
        expect(fake.published).toHaveLength(attempt + 1)
        await vi.advanceTimersByTimeAsync(1)
        expect(fake.published).toHaveLength(attempt + 2)
      }
      expect(hooks.onFailure).toHaveBeenCalledTimes(3)
    })

    it('does not let a pump during the wait skip it', async () => {
      // The connector pumps after every frame it queues. A frame arriving
      // while the broker is down must not turn the 1 s wait into a retry per
      // frame.
      enqueue(queue, 1)
      publisher.pump()
      fake.fail(0)

      enqueue(queue, 2)
      publisher.pump()
      await vi.advanceTimersByTimeAsync(500)
      publisher.pump()
      expect(fake.published).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(500)
      expect(fake.published).toHaveLength(2)
      expect(nOf(fake, 1)).toBe(1)
    })

    it('treats a publish that throws as a failed publish, and never throws itself', async () => {
      enqueue(queue, 1)
      fake.throwOnPublish = new Error('invalid topic')

      expect(() => publisher.pump()).not.toThrow()
      expect(hooks.onFailure).toHaveBeenCalledTimes(1)
      expect(queue.length).toBe(1)

      fake.throwOnPublish = null
      await vi.advanceTimersByTimeAsync(1000)
      expect(fake.published).toHaveLength(1)
      expect(nOf(fake, 0)).toBe(1)
    })

    it('ignores a second answer to the same publish', async () => {
      enqueue(queue, 1)
      enqueue(queue, 2)
      publisher.pump()
      const first = fake.published[0]!

      first.cb()
      first.cb(new Error('Connection closed'))
      first.cb()

      expect(hooks.onPublished).toHaveBeenCalledTimes(1)
      expect(hooks.onFailure).not.toHaveBeenCalled()
      expect(fake.published).toHaveLength(2)
      expect(nOf(fake, 1)).toBe(2)
    })

    it('keeps pumping when a hook throws', async () => {
      // A metrics hook that throws must not strand the frame in flight: the
      // state is settled before the hook runs, so the pump carries on.
      hooks.onPublished.mockImplementationOnce(() => {
        throw new Error('metrics down')
      })
      hooks.onFailure.mockImplementationOnce(() => {
        throw new Error('metrics down')
      })
      enqueue(queue, 1)
      enqueue(queue, 2)
      publisher.pump()

      expect(() => fake.fail(0)).not.toThrow()
      await vi.advanceTimersByTimeAsync(1000)
      expect(fake.published).toHaveLength(2)

      expect(() => fake.ack(1)).not.toThrow()
      expect(fake.published).toHaveLength(3)
      expect(nOf(fake, 2)).toBe(2)
    })
  })

  describe('onEmpty', () => {
    it('fires when the last frame is acknowledged, not between frames', () => {
      const empty = vi.fn()
      publisher.onEmpty(empty)
      enqueue(queue, 1)
      enqueue(queue, 2)
      publisher.pump()

      fake.ack(0)
      expect(empty).not.toHaveBeenCalled()

      fake.ack(1)
      expect(empty).toHaveBeenCalledTimes(1)
    })

    it('fires again each time the queue empties, and for every listener', () => {
      const first = vi.fn()
      const second = vi.fn()
      publisher.onEmpty(first)
      publisher.onEmpty(second)

      enqueue(queue, 1)
      publisher.pump()
      fake.ack(0)
      enqueue(queue, 2)
      publisher.pump()
      fake.ack(1)

      expect(first).toHaveBeenCalledTimes(2)
      expect(second).toHaveBeenCalledTimes(2)
    })

    it('does not fire for a failed publish: the frame is still waiting', async () => {
      const empty = vi.fn()
      publisher.onEmpty(empty)
      enqueue(queue, 1)
      publisher.pump()

      fake.fail(0)
      await vi.advanceTimersByTimeAsync(1000)
      expect(empty).not.toHaveBeenCalled()

      fake.ack(1)
      expect(empty).toHaveBeenCalledTimes(1)
    })

    it('does not fire when pumped with nothing to send', () => {
      const empty = vi.fn()
      publisher.onEmpty(empty)
      publisher.pump()
      expect(empty).not.toHaveBeenCalled()
    })

    it('survives a listener that throws', () => {
      const after = vi.fn()
      publisher.onEmpty(() => {
        throw new Error('listener bug')
      })
      publisher.onEmpty(after)
      enqueue(queue, 1)
      publisher.pump()

      expect(() => fake.ack(0)).not.toThrow()
      expect(after).toHaveBeenCalledTimes(1)
    })
  })

  describe('drain', () => {
    it('resolves 0 at once when there is nothing to publish', async () => {
      expect(await publisher.drain(50)).toBe(0)
    })

    it('resolves the number of frames left when the broker never answers', async () => {
      enqueue(queue, 1)
      enqueue(queue, 2)
      publisher.pump()

      // One in flight and one waiting behind it: both are still owed.
      const drained = publisher.drain(50)
      await vi.advanceTimersByTimeAsync(49)
      let settled = false
      void drained.then(() => (settled = true))
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      expect(await drained).toBe(2)
    })

    it('resolves 0 as soon as the last frame is acknowledged, without waiting out the timeout', async () => {
      enqueue(queue, 1)
      enqueue(queue, 2)
      publisher.pump()

      const drained = publisher.drain(5_000)
      fake.ack(0)
      fake.ack(1)

      expect(await drained).toBe(0)
      // The timeout was cancelled with it: nothing is left to fire.
      expect(vi.getTimerCount()).toBe(0)
    })

    it('starts publishing if nobody has pumped yet', async () => {
      enqueue(queue, 1)

      const drained = publisher.drain(5_000)
      expect(fake.published).toHaveLength(1)
      fake.ack(0)

      expect(await drained).toBe(0)
    })

    it('counts frames waiting out a failed publish', async () => {
      enqueue(queue, 1)
      publisher.pump()
      fake.fail(0)

      const drained = publisher.drain(50)
      await vi.advanceTimersByTimeAsync(50)
      expect(await drained).toBe(1)
    })

    it('resolves every caller that is waiting', async () => {
      enqueue(queue, 1)
      publisher.pump()

      const a = publisher.drain(5_000)
      const b = publisher.drain(5_000)
      fake.ack(0)

      expect(await Promise.all([a, b])).toEqual([0, 0])
    })
  })

  describe('end', () => {
    it('ends the client gracefully when nothing is waiting on the broker', async () => {
      await publisher.end()
      expect(fake.ends).toEqual([false])
    })

    it('forces the client closed when a publish is still unacknowledged', async () => {
      // A graceful end waits for every outstanding publish to be acknowledged,
      // with no limit. If the broker is the reason the caller is giving up,
      // that wait would never finish.
      enqueue(queue, 1)
      publisher.pump()

      await publisher.end()
      expect(fake.ends).toEqual([true])
    })

    it('resolves only once the client says it has ended', async () => {
      let finish: () => void = () => {}
      fake.end = (force, cb) => {
        fake.ends.push(force)
        finish = () => cb?.()
      }

      let resolved = false
      const ended = publisher.end().then(() => (resolved = true))
      await vi.advanceTimersByTimeAsync(10)
      expect(resolved).toBe(false)

      finish()
      await ended
      expect(resolved).toBe(true)
    })

    it('can be called twice, and ends the client once', async () => {
      await publisher.end()
      await publisher.end()
      expect(fake.ends).toHaveLength(1)
    })

    it('publishes nothing more once ended', async () => {
      await publisher.end()
      enqueue(queue, 1)
      publisher.pump()
      expect(fake.published).toHaveLength(0)
      expect(queue.length).toBe(1)
    })

    it('cancels a retry that was waiting', async () => {
      enqueue(queue, 1)
      publisher.pump()
      fake.fail(0)
      expect(vi.getTimerCount()).toBe(1)

      await publisher.end()
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(fake.published).toHaveLength(1)
    })

    it('does not schedule a retry for a publish that fails after it, and keeps the frame', async () => {
      // Ending with force fails the publish that was out ("Connection
      // closed"). That is the shutdown, not a broker to retry against, but the
      // frame is still owed and still counts as left.
      enqueue(queue, 1)
      publisher.pump()
      await publisher.end()

      fake.fail(0)
      expect(queue.length).toBe(1)
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(fake.published).toHaveLength(1)
    })
  })
})

describe('connectMqtt', () => {
  /** What `mqtt.connect` hands back: an emitter with the two methods the publisher uses. */
  class FakeClient extends EventEmitter {
    publish = vi.fn()
    end = vi.fn()
  }

  beforeEach(() => {
    mqttMock.connect.mockReset()
  })

  it('connects with the connector id on a clean session, reconnecting every 2 s', () => {
    const client = new FakeClient()
    mqttMock.connect.mockReturnValue(client)

    const result = connectMqtt({
      url: 'mqtt://broker:1883',
      username: 'rivian',
      password: 'secret',
      clientId: 'ev-rivian',
    })

    expect(result).toBe(client)
    expect(mqttMock.connect).toHaveBeenCalledTimes(1)
    expect(mqttMock.connect).toHaveBeenCalledWith('mqtt://broker:1883', {
      clientId: 'ev-rivian',
      username: 'rivian',
      password: 'secret',
      clean: true,
      reconnectPeriod: 2000,
    })
  })

  it('does not let a connection error go unhandled', () => {
    // An EventEmitter throws an 'error' event that nobody listens for, and
    // mqtt.js emits one for a refused connection or a keepalive timeout. The
    // broker being down must cost frames in the queue, not the process.
    const client = new FakeClient()
    mqttMock.connect.mockReturnValue(client)
    connectMqtt({ url: 'mqtt://broker:1883', username: 'u', password: 'p', clientId: 'ev-rivian' })

    expect(() => client.emit('error', new Error('connect ECONNREFUSED'))).not.toThrow()
  })
})
