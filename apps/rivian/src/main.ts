import { closePool, getPool } from '@ev/db'
import { RivianHttp } from '@ev/rivian'
import { loadConnectorConfig } from './config.js'
import { Connector, systemClock } from './connector.js'
import {
  connectorMetrics,
  initialiseSeries,
  mqttConnected,
  startMetricsServer,
} from './metrics.js'
import { Publisher, connectMqtt } from './publisher.js'
import { PublishQueue } from './queue.js'
import { openSocket } from './socket.js'
import { pgConnectorStore } from './store.js'

/** The longest shutdown waits for the connection pool to close before it exits anyway. */
const POOL_CLOSE_WAIT_MS = 3_000

/**
 * The connector's entrypoint: wire the parts together, start them, and see
 * that they stop cleanly.
 *
 * Everything with a decision in it is in `connector.ts`. What is here is the
 * order things are started in, and what happens when it goes wrong.
 */
async function main(): Promise<void> {
  const config = loadConnectorConfig()

  // BEFORE anything else can fail, so that "never" is a value an alert can see.
  // Every series that is only written when something happens (a frame, a
  // reconnect, a poll failure) does not exist until it first does, and an alert
  // over an absent series evaluates an empty vector and never fires. See
  // `initialiseSeries` for what is seeded and why.
  initialiseSeries()

  const metricsServer = startMetricsServer(config.metricsPort)
  const pool = getPool()

  const queue = new PublishQueue()
  const client = connectMqtt(config.mqtt, {
    // The only way a wrong broker password, or a broker that is simply gone,
    // is visible: mqtt.js retries for ever and fails no publish, so frames
    // just queue (see `connectMqtt`).
    onConnectionChange: (connected) => mqttConnected.set(connected ? 1 : 0),
  })
  const publisher = new Publisher(client, queue, {
    onPublished: () => {},
    onFailure: () => connectorMetrics.publishFailure(),
  })

  const connector = new Connector({
    config,
    store: pgConnectorStore(pool),
    http: new RivianHttp(),
    openSocket,
    queue,
    publisher,
    clock: systemClock,
    metrics: connectorMetrics,
    log: (line) => console.log(line),
  })
  connector.start()

  let closing = false
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return
    closing = true
    console.log(`${signal} received, shutting down`)
    try {
      await connector.stop()
    } catch (err) {
      // The error is named and nothing more: it is whatever went wrong while
      // the connector held a session token, a broker password and a key.
      console.error('shutdown failed', err instanceof Error ? err.name : 'error')
    }
    metricsServer.close()
    // Raced against a short wait, not simply awaited. A database call that the
    // connector gave up on (`#withinTimeout`) is still running, and still holds
    // its client; `pool.end()` waits for every client to be released, so against
    // a Postgres that has stopped answering it can wait for ever. Shutdown has
    // already spent its drain on the broker, the orchestrator's grace period is
    // running, and a pool that will not close is no reason to be killed halfway
    // through it.
    await Promise.race([
      closePool().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, POOL_CLOSE_WAIT_MS)),
    ])
    // exit(), not a return. The MQTT end that `stop()` waits for is graceful,
    // and a graceful end may not destroy the stream: a broker that has gone
    // quiet leaves a socket that holds the event loop open, and the pod would
    // sit through its whole grace period and then be killed, losing nothing but
    // looking like a crash. Everything that had to be said has been said by
    // here, so the process ends.
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  console.log(
    `ev-rivian listening: broker=${config.mqtt.url} client=${config.mqtt.clientId} ` +
      `metrics=:${config.metricsPort}`,
  )
}

main().catch((err: unknown) => {
  // The message is printed, and only the message: the usual cause is a config
  // mistake ("missing required environment variable ..."), and that sentence is
  // exactly what the operator needs. Every error that can reach here from
  // startup has a fixed message that never quotes a value (`loadConnectorConfig`,
  // `parseJwk` and `getPool` are written that way on purpose), whereas an error
  // object logged whole carries its stack and whatever else it was given.
  console.error('ev-rivian failed to start', err instanceof Error ? err.message : 'error')
  // exit(), not exitCode: by the time startup can fail the metrics server is
  // already listening, and an open server holds the process up indefinitely.
  // The liveness probe is a TCP check on that very port, so the pod would stay
  // Running and never be restarted, holding no session. That is how a node
  // reboot that beat Postgres to readiness cost the Tesla worker six days of
  // telemetry.
  process.exit(1)
})
