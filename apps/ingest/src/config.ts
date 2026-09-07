import type { HomeLocation } from './pricing.js'

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
  /**
   * Where the car lives, for pricing a charge at the domestic rate when the
   * car's own `locatedAtHome` never arrives (spec §3.4). Null disables that
   * fallback and leaves the signal as the only test, which is a working
   * configuration rather than a degraded one.
   */
  home: HomeLocation | null
  /**
   * NREL's key for the URDB rate fetch (spec §3.3). Null skips the fetch
   * entirely and leaves manual rates as the whole story — still a working
   * product, just one where the owner types the number in.
   *
   * The only variable here that breaks the EV_/MQTT_ prefix pattern, and
   * deliberately: it names a vendor's service rather than anything about this
   * system, so EV_OPENEI_API_KEY would imply we owned the account. No test
   * constrains the name — `env-names.test.ts` greps apps/web only.
   */
  openEiApiKey: string | null
}

/** Metres, near enough: a driveway, not a postcode. */
export const DEFAULT_HOME_RADIUS_KM = 0.1

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
    home: homeLocation(env),
    openEiApiKey: env['OPENEI_API_KEY'] ?? null,
  }
}

/**
 * The home coordinate pair, all or nothing.
 *
 * All-or-nothing because half a coordinate is not a location, and the failure
 * of ignoring the half that was set is invisible: the fallback the operator
 * meant to switch on stays off, and the only evidence is charges classified
 * `unknown` weeks later.
 */
function homeLocation(env: NodeJS.ProcessEnv): HomeLocation | null {
  const lat = env['EV_HOME_LAT']
  const lon = env['EV_HOME_LON']
  if (lat === undefined && lon === undefined) return null
  if (lat === undefined || lon === undefined) {
    throw new Error('EV_HOME_LAT and EV_HOME_LON must be set together, or neither')
  }
  return {
    lat: coordinate(env, 'EV_HOME_LAT', 90),
    lon: coordinate(env, 'EV_HOME_LON', 180),
    radiusKm: env['EV_HOME_RADIUS_KM'] === undefined
      ? DEFAULT_HOME_RADIUS_KM
      : positiveNumber(env, 'EV_HOME_RADIUS_KM'),
  }
}

/**
 * A latitude or longitude, in degrees.
 *
 * Not `positiveNumber`, and the difference is not pedantry twice over. That
 * validator rejects negatives, and every longitude in the western hemisphere is
 * one — Seattle is at about -122. And it accepts what `Number` makes of an
 * empty string, which is 0: an unset value would silently become the coordinate
 * 0,0, a real point in the Gulf of Guinea some 12,000 km from any driveway.
 * Every charge would then classify as not-home and be priced as unknown, with
 * nothing anywhere reporting a problem. A set-but-empty value has to fail
 * startup, because a crashing pod is the only symptom an operator can act on.
 *
 * Zero itself is legal, so the emptiness test is on the text and never on the
 * number being truthy.
 */
function coordinate(env: NodeJS.ProcessEnv, name: string, limit: number): number {
  const raw = env[name] ?? ''
  const n = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(n) || Math.abs(n) > limit) {
    throw new Error(
      `${name} must be a number between -${limit} and ${limit}, ` +
      `got ${JSON.stringify(raw)}`)
  }
  return n
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
