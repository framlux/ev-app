/**
 * The only place the worker names a vendor decoder.
 *
 * Re-exporting `@ev/core` from here keeps every other module importing from one
 * path, so adding Rivian later touches this file and nothing else.
 */
export * from '@ev/core'

import type { RawMessage } from '@ev/core'
import {
  decodeTeslaConnectivity,
  decodeTeslaField,
  type TeslaFieldUpdate,
} from '@ev/tesla'
import { readEnvelope } from './pipeline.js'

/**
 * One taped message -> the fields it contributes, or null if it contributes
 * nothing.
 *
 * This replaced a `normaliseIfKnown(raw): VehicleSample[]`, and the signature
 * change is the whole point rather than a tidy-up. On the MQTT transport
 * fleet-telemetry publishes ONE FIELD PER MESSAGE, so a message cannot produce
 * a sample: it produces a fragment, and the accumulator in `pipeline.ts` is
 * what turns fragments into samples. The old signature could only ever have
 * been satisfied by inventing the rest of the sample, which is exactly the
 * null-becomes-zero failure this codebase is built to avoid.
 */
export function decodeIfKnown(raw: RawMessage): TeslaFieldUpdate | null {
  switch (raw.vendor) {
    case 'tesla': {
      const env = readEnvelope(raw.payload)
      if (!env) return null
      switch (env.kind) {
        case 'metrics':
          return env.field === null ? null : decodeTeslaField(env.field, env.value)
        case 'connectivity': {
          const powerState = decodeTeslaConnectivity(env.value)
          return powerState === null ? null : { powerState }
        }
        // Alerts and errors have no VehicleSample counterpart yet. They stay on
        // the tape so a future parser has history to work from, and are
        // deliberately not guessed into a sample.
        case 'alert':
        case 'error':
          return null
      }
    }
    // Rivian lands here when its adapter is written. Nothing else changes.
    case 'rivian':
      return null
  }
}
