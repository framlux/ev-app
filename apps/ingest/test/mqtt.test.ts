import { describe, expect, it, vi } from 'vitest'
import { Pipeline } from '../src/pipeline.js'
import {
  attach,
  recordType,
  vinOf,
  type MqttClientLike,
  type MqttHooks,
  type MqttOptions,
  type PublishPacketLike,
} from '../src/mqtt.js'
import { FakeDb } from './support/fake-db.js'

const OPTS: MqttOptions = {
  url: 'tcp://localhost:1883',
  username: 'telemetry',
  password: 'secret',
  clientId: 'ev-ingest',
  topic: 'ev/#',
  vehicleId: 'veh-1',
  vin: '5YJ3E1EA1JF000001',
}

interface Delivery { acked: boolean; error: Error | undefined }

/**
 * The smallest client that behaves like mqtt.js where it matters: the PUBLISH
 * handler is `handleMessage`, and the PUBACK corresponds to calling `done()`
 * without an error.
 */
class FakeClient implements MqttClientLike {
  readonly listeners = new Map<string, ((...args: never[]) => void)[]>()
  readonly subscriptions: { topic: string; qos: number }[] = []
  handleMessage?: (packet: never, done: (err?: Error) => void) => void

  on(event: string, listener: (...args: never[]) => void): this {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  subscribe(topic: string, opts: { qos: 0 | 1 | 2 }, cb?: (err: Error | null) => void): this {
    this.subscriptions.push({ topic, qos: opts.qos })
    cb?.(null)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) {
      ;(l as (...a: unknown[]) => void)(...args)
    }
  }

  deliver(topic: string, body: string): Promise<Delivery> {
    const packet: PublishPacketLike = { topic, payload: Buffer.from(body) }
    return new Promise((resolve) => {
      this.handleMessage?.(packet as never, (err) =>
        resolve({ acked: err === undefined, error: err }))
    })
  }
}

function record(at: string, fields: Record<string, unknown>): string {
  return JSON.stringify({
    vin: OPTS.vin,
    createdAt: at,
    data: Object.entries(fields).map(([key, value]) => ({ key, value })),
  })
}

function wire(hooks: MqttHooks = {}) {
  const db = new FakeDb()
  const pipeline = new Pipeline(db, { usableCapacityKwh: 75 })
  const client = new FakeClient()
  attach(client, OPTS, async (raw) => {
    await pipeline.handle(raw)
  }, hooks)
  return { db, client }
}

describe('mqtt subscription', () => {
  it('subscribes at QoS 1 on every connect', () => {
    const changes: boolean[] = []
    const { client } = wire({ onConnectionChange: (c) => changes.push(c) })

    client.emit('connect')
    client.emit('close')
    client.emit('connect')

    expect(client.subscriptions).toEqual([
      { topic: 'ev/#', qos: 1 },
      { topic: 'ev/#', qos: 1 },
    ])
    // The gauge the stall alert guards on.
    expect(changes).toEqual([true, false, true])
  })
})

describe('message handling', () => {
  it('runs the full pipeline and acknowledges only after the commit', async () => {
    const { db, client } = wire()

    const delivery = await client.deliver(
      'ev/5YJ3E1EA1JF000001/v',
      record('2026-09-04T10:00:00.000Z', { Soc: { doubleValue: 72 } }),
    )
    db.log.push('ack')

    expect(delivery.acked).toBe(true)
    expect(db.state.raw).toHaveLength(1)
    expect(db.state.samples[0]?.socPct).toBe(72)
    // Order, not just presence: the vehicle's own acknowledgement is chained to
    // ours via reliable_ack_sources, so an ack before COMMIT turns a crash into
    // data the car has already thrown away.
    expect(db.log).toEqual(['commit', 'ack'])
  })

  it('does not acknowledge a message whose transaction failed', async () => {
    const onHandlerError = vi.fn()
    const { db, client } = wire({ onHandlerError })
    db.failNextCommit = new Error('the database system is shutting down')

    const failed = await client.deliver(
      'ev/5YJ3E1EA1JF000001/v',
      record('2026-09-04T10:00:00.000Z', { Soc: { doubleValue: 72 } }),
    )

    expect(failed.acked).toBe(false)
    expect(failed.error?.message).toContain('shutting down')
    expect(onHandlerError).toHaveBeenCalledTimes(1)
    expect(db.log).toEqual(['rollback'])

    // Unacked means redelivered. The worker must still be able to take it.
    const retry = await client.deliver(
      'ev/5YJ3E1EA1JF000001/v',
      record('2026-09-04T10:00:00.000Z', { Soc: { doubleValue: 72 } }),
    )
    expect(retry.acked).toBe(true)
    expect(db.state.samples).toHaveLength(1)
  })

  it('counts and drops a malformed payload without crashing or retrying it', async () => {
    const onParseFailure = vi.fn()
    const { db, client } = wire({ onParseFailure })

    const bad = await client.deliver('ev/5YJ3E1EA1JF000001/v', '{"data": [')

    expect(onParseFailure).toHaveBeenCalledWith('json')
    expect(db.state.raw).toHaveLength(0)
    // Acked deliberately: redelivering it cannot make it parse, and an unacked
    // message is redelivered ahead of everything queued behind it.
    expect(bad.acked).toBe(true)

    // The worker keeps working. A process that dies on one bad message stops
    // collecting everything.
    const good = await client.deliver(
      'ev/5YJ3E1EA1JF000001/v',
      record('2026-09-04T10:01:00.000Z', { Soc: { doubleValue: 71 } }),
    )
    expect(good.acked).toBe(true)
    expect(db.state.samples).toHaveLength(1)
  })

  it('drops a record for a VIN this worker is not configured for', async () => {
    const onParseFailure = vi.fn()
    const { db, client } = wire({ onParseFailure })

    const other = await client.deliver(
      'ev/5YJ3E1EA1JF999999/v',
      record('2026-09-04T10:00:00.000Z', { Soc: { doubleValue: 72 } }),
    )

    // Inserting it would violate the vehicle foreign key on every redelivery.
    expect(onParseFailure).toHaveBeenCalledWith('unknown-vehicle')
    expect(other.acked).toBe(true)
    expect(db.state.raw).toHaveLength(0)
  })

  it('keeps non-telemetry records on the tape', async () => {
    const records: string[] = []
    const { db, client } = wire({ onRecord: (r) => records.push(r) })

    await client.deliver('ev/5YJ3E1EA1JF000001/alerts',
      JSON.stringify({ vin: OPTS.vin, alerts: [{ name: 'Charge_Cable_Fault' }] }))

    expect(records).toEqual(['alerts'])
    // No sample - there is nothing to normalise - but the raw row is kept so a
    // future alert parser has history to work from.
    expect(db.state.raw).toHaveLength(1)
    expect(db.state.samples).toHaveLength(0)
  })
})

describe('topic parsing', () => {
  it.each([
    ['ev/5YJ3E1EA1JF000001/v', 'v', '5YJ3E1EA1JF000001'],
    ['ev/5YJ3E1EA1JF000001/V', 'v', '5YJ3E1EA1JF000001'],
    ['ev/5YJ3E1EA1JF000001/connectivity', 'connectivity', '5YJ3E1EA1JF000001'],
    ['ev/5YJ3E1EA1JF000001/errors', 'errors', '5YJ3E1EA1JF000001'],
    ['ev/v', 'v', 'ev'],
    ['', 'unknown', null],
  ])('parses %s', (topic, expectedRecord, expectedVin) => {
    expect(recordType(topic)).toBe(expectedRecord)
    expect(vinOf(topic, {})).toBe(expectedVin)
  })

  it('falls back to the VIN in the body when the topic carries none', () => {
    expect(vinOf('v', { vin: '5YJ3E1EA1JF000001' })).toBe('5YJ3E1EA1JF000001')
    expect(vinOf('v', { vin: '' })).toBeNull()
    expect(vinOf('v', { vin: 42 })).toBeNull()
  })
})
