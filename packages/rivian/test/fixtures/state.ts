/** SYNTHETIC. Hand-written from the R1 shapes documented by the Apache-2.0 Home Assistant
 *  integration (spec §2.5). Replace with real R2 tape excerpts after delivery (spec §8.4). */
export function stateEnvelope(receivedAt: string, props: Record<string, unknown>) {
  return { v: 1, stream: 'state', vin: 'VIN1', receivedAt, body: { data: { vehicleState: props } } }
}
export const tv = (timeStamp: string, value: unknown) => ({ timeStamp, value })
