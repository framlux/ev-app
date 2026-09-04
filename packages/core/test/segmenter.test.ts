import { describe, expect, it } from 'vitest'
import { makeSample } from '../src/model.js'
import { initialState, step, type SegmenterState } from '../src/engine/segmenter.js'

const t0 = new Date('2026-09-04T10:00:00Z')
const at = (s: number) => new Date(t0.getTime() + s * 1000)

function run(samples: ReturnType<typeof makeSample>[]) {
  let state: SegmenterState = initialState()
  const events = []
  for (const s of samples) {
    const r = step(state, s)
    state = r.state
    events.push(...r.events)
  }
  return { state, events }
}

const moving = (sec: number, speed: number, odo: number, soc: number) =>
  makeSample({ vehicleId: 'v1', ts: at(sec), speedKph: speed, odometerKm: odo,
               socPct: soc, powerState: 'online', chargeState: 'disconnected' })

const parked = (sec: number, odo: number, soc: number) =>
  makeSample({ vehicleId: 'v1', ts: at(sec), speedKph: 0, odometerKm: odo,
               socPct: soc, powerState: 'online', chargeState: 'disconnected' })

const charging = (sec: number, soc: number, kw: number) =>
  makeSample({ vehicleId: 'v1', ts: at(sec), speedKph: 0, odometerKm: 1000,
               socPct: soc, powerState: 'online', chargeState: 'charging',
               chargePowerKw: kw })

describe('segmenter', () => {
  it('opens a drive when the car starts moving', () => {
    const { events } = run([parked(0, 1000, 80), moving(60, 30, 1000.2, 80)])
    expect(events.filter((e) => e.type === 'session-start' && e.kind === 'drive')).toHaveLength(1)
  })

  it('closes the drive once stopped for longer than the park threshold', () => {
    const { events } = run([
      parked(0, 1000, 80),
      moving(60, 30, 1000.2, 80),
      moving(120, 50, 1001.0, 79),
      parked(180, 1002.0, 79),
      parked(600, 1002.0, 79),
    ])
    const ends = events.filter((e) => e.type === 'session-end' && e.kind === 'drive')
    expect(ends).toHaveLength(1)
  })

  it('does not split a drive at a traffic light', () => {
    const { events } = run([
      moving(0, 40, 1000.0, 80),
      parked(30, 1000.5, 80),
      parked(60, 1000.5, 80),
      moving(90, 40, 1001.0, 79),
      moving(120, 45, 1001.6, 79),
    ])
    expect(events.filter((e) => e.type === 'session-start' && e.kind === 'drive')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'session-end')).toHaveLength(0)
  })

  it('opens and closes a charge session on charge state', () => {
    const { events } = run([
      parked(0, 1000, 40),
      charging(60, 41, 11),
      charging(120, 45, 11),
      makeSample({ vehicleId: 'v1', ts: at(180), speedKph: 0, socPct: 46,
                   powerState: 'online', chargeState: 'complete' }),
    ])
    expect(events.filter((e) => e.type === 'session-start' && e.kind === 'charge')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'session-end' && e.kind === 'charge')).toHaveLength(1)
  })

  it('treats a resumed charge after a long stop as a second session', () => {
    const { events } = run([
      charging(0, 40, 50),
      makeSample({ vehicleId: 'v1', ts: at(60), socPct: 45, powerState: 'online',
                   chargeState: 'stopped' }),
      charging(1800, 46, 50),
    ])
    expect(events.filter((e) => e.type === 'session-start' && e.kind === 'charge')).toHaveLength(2)
  })

  it('closes an open session when samples gap beyond the reset window', () => {
    const { events } = run([
      moving(0, 40, 1000, 80),
      moving(60, 40, 1001, 79),
      moving(60 + 4 * 3600, 40, 1200, 40),
    ])
    const starts = events.filter((e) => e.type === 'session-start' && e.kind === 'drive')
    const ends = events.filter((e) => e.type === 'session-end' && e.kind === 'drive')
    expect(starts).toHaveLength(2)
    expect(ends).toHaveLength(1)
  })

  it('ignores samples that arrive out of order', () => {
    const { events } = run([moving(120, 40, 1001, 79), moving(60, 40, 1000, 80)])
    expect(events.filter((e) => e.type === 'session-point')).toHaveLength(1)
  })

  it('resumes an open session carried across a restart', () => {
    const first = run([moving(0, 40, 1000, 80), moving(60, 40, 1001, 79)])
    expect(first.state.open?.kind).toBe('drive')

    const resumed = step(first.state, moving(120, 40, 1002, 78))
    expect(resumed.events.filter((e) => e.type === 'session-start')).toHaveLength(0)
    expect(resumed.events.filter((e) => e.type === 'session-point')).toHaveLength(1)
  })
})
