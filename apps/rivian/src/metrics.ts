import { createServer, type Server } from 'node:http'
import type { RivianConnectorState } from '@ev/db'
import { RIVIAN_STREAMS, type RivianStream } from '@ev/rivian'
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client'

/**
 * Instrumentation for the failure this connector exists to prevent: not
 * crashing, but quietly holding no session. A crash restarts loudly; a
 * connector that is signed out, rate-limited, unauthenticated or backing off
 * for an hour is a pod that is Running and recording nothing, and every minute
 * of it is a car's history that Rivian will not send again (design §5.7).
 *
 * The names are §5.7's, plus `rivian_mqtt_connected`, which is not in the list
 * and is here for a reason found afterwards: a wrong broker password makes
 * mqtt.js retry for ever without any frame failing, so the queue just grows
 * towards its cap, and nothing else on this page says the broker is the problem.
 */
export const registry = new Registry()
collectDefaultMetrics({ register: registry })

/**
 * What the connector reports through, as an interface rather than the objects
 * below, so that its tests pass a fake that records the calls. Each method is
 * one fact the connector has just learned; none takes a label the caller could
 * get wrong (the state and stream are typed, the reconnect reason is one of
 * `RECONNECT_REASONS`).
 */
export interface ConnectorMetrics {
  setState(s: RivianConnectorState): void
  frame(stream: RivianStream): void
  dropped(n: number): void
  publishFailure(): void
  reconnect(reason: string): void
  droppedProperties(n: number): void
  pollFailure(): void
  lastFrame(atMs: number): void
}

/**
 * Every state, written out so the gauge can be one-hot over all of them. The
 * object form is how the compiler holds this list to the type: a state added to
 * `RivianConnectorState` without a line here is an error, and so is a line for a
 * state that does not exist.
 */
const STATE_NAMES: readonly RivianConnectorState[] = Object.keys({
  signed_out: 0,
  starting: 0,
  credential_invalid: 0,
  finding_vehicle: 0,
  waiting_for_vehicle: 0,
  connecting: 0,
  subscribed: 0,
  backing_off: 0,
  unauthenticated: 0,
} satisfies Record<RivianConnectorState, 0>) as RivianConnectorState[]

/**
 * The streams a frame can arrive on. `meta` is left out: it is what the
 * connector says about itself, not something Rivian sent, so it is never
 * counted by `frame()`, and a series that can never move would only look like
 * a stream that has gone quiet.
 */
const SUBSCRIPTION_STREAMS: readonly RivianStream[] = RIVIAN_STREAMS.filter((s) => s !== 'meta')

/**
 * Why a reconnect was scheduled: how the websocket ended (`socket.ts`'s
 * `CloseReason`, less `unauthenticated`, which is never retried and so never a
 * reconnect) or `http`, for a Rivian HTTP call that failed before there was a
 * socket to open. Bounded on purpose: it is a label.
 */
export const RECONNECT_REASONS = ['rate_limited', 'no_ack', 'closed', 'error', 'http'] as const

const connectorState = new Gauge({
  name: 'rivian_connector_state',
  help: 'One-hot: 1 for the state the connector is in, 0 for every other state.',
  labelNames: ['state'] as const,
  registers: [registry],
})

const framesTotal = new Counter({
  name: 'rivian_frames_total',
  help: 'Frames received from Rivian and queued for the broker, by stream.',
  labelNames: ['stream'] as const,
  registers: [registry],
})

const framesDroppedTotal = new Counter({
  name: 'rivian_frames_dropped_total',
  help: 'Frames dropped because the publish queue was full or shutdown ended first.',
  registers: [registry],
})

const publishFailuresTotal = new Counter({
  name: 'rivian_publish_failures_total',
  help: 'MQTT publishes that failed and were retried. A broker outage is not one: see rivian_mqtt_connected.',
  registers: [registry],
})

const reconnectsTotal = new Counter({
  name: 'rivian_reconnects_total',
  help: 'Reconnects scheduled after a failure, by reason.',
  labelNames: ['reason'] as const,
  registers: [registry],
})

const droppedPropertiesGauge = new Gauge({
  name: 'rivian_dropped_properties',
  help: 'vehicleState properties Rivian rejects and the connector no longer subscribes to.',
  registers: [registry],
})

const credentialPollFailuresTotal = new Counter({
  name: 'rivian_credential_poll_failures_total',
  help: 'Credential polls whose query failed. The socket is unaffected.',
  registers: [registry],
})

/**
 * Seconds, not milliseconds, so that an alert can say `time() - ...` the way the
 * ingest worker's does. Initialised to 0, which reads as 1970 and so as "no
 * frame ever", and a staleness alert over it fires on a connector that starts
 * and stays silent.
 */
const lastFrameTimestampSeconds = new Gauge({
  name: 'rivian_last_frame_timestamp_seconds',
  help: 'UNIX time of the most recent frame received from Rivian.',
  registers: [registry],
})

/** Whether the MQTT client holds a connection (1) or not (0). Set by `connectMqtt`'s hook. */
export const mqttConnected = new Gauge({
  name: 'rivian_mqtt_connected',
  help: 'Whether the MQTT client currently holds a connection (1) or not (0).',
  registers: [registry],
})

export const connectorMetrics: ConnectorMetrics = {
  setState(s) {
    for (const state of STATE_NAMES) connectorState.set({ state }, state === s ? 1 : 0)
  },
  frame: (stream) => framesTotal.inc({ stream }),
  dropped: (n) => framesDroppedTotal.inc(n),
  publishFailure: () => publishFailuresTotal.inc(),
  reconnect: (reason) => reconnectsTotal.inc({ reason }),
  droppedProperties: (n) => droppedPropertiesGauge.set(n),
  pollFailure: () => credentialPollFailuresTotal.inc(),
  lastFrame: (atMs) => lastFrameTimestampSeconds.set(atMs / 1000),
}

/**
 * Create every series at startup, before anything has happened.
 *
 * A Prometheus series does not exist until it is first written, and an alert
 * over an absent series evaluates an empty vector and never fires. The failures
 * this connector is watched for are mostly NEVER events (no frame has ever
 * arrived, the broker has never connected, no credential poll has ever
 * succeeded), so the series must exist at zero for "never" to be a value. Every
 * state is written, so the one-hot gauge has a row for each of them from the
 * first scrape; none is set to 1, because at startup the connector has not yet
 * found out which it is in. Every stream and reconnect reason is seeded too, so
 * `rate()` over a label that has not fired yet returns a number instead of
 * nothing.
 *
 * Call once, at startup, from the entrypoint.
 */
export function initialiseSeries(): void {
  for (const state of STATE_NAMES) connectorState.set({ state }, 0)
  for (const stream of SUBSCRIPTION_STREAMS) framesTotal.inc({ stream }, 0)
  for (const reason of RECONNECT_REASONS) reconnectsTotal.inc({ reason }, 0)
  framesDroppedTotal.inc(0)
  publishFailuresTotal.inc(0)
  droppedPropertiesGauge.set(0)
  credentialPollFailuresTotal.inc(0)
  lastFrameTimestampSeconds.set(0)
  mqttConnected.set(0)
}

/**
 * Serve `/metrics` for Prometheus and `/healthz` for the kubelet. Copied from
 * the ingest worker's, not imported: the two images share no application code,
 * and a metrics server is too small to be worth a package of its own.
 */
export function startMetricsServer(port: number): Server {
  const server = createServer((req, res) => {
    if (req.url === '/metrics') {
      registry
        .metrics()
        .then((body) => {
          res.writeHead(200, { 'content-type': registry.contentType })
          res.end(body)
        })
        .catch(() => {
          res.writeHead(500)
          res.end()
        })
      return
    }
    // Anything else is the kubelet's probe. 200 while the process is up is the
    // honest answer: liveness here means "the event loop still turns". Whether a
    // session is held is what `rivian_connector_state` is for, and failing a
    // probe on a signed-out connector would restart it for no reason.
    res.writeHead(req.url === '/healthz' ? 200 : 404)
    res.end()
  })
  server.listen(port)
  return server
}
