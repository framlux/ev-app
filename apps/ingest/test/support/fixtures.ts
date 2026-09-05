import type { RawMessage } from '@ev/core'

/**
 * A decoded Fleet Telemetry "V" record, in the shape the car actually puts on
 * the wire: a `createdAt` and a `data` array of {key, value} pairs where each
 * value is a single-key typed wrapper.
 */
export function teslaRaw(
  at: string,
  fields: Record<string, unknown>,
  overrides: Partial<RawMessage> = {},
): RawMessage {
  return {
    vehicleId: 'veh-1',
    vendor: 'tesla',
    receivedAt: new Date(at),
    source: 'telemetry',
    payload: {
      vin: '5YJ3E1EA1JF000001',
      createdAt: at,
      data: Object.entries(fields).map(([key, value]) => ({ key, value })),
    },
    ...overrides,
  }
}

export const num = (n: number): unknown => ({ doubleValue: n })
export const str = (s: string): unknown => ({ stringValue: s })
