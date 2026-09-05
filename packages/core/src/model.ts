import { SAMPLE_COLUMNS, type TsType } from './signals.js'

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
 * The TypeScript type behind each catalogue `ts` tag.
 *
 * `signals.ts` imports nothing — that is what keeps the column list from
 * acquiring a dependency — so the tags are strings there and are bound to real
 * types here, in the one file that owns the canonical model.
 */
interface TsTypeMap {
  number: number
  string: string
  boolean: boolean
  Date: Date
  PowerState: PowerState
  ChargeState: ChargeState
  TpmsMap: Record<string, number>
}

/**
 * Fails the build if a catalogue tag has no type above. Without it a missing
 * tag would silently drop its columns out of `VehicleSample` instead.
 */
type Mapped<T extends keyof TsTypeMap> = T
type _EveryTsTagIsMapped = Mapped<TsType>

/**
 * Every catalogued column, nullable, keyed by its `VehicleSample` property.
 *
 * Derived rather than written out: there are two hundred of them, and a
 * hand-maintained list would be free to disagree with the catalogue that the
 * migration and the insert are generated from — which is the one drift this
 * design exists to make impossible.
 */
type SampleColumns = {
  [E in (typeof SAMPLE_COLUMNS)[number] as E['key']]: TsTypeMap[E['ts']] | null
}

/**
 * The canonical vehicle observation. Vendor-neutral by construction.
 *
 * Every field but vehicleId and ts is nullable: vendors disagree about what
 * they expose, and a missing field must be distinguishable from a zero.
 * Rivian, for instance, does not expose battery temperature at all.
 */
export interface VehicleSample extends SampleColumns {
  vehicleId: string
  ts: Date
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

/**
 * Built from the catalogue at module load, not written out, for the same reason
 * `SampleColumns` is derived: a column that exists but is missing here would
 * arrive at `insertSample` as `undefined` rather than `null`.
 */
const NULL_SAMPLE = Object.fromEntries(
  SAMPLE_COLUMNS.map((c) => [c.key, null]),
) as Omit<VehicleSample, 'vehicleId' | 'ts'>

/**
 * Build a sample with explicit nulls for everything unspecified.
 * Used by adapters and by every test fixture in this repo.
 */
export function makeSample(
  partial: Pick<VehicleSample, 'vehicleId' | 'ts'> & Partial<VehicleSample>,
): VehicleSample {
  return { ...NULL_SAMPLE, ...partial }
}
