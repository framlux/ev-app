/**
 * Configuration, resolved once at startup so a missing value fails the pod
 * immediately rather than on the first message of the day.
 */
export interface Config {
  mqtt: {
    url: string
    username: string
    password: string
    clientId: string
    topic: string
  }
  vehicle: {
    id: string
    vin: string | null
    displayName: string
  }
  usableCapacityKwh: number
  metricsPort: number
  /** Key under which the watermark is filed in `ingest_cursor`. */
  cursorSource: string
}

/**
 * The receiver's client id. Reserved, not merely discouraged: MQTT allows one
 * live connection per client id, so sharing it would make ev-ingest and
 * ev-telemetry disconnect each other in a permanent reconnect loop where each
 * looks healthy in isolation.
 */
export const RECEIVER_CLIENT_ID = 'ev-fleet-telemetry'

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const clientId = env['MQTT_CLIENT_ID'] ?? 'ev-ingest'
  if (clientId === RECEIVER_CLIENT_ID) {
    throw new Error(
      `MQTT_CLIENT_ID must not be '${RECEIVER_CLIENT_ID}': that is the telemetry ` +
      'receiver\'s id, and two connections sharing one id evict each other forever',
    )
  }

  return {
    mqtt: {
      url: env['MQTT_URL'] ?? 'tcp://ev-mqtt.ev.svc.cluster.local:1883',
      username: env['MQTT_USERNAME'] ?? 'telemetry',
      password: required(env, 'MQTT_PASSWORD'),
      clientId,
      topic: env['MQTT_TOPIC'] ?? 'ev/#',
    },
    vehicle: {
      id: required(env, 'EV_VEHICLE_ID'),
      vin: env['EV_VEHICLE_VIN'] ?? null,
      displayName: env['EV_VEHICLE_NAME'] ?? required(env, 'EV_VEHICLE_ID'),
    },
    // No default. A guessed capacity silently rescales every drive's energy and
    // efficiency figure, and the error is plausible enough never to be noticed.
    usableCapacityKwh: positiveNumber(env, 'EV_USABLE_CAPACITY_KWH'),
    metricsPort: Number(env['METRICS_PORT'] ?? 9090),
    cursorSource: env['EV_CURSOR_SOURCE'] ?? 'tesla:mqtt',
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]
  if (!v) throw new Error(`missing required environment variable ${name}`)
  return v
}

function positiveNumber(env: NodeJS.ProcessEnv, name: string): number {
  const raw = required(env, name)
  const n = Number(raw)
  // Number('') is 0 and Number('12kWh') is NaN; both would otherwise become a
  // capacity of 0 or NaN and poison every derived energy figure downstream.
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number, got ${JSON.stringify(raw)}`)
  }
  return n
}
