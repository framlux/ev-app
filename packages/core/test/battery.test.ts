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
})
