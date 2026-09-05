import { afterEach, describe, expect, it, vi } from 'vitest'
import { Pipeline, readEnvelope } from '../src/pipeline.js'
import {
  attach,
  parseTopic,
  vinOf,
  type MqttClientLike,
  type MqttHooks,
  type MqttOptions,
  type ParseFailure,
  type PublishPacketLike,
} from '../src/mqtt.js'
import { FakeDb } from './support/fake-db.js'

const VIN = '5YJ3E1EA1JF000001'

const OPTS: MqttOptions = {
  url: 'tcp://localhost:1883',
  username: 'telemetry',
  password: 'secret',
  clientId: 'ev-ingest',
  topic: 'ev/#',
  vehicleId: 'veh-1',
  vin: VIN,
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

  /** One field message, exactly as fleet-telemetry publishes it: value alone. */
  deliver(topic: string, body: string): Promise<Delivery> {
    const packet: PublishPacketLike = { topic, payload: Buffer.from(body) }
    return new Promise((resolve) => {
      this.handleMessage?.(packet as never, (err) =>
        resolve({ acked: err === undefined, error: err }))
    })
  }

  field(name: string, value: unknown): Promise<Delivery> {
    return this.deliver(`ev/${VIN}/v/${name}`, JSON.stringify(value))
  }
}

function wire(hooks: MqttHooks = {}) {
  const db = new FakeDb()
  const pipeline = new Pipeline(db, { usableCapacityKwh: 75 })
  const client = new FakeClient()
  attach(client, OPTS, async (raw) => {
    await pipeline.handle(raw)
  }, hooks)
  return { db, client, pipeline }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('topic parsing', () => {
  it.each([
    [`ev/${VIN}/v/Soc`, 'metrics', 'Soc'],
    [`ev/${VIN}/v/TpmsPressureFl`, 'metrics', 'TpmsPressureFl'],
    [`ev/${VIN}/alerts/Charge_Cable_Fault/current`, 'alert', 'Charge_Cable_Fault'],
    [`ev/${VIN}/alerts/Charge_Cable_Fault/history`, 'alert', 'Charge_Cable_Fault'],
    [`ev/${VIN}/errors/SomeError`, 'error', 'SomeError'],
    [`ev/${VIN}/connectivity`, 'connectivity', null],
  ])('reads %s', (topic, kind, field) => {
    expect(parseTopic(topic)).toEqual({ kind, vin: VIN, field })
  })

  it('takes the VIN from the SECOND segment, never from the end', () => {
    // The regression this file exists for: `parts[length - 2]` returned the
    // literal "v" for every metrics message and "errors" for every error, so
    // every message looked like it belonged to an unknown vehicle and the whole
    // feed was dropped.
    expect(vinOf(`ev/${VIN}/v/Soc`)).toBe(VIN)
    expect(vinOf(`ev/${VIN}/errors/SomeError`)).toBe(VIN)
    expect(vinOf(`ev/${VIN}/connectivity`)).toBe(VIN)
  })

  it.each([
    '',
    'ev',
    `ev/${VIN}`,
    `ev/${VIN}/v`,
    `ev/${VIN}/v/Soc/extra`,
    `ev/${VIN}/alerts/Name`,
    `ev/${VIN}/alerts/Name/pending`,
    `ev/${VIN}/connectivity/extra`,
    `ev/${VIN}/somethingelse/x`,
  ])('refuses to guess at the unknown shape %s', (topic) => {
    expect(parseTopic(topic)).toBeNull()
    expect(vinOf(topic)).toBeNull()
  })
})

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
  it('tapes the field message with the field name folded in from the topic', async () => {
    const kinds: string[] = []
    const { db, client } = wire({ onRecord: (k) => kinds.push(k) })

    const delivery = await client.field('Soc', 72.5)

    expect(delivery.acked).toBe(true)
    expect(kinds).toEqual(['metrics'])
    expect(db.state.raw).toHaveLength(1)
    // raw_message has no topic column. Without the fold, a replay would find a
    // bare 72.5 and no idea what it measured.
    expect(readEnvelope(db.state.raw[0]?.payload))
      .toEqual({ kind: 'metrics', vin: VIN, field: 'Soc', value: 72.5 })
  })

  it('acknowledges only after the commit', async () => {
    const { db, client } = wire()

    await client.field('Soc', 72.5)
    db.log.push('ack')

    // Order, not just presence: the vehicle's own acknowledgement is chained to
    // ours via reliable_ack_sources {"V":"mqtt"}, so an ack before COMMIT turns
    // a crash into data the car has already thrown away.
    expect(db.log).toEqual(['commit', 'ack'])
  })

  it('does not acknowledge a message whose transaction failed, and takes it again', async () => {
    const onHandlerError = vi.fn()
    const { db, client } = wire({ onHandlerError })
    db.failNextCommit = new Error('the database system is shutting down')

    const failed = await client.field('Soc', 72.5)

    expect(failed.acked).toBe(false)
    expect(failed.error?.message).toContain('shutting down')
    expect(onHandlerError).toHaveBeenCalledTimes(1)
    expect(db.log).toEqual(['rollback'])
    expect(db.state.raw).toHaveLength(0)

    // Unacked means redelivered. The worker must still be able to take it.
    const retry = await client.field('Soc', 72.5)
    expect(retry.acked).toBe(true)
    expect(db.state.raw).toHaveLength(1)
  })

  it('emits one accumulated sample once the car goes quiet', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T10:00:00.000Z'))
    const { db, client } = wire()

    // A burst: fleet-telemetry publishes one message per field.
    await client.field('Soc', 72)
    await client.field('VehicleSpeed', 40)
    await client.field('Odometer', 1000)
    // One row per field would give the segmenter a stream in which almost every
    // field is null. Nothing is emitted until the burst is over.
    expect(db.state.samples).toHaveLength(0)

    vi.setSystemTime(new Date('2026-09-04T10:00:03.000Z'))
    await client.field('Soc', 71)

    expect(db.state.samples).toHaveLength(1)
    const sample = db.state.samples[0]
    expect(sample?.socPct).toBe(72)
    expect(sample?.speedKph).toBeCloseTo(64.37, 2)
    expect(sample?.odometerKm).toBeCloseTo(1609.34, 2)
    // Stamped at the last observation, not at the emit.
    expect(sample?.ts.toISOString()).toBe('2026-09-04T10:00:00.000Z')
    expect(db.state.raw).toHaveLength(4)
  })

  it.each<[string, string, ParseFailure]>([
    ['an unknown topic shape', `ev/${VIN}/v`, 'topic'],
    ['a body that is not JSON', `ev/${VIN}/v/Soc`, 'json'],
  ])('counts and drops %s without crashing', async (_label, topic, reason) => {
    const onParseFailure = vi.fn()
    const { db, client } = wire({ onParseFailure })

    const bad = await client.deliver(topic, '{"unterminated')

    expect(onParseFailure).toHaveBeenCalledWith(reason)
    expect(db.state.raw).toHaveLength(0)
    // Acked deliberately: redelivering it cannot make it parse, and an unacked
    // message is redelivered ahead of everything queued behind it.
    expect(bad.acked).toBe(true)

    // The worker keeps working. A process that dies on one bad message stops
    // collecting everything.
    const good = await client.field('Soc', 71)
    expect(good.acked).toBe(true)
    expect(db.state.raw).toHaveLength(1)
  })

  it('counts a cleared retained message separately from a broken one', async () => {
    const onParseFailure = vi.fn()
    const { db, client } = wire({ onParseFailure })

    const empty = await client.deliver(`ev/${VIN}/v/Soc`, '')

    // A zero-length payload is how MQTT clears a retained message, not a
    // publisher bug; counting it as one would drown the real signal.
    expect(onParseFailure).toHaveBeenCalledWith('empty')
    expect(empty.acked).toBe(true)
    expect(db.state.raw).toHaveLength(0)
  })

  it('keeps a null payload, which is a real reading of Value_Invalid', async () => {
    const onParseFailure = vi.fn()
    const { db, client } = wire({ onParseFailure })

    const delivery = await client.field('Soc', null)

    expect(onParseFailure).not.toHaveBeenCalled()
    expect(delivery.acked).toBe(true)
    // Taped, but it must not become a sample claiming an SoC of 0.
    expect(db.state.raw).toHaveLength(1)
    expect(db.state.samples).toHaveLength(0)
  })

  it('drops a message for a VIN this worker is not configured for', async () => {
    const onParseFailure = vi.fn()
    const { db, client } = wire({ onParseFailure })

    const other = await client.deliver('ev/5YJ3E1EA1JF999999/v/Soc', '72')

    // Inserting it would violate the vehicle foreign key on every redelivery.
    expect(onParseFailure).toHaveBeenCalledWith('unknown-vehicle')
    expect(other.acked).toBe(true)
    expect(db.state.raw).toHaveLength(0)
  })

  it('keeps alerts and errors on the tape without inventing a sample', async () => {
    const kinds: string[] = []
    const { db, client } = wire({ onRecord: (k) => kinds.push(k) })

    await client.deliver(`ev/${VIN}/alerts/Charge_Cable_Fault/current`,
      JSON.stringify({ name: 'Charge_Cable_Fault', startedAt: '2026-09-04T10:00:00Z' }))
    await client.deliver(`ev/${VIN}/errors/SomeError`, JSON.stringify({ body: 'x' }))

    expect(kinds).toEqual(['alert', 'error'])
    // No sample - there is nothing to normalise - but the raw rows are kept so a
    // future alert parser has history to work from.
    expect(db.state.raw).toHaveLength(2)
    expect(db.state.samples).toHaveLength(0)
  })
})
