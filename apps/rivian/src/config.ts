import { parseJwk } from '@ev/rivian'

/**
 * Configuration, resolved once at startup so a missing or malformed value fails
 * the pod at once rather than on the first thing that needs it (design §5.1).
 *
 * A connector that starts with a bad key, or with the wrong client id, does
 * nothing visibly wrong until much later: the key only matters when a
 * credential arrives, and the client id only when another process shares it.
 * Both are the kind of mistake that is cheap to refuse here and expensive to
 * find afterwards, so both are refused here.
 */

/**
 * The private half of the credential keypair, as `parseJwk` returns it. Derived
 * from `parseJwk` rather than imported from `jose`, so that this package does
 * not take a dependency on a library it never calls itself.
 */
type PrivateJwk = ReturnType<typeof parseJwk>

export interface ConnectorConfig {
  /** The car to find. Never guessed: an account can hold several (design §5.1). */
  vin: string
  /** Opens the sealed credential. Validated as a private P-256 key at load. */
  privateJwk: PrivateJwk
  mqtt: { url: string; username: string; password: string; clientId: string }
  /** Parallax topic filter, or null for every topic. */
  parallaxRvms: string[] | null
  metricsPort: number
}

/** The connector's own client id: the default, and the only one of these it may use. */
export const CONNECTOR_CLIENT_ID = 'ev-rivian'

/**
 * Every client id some OTHER process in this system holds: the Tesla receiver
 * and each vendor's ingest worker.
 *
 * MQTT permits one live connection per client id, and files a durable session
 * under it. A connector that took `ev-ingest-rivian` would be handed that
 * worker's session and would evict the worker from the broker, which would
 * reconnect and evict it in turn, for ever, with each side looking healthy in
 * its own logs. A connector that took `ev-ingest` or `ev-fleet-telemetry` would
 * do the same to the Tesla side, whose car discards what it believes the
 * receiver has acknowledged. The connector only publishes and has no session of
 * its own to preserve, so there is no reason for it to ever answer to one of
 * these; refusing is cheaper than finding out from the Tesla backlog.
 */
const OTHER_CLIENT_IDS: readonly string[] = ['ev-fleet-telemetry', 'ev-ingest', 'ev-ingest-rivian']

export function loadConnectorConfig(env: NodeJS.ProcessEnv = process.env): ConnectorConfig {
  const clientId = env['MQTT_CLIENT_ID'] ?? CONNECTOR_CLIENT_ID
  if (OTHER_CLIENT_IDS.includes(clientId)) {
    throw new Error(
      `MQTT_CLIENT_ID must not be '${clientId}' for the Rivian connector: that id belongs to ` +
        'another process in this system (the telemetry receiver, or an ingest worker), and two ' +
        'connections sharing one id evict each other for ever, or one inherits the other\'s ' +
        `durable session. The connector's own id is '${CONNECTOR_CLIENT_ID}'`,
    )
  }

  return {
    vin: vinOf(env),
    // The text of this variable is a private key. `parseJwk`'s errors are fixed
    // messages that never quote it, and nothing here adds to them.
    privateJwk: parseJwk(required(env, 'RIVIAN_CREDENTIAL_PRIVATE_KEY'), 'private'),
    mqtt: {
      url: env['MQTT_URL'] ?? 'tcp://ev-mqtt.ev.svc.cluster.local:1883',
      username: env['MQTT_USERNAME'] ?? 'rivian',
      password: required(env, 'MQTT_PASSWORD'),
      clientId,
    },
    parallaxRvms: rvmsOf(env['RIVIAN_PARALLAX_RVMS']),
    metricsPort: portOf(env['METRICS_PORT'] ?? '9090'),
  }
}

/**
 * EV_VEHICLE_VIN: required, and a plain alphanumeric string.
 *
 * The VIN becomes the middle segment of every topic the connector publishes to
 * (`rivian/<VIN>/<stream>`), so a VIN holding `/`, `+` or `#` would publish to a
 * different topic than the one ingest listens on, or to none at all. A VIN is
 * alphanumeric by definition, and a value that is not is a typo that is much
 * better refused at startup than discovered as an empty tape.
 */
function vinOf(env: NodeJS.ProcessEnv): string {
  const vin = required(env, 'EV_VEHICLE_VIN')
  if (!/^[A-Za-z0-9]+$/.test(vin)) {
    throw new Error('EV_VEHICLE_VIN must contain only letters and digits')
  }
  return vin
}

/**
 * The Parallax topic filter: comma-separated, each name trimmed, empty names
 * dropped, and nothing left meaning "all topics". An unset variable, an empty
 * one and a stray `,` are all the same instruction, because a filter that
 * silently selected nothing would starve the tape of Parallax and look like a
 * quiet car.
 */
function rvmsOf(raw: string | undefined): string[] | null {
  if (raw === undefined) return null
  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
  return names.length === 0 ? null : names
}

/**
 * A TCP port. `Number('abc')` is NaN and `server.listen(NaN)` throws far from
 * here, after the connector has started doing things, so the check is here.
 */
function portOf(raw: string): number {
  const port = Number(raw)
  if (raw.trim() === '' || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`METRICS_PORT must be a port number from 0 to 65535, got ${JSON.stringify(raw)}`)
  }
  return port
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]
  if (!v) throw new Error(`missing required environment variable ${name}`)
  return v
}
