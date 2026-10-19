import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RawMessage } from '@ev/core'
import type { ParseFailure, PublishPacketLike, VendorMqttOptions } from '../src/mqtt.js'

// `subscribe` is the one function that connects, so the connection is replaced:
// what is under test is which handler it hands the client, and a live broker
// would add nothing to that.
const connect = vi.hoisted(() => vi.fn())
vi.mock('mqtt', () => ({ default: { connect } }))

import { handlerFor, subscribe } from '../src/mqtt.js'

/**
 * A Rivian worker that was handed the Tesla topic parser would find no
 * `ev/<VIN>/...` in `rivian/<VIN>/state`, count a `topic` failure and ACK, for
 * every message the connector ever sent: acked, so the broker discards it, and
 * never taped. Nothing would crash and the only trace would be a parse-failure
 * counter climbing. These tests are what holds the dispatch the right way round.
 */
const VIN = 'VIN1'

const OPTS: VendorMqttOptions = {
  vendor: 'tesla',
  url: 'tcp://localhost:1883',
  username: 'telemetry',
  password: 'secret',
  clientId: 'ev-ingest',
  topic: 'ev/#',
  vehicleId: 'veh-1',
  vin: VIN,
}

const RIVIAN_OPTS: VendorMqttOptions = {
  ...OPTS, vendor: 'rivian', clientId: 'ev-ingest-rivian', topic: 'rivian/#',
}

const TESLA_PACKET: PublishPacketLike = { topic: `ev/${VIN}/v/Soc`, payload: '80' }
const RIVIAN_PACKET: PublishPacketLike = {
  topic: `rivian/${VIN}/state`,
  payload: JSON.stringify({
    v: 1, stream: 'state', vin: VIN, receivedAt: '2026-10-19T11:59:30.000Z', body: { data: {} },
  }),
}

interface Result { acked: boolean; taped: RawMessage[]; failures: ParseFailure[] }

type Handle = (packet: never, done: (err?: Error) => void) => void

/** Push one packet through a handler and report whether it was taped, and what was counted. */
async function run(
  make: (onMessage: (m: RawMessage) => Promise<void>, hooks: { onParseFailure(r: ParseFailure): void }) => Handle,
  packet: PublishPacketLike,
): Promise<Result> {
  const result: Result = { acked: false, taped: [], failures: [] }
  const handle = make(
    async (m) => { result.taped.push(m) },
    { onParseFailure: (r) => result.failures.push(r) },
  )
  await new Promise<void>((resolve) => {
    handle(packet as never, (err) => {
      result.acked = err === undefined
      resolve()
    })
  })
  return result
}

describe('handlerFor', () => {
  const via = (vendor: 'tesla' | 'rivian') =>
    (onMessage: (m: RawMessage) => Promise<void>, hooks: { onParseFailure(r: ParseFailure): void }) =>
      handlerFor(vendor, vendor === 'tesla' ? OPTS : RIVIAN_OPTS, onMessage, hooks) as Handle

  it('hands a Rivian worker the Rivian reader', async () => {
    const r = await run(via('rivian'), RIVIAN_PACKET)
    expect(r.failures).toEqual([])
    expect(r.taped).toMatchObject([{ vendor: 'rivian', source: 'graphql_ws', vehicleId: 'veh-1' }])
    expect(r.acked).toBe(true)
  })

  it('hands a Tesla worker the Tesla reader', async () => {
    const r = await run(via('tesla'), TESLA_PACKET)
    expect(r.failures).toEqual([])
    expect(r.taped).toMatchObject([{ vendor: 'tesla', source: 'telemetry', vehicleId: 'veh-1' }])
    expect(r.acked).toBe(true)
  })

  it('does not read the other vendor\'s topics, either way round', async () => {
    const rivianGivenTesla = await run(via('rivian'), TESLA_PACKET)
    expect(rivianGivenTesla.taped).toEqual([])
    expect(rivianGivenTesla.failures).toEqual(['topic'])

    const teslaGivenRivian = await run(via('tesla'), RIVIAN_PACKET)
    expect(teslaGivenRivian.taped).toEqual([])
    expect(teslaGivenRivian.failures).toEqual(['topic'])
  })
})

describe('subscribe', () => {
  interface FakeClient {
    handleMessage?: Handle
    on: ReturnType<typeof vi.fn>
    subscribe: ReturnType<typeof vi.fn>
  }
  let client: FakeClient

  beforeEach(() => {
    connect.mockReset()
    client = { on: vi.fn(() => client), subscribe: vi.fn() }
    connect.mockReturnValue(client)
  })

  const wired = (opts: VendorMqttOptions) => (
    onMessage: (m: RawMessage) => Promise<void>,
    hooks: { onParseFailure(r: ParseFailure): void },
  ): Handle => {
    subscribe(opts, onMessage, hooks)
    return client.handleMessage as Handle
  }

  it('wires the Rivian reader for EV_VENDOR=rivian, on the connection it was given', async () => {
    const r = await run(wired(RIVIAN_OPTS), RIVIAN_PACKET)
    expect(r.failures).toEqual([])
    expect(r.taped).toMatchObject([{ vendor: 'rivian', source: 'graphql_ws' }])
    expect(connect).toHaveBeenCalledWith(
      RIVIAN_OPTS.url, expect.objectContaining({ clientId: 'ev-ingest-rivian', clean: false }))
  })

  it('wires the Tesla reader for EV_VENDOR=tesla', async () => {
    const r = await run(wired(OPTS), TESLA_PACKET)
    expect(r.failures).toEqual([])
    expect(r.taped).toMatchObject([{ vendor: 'tesla', source: 'telemetry' }])
    expect(connect).toHaveBeenCalledWith(
      OPTS.url, expect.objectContaining({ clientId: 'ev-ingest', clean: false }))
  })

  it('subscribes to the configured topic on connect', () => {
    subscribe(RIVIAN_OPTS, async () => {}, {})
    const onConnect = client.on.mock.calls.find(([event]) => event === 'connect')?.[1] as () => void
    onConnect()
    expect(client.subscribe).toHaveBeenCalledWith('rivian/#', { qos: 1 }, expect.any(Function))
  })
})
