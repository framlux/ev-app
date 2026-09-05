import { describe, expect, it } from 'vitest'
import {
  notifyVehicleChanged,
  parseVehicleChange,
  VEHICLE_CHANGED_CHANNEL,
  type VehicleChange,
} from '../src/repo/notify.js'
import type { DbClient } from '../src/repo/types.js'

const CHANGE: VehicleChange = {
  vehicleId: 'v1',
  ts: '2026-09-05T10:00:00.000Z',
  kind: 'sample',
}

function fakeClient(): DbClient & { calls: Array<{ sql: string; values: unknown[] }> } {
  const calls: Array<{ sql: string; values: unknown[] }> = []
  return {
    calls,
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values })
      return { rows: [] }
    },
  } as unknown as DbClient & { calls: Array<{ sql: string; values: unknown[] }> }
}

describe('notifyVehicleChanged', () => {
  it('uses parameterised pg_notify, never string-built NOTIFY', async () => {
    const c = fakeClient()
    await notifyVehicleChanged(c, CHANGE)
    expect(c.calls).toHaveLength(1)
    expect(c.calls[0]!.sql).toMatch(/pg_notify/)
    // NOTIFY takes an identifier, not a parameter, so a literal NOTIFY would
    // have to be built by string concatenation. pg_notify is what keeps the
    // payload a bound parameter.
    expect(c.calls[0]!.sql).not.toMatch(/\bNOTIFY\s+\w/i)
    expect(c.calls[0]!.values).toEqual([VEHICLE_CHANGED_CHANNEL, JSON.stringify(CHANGE)])
  })
})

describe('parseVehicleChange', () => {
  it('reads back what notifyVehicleChanged writes', () => {
    expect(parseVehicleChange(JSON.stringify(CHANGE))).toEqual(CHANGE)
  })

  it('returns null rather than throwing on anything unexpected', () => {
    for (const bad of ['', 'not json', '[]', '{}', '{"vehicleId":1}', 'null']) {
      expect(parseVehicleChange(bad)).toBeNull()
    }
  })

  it('rejects an unknown kind, so a newer worker cannot inject a state we do not handle', () => {
    expect(parseVehicleChange('{"vehicleId":"v1","ts":"t","kind":"telepathy"}')).toBeNull()
  })
})
