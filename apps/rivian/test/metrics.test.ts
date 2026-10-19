import { RIVIAN_STREAMS } from '@ev/rivian'
import { describe, expect, it } from 'vitest'
import {
  RECONNECT_REASONS,
  connectorMetrics,
  initialiseSeries,
  mqttConnected,
  registry,
} from '../src/metrics.js'

/** The value of one series in the text exposition, or undefined if there is no such series. */
async function sample(name: string, labels = ''): Promise<number | undefined> {
  const text = await registry.metrics()
  const line = text.split('\n').find((l) => l.startsWith(`${name}${labels} `))
  return line === undefined ? undefined : Number(line.slice(name.length + labels.length + 1))
}

const STATES = [
  'signed_out',
  'starting',
  'credential_invalid',
  'finding_vehicle',
  'waiting_for_vehicle',
  'connecting',
  'subscribed',
  'backing_off',
  'unauthenticated',
]

describe('connector metrics', () => {
  it('has every series at zero after initialiseSeries, so "never" is a value an alert can read', async () => {
    initialiseSeries()

    for (const state of STATES) {
      expect(await sample('rivian_connector_state', `{state="${state}"}`), state).toBe(0)
    }
    // Every stream Rivian can send on; not `meta`, which is the connector's own.
    for (const stream of RIVIAN_STREAMS.filter((s) => s !== 'meta')) {
      expect(await sample('rivian_frames_total', `{stream="${stream}"}`), stream).toBe(0)
    }
    expect(await sample('rivian_frames_total', '{stream="meta"}')).toBeUndefined()
    for (const reason of RECONNECT_REASONS) {
      expect(await sample('rivian_reconnects_total', `{reason="${reason}"}`), reason).toBe(0)
    }
    for (const name of [
      'rivian_frames_dropped_total',
      'rivian_publish_failures_total',
      'rivian_dropped_properties',
      'rivian_credential_poll_failures_total',
      'rivian_last_frame_timestamp_seconds',
      'rivian_mqtt_connected',
    ]) {
      expect(await sample(name), name).toBe(0)
    }
  })

  it('keeps the state gauge one-hot', async () => {
    connectorMetrics.setState('subscribed')
    expect(await sample('rivian_connector_state', '{state="subscribed"}')).toBe(1)
    connectorMetrics.setState('backing_off')

    for (const state of STATES) {
      expect(await sample('rivian_connector_state', `{state="${state}"}`), state).toBe(
        state === 'backing_off' ? 1 : 0,
      )
    }
  })

  it('counts what the connector reports', async () => {
    const frames = (await sample('rivian_frames_total', '{stream="cloud"}')) ?? 0
    const dropped = (await sample('rivian_frames_dropped_total')) ?? 0
    const failures = (await sample('rivian_publish_failures_total')) ?? 0
    const reconnects = (await sample('rivian_reconnects_total', '{reason="http"}')) ?? 0
    const polls = (await sample('rivian_credential_poll_failures_total')) ?? 0

    connectorMetrics.frame('cloud')
    connectorMetrics.dropped(7)
    connectorMetrics.publishFailure()
    connectorMetrics.reconnect('http')
    connectorMetrics.pollFailure()
    connectorMetrics.droppedProperties(3)
    connectorMetrics.lastFrame(1_760_000_000_500)
    mqttConnected.set(1)

    expect(await sample('rivian_frames_total', '{stream="cloud"}')).toBe(frames + 1)
    expect(await sample('rivian_frames_dropped_total')).toBe(dropped + 7)
    expect(await sample('rivian_publish_failures_total')).toBe(failures + 1)
    expect(await sample('rivian_reconnects_total', '{reason="http"}')).toBe(reconnects + 1)
    expect(await sample('rivian_credential_poll_failures_total')).toBe(polls + 1)
    expect(await sample('rivian_dropped_properties')).toBe(3)
    // Seconds, so that `time() - ...` works as it does for the ingest worker's gauge.
    expect(await sample('rivian_last_frame_timestamp_seconds')).toBe(1_760_000_000.5)
    expect(await sample('rivian_mqtt_connected')).toBe(1)
  })
})
