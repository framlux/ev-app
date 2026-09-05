/**
 * The only place the worker names a vendor adapter.
 *
 * Re-exporting `@ev/core` from here keeps every other module in this app
 * importing from one path, so adding Rivian later touches this file and nothing
 * else.
 */
export * from '@ev/core'

import type { RawMessage, VehicleSample } from '@ev/core'
import { normaliseTeslaConnectivity, normaliseTeslaMessage } from '@ev/tesla'

export function normaliseIfKnown(raw: RawMessage): VehicleSample[] {
  switch (raw.vendor) {
    case 'tesla': {
      // Both are tried: a telemetry record has a `data` array and no `status`,
      // a connectivity record the reverse, and each returns null for the
      // other's shape. Trying both means neither has to recognise the other.
      const out: VehicleSample[] = []
      const telemetry = normaliseTeslaMessage(raw)
      if (telemetry) out.push(telemetry)
      const connectivity = normaliseTeslaConnectivity(raw)
      if (connectivity) out.push(connectivity)
      return out
    }
    // Rivian lands here when its adapter is written. Nothing else changes.
    case 'rivian':
      return []
  }
}
