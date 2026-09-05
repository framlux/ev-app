import mqtt from 'mqtt'
import type { RawMessage } from './deps.js'
import type { RecordKind, TeslaEnvelope } from './pipeline.js'

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
  /** The VIN we expect on the wire; messages for any other VIN are dropped. */
  vin: string | null
}

export interface MqttHooks {
  onRecord?(record: RecordKind): void
  onParseFailure?(reason: ParseFailure): void
  onHandlerError?(err: unknown): void
  onConnectionChange?(connected: boolean): void
}

/**
 * Why a message was discarded. Separate reasons because they mean different
 * things operationally: a rise in `topic` means fleet-telemetry changed its
 * layout under us, a rise in `json` means a broken publisher, and
 * `unknown-vehicle` is usually just a second car on a shared broker.
 */
export type ParseFailure = 'topic' | 'json' | 'empty' | 'unknown-vehicle'

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

/** What a topic said. `field` is only populated for metrics/alerts/errors. */
export interface TopicInfo {
  kind: RecordKind
  vin: string
  /** Metrics: the Tesla field name. Alerts/errors: the alert or error name. */
  field: string | null
}

/**
 * Parse a fleet-telemetry topic.
 *
 * Layout, from `datastore/mqtt` (topic_base is "ev" here):
 *
 *   metrics:      ev/<VIN>/v/<FieldName>
 *   alerts:       ev/<VIN>/alerts/<AlertName>/current   and   .../history
 *   errors:       ev/<VIN>/errors/<ErrorName>
 *   connectivity: ev/<VIN>/connectivity
 *
 * The VIN is therefore always the SECOND segment. It is emphatically not at a
 * fixed offset from the END: an earlier version of this function took
 * `parts[length - 2]`, which yields the literal string "v" for every metrics
 * message and "errors" for every error - so every message looked like it
 * belonged to a vehicle we had never heard of.
 *
 * A topic that matches none of these shapes returns null. It is then counted and
 * skipped rather than guessed at: guessing which segment is a VIN is how
 * telemetry ends up attributed to the wrong car, and the sample table has no way
 * to tell that apart afterwards.
 */
export function parseTopic(topic: string): TopicInfo | null {
  const parts = topic.split('/').filter((p) => p.length > 0)
  const vin = parts[1]
  const kind = parts[2]
  if (!vin || !kind) return null

  if (kind === 'v' && parts.length === 4 && parts[3]) {
    return { kind: 'metrics', vin, field: parts[3] }
  }
  if (kind === 'alerts' && parts.length === 5 && parts[3]) {
    // .../current and .../history are the two publish points; anything else is
    // a shape we do not know.
    if (parts[4] !== 'current' && parts[4] !== 'history') return null
    return { kind: 'alert', vin, field: parts[3] }
  }
  if (kind === 'errors' && parts.length === 4 && parts[3]) {
    return { kind: 'error', vin, field: parts[3] }
  }
  if (kind === 'connectivity' && parts.length === 3) {
    return { kind: 'connectivity', vin, field: null }
  }
  return null
}

/** The VIN alone, or null if the topic is not one we recognise. */
export function vinOf(topic: string): string | null {
  return parseTopic(topic)?.vin ?? null
}

/**
 * Build the QoS 1 message handler.
 *
 * ACK ORDERING IS THE POINT OF THIS FUNCTION. The receiver runs with
 * `reliable_ack_sources {"V":"mqtt"}`, which chains the vehicle's own
 * acknowledgement to the broker accepting the message: once we PUBACK, the car
 * is free to discard it. So `done()` is called strictly AFTER `onMessage`
 * resolves, and `onMessage` resolves only after COMMIT. Acking first would
 * convert any crash in between into data that no longer exists anywhere.
 *
 * Three outcomes, and they are not the same:
 *
 * - The message is unusable (a topic shape we do not know, a body that is not
 *   JSON, a VIN that is not ours). Counted and ACKED. Nothing about redelivering
 *   it would make it parse, and an unacked message is redelivered ahead of
 *   everything behind it - one poison message would wedge the durable session.
 * - Handling failed (the database is down). Counted and NOT acked, so the broker
 *   keeps it and delivers it again after the reconnect.
 * - It worked. Acked after the commit.
 *
 * Nothing here throws: a single bad message must never kill the worker, because
 * a dead worker loses every message that arrives while it is down.
 */
export function makeMessageHandler(
  opts: MqttOptions,
  onMessage: (m: RawMessage) => Promise<void>,
  hooks: MqttHooks = {},
): MessageHandler {
  return (packet, done) => {
    const topic = packet.topic === undefined ? '' : packet.topic.toString()
    const info = parseTopic(topic)
    if (!info) {
      hooks.onParseFailure?.('topic')
      done()
      return
    }
    hooks.onRecord?.(info.kind)

    // A message for a VIN we are not configured for cannot be attributed to a
    // `vehicle` row, and inserting it anyway is a foreign key violation on every
    // redelivery. Drop it visibly instead.
    if (opts.vin !== null && info.vin !== opts.vin) {
      hooks.onParseFailure?.('unknown-vehicle')
      done()
      return
    }

    const body = bodyOf(packet)
    // A zero-length payload is how MQTT clears a retained message, not a broken
    // publisher. Counted separately so it cannot drown the signal from real
    // decode failures.
    if (body.length === 0) {
      hooks.onParseFailure?.('empty')
      done()
      return
    }

    let value: unknown
    try {
      // The metrics payload is the VALUE ALONE - a bare number, string, boolean,
      // `{latitude, longitude}`, or `null` for Value_Invalid. `null` parses
      // fine and is a legitimate "reading unavailable"; the normaliser drops it.
      value = JSON.parse(body)
    } catch {
      hooks.onParseFailure?.('json')
      done()
      return
    }

    // The field name exists ONLY in the topic, so it is folded into the payload
    // before the message reaches the tape. `raw_message` has no topic column,
    // and a stored value with no field name attached would be unreplayable -
    // reprocess would have a number and no idea what it measured.
    const envelope: TeslaEnvelope = {
      kind: info.kind,
      vin: info.vin,
      field: info.field,
      value,
    }

    onMessage({
      vehicleId: opts.vehicleId,
      vendor: 'tesla',
      // The metrics transport carries no timestamp of its own: `getDatumValue`
      // publishes the value alone. Arrival time is the only time we have.
      receivedAt: new Date(),
      source: 'telemetry',
      payload: envelope,
    }).then(
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

function bodyOf(packet: PublishPacketLike): string {
  const body = packet.payload
  if (body === undefined) return ''
  return typeof body === 'string' ? body : Buffer.from(body).toString('utf8')
}
