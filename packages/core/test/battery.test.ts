import { describe, expect, it } from 'vitest'
import { estimateCapacity } from '../src/engine/battery.js'

describe('estimateCapacity', () => {
  it('estimates usable capacity from a wide charge', () => {
    const e = estimateCapacity({ startSocPct: 20, endSocPct: 80, energyKwh: 45 })
    expect(e).not.toBeNull()
    expect(e?.estimatedCapacityKwh).toBeCloseTo(75)
    expect(e?.confidence).toBeGreaterThan(0.5)
  })

  it('rejects a charge too narrow to be informative', () => {
    expect(estimateCapacity({ startSocPct: 60, endSocPct: 63, energyKwh: 2.2 })).toBeNull()
  })

  it('rejects a charge with missing SoC', () => {
    expect(estimateCapacity({ startSocPct: null, endSocPct: 80, energyKwh: 45 })).toBeNull()
  })

  it('gives a wider charge more confidence than a narrow one', () => {
    const wide = estimateCapacity({ startSocPct: 10, endSocPct: 90, energyKwh: 60 })
    const narrow = estimateCapacity({ startSocPct: 40, endSocPct: 65, energyKwh: 18.75 })
    expect(wide!.confidence).toBeGreaterThan(narrow!.confidence)
  })

  // The 20-point floor is the whole reason this function can refuse: below it
  // SoC measurement error swamps the signal and the health series becomes noise.
  it('accepts a span of exactly the minimum and rejects one point less', () => {
    expect(estimateCapacity({ startSocPct: 40, endSocPct: 60, energyKwh: 15 }))
      .not.toBeNull()
    expect(estimateCapacity({ startSocPct: 40, endSocPct: 59, energyKwh: 14.25 }))
      .toBeNull()
  })

  it('rejects a typical top-up charge', () => {
    expect(estimateCapacity({ startSocPct: 62, endSocPct: 70, energyKwh: 6 })).toBeNull()
  })

  it('rejects a discharge and a charge that reports no energy', () => {
    expect(estimateCapacity({ startSocPct: 80, endSocPct: 20, energyKwh: 45 })).toBeNull()
    expect(estimateCapacity({ startSocPct: 20, endSocPct: 80, energyKwh: 0 })).toBeNull()
  })
})
