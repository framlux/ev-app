import { describe, expect, it } from 'vitest'
import { makeSample } from '../src/model.js'
import {
  DEFAULT_SEGMENTER_OPTIONS,
  initialState,
  step,
  type SegmenterEvent,
  type SegmenterOptions,
  type SegmenterState,
} from '../src/engine/segmenter.js'

const t0 = new Date('2026-09-04T10:00:00Z')
const at = (s: number) => new Date(t0.getTime() + s * 1000)
const atMs = (ms: number) => new Date(t0.getTime() + ms)

const OPTS = DEFAULT_SEGMENTER_OPTIONS

function run(
  samples: ReturnType<typeof makeSample>[],
  opts: SegmenterOptions = OPTS,
) {
  let state: SegmenterState = initialState()
  const events: SegmenterEvent[] = []
  for (const s of samples) {
    const r = step(state, s, opts)
    state = r.state
    events.push(...r.events)
  }
  return { state, events }
}

const starts = (events: SegmenterEvent[], kind: 'drive' | 'charge') =>
  events.filter((e) => e.type === 'session-start' && e.kind === kind)
const ends = (events: SegmenterEvent[], kind: 'drive' | 'charge') =>
  events.filter((e) => e.type === 'session-end' && e.kind === kind)
const points = (events: SegmenterEvent[]) =>
  events.filter((e) => e.type === 'session-point')

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

/** Plugged in but not charging: a pause, not an end. */
const chargePaused = (sec: number, soc: number) =>
  makeSample({ vehicleId: 'v1', ts: at(sec), speedKph: 0, odometerKm: 1000,
               socPct: soc, powerState: 'online', chargeState: 'stopped' })

describe('segmenter', () => {
  it('opens a drive when the car starts moving', () => {
    const { events } = run([parked(0, 1000, 80), moving(60, 30, 1000.2, 80)])
    expect(starts(events, 'drive')).toHaveLength(1)
  })

  it('closes the drive once stopped for longer than the park threshold', () => {
    const { events } = run([
      parked(0, 1000, 80),
      moving(60, 30, 1000.2, 80),
      moving(120, 50, 1001.0, 79),
      parked(180, 1002.0, 79),
      parked(600, 1002.0, 79),
    ])
    const drivEnds = ends(events, 'drive')
    expect(drivEnds).toHaveLength(1)
    // Ends where the car actually stopped, not at the later sample that
    // noticed the park threshold had been crossed.
    expect(drivEnds[0]?.at).toEqual(at(180))
    expect(drivEnds[0]?.sample.ts).toEqual(at(180))
  })

  it('does not split a drive at a traffic light', () => {
    const { events } = run([
      moving(0, 40, 1000.0, 80),
      parked(30, 1000.5, 80),
      parked(60, 1000.5, 80),
      moving(90, 40, 1001.0, 79),
      moving(120, 45, 1001.6, 79),
    ])
    expect(starts(events, 'drive')).toHaveLength(1)
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
    expect(starts(events, 'charge')).toHaveLength(1)
    const chargeEnds = ends(events, 'charge')
    expect(chargeEnds).toHaveLength(1)
    // The terminal sample carries the final SoC and energy counter, so it is
    // the one the session ends on.
    expect(chargeEnds[0]?.at).toEqual(at(180))
    expect(chargeEnds[0]?.sample.socPct).toBe(46)
  })

  it('closes a charge when the cable is pulled without a completion report', () => {
    const { events } = run([
      charging(0, 40, 11),
      charging(60, 42, 11),
      parked(120, 1000, 42),
    ])
    const chargeEnds = ends(events, 'charge')
    expect(chargeEnds).toHaveLength(1)
    expect(chargeEnds[0]?.at).toEqual(at(120))
  })

  it('keeps one session when charging pauses briefly and resumes', () => {
    const { events } = run([
      charging(0, 40, 50),
      chargePaused(60, 45),
      chargePaused(120, 45),
      charging(180, 46, 50),
      charging(240, 50, 50),
    ])
    expect(starts(events, 'charge')).toHaveLength(1)
    expect(ends(events, 'charge')).toHaveLength(0)
  })

  it('treats a resumed charge after a long stop as a second session', () => {
    const { events } = run([
      charging(0, 40, 50),
      chargePaused(60, 45),
      charging(1800, 46, 50),
    ])
    expect(starts(events, 'charge')).toHaveLength(2)
    const chargeEnds = ends(events, 'charge')
    // The first session must be closed, not leaked: the schema permits only
    // one open session per vehicle per kind.
    expect(chargeEnds).toHaveLength(1)
    // It ended when charging stopped, not when the resume was noticed.
    expect(chargeEnds[0]?.at).toEqual(at(60))
  })

  it('ends a paused charge where it stopped, not where the pause was noticed', () => {
    const { events } = run([
      charging(0, 40, 50),
      charging(60, 45, 50),
      chargePaused(120, 46),
      chargePaused(400, 46),
      chargePaused(3000, 46),
    ])
    const chargeEnds = ends(events, 'charge')
    expect(chargeEnds).toHaveLength(1)
    expect(chargeEnds[0]?.at).toEqual(at(120))
  })

  it('hands a charge over to the drive that follows an unplug', () => {
    // The charge state is stale: the car drove off still reporting 'stopped',
    // which is what a Tesla does when the unplug message is the one that got
    // dropped. Only the motion says the charge is over.
    const drivingStillPluggedIn = (sec: number, speed: number, odo: number, soc: number) =>
      makeSample({ vehicleId: 'v1', ts: at(sec), speedKph: speed, odometerKm: odo,
                   socPct: soc, powerState: 'online', chargeState: 'stopped' })
    const { events } = run([
      charging(0, 80, 11),
      chargePaused(60, 80),
      drivingStillPluggedIn(120, 40, 1001, 80),
      drivingStillPluggedIn(300, 60, 1005, 78),
      drivingStillPluggedIn(600, 60, 1012, 76),
      drivingStillPluggedIn(700, 50, 1014, 75),
    ])
    const chargeEnds = ends(events, 'charge')
    expect(chargeEnds).toHaveLength(1)
    expect(chargeEnds[0]?.at).toEqual(at(60))

    const driveStarts = starts(events, 'drive')
    expect(driveStarts).toHaveLength(1)
    expect(driveStarts[0]?.at).toEqual(at(120))
    // Every driving sample belongs to the drive; none is swallowed by the
    // charge or dropped on the floor.
    expect(points(events).map((e) => e.sample.ts)).toEqual([
      at(0), at(120), at(300), at(600), at(700),
    ])
  })

  it('hands a drive over to a charge when the car is plugged in on arrival', () => {
    const { events } = run([
      moving(0, 40, 1000, 60),
      moving(60, 30, 1001, 59),
      charging(120, 59, 11),
      charging(180, 62, 11),
    ])
    expect(ends(events, 'drive')).toHaveLength(1)
    expect(ends(events, 'drive')[0]?.at).toEqual(at(120))
    const chargeStarts = starts(events, 'charge')
    expect(chargeStarts).toHaveLength(1)
    expect(chargeStarts[0]?.at).toEqual(at(120))
  })

  it('does not split a drive across samples that omit speed', () => {
    const noSpeed = (sec: number, odo: number) =>
      makeSample({ vehicleId: 'v1', ts: at(sec), odometerKm: odo,
                   powerState: 'online', chargeState: 'disconnected' })
    const { events } = run([
      moving(0, 50, 100, 80),
      noSpeed(60, 101),
      noSpeed(400, 108),
      moving(700, 50, 115, 70),
    ])
    expect(starts(events, 'drive')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'session-end')).toHaveLength(0)
    expect(points(events)).toHaveLength(4)
  })

  it('closes an open session when samples gap beyond the reset window', () => {
    const { events } = run([
      moving(0, 40, 1000, 80),
      moving(60, 40, 1001, 79),
      moving(60 + 4 * 3600, 40, 1200, 40),
    ])
    expect(starts(events, 'drive')).toHaveLength(2)
    const driveEnds = ends(events, 'drive')
    expect(driveEnds).toHaveLength(1)
    // The drive ended when coverage was lost, not when it came back.
    expect(driveEnds[0]?.at).toEqual(at(60))
  })

  it('ignores samples that arrive out of order', () => {
    const { events } = run([moving(120, 40, 1001, 79), moving(60, 40, 1000, 80)])
    expect(points(events)).toHaveLength(1)
  })

  it('resumes an open session carried across a restart', () => {
    const first = run([moving(0, 40, 1000, 80), moving(60, 40, 1001, 79)])
    expect(first.state.open?.kind).toBe('drive')

    const resumed = step(first.state, moving(120, 40, 1002, 78))
    expect(resumed.events.filter((e) => e.type === 'session-start')).toHaveLength(0)
    expect(points(resumed.events)).toHaveLength(1)
  })
})

// Each threshold is pinned from both sides. Without these a units slip, or a
// tidy-up that turns 5 * 60_000 into 5 * 1000, ships green and permanently
// mis-segments every drive and charge that follows.
describe('segmenter thresholds', () => {
  const parkedAt = (ms: number) =>
    makeSample({ vehicleId: 'v1', ts: atMs(ms), speedKph: 0, odometerKm: 1001,
                 socPct: 79, powerState: 'online', chargeState: 'disconnected' })

  it('ends a drive at exactly driveEndParkedMs, and not a millisecond before', () => {
    const drive = makeSample({ vehicleId: 'v1', ts: atMs(0), speedKph: 40,
                               odometerKm: 1000, socPct: 80, powerState: 'online',
                               chargeState: 'disconnected' })
    const stop = parkedAt(1000)

    const short = run([drive, stop, parkedAt(1000 + OPTS.driveEndParkedMs - 1)])
    expect(ends(short.events, 'drive')).toHaveLength(0)

    const exact = run([drive, stop, parkedAt(1000 + OPTS.driveEndParkedMs)])
    expect(ends(exact.events, 'drive')).toHaveLength(1)
    expect(ends(exact.events, 'drive')[0]?.at).toEqual(atMs(1000))
  })

  it('splits a charge at exactly chargeResumeWindowMs, and not a millisecond before', () => {
    const start = makeSample({ vehicleId: 'v1', ts: atMs(0), speedKph: 0, socPct: 40,
                               powerState: 'online', chargeState: 'charging',
                               chargePowerKw: 11 })
    const pause = makeSample({ vehicleId: 'v1', ts: atMs(1000), speedKph: 0, socPct: 45,
                               powerState: 'online', chargeState: 'stopped' })
    const resumeAt = (ms: number) =>
      makeSample({ vehicleId: 'v1', ts: atMs(ms), speedKph: 0, socPct: 46,
                   powerState: 'online', chargeState: 'charging', chargePowerKw: 11 })

    const within = run([start, pause, resumeAt(1000 + OPTS.chargeResumeWindowMs - 1)])
    expect(starts(within.events, 'charge')).toHaveLength(1)
    expect(ends(within.events, 'charge')).toHaveLength(0)

    const beyond = run([start, pause, resumeAt(1000 + OPTS.chargeResumeWindowMs)])
    expect(starts(beyond.events, 'charge')).toHaveLength(2)
    expect(ends(beyond.events, 'charge')).toHaveLength(1)
  })

  it('resets on a gap longer than sampleGapResetMs, but not on one exactly that long', () => {
    const a = makeSample({ vehicleId: 'v1', ts: atMs(0), speedKph: 40, odometerKm: 1000,
                           socPct: 80, powerState: 'online', chargeState: 'disconnected' })
    const later = (ms: number) =>
      makeSample({ vehicleId: 'v1', ts: atMs(ms), speedKph: 40, odometerKm: 1100,
                   socPct: 60, powerState: 'online', chargeState: 'disconnected' })

    const exact = run([a, later(OPTS.sampleGapResetMs)])
    expect(ends(exact.events, 'drive')).toHaveLength(0)
    expect(starts(exact.events, 'drive')).toHaveLength(1)

    const beyond = run([a, later(OPTS.sampleGapResetMs + 1)])
    expect(ends(beyond.events, 'drive')).toHaveLength(1)
    expect(starts(beyond.events, 'drive')).toHaveLength(2)
  })

  it('treats exactly movingSpeedKph as stationary and anything above it as moving', () => {
    const atSpeed = (speed: number) =>
      makeSample({ vehicleId: 'v1', ts: atMs(0), speedKph: speed, odometerKm: 1000,
                   socPct: 80, powerState: 'online', chargeState: 'disconnected' })

    expect(starts(run([atSpeed(OPTS.movingSpeedKph)]).events, 'drive')).toHaveLength(0)
    expect(starts(run([atSpeed(OPTS.movingSpeedKph + 0.1)]).events, 'drive')).toHaveLength(1)
  })

  // The tests above pin the >= / > semantics but move with the constants; these
  // pin the magnitudes themselves, so a minutes-to-seconds slip cannot ship.
  it('keeps the drive-end threshold in minutes, not seconds', () => {
    const stop = (sec: number) => parked(sec, 1001, 79)
    const fourMinutes = run([moving(0, 40, 1000, 80), stop(10), stop(10 + 240)])
    expect(ends(fourMinutes.events, 'drive')).toHaveLength(0)

    const sixMinutes = run([moving(0, 40, 1000, 80), stop(10), stop(10 + 360)])
    expect(ends(sixMinutes.events, 'drive')).toHaveLength(1)
  })

  it('keeps the charge-resume window in minutes, not seconds', () => {
    const eightMinutes = run([charging(0, 40, 11), chargePaused(10, 45), charging(10 + 480, 46, 11)])
    expect(starts(eightMinutes.events, 'charge')).toHaveLength(1)

    const twelveMinutes = run([charging(0, 40, 11), chargePaused(10, 45), charging(10 + 720, 46, 11)])
    expect(starts(twelveMinutes.events, 'charge')).toHaveLength(2)
  })

  it('keeps the gap reset around an hour', () => {
    const fiftyMinutes = run([moving(0, 40, 1000, 80), moving(50 * 60, 40, 1050, 70)])
    expect(ends(fiftyMinutes.events, 'drive')).toHaveLength(0)

    const seventyMinutes = run([moving(0, 40, 1000, 80), moving(70 * 60, 40, 1050, 70)])
    expect(ends(seventyMinutes.events, 'drive')).toHaveLength(1)
  })

  it('keeps the moving threshold below walking pace', () => {
    const atSpeed = (speed: number) =>
      makeSample({ vehicleId: 'v1', ts: atMs(0), speedKph: speed, odometerKm: 1000,
                   socPct: 80, powerState: 'online', chargeState: 'disconnected' })
    // GPS jitter, not a drive.
    expect(starts(run([atSpeed(0.6)]).events, 'drive')).toHaveLength(0)
    // Crawling out of a car park is a drive.
    expect(starts(run([atSpeed(5)]).events, 'drive')).toHaveLength(1)
  })

  it('honours overridden options rather than the defaults', () => {
    const opts: SegmenterOptions = { ...OPTS, driveEndParkedMs: 30_000 }
    const events = run([
      moving(0, 40, 1000, 80),
      parked(10, 1001, 80),
      parked(45, 1001, 80),
    ], opts).events
    expect(ends(events, 'drive')).toHaveLength(1)
  })
})
