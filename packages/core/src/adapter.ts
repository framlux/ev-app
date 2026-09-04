import type { RawMessage, Vendor, VehicleSample } from './model.js'

/**
 * The single vendor seam. Nothing downstream of normalise() knows which
 * make of car produced a sample. Adding Rivian means adding one
 * implementation of this and changing nothing else.
 */
export interface VehicleAdapter {
  readonly vendor: Vendor
  /** Begin delivering raw messages to the sink. Resolves once connected. */
  start(sink: (m: RawMessage) => Promise<void>): Promise<void>
  /** Stop cleanly, flushing anything in flight. */
  stop(): Promise<void>
  /** Pure. One raw message may yield zero, one or many samples. */
  normalise(raw: RawMessage): VehicleSample[]
}
