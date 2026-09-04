import type { SessionKind, VehicleSample } from '../model.js'

export interface MetricsOptions {
  /** Nameplate usable capacity, used to convert SoC delta into energy for
   *  drives. Charges use the car's own energy counter instead, which is
   *  measured rather than inferred. */
  usableCapacityKwh: number
}

export interface SessionSummary {
  startedAt: Date | null
  endedAt: Date | null
  distanceKm: number | null
  energyKwh: number | null
  efficiencyWhPerKm: number | null
  avgSpeedKph: number | null
  maxChargePowerKw: number | null
  startSocPct: number | null
  endSocPct: number | null
  startOdometerKm: number | null
  endOdometerKm: number | null
  startLat: number | null
  startLon: number | null
  endLat: number | null
  endLon: number | null
}

export function summariseSession(
  kind: SessionKind,
  points: VehicleSample[],
  opts: MetricsOptions,
): SessionSummary {
  const first = points[0] ?? null
  const last = points[points.length - 1] ?? null

  const startOdo = firstOf(points, (s) => s.odometerKm)
  const endOdo = lastOf(points, (s) => s.odometerKm)
  const startSoc = firstOf(points, (s) => s.socPct)
  const endSoc = lastOf(points, (s) => s.socPct)

  const distanceKm =
    startOdo !== null && endOdo !== null ? round(endOdo - startOdo, 3) : null

  let energyKwh: number | null = null
  if (kind === 'charge') {
    // The car's counter is cumulative but not necessarily zeroed at the point
    // this session opened: a session that resumed after a pause inherits
    // whatever the counter had already reached, so subtract the opening value.
    // If the counter went backwards the car zeroed it mid-session, and the
    // reading itself is the best estimate we have — never a negative energy.
    const added = lastOf(points, (s) => s.chargeEnergyAddedKwh)
    const startAdded = firstOf(points, (s) => s.chargeEnergyAddedKwh) ?? 0
    energyKwh =
      added !== null ? round(added >= startAdded ? added - startAdded : added, 3) : null
  } else if (startSoc !== null && endSoc !== null) {
    energyKwh = round(((startSoc - endSoc) / 100) * opts.usableCapacityKwh, 3)
  }

  const efficiencyWhPerKm =
    distanceKm !== null && distanceKm > 0 && energyKwh !== null
      ? round((energyKwh * 1000) / distanceKm, 1)
      : null

  const durationH =
    first && last ? (last.ts.getTime() - first.ts.getTime()) / 3_600_000 : 0
  const avgSpeedKph =
    distanceKm !== null && durationH > 0 ? round(distanceKm / durationH, 1) : null

  const powers = points.map((s) => s.chargePowerKw).filter(isNum)

  return {
    startedAt: first?.ts ?? null,
    endedAt: last?.ts ?? null,
    distanceKm,
    energyKwh,
    efficiencyWhPerKm,
    avgSpeedKph,
    maxChargePowerKw: powers.length ? Math.max(...powers) : null,
    startSocPct: startSoc,
    endSocPct: endSoc,
    startOdometerKm: startOdo,
    endOdometerKm: endOdo,
    startLat: firstOf(points, (s) => s.lat),
    startLon: firstOf(points, (s) => s.lon),
    endLat: lastOf(points, (s) => s.lat),
    endLon: lastOf(points, (s) => s.lon),
  }
}

export interface IdleSpan { startedAt: Date; endedAt: Date }
export interface IdleOptions { minIdleMs: number }

/**
 * An idle is the absence of a drive or charge, derived from the gaps between
 * them rather than tracked as its own state. One fewer state machine to get
 * wrong, and it cannot disagree with the sessions it sits between.
 */
export function deriveIdles(
  sessions: { startedAt: Date; endedAt: Date | null }[],
  opts: IdleOptions,
): IdleSpan[] {
  const ordered = [...sessions]
    .filter((s) => s.endedAt !== null)
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())

  const out: IdleSpan[] = []
  for (let i = 0; i < ordered.length - 1; i++) {
    const end = ordered[i]?.endedAt
    const next = ordered[i + 1]?.startedAt
    if (!end || !next) continue
    if (next.getTime() - end.getTime() >= opts.minIdleMs) {
      out.push({ startedAt: end, endedAt: next })
    }
  }
  return out
}

function isNum(v: number | null): v is number { return v !== null }

function firstOf(points: VehicleSample[], pick: (s: VehicleSample) => number | null): number | null {
  for (const p of points) { const v = pick(p); if (v !== null) return v }
  return null
}

function lastOf(points: VehicleSample[], pick: (s: VehicleSample) => number | null): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i]
    if (!p) continue
    const v = pick(p)
    if (v !== null) return v
  }
  return null
}

function round(n: number, dp: number): number {
  const f = 10 ** dp
  return Math.round(n * f) / f
}
