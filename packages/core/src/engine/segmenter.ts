import type { SessionKind, VehicleSample } from '../model.js'

export interface SegmenterOptions {
  /** Stationary for at least this long ends a drive. Long enough to survive a
   *  traffic light, short enough that a shop stop is its own drive. */
  driveEndParkedMs: number
  /** A charge that stops and resumes within this window is one session. */
  chargeResumeWindowMs: number
  /** A gap larger than this means we lost coverage; close whatever is open
   *  rather than inventing a session that spans the hole. */
  sampleGapResetMs: number
  /** Below this the car is stationary. Not zero: GPS speed jitters. */
  movingSpeedKph: number
}

export const DEFAULT_SEGMENTER_OPTIONS: SegmenterOptions = {
  driveEndParkedMs: 5 * 60_000,
  chargeResumeWindowMs: 10 * 60_000,
  sampleGapResetMs: 60 * 60_000,
  movingSpeedKph: 1,
}

export interface OpenSession {
  kind: SessionKind
  startedAt: Date
  startSample: VehicleSample
  lastSample: VehicleSample
  /** When the car first went stationary during a drive; null while moving. */
  stationarySince: Date | null
  /** When charging last stopped, for the resume window. */
  pausedSince: Date | null
}

export interface SegmenterState {
  open: OpenSession | null
  lastTs: Date | null
}

export type SegmenterEvent =
  | { type: 'session-start'; kind: SessionKind; at: Date; sample: VehicleSample }
  | { type: 'session-point'; sample: VehicleSample }
  | { type: 'session-end'; kind: SessionKind; at: Date; sample: VehicleSample }

export interface StepResult {
  state: SegmenterState
  events: SegmenterEvent[]
}

export function initialState(): SegmenterState {
  return { open: null, lastTs: null }
}

export function step(
  state: SegmenterState,
  sample: VehicleSample,
  opts: SegmenterOptions = DEFAULT_SEGMENTER_OPTIONS,
): StepResult {
  // Out-of-order delivery is normal after the car replays its buffer. Dropping
  // is correct: the segmenter is a forward-only state machine, and reprocessing
  // from raw_message is how history gets rebuilt if ordering matters.
  if (state.lastTs && sample.ts.getTime() < state.lastTs.getTime()) {
    return { state, events: [] }
  }

  const events: SegmenterEvent[] = []
  let open = state.open

  const gapMs = state.lastTs ? sample.ts.getTime() - state.lastTs.getTime() : 0
  if (open && gapMs > opts.sampleGapResetMs) {
    events.push({ type: 'session-end', kind: open.kind, at: open.lastSample.ts, sample: open.lastSample })
    open = null
  }

  const isCharging = sample.chargeState === 'charging'
  const isMoving = (sample.speedKph ?? 0) > opts.movingSpeedKph

  if (open?.kind === 'charge') {
    // How long charging has been paused, measured to THIS sample. Evaluated on
    // both branches: a pause that ends the session is just as likely to be
    // discovered when charging resumes as while it is still stopped, because
    // nothing obliges the car to send samples while it sits idle on a charger.
    const pausedFor = open.pausedSince
      ? sample.ts.getTime() - open.pausedSince.getTime()
      : 0
    const terminal =
      sample.chargeState === 'disconnected' || sample.chargeState === 'complete'

    if (isCharging) {
      if (pausedFor >= opts.chargeResumeWindowMs) {
        // Resumed too late to be the same session. Close the old one at its
        // last real sample, and fall through to open a fresh one below.
        events.push({ type: 'session-end', kind: 'charge', at: open.lastSample.ts, sample: open.lastSample })
        open = null
      } else {
        open = { ...open, lastSample: sample, pausedSince: null }
        events.push({ type: 'session-point', sample })
      }
    } else if (terminal || pausedFor >= opts.chargeResumeWindowMs) {
      events.push({ type: 'session-end', kind: 'charge', at: sample.ts, sample })
      open = null
    } else {
      open = { ...open, lastSample: sample, pausedSince: open.pausedSince ?? sample.ts }
    }
  } else if (open?.kind === 'drive') {
    if (isCharging) {
      events.push({ type: 'session-end', kind: 'drive', at: sample.ts, sample })
      open = null
    } else if (isMoving) {
      open = { ...open, lastSample: sample, stationarySince: null }
      events.push({ type: 'session-point', sample })
    } else {
      const stationarySince = open.stationarySince ?? sample.ts
      const stoppedMs = sample.ts.getTime() - stationarySince.getTime()
      if (stoppedMs >= opts.driveEndParkedMs) {
        events.push({ type: 'session-end', kind: 'drive', at: open.lastSample.ts, sample: open.lastSample })
        open = null
      } else {
        open = { ...open, lastSample: sample, stationarySince }
        events.push({ type: 'session-point', sample })
      }
    }
  }

  if (!open) {
    if (isCharging) {
      open = openSession('charge', sample)
      events.push({ type: 'session-start', kind: 'charge', at: sample.ts, sample })
      events.push({ type: 'session-point', sample })
    } else if (isMoving) {
      open = openSession('drive', sample)
      events.push({ type: 'session-start', kind: 'drive', at: sample.ts, sample })
      events.push({ type: 'session-point', sample })
    }
  }

  return { state: { open, lastTs: sample.ts }, events }
}

function openSession(kind: SessionKind, sample: VehicleSample): OpenSession {
  return {
    kind,
    startedAt: sample.ts,
    startSample: sample,
    lastSample: sample,
    stationarySince: null,
    pausedSince: null,
  }
}
