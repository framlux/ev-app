import mqtt from 'mqtt'
import type { RawMessage } from './deps.js'

export interface MqttOptions {
  url: string
  username: string
  password: string
  /**
   * MUST be 'ev-ingest', and MUST NOT be the receiver's 'ev-fleet-telemetry'.
   * MQTT permits one live connection per client id: a collision disconnects the
   * incumbent, which reconnects and disconnects us, forever. It is also the key
   * the broker files our durable session under, so changing it silently
   * abandons whatever backlog the old id was holding.
   */
  clientId: string
  topic: string
  /** Our own vehicle id (the `vehicle.id` FK), not the VIN. */
  vehicleId: string
  /** The VIN we expect on the wire; records for any other VIN are dropped. */
  vin: string | null
}

export interface MqttHooks {
  onRecord?(record: string): void
  onParseFailure?(reason: string): void
  onHandlerError?(err: unknown): void
  onConnectionChange?(connected: boolean): void
}

/** The part of a PUBLISH packet this module needs. Keeps fakes tiny. */
export interface PublishPacketLike {
  topic?: string | Buffer
  payload?: Uint8Array | string
}

/** The part of an MQTT client this module drives. */
export interface MqttClientLike {
  on(event: string, listener: (...args: never[]) => void): unknown
  subscribe(topic: string, opts: { qos: 0 | 1 | 2 }, cb?: (err: Error | null) => void): unknown
  /**
   * `never` for the packet, so both mqtt.js's `IPublishPacket` signature and the
   * minimal fakes in the tests satisfy this interface: parameter positions are
   * contravariant, and every packet type is assignable to `never`'s position.
   */
  handleMessage?: (packet: never, done: (err?: Error) => void) => void
}

export type MessageHandler = (packet: PublishPacketLike, done: (err?: Error) => void) => void

/**
 * Build the QoS 1 message handler.
 *
 * Two outcomes and they are not the same:
 *
 * - The payload is unusable (bad JSON, a VIN that is not ours). It is counted
 *   and ACKED. Nothing about redelivering it would make it parse, and an
 *   unacked message is redelivered ahead of everything behind it — one poison
 *   record would wedge the whole durable session.
 * - Handling failed (the database is down). It is counted and NOT acked, so the
 *   broker keeps it and delivers it again after the reconnect.
 */
export function makeMessageHandler(
  opts: MqttOptions,
  onMessage: (m: RawMessage) => Promise<void>,
  hooks: MqttHooks = {},
): MessageHandler {
  return (packet, done) => {
    const topic = packet.topic === undefined ? '' : packet.topic.toString()
    const record = recordType(topic)
    hooks.onRecord?.(record)

    let payload: unknown
    try {
      payload = JSON.parse(bodyOf(packet))
    } catch {
      hooks.onParseFailure?.('json')
      done()
      return
    }

    const vin = vinOf(topic, payload)
    // A record for a VIN we are not configured for cannot be attributed to a
    // `vehicle` row, and inserting it anyway is a foreign key violation on
    // every redelivery. Drop it visibly instead.
    if (opts.vin !== null && vin !== null && vin !== opts.vin) {
      hooks.onParseFailure?.('unknown-vehicle')
      done()
      return
    }

    onMessage({
      vehicleId: opts.vehicleId,
      vendor: 'tesla',
      receivedAt: new Date(),
      source: 'telemetry',
      payload,
    }).then(
      // done() with no argument is what sends the PUBACK. It runs after the
      // handler's promise resolves, and the handler resolves after COMMIT.
      () => done(),
      (err: unknown) => {
        hooks.onHandlerError?.(err)
        done(err instanceof Error ? err : new Error(String(err)))
      },
    )
  }
}

/**
 * Wire the handler into a client.
 *
 * `handleMessage` is overridden rather than listening on `'message'`. mqtt.js
 * emits `'message'` and sends the PUBACK for QoS 1 only once the
 * `handleMessage` callback fires without an error, so this override is the only
 * hook that defers the acknowledgement. A `'message'` listener acks first and
 * asks questions later, which breaks the durability chain the receiver's
 * `reliable_ack_sources {"V":"mqtt"}` setting depends on.
 */
export function attach(
  client: MqttClientLike,
  opts: MqttOptions,
  onMessage: (m: RawMessage) => Promise<void>,
  hooks: MqttHooks = {},
): void {
  client.handleMessage = makeMessageHandler(opts, onMessage, hooks)

  client.on('connect', (() => {
    hooks.onConnectionChange?.(true)
    // Re-subscribing on every connect is deliberate. clean:false should make
    // the broker remember the subscription, but a broker that lost its
    // persistence (a restarted Mosquitto with no volume) would otherwise leave
    // us connected and permanently silent.
    client.subscribe(opts.topic, { qos: 1 }, (err: Error | null) => {
      if (err) hooks.onHandlerError?.(err)
    })
  }) as (...args: never[]) => void)

  client.on('close', (() => hooks.onConnectionChange?.(false)) as (...args: never[]) => void)
  client.on('offline', (() => hooks.onConnectionChange?.(false)) as (...args: never[]) => void)
  client.on('error', ((err: Error) => hooks.onHandlerError?.(err)) as (...args: never[]) => void)
}

export function subscribe(
  opts: MqttOptions,
  onMessage: (m: RawMessage) => Promise<void>,
  hooks: MqttHooks = {},
): mqtt.MqttClient {
  const client = mqtt.connect(opts.url, {
    clientId: opts.clientId,
    username: opts.username,
    password: opts.password,
    // Durable session: the broker holds our backlog while we are down. With
    // clean:true a restart would silently discard everything that arrived
    // meanwhile, and nothing downstream would ever notice the hole.
    clean: false,
    reconnectPeriod: 2000,
    // Without a queue limit a long outage grows the in-memory backlog until the
    // process is OOM-killed, which loses more than the outage did.
    queueQoSZero: false,
  })
  attach(client, opts, onMessage, hooks)
  return client
}

/** Last topic segment: 'v', 'alerts', 'errors', 'connectivity'. */
export function recordType(topic: string): string {
  const parts = topic.split('/').filter((p) => p.length > 0)
  return parts[parts.length - 1]?.toLowerCase() ?? 'unknown'
}

/**
 * The VIN, from the topic if fleet-telemetry put it there, otherwise from the
 * record body. Topic layout is `<base>/<vin>/<record>`.
 */
export function vinOf(topic: string, payload: unknown): string | null {
  const parts = topic.split('/').filter((p) => p.length > 0)
  const fromTopic = parts.length >= 2 ? parts[parts.length - 2] : undefined
  if (fromTopic) return fromTopic
  if (payload && typeof payload === 'object' && 'vin' in payload) {
    const vin = (payload as { vin?: unknown }).vin
    if (typeof vin === 'string' && vin.length > 0) return vin
  }
  return null
}

function bodyOf(packet: PublishPacketLike): string {
  const body = packet.payload
  if (body === undefined) return ''
  return typeof body === 'string' ? body : Buffer.from(body).toString('utf8')
}
