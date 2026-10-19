import mqtt from 'mqtt'
import {
  parseRivianTopic,
  rivianRecordLabel,
  tapeRivianBody,
  type RawMessage,
  type Vendor,
} from './deps.js'
import type { RecordKind, TeslaEnvelope } from './pipeline.js'

export interface MqttOptions {
  url: string
  username: string
  password: string
  /**
   * The vendor's own id ('ev-ingest' for Tesla, 'ev-ingest-rivian' for Rivian),
   * and MUST NOT be any other process's: the receiver's 'ev-fleet-telemetry',
   * the connector's 'ev-rivian', or the other vendor's worker (config.ts refuses
   * them at startup). MQTT permits one live connection per client id: a
   * collision disconnects the incumbent, which reconnects and disconnects us,
   * forever. It is also the key the broker files our durable session under, so
   * changing it silently abandons whatever backlog the old id was holding, and
   * taking another worker's id inherits ITS backlog, which we would then ack as
   * parse failures.
   */
  clientId: string
  topic: string
  /** Our own vehicle id (the `vehicle.id` FK), not the VIN. */
  vehicleId: string
  /** The VIN we expect on the wire; messages for any other VIN are dropped. */
  vin: string | null
}

export interface MqttHooks {
  /**
   * A string, not `RecordKind`: for Tesla it is the record kind, for Rivian the
   * stream name, and a Rivian stream is not a Tesla record kind.
   */
  onRecord?(record: string): void
  onParseFailure?(reason: ParseFailure): void
  onHandlerError?(err: unknown): void
  onConnectionChange?(connected: boolean): void
}

/**
 * Why a message was discarded. Separate reasons because they mean different
 * things operationally: a rise in `topic` means fleet-telemetry changed its
 * layout under us, a rise in `json` means a broken publisher, and
 * `unknown-vehicle` is usually just a second car on a shared broker.
 *
 * `envelope` is the odd one out: Rivian only, and the message was NOT
 * discarded. The body was JSON, so it was taped, but it was not a v1 envelope
 * with a usable `receivedAt`. A rise means the connector and this reader have
 * drifted apart, and the taped frames are waiting for a reader that can use them.
 */
export type ParseFailure = 'topic' | 'json' | 'empty' | 'unknown-vehicle' | 'envelope'

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
 * Build the Tesla QoS 1 message handler. Rivian's is `makeRivianMessageHandler`;
 * the ack discipline below is shared by both.
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

    handOff(onMessage({
      vehicleId: opts.vehicleId,
      vendor: 'tesla',
      // The metrics transport carries no timestamp of its own: `getDatumValue`
      // publishes the value alone. Arrival time is the only time we have.
      receivedAt: new Date(),
      source: 'telemetry',
      payload: envelope,
    }), hooks, done)
  }
}

/**
 * Build the Rivian QoS 1 message handler.
 *
 * The ack discipline is `makeMessageHandler`'s, unchanged, and the reason is
 * the same even though one link is missing. Rivian has no `reliable_ack_sources`
 * chain behind it: the connector's publish is not held until we acknowledge it
 * and the vehicle is not waiting on us. But the broker's queue for our durable
 * session is still the ONLY buffer between the connector and the tape, and a
 * frame acked before its commit and then lost to a crash is gone from every
 * place it could be recovered from. So `done()` is called strictly after
 * `onMessage` resolves, which is after COMMIT.
 *
 * The outcomes, and what separates them:
 *
 * - UNUSABLE, counted and ACKED: a topic that is not `rivian/<VIN>/<stream>`, a
 *   VIN that is not ours, an empty body, or text that is not JSON. Redelivering
 *   one would not change it, and an unacked message is redelivered ahead of
 *   everything behind it.
 * - HANDLING FAILED, counted and NOT acked: the database is down. The broker
 *   keeps it and delivers it again.
 * - TAPED, acked after the commit. That includes a body that is JSON but not a
 *   v1 envelope, or whose `receivedAt` is unusable: those are taped as they are
 *   (at arrival time, for the stamp) and counted under `envelope`, because a
 *   frame we cannot read today is one a later reader can read, and only if it
 *   is on the tape. A connector deployed ahead of this reader loses nothing.
 *
 * The parsing is in `deps.ts` (`parseRivianTopic`, `tapeRivianBody`): this
 * module may not import `@ev/rivian`. What it adds is the ordering, and that
 * nothing here throws: one bad message must not kill the worker.
 */
export function makeRivianMessageHandler(
  opts: MqttOptions,
  onMessage: (m: RawMessage) => Promise<void>,
  hooks: MqttHooks = {},
): MessageHandler {
  return (packet, done) => {
    const topic = packet.topic === undefined ? '' : packet.topic.toString()
    const info = parseRivianTopic(topic)
    if (!info) {
      hooks.onParseFailure?.('topic')
      done()
      return
    }
    // The stream, counted before the checks below, as the Tesla handler does, so
    // a message for another vehicle still shows up in the volume the worker is
    // being offered. A stream we do not list is counted as `other` (see
    // `rivianRecordLabel`: the label becomes a series, and a topic is whatever a
    // publisher sent). The frame itself is untouched and still taped.
    hooks.onRecord?.(rivianRecordLabel(info.stream))

    // See the Tesla handler: a VIN that is not ours has no `vehicle` row to
    // attach to, and inserting it would fail its foreign key on every redelivery.
    if (opts.vin !== null && info.vin !== opts.vin) {
      hooks.onParseFailure?.('unknown-vehicle')
      done()
      return
    }

    const body = bodyOf(packet)
    if (body.length === 0) {
      hooks.onParseFailure?.('empty')
      done()
      return
    }

    const taped = tapeRivianBody(body, new Date())
    if ('error' in taped) {
      hooks.onParseFailure?.('json')
      done()
      return
    }
    if (!taped.envelopeOk) hooks.onParseFailure?.('envelope')

    handOff(onMessage({
      vehicleId: opts.vehicleId,
      vendor: 'rivian',
      // The connector's clock, which is when the frame arrived; ours would be
      // when it got through the broker, hours later after a backlog.
      receivedAt: taped.receivedAt,
      source: 'graphql_ws',
      payload: taped.payload,
    }), hooks, done)
  }
}

/**
 * The tail both handlers share: ack after the write resolves, never before, and
 * on a failure report it and pass the error to `done`, which withholds the
 * PUBACK so the broker redelivers.
 */
function handOff(
  written: Promise<void>,
  hooks: MqttHooks,
  done: (err?: Error) => void,
): void {
  written.then(
    () => done(),
    (err: unknown) => {
      hooks.onHandlerError?.(err)
      done(err instanceof Error ? err : new Error(String(err)))
    },
  )
}

/**
 * Options for a worker that is wired to a vendor: the connection and the car,
 * plus which vendor's handler reads what arrives on it.
 */
export type VendorMqttOptions = MqttOptions & { vendor: Vendor }

/**
 * The one place a vendor chooses its message handler.
 *
 * It is a function of its own so that the choice can be tested: a flipped branch
 * here would hand a Rivian worker the Tesla topic parser, which would ack every
 * `rivian/...` message as a `topic` failure. That is the worst failure this
 * worker has, an ack for a message that was dropped, and nothing but the
 * parse-failure counter would show it.
 */
export function handlerFor(
  vendor: Vendor,
  opts: MqttOptions,
  onMessage: (m: RawMessage) => Promise<void>,
  hooks: MqttHooks = {},
): MessageHandler {
  switch (vendor) {
    case 'tesla': return makeMessageHandler(opts, onMessage, hooks)
    case 'rivian': return makeRivianMessageHandler(opts, onMessage, hooks)
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
  opts: VendorMqttOptions,
  onMessage: (m: RawMessage) => Promise<void>,
  hooks: MqttHooks = {},
): void {
  client.handleMessage = handlerFor(opts.vendor, opts, onMessage, hooks)

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

/**
 * Connect and wire the handler for `opts.vendor`. The vendor picks the topic
 * parser and the body reader; everything else, the durable session included,
 * is the same.
 */
export function subscribe(
  opts: VendorMqttOptions,
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
