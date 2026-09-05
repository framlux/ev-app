/**
 * Preconditions for pushing a Fleet Telemetry config to a vehicle.
 *
 * Tesla documents two hard requirements - firmware 2024.26 or later, and a
 * paired virtual key - and the config push does not report either of them
 * usefully when unmet. The request is accepted, the vehicle never applies it,
 * and `fleet_telemetry_config` simply reports `synced: false` forever. That is
 * indistinguishable from a car that is merely asleep, so without this check the
 * only debugging signal is a poll that never terminates.
 *
 * These are pure functions over an already-fetched `fleet_status` response so
 * the boundary cases are testable without a vehicle or a network.
 */

/** Tesla firmware floor for Fleet Telemetry on a non-legacy certificate app. */
export const MIN_FIRMWARE: readonly [number, number] = [2024, 26]

export interface VehicleInfo {
  firmware_version?: string
  fleet_telemetry_version?: string
  vehicle_command_protocol_required?: boolean
  safety_screen_streaming_toggle_enabled?: boolean | null
}

export interface Preflight {
  ok: boolean
  blockers: string[]
  warnings: string[]
}

/**
 * Compares a Tesla firmware string against the floor.
 *
 * Versions look like "2024.26.3.1" or "2025.2". Only the first two components
 * decide the comparison, but they must be compared NUMERICALLY: a string
 * compare puts "2024.9" after "2024.26", which would pass a car that is four
 * months too old.
 */
export function firmwareAtLeast(
  version: string,
  floor: readonly [number, number] = MIN_FIRMWARE,
): boolean {
  // parseInt on `undefined ?? ''` yields NaN rather than undefined, which keeps
  // the guard below a single finite-check under noUncheckedIndexedAccess.
  const parts = version.trim().split('.')
  const year = Number.parseInt(parts[0] ?? '', 10)
  const week = Number.parseInt(parts[1] ?? '', 10)
  if (!Number.isFinite(year) || !Number.isFinite(week)) return false
  if (year !== floor[0]) return year > floor[0]
  return week >= floor[1]
}

export function checkTelemetryPreconditions(
  vin: string,
  info: VehicleInfo | undefined,
  keyPaired: boolean,
): Preflight {
  const blockers: string[] = []
  const warnings: string[] = []

  if (!keyPaired) {
    blockers.push(
      `${vin}: virtual key not paired. Pair at https://www.tesla.com/_ak/<developer-domain> ` +
        `- the path takes the DOMAIN serving the public key, not the application name.`)
  }

  if (!info) {
    blockers.push(`${vin}: absent from fleet_status vehicle_info; cannot verify firmware.`)
  } else if (!info.firmware_version) {
    blockers.push(`${vin}: fleet_status reported no firmware_version; cannot verify the floor.`)
  } else if (!firmwareAtLeast(info.firmware_version)) {
    blockers.push(
      `${vin}: firmware ${info.firmware_version} is below the ` +
        `${MIN_FIRMWARE[0]}.${MIN_FIRMWARE[1]} floor for Fleet Telemetry.`)
  }

  // Not a blocker: some vehicles use the in-car toggle INSTEAD of a virtual key.
  // Explicit `false` means the owner must enable "Allow Third-Party App Data
  // Streaming" on the car's Safety screen; `null`/absent means not applicable.
  if (info?.safety_screen_streaming_toggle_enabled === false) {
    warnings.push(
      `${vin}: "Allow Third-Party App Data Streaming" is off on the car's Safety screen. ` +
        `On vehicles that use this instead of a virtual key, the config will not apply.`)
  }

  return { ok: blockers.length === 0, blockers, warnings }
}
