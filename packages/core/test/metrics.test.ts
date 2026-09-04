import { describe, expect, it } from 'vitest'
import { makeSample } from '../src/model.js'
import { deriveIdles, summariseSession } from '../src/engine/metrics.js'

const t = (s: number) => new Date(Date.parse('2026-09-04T10:00:00Z') + s * 1000)

describe('summariseSession', () => {
  it('computes distance and efficiency for a drive', () => {
    const s = summariseSession('drive', [
      makeSample({ vehicleId: 'v1', ts: t(0),    odometerKm: 1000, socPct: 80, speedKph: 0 }),
      makeSample({ vehicleId: 'v1', ts: t(1800), odometerKm: 1050, socPct: 68, speedKph: 90 }),
    ], { usableCapacityKwh: 75 })

    expect(s.distanceKm).toBeCloseTo(50)
    // 12% of 75 kWh = 9 kWh over 50 km = 180 Wh/km
    expect(s.energyKwh).toBeCloseTo(9)
    expect(s.efficiencyWhPerKm).toBeCloseTo(180)
  })

  it('returns null efficiency rather than dividing by zero', () => {
    const s = summariseSession('drive', [
      makeSample({ vehicleId: 'v1', ts: t(0),   odometerKm: 1000, socPct: 80 }),
      makeSample({ vehicleId: 'v1', ts: t(600), odometerKm: 1000, socPct: 79 }),
    ], { usableCapacityKwh: 75 })
    expect(s.distanceKm).toBe(0)
    expect(s.efficiencyWhPerKm).toBeNull()
  })

  it('takes charge energy from the reported counter, not from SoC', () => {
    const s = summariseSession('charge', [
      makeSample({ vehicleId: 'v1', ts: t(0),    socPct: 40, chargeEnergyAddedKwh: 0,  chargePowerKw: 11 }),
      makeSample({ vehicleId: 'v1', ts: t(3600), socPct: 62, chargeEnergyAddedKwh: 16.4, chargePowerKw: 7 }),
    ], { usableCapacityKwh: 75 })
    expect(s.energyKwh).toBeCloseTo(16.4)
    expect(s.maxChargePowerKw).toBe(11)
  })
})

describe('deriveIdles', () => {
  it('creates an idle for the gap between two sessions', () => {
    const idles = deriveIdles([
      { endedAt: t(0),    startedAt: t(-600) },
      { startedAt: t(7200), endedAt: t(7800) },
    ], { minIdleMs: 60_000 })
    expect(idles).toHaveLength(1)
    expect(idles[0]?.startedAt).toEqual(t(0))
    expect(idles[0]?.endedAt).toEqual(t(7200))
  })

  it('ignores gaps shorter than the minimum', () => {
    const idles = deriveIdles([
      { endedAt: t(0), startedAt: t(-600) },
      { startedAt: t(30), endedAt: t(600) },
    ], { minIdleMs: 60_000 })
    expect(idles).toHaveLength(0)
  })
})
