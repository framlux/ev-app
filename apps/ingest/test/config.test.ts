import { describe, expect, it } from 'vitest'
import { RECEIVER_CLIENT_ID, loadConfig } from '../src/config.js'
import { initialiseSeries, registry } from '../src/metrics.js'

const BASE = {
  MQTT_PASSWORD: 'secret',
  EV_VEHICLE_ID: 'veh-1',
  EV_USABLE_CAPACITY_KWH: '75',
}

describe('loadConfig', () => {
  it('defaults to the in-cluster broker, the ev topic tree and client id ev-ingest', () => {
    const config = loadConfig({ ...BASE })
    expect(config.mqtt.url).toBe('tcp://ev-mqtt.ev.svc.cluster.local:1883')
    expect(config.mqtt.username).toBe('telemetry')
    expect(config.mqtt.clientId).toBe('ev-ingest')
    expect(config.mqtt.topic).toBe('ev/#')
    expect(config.metricsPort).toBe(9090)
  })

  it('refuses the telemetry receiver client id', () => {
    // Two connections sharing one client id evict each other in a permanent
    // reconnect loop, and each side's logs look like the other one's fault.
    expect(() => loadConfig({ ...BASE, MQTT_CLIENT_ID: RECEIVER_CLIENT_ID }))
      .toThrow(/must not be/)
    expect(loadConfig({ ...BASE, MQTT_CLIENT_ID: 'ev-ingest-2' }).mqtt.clientId)
      .toBe('ev-ingest-2')
  })

  it.each(['MQTT_PASSWORD', 'EV_VEHICLE_ID', 'EV_USABLE_CAPACITY_KWH'])(
    'fails fast when %s is missing', (name) => {
      const env: Record<string, string> = { ...BASE }
      delete env[name]
      expect(() => loadConfig(env)).toThrow(new RegExp(name))
    })

  it.each([
    ['', true],
    ['   ', true],
    ['75kWh', true],
    ['0', true],
    ['-75', true],
    ['75', false],
    ['75.5', false],
  ])('capacity %s rejected: %s', (value, rejected) => {
    const run = () => loadConfig({ ...BASE, EV_USABLE_CAPACITY_KWH: value })
    // Number('') is 0 and Number('75kWh') is NaN; either would silently rescale
    // every drive's energy figure instead of failing.
    if (rejected) expect(run).toThrow()
    else expect(run().usableCapacityKwh).toBe(Number(value))
  })
})

describe('loadConfig: the home location', () => {
  const AT_HOME = { EV_HOME_LAT: '47.6062', EV_HOME_LON: '-122.3321' }

  it('leaves the coordinate fallback off when neither coordinate is set', () => {
    // Absent is a working configuration, not a broken one: the car's own
    // `locatedAtHome` is then the only test, which is the better signal anyway.
    expect(loadConfig({ ...BASE }).home).toBeNull()
    expect(loadConfig({ ...BASE }).openEiApiKey).toBeNull()
  })

  it('accepts a western longitude', () => {
    // The reason `positiveNumber` cannot be reused. Seattle is at about -122,
    // and every longitude in the western hemisphere is negative — a validator
    // that rejects them rejects half the planet.
    const home = loadConfig({ ...BASE, ...AT_HOME }).home
    expect(home).toEqual({ lat: 47.6062, lon: -122.3321, radiusKm: 0.1 })
  })

  it.each(['EV_HOME_LAT', 'EV_HOME_LON'])('refuses %s on its own', (name) => {
    // Half a coordinate is not a location. Silently ignoring the half that was
    // set would disable the fallback the operator was trying to switch on, and
    // the only symptom would be charges classified `unknown` months later.
    expect(() => loadConfig({ ...BASE, [name]: AT_HOME[name as keyof typeof AT_HOME] }))
      .toThrow(/EV_HOME_LAT.*EV_HOME_LON|EV_HOME_LON.*EV_HOME_LAT/)
  })

  it.each([
    ['EV_HOME_LAT', ''],
    ['EV_HOME_LAT', '   '],
    ['EV_HOME_LAT', 'north'],
    ['EV_HOME_LAT', '91'],
    ['EV_HOME_LAT', '-91'],
    ['EV_HOME_LON', ''],
    ['EV_HOME_LON', '-181'],
    ['EV_HOME_LON', '181'],
  ])('%s of %s fails startup', (name, value) => {
    // Number('') is 0, so an empty value does not disable the fallback — it
    // moves home to 0°N 0°E, a point in the Gulf of Guinea about 12,000 km from
    // any real driveway. Every charge would then classify as not-home and be
    // priced as unknown, and nothing anywhere would say why. Crashing the pod
    // at startup is the only symptom an operator can act on.
    expect(() => loadConfig({ ...BASE, ...AT_HOME, [name]: value })).toThrow(new RegExp(name))
  })

  it('accepts the equator and the prime meridian when they are meant', () => {
    // The flip side of the rule above: 0 is a legitimate coordinate, so the
    // check is on the text being present and numeric, never on the value being
    // truthy.
    expect(loadConfig({ ...BASE, EV_HOME_LAT: '0', EV_HOME_LON: '0' }).home)
      .toMatchObject({ lat: 0, lon: 0 })
  })

  it('takes a wider radius when one is configured, and refuses a broken one', () => {
    // 100 m by default: a driveway, not a postcode. The radius decides which
    // charges get the domestic rate, so a garbled value must not quietly become
    // zero — that would switch the fallback off while looking configured.
    expect(loadConfig({ ...BASE, ...AT_HOME, EV_HOME_RADIUS_KM: '0.25' }).home?.radiusKm)
      .toBe(0.25)
    for (const bad of ['', '0', '-1', 'wide']) {
      expect(() => loadConfig({ ...BASE, ...AT_HOME, EV_HOME_RADIUS_KM: bad }))
        .toThrow(/EV_HOME_RADIUS_KM/)
    }
  })

  it('carries the OpenEI key through when there is one', () => {
    expect(loadConfig({ ...BASE, OPENEI_API_KEY: 'k-123' }).openEiApiKey).toBe('k-123')
  })
})

/**
 * These live here, not in a metrics test file of their own, because this change
 * owns `config.test.ts` and may not add files: `apps/ingest/test/metrics.test.ts`
 * is the right home for them once someone can create it.
 */
describe('metrics series initialisation', () => {
  it('creates the stall-alert gauge before any sample exists', async () => {
    // Before initialisation the gauge is an EMPTY VECTOR, and the alert rule
    // `time() - max by (vehicle) (ev_ingest_last_sample_timestamp_seconds)`
    // over an empty vector produces no samples - so a worker that restarts and
    // then ingests nothing, the exact failure the alert exists for, could never
    // fire it.
    expect(await registry.metrics())
      .not.toMatch(/^ev_ingest_last_sample_timestamp_seconds\{/m)

    initialiseSeries('veh-1')

    const body = await registry.metrics()
    // 0 is 1970: an honest "no sample ever", and time() - 0 is enormous, so the
    // alert fires straight away rather than staying silent.
    expect(body).toContain('ev_ingest_last_sample_timestamp_seconds{vehicle="veh-1"} 0')
    expect(body).toContain('ev_ingest_mqtt_connected 0')
  })

  it('seeds the labelled counters the failure alerts read', async () => {
    initialiseSeries('veh-1')
    const body = await registry.metrics()
    // rate() and increase() over an absent series return nothing at all, so an
    // unseeded counter cannot be alerted on either.
    for (const line of [
      'ev_ingest_parse_failures_total{reason="topic"} 0',
      'ev_ingest_parse_failures_total{reason="json"} 0',
      'ev_ingest_parse_failures_total{reason="empty"} 0',
      'ev_ingest_parse_failures_total{reason="unknown-vehicle"} 0',
      'ev_ingest_messages_total{vendor="tesla",record="metrics"} 0',
      'ev_ingest_samples_written_total{vendor="tesla"} 0',
      'ev_ingest_handler_errors_total 0',
    ]) {
      expect(body).toContain(line)
    }
  })
})
