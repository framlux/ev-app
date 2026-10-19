import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RawMessage } from '@ev/core'
import { RIVIAN_STREAMS, parseRivianTopic, rivianRecordLabel, tapeRivianBody } from '../src/deps.js'
import {
  makeRivianMessageHandler,
  type MqttOptions,
  type ParseFailure,
  type PublishPacketLike,
} from '../src/mqtt.js'

const VIN = 'VIN1'
const ARRIVAL = new Date('2026-10-19T12:00:00.000Z')

const OPTS: MqttOptions = {
  url: 'tcp://localhost:1883',
  username: 'telemetry',
  password: 'secret',
  clientId: 'ev-ingest-rivian',
  topic: 'rivian/#',
  vehicleId: 'r2',
  vin: VIN,
}

/** A v1 envelope, as the connector publishes it. */
const envelope = (over: Record<string, unknown> = {}) => ({
  v: 1,
  stream: 'state',
  vin: VIN,
  receivedAt: '2026-10-19T11:59:30.000Z',
  body: { data: { vehicleState: { gearStatus: { value: 'park' } } } },
  ...over,
})

interface Outcome {
  acked: boolean
  error: Error | undefined
  taped: RawMessage[]
  failures: ParseFailure[]
  records: string[]
  handlerErrors: unknown[]
}

/**
 * Drive one packet through the handler and report what happened to it.
 * `onMessage` defaults to resolving at once; a test of the ack ordering passes
 * its own.
 */
async function deliver(
  topic: string,
  body: string | undefined,
  onMessage?: (m: RawMessage) => Promise<void>,
): Promise<Outcome> {
  const out: Outcome = {
    acked: false, error: undefined, taped: [], failures: [], records: [], handlerErrors: [],
  }
  const handler = makeRivianMessageHandler(
    OPTS,
    async (m) => {
      out.taped.push(m)
      await onMessage?.(m)
    },
    {
      onRecord: (r) => out.records.push(r),
      onParseFailure: (r) => out.failures.push(r),
      onHandlerError: (e) => out.handlerErrors.push(e),
    },
  )
  const packet: PublishPacketLike = body === undefined
    ? { topic }
    : { topic, payload: Buffer.from(body) }
  await new Promise<void>((resolve) => {
    handler(packet, (err) => {
      out.acked = err === undefined
      out.error = err
      resolve()
    })
  })
  return out
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(ARRIVAL)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the Rivian message handler', () => {
  it('tapes a v1 envelope under the connector\'s clock and acks it', async () => {
    const env = envelope()
    const out = await deliver(`rivian/${VIN}/state`, JSON.stringify(env))

    expect(out.taped).toEqual([{
      vehicleId: 'r2',
      vendor: 'rivian',
      source: 'graphql_ws',
      receivedAt: new Date(env.receivedAt),
      payload: env,
    }])
    expect(out.acked).toBe(true)
    expect(out.failures).toEqual([])
    expect(out.records).toEqual(['state'])
  })

  it('acks only after the tape write has resolved', async () => {
    // reliable-ack or not, the broker queue is the only buffer: acking before the
    // commit turns a crash in between into a message that exists nowhere.
    let release!: () => void
    const written = new Promise<void>((resolve) => { release = resolve })
    let acked = false
    const handler = makeRivianMessageHandler(OPTS, () => written)
    handler({ topic: `rivian/${VIN}/state`, payload: JSON.stringify(envelope()) }, () => { acked = true })

    await Promise.resolve()
    await Promise.resolve()
    expect(acked).toBe(false)
    release()
    await written
    await Promise.resolve()
    expect(acked).toBe(true)
  })

  it('tapes an envelope of an unknown version, and counts it', async () => {
    // A connector deployed ahead of its reader must lose nothing: the tape keeps
    // the frame, `decode` returns null for it today, and a later reader can
    // replay it.
    const v2 = envelope({ v: 2 })
    const out = await deliver(`rivian/${VIN}/state`, JSON.stringify(v2))

    expect(out.taped).toHaveLength(1)
    expect(out.taped[0]?.payload).toEqual(v2)
    // The connector's stamp cannot be trusted from a shape we do not know.
    expect(out.taped[0]?.receivedAt).toEqual(ARRIVAL)
    expect(out.failures).toEqual(['envelope'])
    expect(out.acked).toBe(true)
  })

  it.each([
    ['missing', undefined],
    ['unparseable', 'last tuesday'],
    ['not a string', 12345],
  ])('tapes a %s receivedAt at local arrival time, and counts it', async (_name, receivedAt) => {
    const env = envelope({ receivedAt })
    const out = await deliver(`rivian/${VIN}/state`, JSON.stringify(env))

    expect(out.taped).toHaveLength(1)
    expect(out.taped[0]?.receivedAt).toEqual(ARRIVAL)
    expect(out.taped[0]?.payload).toEqual(JSON.parse(JSON.stringify(env)))
    expect(out.failures).toEqual(['envelope'])
    expect(out.acked).toBe(true)
  })

  it('removes a NUL from any string before taping', async () => {
    // Postgres JSONB refuses \u0000. A frame that fails its insert is never
    // acked and is redelivered for ever, wedging everything behind it, and the
    // strings that reach us include ones a person typed.
    const dirty = envelope({
      body: { data: { driver: { name: 'Jo\u0000n' } }, 'ke\u0000y': ['a\u0000'] },
    })
    const out = await deliver(`rivian/${VIN}/state`, JSON.stringify(dirty))

    expect(out.taped[0]?.payload).toEqual(envelope({
      body: { data: { driver: { name: 'Jon' } }, key: ['a'] },
    }))
    expect(JSON.stringify(out.taped[0]?.payload)).not.toContain('\\u0000')
    expect(out.acked).toBe(true)
  })

  it('replaces an unpaired surrogate, so JSONB accepts the frame', async () => {
    const out = await deliver(`rivian/${VIN}/state`, JSON.stringify(envelope({ body: 'x\uD800y' })))
    expect((out.taped[0]?.payload as { body: string }).body).toBe('x�y')
  })

  it('acks and does not tape a body that is not JSON', async () => {
    const out = await deliver(`rivian/${VIN}/state`, '{not json')
    expect(out.taped).toEqual([])
    expect(out.failures).toEqual(['json'])
    expect(out.acked).toBe(true)
  })

  it.each([['an empty payload', ''], ['no payload at all', undefined]])(
    'acks %s as empty', async (_name, body) => {
      const out = await deliver(`rivian/${VIN}/state`, body)
      expect(out.taped).toEqual([])
      expect(out.failures).toEqual(['empty'])
      expect(out.acked).toBe(true)
    })

  it('acks and drops a message for another VIN', async () => {
    const out = await deliver('rivian/OTHERVIN/state', JSON.stringify(envelope({ vin: 'OTHERVIN' })))
    expect(out.taped).toEqual([])
    expect(out.failures).toEqual(['unknown-vehicle'])
    expect(out.acked).toBe(true)
  })

  it.each([`rivian/${VIN}`, `ev/${VIN}/v/Soc`, `rivian/${VIN}/state/extra`, '', 'rivian'])(
    'acks and drops the topic %j, which is not rivian/<VIN>/<stream>', async (topic) => {
      const out = await deliver(topic, JSON.stringify(envelope()))
      expect(out.taped).toEqual([])
      expect(out.failures).toEqual(['topic'])
      expect(out.acked).toBe(true)
    })

  it('tapes a stream it does not list, and counts it as `other`', async () => {
    // Which streams exist is the envelope's business. A topic for one we do not
    // list is still a message we can tape, and dropping it would lose data that
    // nothing can ever re-send. But the topic's last segment is whatever the
    // publisher sent, and the record label becomes a Prometheus series, so it is
    // counted under one bounded label rather than under the name it spelled.
    const out = await deliver(`rivian/${VIN}/brand-new-stream`, JSON.stringify(envelope()))
    expect(out.taped).toHaveLength(1)
    expect(out.acked).toBe(true)
    expect(out.records).toEqual(['other'])
  })

  it.each(RIVIAN_STREAMS)('counts the %s stream under its own name', async (stream) => {
    const out = await deliver(`rivian/${VIN}/${stream}`, JSON.stringify(envelope({ stream })))
    expect(out.records).toEqual([stream])
  })

  it('keeps the series count bounded however many stream names arrive', async () => {
    const labels = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const out = await deliver(`rivian/${VIN}/made-up-${i}`, JSON.stringify(envelope()))
      for (const r of out.records) labels.add(r)
    }
    expect([...labels]).toEqual(['other'])
  })

  it('does not ack a message whose write failed, and reports it', async () => {
    const boom = new Error('database is down')
    const out = await deliver(`rivian/${VIN}/state`, JSON.stringify(envelope()), async () => {
      throw boom
    })
    expect(out.handlerErrors).toEqual([boom])
    expect(out.error).toBe(boom)
    expect(out.acked).toBe(false)
  })

  it('wraps a non-Error rejection so the broker still sees a failed delivery', async () => {
    const out = await deliver(`rivian/${VIN}/state`, JSON.stringify(envelope()), async () => {
      throw 'string rejection'
    })
    expect(out.acked).toBe(false)
    expect(out.error).toBeInstanceOf(Error)
    expect(out.error?.message).toBe('string rejection')
  })

  it('accepts every VIN when none is configured', async () => {
    // Mirrors the Tesla handler: a null VIN is "no check", not "match nothing".
    const handler = makeRivianMessageHandler({ ...OPTS, vin: null }, async () => {})
    let acked = false
    handler({ topic: 'rivian/ANYVIN/state', payload: JSON.stringify(envelope()) }, () => { acked = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(acked).toBe(true)
  })
})

describe('rivianRecordLabel', () => {
  it('passes a listed stream and folds anything else into `other`', () => {
    expect(rivianRecordLabel('state')).toBe('state')
    expect(rivianRecordLabel('meta')).toBe('meta')
    expect(rivianRecordLabel('')).toBe('other')
    expect(rivianRecordLabel('State')).toBe('other')
    expect(rivianRecordLabel('constructor')).toBe('other')
  })
})

describe('parseRivianTopic', () => {
  it('reads rivian/<VIN>/<stream>', () => {
    expect(parseRivianTopic('rivian/VIN1/state')).toEqual({ vin: 'VIN1', stream: 'state' })
  })

  it.each([
    '', 'rivian', 'rivian/VIN1', 'rivian//state', 'rivian/VIN1/', 'rivian/VIN1/state/x',
    '/rivian/VIN1/state', 'ev/VIN1/state', 'Rivian/VIN1/state',
  ])('refuses %j', (topic) => {
    expect(parseRivianTopic(topic)).toBeNull()
  })
})

describe('tapeRivianBody', () => {
  it('reports a body that is not JSON', () => {
    expect(tapeRivianBody('nope', ARRIVAL)).toEqual({ error: 'json' })
  })

  it('takes receivedAt from a v1 envelope', () => {
    const env = envelope()
    expect(tapeRivianBody(JSON.stringify(env), ARRIVAL)).toEqual({
      payload: env, receivedAt: new Date(env.receivedAt), envelopeOk: true,
    })
  })

  it.each([['null', null], ['a number', 7], ['a string', 'hi'], ['an array', [1, 2]]])(
    'tapes %s as it is, at arrival, and flags it', (_name, value) => {
      expect(tapeRivianBody(JSON.stringify(value), ARRIVAL)).toEqual({
        payload: value, receivedAt: ARRIVAL, envelopeOk: false,
      })
    })

  it('keeps a key the envelope version does not mention', () => {
    // The tape is the record of what was sent, so a connector that gains an
    // annotation has it preserved even though v1's reader would ignore it.
    const env = { ...envelope(), note: 'extra' }
    const taped = tapeRivianBody(JSON.stringify(env), ARRIVAL)
    expect(taped).toMatchObject({ payload: env, envelopeOk: true })
  })
})
