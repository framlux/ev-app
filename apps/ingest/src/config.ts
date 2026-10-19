import type { Vendor } from './deps.js'
import type { HomeLocation } from './pricing.js'

/**
 * Configuration, resolved once at startup so a missing value fails the pod
 * immediately rather than on the first message of the day.
 */
export interface Config {
  /**
   * Which car maker this worker ingests. One image serves both, a Deployment
   * per vendor, and this is what picks the profile, the topic parser, the
   * `vendor` stamped on the tape and on `vehicle`, and the metrics label.
   */
  vendor: Vendor
  mqtt: {
    url: string
    username: string
    password: string
    clientId: string
    topic: string
  }
  vehicle: {
    id: string
    /** Optional for Tesla. Never null for Rivian: `loadConfig` refuses to start without it. */
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

/**
 * What each vendor's worker answers to when nothing is configured, and the one
 * topic tree it may subscribe within.
 *
 * Everything that could land a worker on the OTHER vendor's broker session
 * derives from here rather than from a shared default, because the failure is
 * silent and unrecoverable. MQTT files a durable session, and the backlog the
 * broker holds for it, under the client id. A Rivian worker that connected as
 * `ev-ingest` would be handed the Tesla backlog, fail to parse every message as
 * an envelope, and ACK them as parse failures; the Tesla car's own
 * `reliable_ack_sources` chain would then have it discard what it had been
 * waiting to hear acknowledged. No error, no alert, and the data is gone from
 * the car as well. The same worker on a topic outside its own root would do the
 * same to messages that were never meant for it.
 */
const OWN = {
  tesla: { clientId: 'ev-ingest', topic: 'ev/#', root: 'ev/', cursor: 'tesla:mqtt' },
  rivian: { clientId: 'ev-ingest-rivian', topic: 'rivian/#', root: 'rivian/', cursor: 'rivian:mqtt' },
} as const satisfies Record<Vendor, { clientId: string; topic: string; root: string; cursor: string }>

/**
 * Every client id some process in this system holds: the receiver, the Rivian
 * connector, and each vendor's ingest worker. A worker may use its own default
 * by name, and no other id on this list.
 */
const RESERVED_CLIENT_IDS: readonly string[] = [
  RECEIVER_CLIENT_ID, 'ev-rivian', OWN.tesla.clientId, OWN.rivian.clientId,
]

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const vendor = vendorOf(env)
  const own = OWN[vendor]

  const clientId = env['MQTT_CLIENT_ID'] ?? own.clientId
  if (clientId !== own.clientId && RESERVED_CLIENT_IDS.includes(clientId)) {
    throw new Error(
      `MQTT_CLIENT_ID must not be '${clientId}' for a ${vendor} worker: that id belongs to ` +
      'another process in this system (the telemetry receiver, the Rivian connector, or the ' +
      'other vendor\'s ingest worker), and two connections sharing one id evict each other ' +
      'forever, or worse, one inherits the other\'s durable session and acks its backlog. ' +
      `A ${vendor} worker's own id is '${own.clientId}'`,
    )
  }

  const topic = env['MQTT_TOPIC'] ?? own.topic
  if (!topic.startsWith(own.root)) {
    throw new Error(
      `MQTT_TOPIC must start with '${own.root}' for a ${vendor} worker, got ${JSON.stringify(topic)}: ` +
      'a topic outside the vendor\'s own tree (a bare "#" included) would deliver another ' +
      'vendor\'s messages to a worker that can only ack them as parse failures',
    )
  }

  return {
    vendor,
    mqtt: {
      url: env['MQTT_URL'] ?? 'tcp://ev-mqtt.ev.svc.cluster.local:1883',
      username: env['MQTT_USERNAME'] ?? 'telemetry',
      password: required(env, 'MQTT_PASSWORD'),
      clientId,
      topic,
    },
    vehicle: {
      id: required(env, 'EV_VEHICLE_ID'),
      // Upper-cased for both vendors. The VIN keys the vehicle row and is
      // compared with the one in every topic, and both are upper-case on the
      // wire: one typed in lower case would never match either (every Rivian
      // frame would be dropped as another car's), and would be stored as typed.
      // A Tesla VIN is already upper-case, so nothing there changes.
      vin: (vendor === 'rivian' ? requiredVin(env) : env['EV_VEHICLE_VIN'])?.toUpperCase() ?? null,
      displayName: env['EV_VEHICLE_NAME'] ?? required(env, 'EV_VEHICLE_ID'),
    },
    // No default. A guessed capacity silently rescales every drive's energy and
    // efficiency figure, and the error is plausible enough never to be noticed.
    usableCapacityKwh: positiveNumber(env, 'EV_USABLE_CAPACITY_KWH'),
    metricsPort: Number(env['METRICS_PORT'] ?? 9090),
    cursorSource: env['EV_CURSOR_SOURCE'] ?? own.cursor,
    home: homeLocation(env),
    openEiApiKey: env['OPENEI_API_KEY'] ?? null,
  }
}

/**
 * EV_VENDOR, exactly `tesla` or `rivian`, with no default.
 *
 * A default would let a Deployment whose manifest forgot the variable decode
 * one vendor's payloads as the other's and tape them under the wrong vendor:
 * silent, and permanent, since the tape is the record everything is rebuilt
 * from. A crashing pod is the symptom an operator can act on.
 */
function vendorOf(env: NodeJS.ProcessEnv): Vendor {
  const raw = env['EV_VENDOR']
  if (raw === 'tesla' || raw === 'rivian') return raw
  throw new Error(`EV_VENDOR must be 'tesla' or 'rivian', got ${raw === undefined ? 'nothing' : JSON.stringify(raw)}`)
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

/**
 * EV_VEHICLE_VIN, which a Rivian worker cannot start without.
 *
 * Optional for Tesla, where the VIN only keys the vehicle row and the worker
 * falls back to the local id. Not for Rivian (spec §8.2): the vehicle row's
 * vendor id IS the VIN, and it is also what the Rivian handler checks every
 * topic against. With none, the handler accepts any VIN on `rivian/#` and tapes
 * every car's frames under this one vehicle, silently misattributing them, and
 * the sample table has no way to tell that apart afterwards. A crashing pod is
 * the symptom an operator can act on.
 */
function requiredVin(env: NodeJS.ProcessEnv): string {
  const vin = env['EV_VEHICLE_VIN']
  if (!vin) {
    throw new Error(
      'EV_VEHICLE_VIN is required for a rivian worker: it is the vehicle\'s vendor id, and ' +
      'without it frames for any VIN on the topic tree would be taped as this vehicle\'s')
  }
  return vin
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
