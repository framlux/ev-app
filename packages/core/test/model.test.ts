import { describe, expect, it } from 'vitest'
import { makeSample } from '../src/model.js'

describe('makeSample', () => {
  it('fills unspecified fields with null, not undefined', () => {
    const s = makeSample({ vehicleId: 'v1', ts: new Date('2026-09-04T10:00:00Z') })
    expect(s.socPct).toBeNull()
    expect(s.odometerKm).toBeNull()
    expect(s.lat).toBeNull()
  })

  it('keeps the fields it is given', () => {
    const s = makeSample({
      vehicleId: 'v1',
      ts: new Date('2026-09-04T10:00:00Z'),
      socPct: 72,
      speedKph: 0,
      powerState: 'online',
    })
    expect(s.socPct).toBe(72)
    expect(s.speedKph).toBe(0)
    expect(s.powerState).toBe('online')
  })
})
