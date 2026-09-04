export interface CapacityInput {
  startSocPct: number | null
  endSocPct: number | null
  energyKwh: number | null
}

export interface CapacityEstimate {
  estimatedCapacityKwh: number
  confidence: number
}

/** Charges narrower than this tell you almost nothing: measurement error in
 *  SoC swamps the signal. */
const MIN_SOC_SPAN = 20

export function estimateCapacity(c: CapacityInput): CapacityEstimate | null {
  const { startSocPct, endSocPct, energyKwh } = c
  if (startSocPct === null || endSocPct === null || energyKwh === null) return null

  const span = endSocPct - startSocPct
  if (span < MIN_SOC_SPAN || energyKwh <= 0) return null

  return {
    estimatedCapacityKwh: round(energyKwh / (span / 100), 2),
    // Confidence scales with span: a 20% charge is the floor, 80% or more is
    // as good as this method gets.
    confidence: round(Math.min(1, span / 80), 3),
  }
}

function round(n: number, dp: number): number {
  const f = 10 ** dp
  return Math.round(n * f) / f
}
