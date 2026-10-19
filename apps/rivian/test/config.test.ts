import { generateCredentialKeys } from '@ev/rivian'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadConnectorConfig } from '../src/config.js'

let BASE: Record<string, string>

beforeAll(async () => {
  const { privateJwk } = await generateCredentialKeys()
  BASE = {
    EV_VEHICLE_VIN: '7PD2EAAB2VN016249',
    RIVIAN_CREDENTIAL_PRIVATE_KEY: JSON.stringify(privateJwk),
    MQTT_PASSWORD: 'secret',
  }
})

describe('loadConnectorConfig', () => {
  it('defaults to the in-cluster broker, the rivian user and client id ev-rivian', () => {
    const config = loadConnectorConfig({ ...BASE })
    expect(config.vin).toBe('7PD2EAAB2VN016249')
    expect(config.mqtt).toEqual({
      url: 'tcp://ev-mqtt.ev.svc.cluster.local:1883',
      username: 'rivian',
      password: 'secret',
      clientId: 'ev-rivian',
    })
    expect(config.parallaxRvms).toBeNull()
    expect(config.metricsPort).toBe(9090)
  })

  it('reads the broker, user, client id and metrics port from the environment', () => {
    const config = loadConnectorConfig({
      ...BASE,
      MQTT_URL: 'tcp://broker.example:1884',
      MQTT_USERNAME: 'someone',
      MQTT_CLIENT_ID: 'ev-rivian-2',
      METRICS_PORT: '9191',
    })
    expect(config.mqtt.url).toBe('tcp://broker.example:1884')
    expect(config.mqtt.username).toBe('someone')
    expect(config.mqtt.clientId).toBe('ev-rivian-2')
    expect(config.metricsPort).toBe(9191)
  })

  it('returns the private key as a JWK with its private part', () => {
    const config = loadConnectorConfig({ ...BASE })
    expect(config.privateJwk.kty).toBe('EC')
    expect(config.privateJwk.crv).toBe('P-256')
    expect(typeof config.privateJwk.d).toBe('string')
  })

  it.each(['EV_VEHICLE_VIN', 'RIVIAN_CREDENTIAL_PRIVATE_KEY', 'MQTT_PASSWORD'])(
    'fails fast when %s is missing',
    (name) => {
      const env = { ...BASE }
      delete env[name]
      expect(() => loadConnectorConfig(env)).toThrow(new RegExp(name))
    },
  )

  // Another process's id would evict that process from the broker for ever (or
  // inherit its durable session and ack its backlog), and each side's logs would
  // blame the other.
  it.each(['ev-fleet-telemetry', 'ev-ingest', 'ev-ingest-rivian'])(
    'refuses the client id %s, which another process holds',
    (clientId) => {
      expect(() => loadConnectorConfig({ ...BASE, MQTT_CLIENT_ID: clientId })).toThrow(/must not be/)
    },
  )

  it('splits RIVIAN_PARALLAX_RVMS on commas and trims each name', () => {
    expect(
      loadConnectorConfig({ ...BASE, RIVIAN_PARALLAX_RVMS: ' energy_storage.state , vehicle.speed' })
        .parallaxRvms,
    ).toEqual(['energy_storage.state', 'vehicle.speed'])
  })

  it.each(['', '   ', ',', ' , ,'])('reads RIVIAN_PARALLAX_RVMS=%j as "all topics"', (value) => {
    expect(loadConnectorConfig({ ...BASE, RIVIAN_PARALLAX_RVMS: value }).parallaxRvms).toBeNull()
  })

  it('drops the empty names from a list that has some', () => {
    expect(loadConnectorConfig({ ...BASE, RIVIAN_PARALLAX_RVMS: 'a,,b,' }).parallaxRvms).toEqual(['a', 'b'])
  })

  describe('a bad private key fails at load, without quoting it', () => {
    it('refuses text that is not JSON', () => {
      expect(() => loadConnectorConfig({ ...BASE, RIVIAN_CREDENTIAL_PRIVATE_KEY: 'sekrit-not-json' })).toThrow(
        /private key is not valid JSON/,
      )
    })

    it('refuses a public key', () => {
      const { d: _d, ...publicOnly } = JSON.parse(BASE['RIVIAN_CREDENTIAL_PRIVATE_KEY']!)
      expect(() =>
        loadConnectorConfig({ ...BASE, RIVIAN_CREDENTIAL_PRIVATE_KEY: JSON.stringify(publicOnly) }),
      ).toThrow(/no private part/)
    })

    it('refuses a key on another curve', () => {
      const other = { ...JSON.parse(BASE['RIVIAN_CREDENTIAL_PRIVATE_KEY']!), crv: 'P-384' }
      expect(() =>
        loadConnectorConfig({ ...BASE, RIVIAN_CREDENTIAL_PRIVATE_KEY: JSON.stringify(other) }),
      ).toThrow(/curve/)
    })

    it('never puts any of the key in the message', () => {
      const key = JSON.parse(BASE['RIVIAN_CREDENTIAL_PRIVATE_KEY']!) as { d: string }
      try {
        loadConnectorConfig({
          ...BASE,
          RIVIAN_CREDENTIAL_PRIVATE_KEY: JSON.stringify({ ...key, crv: 'P-384' }),
        })
        expect.unreachable()
      } catch (e) {
        expect((e as Error).message).not.toContain(key.d)
      }
    })
  })

  // The VIN is a topic segment: `/`, `+` and `#` in it would publish to a topic
  // ingest is not listening on, or to none.
  it.each(['', 'ABC/DEF', 'ABC+DEF', 'ABC#', 'with space'])('refuses the VIN %j', (vin) => {
    expect(() => loadConnectorConfig({ ...BASE, EV_VEHICLE_VIN: vin })).toThrow(/EV_VEHICLE_VIN/)
  })

  it.each(['abc', '-1', '65536', '90.5', ''])('refuses the metrics port %j', (port) => {
    expect(() => loadConnectorConfig({ ...BASE, METRICS_PORT: port })).toThrow(/METRICS_PORT/)
  })
})
