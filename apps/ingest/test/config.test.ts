import { describe, expect, it } from 'vitest'
import { RECEIVER_CLIENT_ID, loadConfig } from '../src/config.js'

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
