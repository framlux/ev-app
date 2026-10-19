import { describe, expect, it } from 'vitest'
import { PublishQueue, QUEUE_CAP_BYTES, frameFor, type QueuedFrame } from '../src/queue.js'

/** A frame whose size is whatever the test says, so capacity arithmetic is exact. */
function frame(n: number, bytes = 40): QueuedFrame {
  return { topic: 'rivian/VIN1/state', body: `frame-${n}`, bytes }
}

/** Everything left in the queue, oldest first. */
function drain(queue: PublishQueue): string[] {
  const bodies: string[] = []
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) bodies.push(next.body)
  return bodies
}

describe('frameFor', () => {
  const receivedAt = new Date('2026-10-19T17:03:11.482Z')

  it('builds the v1 envelope under rivian/<VIN>/<stream>, body verbatim', () => {
    const body = { data: { vehicleState: { powerState: { value: 'sleep' } } } }
    const f = frameFor('VIN1', 'state', receivedAt, body)

    expect(f.topic).toBe('rivian/VIN1/state')
    expect(JSON.parse(f.body)).toEqual({
      v: 1,
      stream: 'state',
      vin: 'VIN1',
      receivedAt: '2026-10-19T17:03:11.482Z',
      body,
    })
  })

  it('takes the topic from the stream it was given', () => {
    expect(frameFor('VIN1', 'meta', receivedAt, { kind: 'userInfo', data: {} }).topic).toBe(
      'rivian/VIN1/meta',
    )
  })

  it('cleans a NUL and a lone surrogate out of the body, and leaves an emoji alone', () => {
    const f = frameFor('VIN1', 'state', receivedAt, {
      driver: 'Jo\u0000n',
      vehicle: 'R1\uD800S',
      pet: 'dog \u{1F415}',
    })

    // Checked on the serialised text as well as the parsed value: the text is
    // what Postgres would be handed, and JSON.stringify writes a NUL as the six
    // characters \u0000, so a surviving one would show here.
    expect(f.body).not.toContain('\\u0000')
    expect(JSON.parse(f.body).body).toEqual({
      driver: 'Jon',
      vehicle: 'R1�S',
      pet: 'dog \u{1F415}',
    })
  })

  it('builds the topic from the cleaned VIN, so it and the envelope name the same car', () => {
    // A NUL in a VIN is garbage, but the topic is what ingest reads the VIN
    // from and the envelope is what it reads it from again: they must not be
    // able to disagree about which vehicle a frame belongs to.
    const f = frameFor('VIN\u00001', 'state', receivedAt, { n: 1 })

    expect(f.topic).toBe('rivian/VIN1/state')
    expect(JSON.parse(f.body).vin).toBe('VIN1')
    expect(f.topic).not.toContain('\u0000')
  })

  it('measures bytes as the UTF-8 length of what will be published', () => {
    // Multi-byte on purpose: a character count would undercount this, and the
    // cap is in bytes because it stands in for memory.
    const f = frameFor('VIN1', 'state', receivedAt, { name: 'R1T € \u{1F699}' })

    expect(f.bytes).toBe(Buffer.byteLength(f.body, 'utf8'))
    expect(f.bytes).toBeGreaterThan(f.body.length)
  })
})

describe('PublishQueue', () => {
  it('is capped at 32 MiB unless told otherwise', () => {
    expect(QUEUE_CAP_BYTES).toBe(32 * 1024 * 1024)

    const queue = new PublishQueue()
    expect(queue.push(frame(1, QUEUE_CAP_BYTES))).toBe(0)
    // One byte over: the oldest has to go.
    expect(queue.push(frame(2, 1))).toBe(1)
    expect(drain(queue)).toEqual(['frame-2'])
  })

  it('hands frames back in the order they went in', () => {
    const queue = new PublishQueue(1_000)
    for (let n = 1; n <= 4; n++) queue.push(frame(n))

    expect(queue.shift()?.body).toBe('frame-1')
    queue.push(frame(5))
    expect(drain(queue)).toEqual(['frame-2', 'frame-3', 'frame-4', 'frame-5'])
    expect(queue.shift()).toBeUndefined()
  })

  it('counts length and bytes as frames come and go', () => {
    const queue = new PublishQueue(1_000)
    expect(queue.length).toBe(0)
    expect(queue.bytes).toBe(0)

    queue.push(frame(1, 30))
    queue.push(frame(2, 50))
    expect(queue.length).toBe(2)
    expect(queue.bytes).toBe(80)

    queue.shift()
    expect(queue.length).toBe(1)
    expect(queue.bytes).toBe(50)

    queue.shift()
    expect(queue.length).toBe(0)
    expect(queue.bytes).toBe(0)
  })

  it('drops the oldest once the total passes the cap, and says how many', () => {
    const queue = new PublishQueue(100)

    expect(queue.push(frame(1))).toBe(0)
    expect(queue.push(frame(2))).toBe(0)
    // 120 bytes against a cap of 100: frame 1 is the one to go.
    expect(queue.push(frame(3))).toBe(1)
    expect(queue.bytes).toBe(80)
    expect(drain(queue)).toEqual(['frame-2', 'frame-3'])
  })

  it('drops as many frames as it takes to fit the new one', () => {
    const queue = new PublishQueue(100)
    queue.push(frame(1))
    queue.push(frame(2))

    // 80 + 90 = 170: dropping frame 1 leaves 130, still over, so frame 2 goes too.
    expect(queue.push(frame(3, 90))).toBe(2)
    expect(queue.length).toBe(1)
    expect(queue.bytes).toBe(90)
    expect(drain(queue)).toEqual(['frame-3'])
  })

  it('accepts a frame larger than the cap, alone: the newest is never refused', () => {
    const queue = new PublishQueue(100)
    queue.push(frame(1))
    queue.push(frame(2))

    expect(queue.push(frame(3, 250))).toBe(2)
    expect(queue.length).toBe(1)
    expect(queue.bytes).toBe(250)
    expect(drain(queue)).toEqual(['frame-3'])
  })

  it('accepts an oversized frame into an empty queue without dropping anything', () => {
    const queue = new PublishQueue(100)
    expect(queue.push(frame(1, 250))).toBe(0)
    expect(drain(queue)).toEqual(['frame-1'])
  })

  it('puts a returned frame back at the head, bytes counted', () => {
    const queue = new PublishQueue(1_000)
    queue.push(frame(1))
    queue.push(frame(2))

    const inFlight = queue.shift()!
    expect(queue.bytes).toBe(40)
    queue.unshift(inFlight)

    expect(queue.length).toBe(2)
    expect(queue.bytes).toBe(80)
    expect(drain(queue)).toEqual(['frame-1', 'frame-2'])
  })

  it('puts a frame back at the head of an empty queue, and of one that has never been shifted', () => {
    const queue = new PublishQueue(1_000)
    queue.unshift(frame(1))
    queue.push(frame(2))
    queue.unshift(frame(0))

    expect(drain(queue)).toEqual(['frame-0', 'frame-1', 'frame-2'])
  })

  it('lets a returned frame take the queue over its cap, and the next push trims from the head', () => {
    // The frame in flight is outside the queue's byte count, so while it is
    // out the queue may fill to the cap behind it. If the publish then fails,
    // putting it back overshoots by at most that one frame. Dropping something
    // here would lose a frame with nobody told; instead the overshoot stands
    // until the next push, which drops from the head (the returned frame, the
    // oldest) and reports it like any other drop.
    const queue = new PublishQueue(100)
    queue.push(frame(1))
    queue.push(frame(2))
    const inFlight = queue.shift()!
    queue.push(frame(3))
    expect(queue.bytes).toBe(80)

    queue.unshift(inFlight)
    expect(queue.bytes).toBe(120)
    expect(queue.length).toBe(3)

    expect(queue.push(frame(4))).toBe(2)
    expect(drain(queue)).toEqual(['frame-3', 'frame-4'])
  })

  it('stays in order and exact across many pushes and shifts', () => {
    // Enough turnover to exercise whatever the queue does to keep shifting
    // cheap: order and the byte total must survive it.
    const queue = new PublishQueue(1_000_000)
    let next = 0
    let expected = 0
    for (let round = 0; round < 50; round++) {
      for (let i = 0; i < 100; i++) queue.push(frame(next++, 10))
      for (let i = 0; i < 90; i++) expect(queue.shift()?.body).toBe(`frame-${expected++}`)
    }

    expect(queue.length).toBe(next - expected)
    expect(queue.bytes).toBe(queue.length * 10)
    expect(drain(queue)).toEqual(
      Array.from({ length: next - expected }, (_, i) => `frame-${expected + i}`),
    )
  })
})
