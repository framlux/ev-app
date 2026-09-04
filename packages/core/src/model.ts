export type Vendor = 'tesla' | 'rivian'

/** Whether the car's computer is reachable. Not whether it is moving. */
export type PowerState = 'online' | 'asleep' | 'offline'

export type ChargeState =
  | 'disconnected'
  | 'connected'
  | 'charging'
  | 'complete'
  | 'stopped'

export type RawSource = 'telemetry' | 'fleet_api' | 'graphql_ws'

export interface RawMessage {
  vehicleId: string
  vendor: Vendor
  receivedAt: Date
  source: RawSource
  payload: unknown
}

/**
 * The canonical vehicle observation. Vendor-neutral by construction.
 *
 * Every field but vehicleId and ts is nullable: vendors disagree about what
 * they expose, and a missing field must be distinguishable from a zero.
 * Rivian, for instance, does not expose battery temperature at all.
 */
export interface VehicleSample {
  vehicleId: string
  ts: Date
  socPct: number | null
  rangeKm: number | null
  odometerKm: number | null
  lat: number | null
  lon: number | null
  speedKph: number | null
  powerState: PowerState | null
  chargeState: ChargeState | null
  chargePowerKw: number | null
  chargeEnergyAddedKwh: number | null
  insideTempC: number | null
  outsideTempC: number | null
  locked: boolean | null
  doorsOpen: boolean | null
  tpms: Record<string, number> | null
}

export type SessionKind = 'drive' | 'charge' | 'idle'

export interface Session {
  id: string
  vehicleId: string
  kind: SessionKind
  startedAt: Date
  endedAt: Date | null
  startOdometerKm: number | null
  endOdometerKm: number | null
  startSocPct: number | null
  endSocPct: number | null
  energyKwh: number | null
  distanceKm: number | null
  efficiencyWhPerKm: number | null
  avgSpeedKph: number | null
  maxChargePowerKw: number | null
  startLat: number | null
  startLon: number | null
  endLat: number | null
  endLon: number | null
  isOpen: boolean
}

export interface SessionPoint {
  sessionId: string
  ts: Date
  lat: number | null
  lon: number | null
  socPct: number | null
  speedKph: number | null
  powerKw: number | null
}

const NULL_SAMPLE: Omit<VehicleSample, 'vehicleId' | 'ts'> = {
  socPct: null,
  rangeKm: null,
  odometerKm: null,
  lat: null,
  lon: null,
  speedKph: null,
  powerState: null,
  chargeState: null,
  chargePowerKw: null,
  chargeEnergyAddedKwh: null,
  insideTempC: null,
  outsideTempC: null,
  locked: null,
  doorsOpen: null,
  tpms: null,
}

/**
 * Build a sample with explicit nulls for everything unspecified.
 * Used by adapters and by every test fixture in this repo.
 */
export function makeSample(
  partial: Pick<VehicleSample, 'vehicleId' | 'ts'> & Partial<VehicleSample>,
): VehicleSample {
  return { ...NULL_SAMPLE, ...partial }
}
