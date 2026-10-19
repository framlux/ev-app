import { describe, expect, it } from 'vitest'
import { TESLA_FIELDS, slotsOf } from '@ev/tesla'
import { STALE_VALUE_MS, VOLATILE_STALE_MS } from '../src/timing.js'
import { VOLATILE_FIELDS, staleWindowFor, teslaProfile } from '../src/profiles/tesla.js'

describe('the Tesla profile is exactly what pipeline.ts hard-coded', () => {
  it('derives the volatile set from the drive tier, minus Location and Gear, plus the rails and speed', () => {
    const expected = new Set<string>([
      'speedKph', 'acPowerKw', 'dcPowerKw',
      ...TESLA_FIELDS.filter((e) => e.tier === 'drive' && e.field !== 'Location' && e.field !== 'Gear')
        .flatMap(slotsOf),
    ])
    expect(VOLATILE_FIELDS).toEqual(expected)
    expect(staleWindowFor('speedKph')).toBe(VOLATILE_STALE_MS)
    expect(staleWindowFor('socPct')).toBe(STALE_VALUE_MS)
    expect(teslaProfile.staleWindowFor).toBe(staleWindowFor)
  })

  it('keeps the charge refresh slots', () => {
    expect(teslaProfile.chargeStateSlots).toEqual(['chargeStateDetailed', 'chargeStateBasic', 'activeRail'])
    expect(teslaProfile.chargingPowerSlots).toEqual(['acPowerKw', 'dcPowerKw'])
    expect(teslaProfile.chargingEnergySlots).toEqual(['acEnergyKwh', 'dcEnergyKwh'])
  })

  it('decodes a metrics envelope to slots with no observedAt, so arrival time stamps it as before', () => {
    const d = teslaProfile.decode({
      vehicleId: 'v', vendor: 'tesla', receivedAt: new Date(0), source: 'telemetry',
      payload: { kind: 'metrics', vin: 'X', field: 'Soc', value: 55 },
    })
    expect(d).toEqual({ slots: { socPct: 55 } })
  })

  it('refuses another vendor\'s message', () => {
    expect(teslaProfile.decode({
      vehicleId: 'v', vendor: 'rivian', receivedAt: new Date(0), source: 'graphql_ws',
      payload: { kind: 'metrics', vin: 'X', field: 'Soc', value: 55 },
    })).toBeNull()
  })
})
