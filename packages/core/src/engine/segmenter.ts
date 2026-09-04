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

/**
 * What a sample says about whether the car is moving.
 *
 * `unknown` is a first-class answer, not a synonym for stationary: every field
 * but vehicleId and ts is nullable, and a sample that omits speed (and gives us
 * no odometer movement to fall back on) is silent about motion. Treating that
 * silence as "parked" would split one drive into two.
 */
export type Motion = 'moving' | 'stationary' | 'unknown'

export interface OpenSession {
  kind: SessionKind
  startedAt: Date
  startSample: VehicleSample
  /** The last sample that genuinely belongs to the session: for a drive, the
   *  last one seen; for a charge, the last one that was actually charging. */
  lastSample: VehicleSample
  /** When the car first went stationary during a drive; null while moving. */
  stationarySince: Date | null
  /**
   * The first sample that showed charging had stopped, or null while charging.
   * The sample rather than the timestamp, because it is where the session ends:
   * closing at the sample that happens to cross the resume window would credit
   * the charge with however long the car sat there before that sample arrived.
   */
  pausedSample: VehicleSample | null
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
    events.push(endEvent(open))
    open = null
  }

  const isCharging = sample.chargeState === 'charging'
  const motion = motionOf(sample, open?.lastSample ?? null, opts)

  if (open?.kind === 'charge') {
    // How long charging has been paused, measured to THIS sample. Evaluated on
    // both branches: a pause that ends the session is just as likely to be
    // discovered when charging resumes as while it is still stopped, because
    // nothing obliges the car to send samples while it sits idle on a charger.
    const paused = open.pausedSample
    const pausedFor = paused ? sample.ts.getTime() - paused.ts.getTime() : 0
    const terminal =
      sample.chargeState === 'disconnected' || sample.chargeState === 'complete'

    if (isCharging) {
      if (pausedFor >= opts.chargeResumeWindowMs) {
        // Resumed too late to be the same session. Close the old one where
        // charging stopped, and fall through to open a fresh one below.
        events.push(endEvent(open))
        open = null
      } else {
        open = { ...open, lastSample: sample, pausedSample: null }
        events.push({ type: 'session-point', sample })
      }
    } else if (terminal || pausedFor >= opts.chargeResumeWindowMs || motion === 'moving') {
      // A car that is moving is not charging, whatever the charge state says:
      // without this the drive that follows an unplug would be swallowed into
      // the charge session until the resume window happened to expire.
      events.push(endEvent({ ...open, pausedSample: paused ?? sample }))
      open = null
    } else {
      // Still plugged in but not charging. Deliberately does not advance
      // lastSample: if this pause turns out to have ended the session, the
      // session's final reading is the last one taken while charging.
      open = { ...open, pausedSample: paused ?? sample }
    }
  } else if (open?.kind === 'drive') {
    if (isCharging) {
      events.push({ type: 'session-end', kind: 'drive', at: sample.ts, sample })
      open = null
    } else if (motion === 'moving') {
      open = { ...open, lastSample: sample, stationarySince: null }
      events.push({ type: 'session-point', sample })
    } else {
      // Only a sample that actually says "stopped" starts the parked clock; an
      // `unknown` one neither starts nor clears it, but is still measured
      // against a clock already running.
      const stationarySince =
        motion === 'stationary' ? open.stationarySince ?? sample.ts : open.stationarySince
      const stoppedMs = stationarySince
        ? sample.ts.getTime() - stationarySince.getTime()
        : 0
      if (stationarySince && stoppedMs >= opts.driveEndParkedMs) {
        events.push(endEvent(open))
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
    } else if (motion === 'moving') {
      open = openSession('drive', sample)
      events.push({ type: 'session-start', kind: 'drive', at: sample.ts, sample })
      events.push({ type: 'session-point', sample })
    }
  }

  return { state: { open, lastTs: sample.ts }, events }
}

/**
 * Where a session ends: the last sample that belongs to it, never the later one
 * that happened to notice it was over. For a charge that is the first sample
 * showing charging had stopped (it carries the final SoC and energy counter),
 * falling back to the last charging sample when the session is cut short by a
 * coverage gap.
 */
function endEvent(open: OpenSession): SegmenterEvent {
  const sample =
    open.kind === 'charge' ? open.pausedSample ?? open.lastSample : open.lastSample
  return { type: 'session-end', kind: open.kind, at: sample.ts, sample }
}

function motionOf(
  sample: VehicleSample,
  prev: VehicleSample | null,
  opts: SegmenterOptions,
): Motion {
  if (sample.speedKph !== null) {
    return sample.speedKph > opts.movingSpeedKph ? 'moving' : 'stationary'
  }
  // No speed reported. A rising odometer still proves movement; a flat one
  // proves nothing, because odometer resolution is coarse enough to sit still
  // through slow traffic.
  const prevOdo = prev?.odometerKm ?? null
  if (sample.odometerKm !== null && prevOdo !== null && sample.odometerKm > prevOdo) {
    return 'moving'
  }
  return 'unknown'
}

function openSession(kind: SessionKind, sample: VehicleSample): OpenSession {
  return {
    kind,
    startedAt: sample.ts,
    startSample: sample,
    lastSample: sample,
    stationarySince: null,
    pausedSample: null,
  }
}
