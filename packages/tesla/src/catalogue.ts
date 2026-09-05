/**
 * THE FIELD CATALOGUE: one entry per Fleet Telemetry signal we capture.
 *
 * The other half of the agreement `packages/core/src/signals.ts` opens. That
 * file says what columns exist and what type each holds, vendor-neutrally; this
 * one says which of Tesla's proto field names fills which column, at what
 * interval we ask for it, and how much it has to move before the car bothers to
 * send it. The dependency runs tesla -> core, the direction it already runs, so
 * nothing Tesla-shaped ever reaches the canonical model.
 *
 * WHAT THIS DRIVES: the field list `scripts/push-telemetry-config.sh` pushes to
 * the car, `normalise.ts`'s `FIELD_DECODERS`, `pipeline.ts`'s `VOLATILE_FIELDS`,
 * and the budget model below.
 *
 * WHY IT IS A LIST AND NOT CODE. The failure this exists to prevent is silent
 * in every direction: the car ignores a config entry whose name it does not
 * recognise, without an error and without the signal; the normaliser ignores a
 * field it cannot place, without an error and without the value; and a signal
 * nobody asked for is not merely missing from the database, it is gone for
 * every hour we did not ask. Only data can be cross-checked against the vendored
 * proto and against the column catalogue, which is what `test/catalogue.test.ts`
 * does — including in the direction that matters most, that every member of the
 * proto enum is either captured here or excluded BY NAME with a reason. A proto
 * update that adds a signal then fails the build until someone decides about it,
 * rather than costing a year of the signal.
 *
 * ORDER is proto field order, the same order the column catalogue uses, so the
 * two files and the proto stay line-comparable in review.
 */

/**
 * How often we ask for a field, in seconds.
 *
 * THE INTERVAL IS A FLOOR ON THE PERIOD, NOT A CAP ON COST. The car sends on
 * change and waits at least this long before sending again, so what a tier
 * actually costs depends on how often its fields move — and that tracks how long
 * the car is AWAKE, not how long it is driven. Sentry mode keeps a car awake all
 * day, which is what `delta` below exists to survive.
 */
export const TIER_INTERVAL_SECONDS = {
  /** Motion. Pins to constants in Park, so it is billed over driving hours. */
  drive: 10,
  /** The charge curve, and the pack rails that shape it. */
  charge: 60,
  /** Climate, openings, seats, navigation, pack and powertrain thermals. */
  status: 300,
  /** Configuration, identity, and state that moves a few times a day at most. */
  static: 3600,
} as const

export type Tier = keyof typeof TIER_INTERVAL_SECONDS

/**
 * Conversions applied at the normaliser, named here.
 *
 * Tesla streams miles and mph regardless of what the touchscreen displays, so a
 * column whose name claims km or kph must name the converter that makes that
 * true. `epochSecondsToDate` has no entry yet on purpose: every time-shaped
 * field is parked at `TEXT` until we have seen what the car actually sends
 * (core `signals.ts`), and promoting one of those columns is a planned step, not
 * a hypothetical one.
 */
export const CONVERTERS = ['milesToKm', 'mphToKph', 'epochSecondsToDate'] as const

export type Converter = (typeof CONVERTERS)[number]

/** One Tesla signal, and everything we have decided about it. */
export interface TeslaField {
  /** Proto name: what the pushed config asks for, and what the topic carries. */
  readonly field: string
  /**
   * The column(s) in `@ev/core`'s catalogue this fills. A pair for the three
   * fields that arrive as `{latitude, longitude}` — one message, two columns,
   * which is the expansion the design calls `targets`. It is written as a pair
   * rather than a suffix rule because the column catalogue is already expanded,
   * so there is no `_lat`/`_lon` left to derive.
   */
  readonly column: string | readonly [string, string]
  /**
   * Accumulator key in `TeslaFieldState`. Usually the column's camelCase, but
   * not where several fields collapse into one column: those need to stay apart
   * until `teslaStateToSample` collapses them, because each arrives in its own
   * MQTT message.
   */
  readonly slot: string | readonly [string, string]
  readonly tier: Tier
  readonly convert: Converter | null
  /**
   * `minimum_delta`: how far the value must move before the car sends it again,
   * IN THE UNITS ON THE WIRE (miles, mph, metres for a location) rather than in
   * the units of the column, because the car does this arithmetic before we ever
   * see the value.
   *
   * Set where suppression actually removes messages — a value that oscillates
   * around a level (pack current under standby draw, a parked GPS fix, cabin
   * temperature drifting a tenth of a degree), or a counter that ticks faster
   * than the resolution we chart at. Left null for a setpoint or an enum, where
   * every change is meaningful, and for a monotonic counter that already moves
   * far more than any sane threshold between reports: suppressing those only
   * delays a real change while saving nothing.
   */
  readonly delta: number | null
}

const asArray = (v: string | readonly [string, string]): readonly string[] =>
  typeof v === 'string' ? [v] : v

/** The column(s) an entry writes. One, or two for a location pair. */
export const columnsOf = (entry: TeslaField): readonly string[] => asArray(entry.column)

/** The accumulator slot(s) an entry fills. */
export const slotsOf = (entry: TeslaField): readonly string[] => asArray(entry.slot)

/**
 * Columns that more than one field writes, and why that is correct rather than
 * a collision. Declared so that an UNdeclared duplicate — two signals silently
 * overwriting each other — fails the test instead of the data.
 */
export const COLLAPSED_COLUMNS: Record<string, string> = {
  charge_state:
    'ChargeState and DetailedChargeState are the same enum at two resolutions; ' +
    'the detailed one wins when both are known.',
  charge_power_kw:
    'AC and DC charging are mutually exclusive on a real car, and the idle rail ' +
    'reports 0 or nothing, so the live rail is the one with the greater magnitude.',
  charge_energy_added_kwh:
    'The two rails are CUMULATIVE counters, so the idle one retains a total from ' +
    'an earlier session; the rail is chosen by observed power flow, never by size.',
  tpms:
    'The four corners arrive as four messages and collapse into one JSONB record ' +
    'rather than four columns holding the same four numbers twice.',
}

/**
 * Every signal we capture, in proto field order.
 *
 * 204 of the proto's 270 members; the other 66 are in `EXCLUDED_FIELDS` below.
 *
 * THE TIER SPLIT is 20 drive / 27 charge / 60 status / 97 static, which is what
 * `projectMonthlySignals` is sized against and what the test pins. Three calls
 * in it are worth stating because a reader would otherwise assume the opposite:
 *
 *   - `PackVoltage` and `PackCurrent` are CHARGE, not drive. They shape the
 *     charge curve, and the drive tier is ten times more expensive for a pair of
 *     values that a slower interval barely blurs.
 *   - `Odometer` is CHARGE. It is monotonic and only moves while driving, so it
 *     costs nothing when the car is merely awake; 60s is also what it has today,
 *     so nothing regresses.
 *   - `ACChargingPower`/`DCChargingPower` move from the 30s they are pushed at
 *     today to the charge tier's 60s. That halves charge-power resolution, and
 *     is the one place this catalogue is deliberately worse than the config it
 *     replaces: a per-field interval outside the tiers would be a fifth number
 *     to keep in agreement, and `delta` is the knob that actually bounds cost.
 */
export const TESLA_FIELDS: readonly TeslaField[] = [
  { field: 'DriveRail', column: 'drive_rail', slot: 'driveRail', tier: 'static',
    convert: null, delta: null },
  { field: 'ChargeState', column: 'charge_state', slot: 'chargeStateBasic',
    tier: 'charge', convert: null, delta: null },
  { field: 'BmsFullchargecomplete', column: 'bms_fullchargecomplete',
    slot: 'bmsFullchargecomplete', tier: 'status', convert: null, delta: null },
  { field: 'VehicleSpeed', column: 'speed_kph', slot: 'speedKph', tier: 'drive',
    convert: 'mphToKph', delta: 1 },
  { field: 'Odometer', column: 'odometer_km', slot: 'odometerKm', tier: 'charge',
    convert: 'milesToKm', delta: null },
  { field: 'PackVoltage', column: 'pack_voltage', slot: 'packVoltage', tier: 'charge',
    convert: null, delta: 1 },
  { field: 'PackCurrent', column: 'pack_current', slot: 'packCurrent', tier: 'charge',
    convert: null, delta: 1 },
  { field: 'Soc', column: 'soc_pct', slot: 'socPct', tier: 'charge', convert: null,
    delta: 0.5 },
  { field: 'DCDCEnable', column: 'dcdc_enable', slot: 'dcdcEnable', tier: 'static',
    convert: null, delta: null },
  { field: 'Gear', column: 'gear', slot: 'gear', tier: 'drive', convert: null,
    delta: null },
  { field: 'IsolationResistance', column: 'isolation_resistance',
    slot: 'isolationResistance', tier: 'static', convert: null, delta: 50 },
  { field: 'PedalPosition', column: 'pedal_position', slot: 'pedalPosition',
    tier: 'drive', convert: null, delta: 1 },
  { field: 'BrakePedal', column: 'brake_pedal', slot: 'brakePedal', tier: 'drive',
    convert: null, delta: null },
  { field: 'DiStateR', column: 'di_state_r', slot: 'diStateR', tier: 'drive',
    convert: null, delta: null },
  { field: 'DiHeatsinkTR', column: 'di_heatsink_tr', slot: 'diHeatsinkTr',
    tier: 'status', convert: null, delta: 1 },
  { field: 'DiAxleSpeedR', column: 'di_axle_speed_r', slot: 'diAxleSpeedR',
    tier: 'drive', convert: null, delta: 10 },
  { field: 'DiTorquemotor', column: 'di_torquemotor', slot: 'diTorquemotor',
    tier: 'drive', convert: null, delta: 5 },
  { field: 'DiStatorTempR', column: 'di_stator_temp_r', slot: 'diStatorTempR',
    tier: 'status', convert: null, delta: 1 },
  { field: 'DiVBatR', column: 'di_v_bat_r', slot: 'diVBatR', tier: 'status',
    convert: null, delta: 1 },
  { field: 'DiMotorCurrentR', column: 'di_motor_current_r', slot: 'diMotorCurrentR',
    tier: 'drive', convert: null, delta: 5 },
  { field: 'Location', column: ['lat', 'lon'], slot: ['lat', 'lon'], tier: 'drive',
    convert: null, delta: 10 },
  { field: 'GpsState', column: 'gps_state', slot: 'gpsState', tier: 'static',
    convert: null, delta: null },
  { field: 'GpsHeading', column: 'gps_heading', slot: 'gpsHeading', tier: 'drive',
    convert: null, delta: 5 },
  { field: 'NumBrickVoltageMax', column: 'num_brick_voltage_max',
    slot: 'numBrickVoltageMax', tier: 'status', convert: null, delta: null },
  { field: 'BrickVoltageMax', column: 'brick_voltage_max', slot: 'brickVoltageMax',
    tier: 'status', convert: null, delta: 0.005 },
  { field: 'NumBrickVoltageMin', column: 'num_brick_voltage_min',
    slot: 'numBrickVoltageMin', tier: 'status', convert: null, delta: null },
  { field: 'BrickVoltageMin', column: 'brick_voltage_min', slot: 'brickVoltageMin',
    tier: 'status', convert: null, delta: 0.005 },
  { field: 'NumModuleTempMax', column: 'num_module_temp_max', slot: 'numModuleTempMax',
    tier: 'status', convert: null, delta: null },
  { field: 'ModuleTempMax', column: 'module_temp_max', slot: 'moduleTempMax',
    tier: 'status', convert: null, delta: 0.5 },
  { field: 'NumModuleTempMin', column: 'num_module_temp_min', slot: 'numModuleTempMin',
    tier: 'status', convert: null, delta: null },
  { field: 'ModuleTempMin', column: 'module_temp_min', slot: 'moduleTempMin',
    tier: 'status', convert: null, delta: 0.5 },
  { field: 'RatedRange', column: 'range_km', slot: 'rangeKm', tier: 'charge',
    convert: 'milesToKm', delta: 1 },
  { field: 'Hvil', column: 'hvil', slot: 'hvil', tier: 'static', convert: null,
    delta: null },
  { field: 'DCChargingEnergyIn', column: 'charge_energy_added_kwh', slot: 'dcEnergyKwh',
    tier: 'charge', convert: null, delta: 0.1 },
  { field: 'DCChargingPower', column: 'charge_power_kw', slot: 'dcPowerKw',
    tier: 'charge', convert: null, delta: 0.5 },
  { field: 'ACChargingEnergyIn', column: 'charge_energy_added_kwh', slot: 'acEnergyKwh',
    tier: 'charge', convert: null, delta: 0.1 },
  { field: 'ACChargingPower', column: 'charge_power_kw', slot: 'acPowerKw',
    tier: 'charge', convert: null, delta: 0.5 },
  { field: 'ChargeLimitSoc', column: 'charge_limit_soc', slot: 'chargeLimitSoc',
    tier: 'charge', convert: null, delta: null },
  { field: 'FastChargerPresent', column: 'fast_charger_present',
    slot: 'fastChargerPresent', tier: 'charge', convert: null, delta: null },
  { field: 'EstBatteryRange', column: 'est_battery_range_km', slot: 'estBatteryRangeKm',
    tier: 'charge', convert: 'milesToKm', delta: 1 },
  { field: 'IdealBatteryRange', column: 'ideal_battery_range_km',
    slot: 'idealBatteryRangeKm', tier: 'charge', convert: 'milesToKm', delta: 1 },
  { field: 'BatteryLevel', column: 'battery_level', slot: 'batteryLevel',
    tier: 'charge', convert: null, delta: 0.5 },
  { field: 'TimeToFullCharge', column: 'time_to_full_charge_hours',
    slot: 'timeToFullChargeHours', tier: 'charge', convert: null, delta: 0.1 },
  { field: 'ScheduledChargingStartTime', column: 'scheduled_charging_start_time',
    slot: 'scheduledChargingStartTime', tier: 'static', convert: null, delta: null },
  { field: 'ScheduledChargingPending', column: 'scheduled_charging_pending',
    slot: 'scheduledChargingPending', tier: 'static', convert: null, delta: null },
  { field: 'ScheduledDepartureTime', column: 'scheduled_departure_time',
    slot: 'scheduledDepartureTime', tier: 'static', convert: null, delta: null },
  { field: 'PreconditioningEnabled', column: 'preconditioning_enabled',
    slot: 'preconditioningEnabled', tier: 'static', convert: null, delta: null },
  { field: 'ScheduledChargingMode', column: 'scheduled_charging_mode',
    slot: 'scheduledChargingMode', tier: 'static', convert: null, delta: null },
  { field: 'ChargeAmps', column: 'charge_amps', slot: 'chargeAmps', tier: 'charge',
    convert: null, delta: null },
  { field: 'ChargeEnableRequest', column: 'charge_enable_request',
    slot: 'chargeEnableRequest', tier: 'static', convert: null, delta: null },
  { field: 'ChargerPhases', column: 'charger_phases', slot: 'chargerPhases',
    tier: 'charge', convert: null, delta: null },
  { field: 'ChargePortColdWeatherMode', column: 'charge_port_cold_weather_mode',
    slot: 'chargePortColdWeatherMode', tier: 'static', convert: null, delta: null },
  { field: 'ChargeCurrentRequest', column: 'charge_current_request',
    slot: 'chargeCurrentRequest', tier: 'charge', convert: null, delta: null },
  { field: 'ChargeCurrentRequestMax', column: 'charge_current_request_max',
    slot: 'chargeCurrentRequestMax', tier: 'static', convert: null, delta: null },
  { field: 'BatteryHeaterOn', column: 'battery_heater_on', slot: 'batteryHeaterOn',
    tier: 'status', convert: null, delta: null },
  { field: 'NotEnoughPowerToHeat', column: 'not_enough_power_to_heat',
    slot: 'notEnoughPowerToHeat', tier: 'static', convert: null, delta: null },
  { field: 'SuperchargerSessionTripPlanner',
    column: 'supercharger_session_trip_planner', slot: 'superchargerSessionTripPlanner',
    tier: 'static', convert: null, delta: null },
  { field: 'DoorState', column: 'doors_open', slot: 'doorsOpen', tier: 'status',
    convert: null, delta: null },
  { field: 'Locked', column: 'locked', slot: 'locked', tier: 'status', convert: null,
    delta: null },
  { field: 'FdWindow', column: 'fd_window', slot: 'fdWindow', tier: 'status',
    convert: null, delta: null },
  { field: 'FpWindow', column: 'fp_window', slot: 'fpWindow', tier: 'status',
    convert: null, delta: null },
  { field: 'RdWindow', column: 'rd_window', slot: 'rdWindow', tier: 'status',
    convert: null, delta: null },
  { field: 'RpWindow', column: 'rp_window', slot: 'rpWindow', tier: 'status',
    convert: null, delta: null },
  { field: 'VehicleName', column: 'vehicle_name', slot: 'vehicleName', tier: 'static',
    convert: null, delta: null },
  { field: 'SentryMode', column: 'sentry_mode', slot: 'sentryMode', tier: 'status',
    convert: null, delta: null },
  { field: 'SpeedLimitMode', column: 'speed_limit_mode', slot: 'speedLimitMode',
    tier: 'static', convert: null, delta: null },
  { field: 'CurrentLimitMph', column: 'current_limit_kph', slot: 'currentLimitKph',
    tier: 'static', convert: 'mphToKph', delta: null },
  { field: 'Version', column: 'version', slot: 'version', tier: 'static', convert: null,
    delta: null },
  { field: 'TpmsPressureFl', column: 'tpms', slot: 'tpmsFl', tier: 'static',
    convert: null, delta: 0.05 },
  { field: 'TpmsPressureFr', column: 'tpms', slot: 'tpmsFr', tier: 'static',
    convert: null, delta: 0.05 },
  { field: 'TpmsPressureRl', column: 'tpms', slot: 'tpmsRl', tier: 'static',
    convert: null, delta: 0.05 },
  { field: 'TpmsPressureRr', column: 'tpms', slot: 'tpmsRr', tier: 'static',
    convert: null, delta: 0.05 },
  { field: 'TpmsLastSeenPressureTimeFl', column: 'tpms_last_seen_pressure_time_fl',
    slot: 'tpmsLastSeenPressureTimeFl', tier: 'static', convert: null, delta: null },
  { field: 'TpmsLastSeenPressureTimeFr', column: 'tpms_last_seen_pressure_time_fr',
    slot: 'tpmsLastSeenPressureTimeFr', tier: 'static', convert: null, delta: null },
  { field: 'TpmsLastSeenPressureTimeRl', column: 'tpms_last_seen_pressure_time_rl',
    slot: 'tpmsLastSeenPressureTimeRl', tier: 'static', convert: null, delta: null },
  { field: 'TpmsLastSeenPressureTimeRr', column: 'tpms_last_seen_pressure_time_rr',
    slot: 'tpmsLastSeenPressureTimeRr', tier: 'static', convert: null, delta: null },
  { field: 'InsideTemp', column: 'inside_temp_c', slot: 'insideTempC', tier: 'status',
    convert: null, delta: 0.5 },
  { field: 'OutsideTemp', column: 'outside_temp_c', slot: 'outsideTempC',
    tier: 'status', convert: null, delta: 0.5 },
  { field: 'SeatHeaterLeft', column: 'seat_heater_left', slot: 'seatHeaterLeft',
    tier: 'status', convert: null, delta: null },
  { field: 'SeatHeaterRight', column: 'seat_heater_right', slot: 'seatHeaterRight',
    tier: 'status', convert: null, delta: null },
  { field: 'SeatHeaterRearLeft', column: 'seat_heater_rear_left',
    slot: 'seatHeaterRearLeft', tier: 'status', convert: null, delta: null },
  { field: 'SeatHeaterRearRight', column: 'seat_heater_rear_right',
    slot: 'seatHeaterRearRight', tier: 'status', convert: null, delta: null },
  { field: 'SeatHeaterRearCenter', column: 'seat_heater_rear_center',
    slot: 'seatHeaterRearCenter', tier: 'status', convert: null, delta: null },
  { field: 'AutoSeatClimateLeft', column: 'auto_seat_climate_left',
    slot: 'autoSeatClimateLeft', tier: 'static', convert: null, delta: null },
  { field: 'AutoSeatClimateRight', column: 'auto_seat_climate_right',
    slot: 'autoSeatClimateRight', tier: 'static', convert: null, delta: null },
  { field: 'DriverSeatBelt', column: 'driver_seat_belt', slot: 'driverSeatBelt',
    tier: 'status', convert: null, delta: null },
  { field: 'PassengerSeatBelt', column: 'passenger_seat_belt',
    slot: 'passengerSeatBelt', tier: 'status', convert: null, delta: null },
  { field: 'DriverSeatOccupied', column: 'driver_seat_occupied',
    slot: 'driverSeatOccupied', tier: 'status', convert: null, delta: null },
  { field: 'LateralAcceleration', column: 'lateral_acceleration',
    slot: 'lateralAcceleration', tier: 'drive', convert: null, delta: 0.05 },
  { field: 'LongitudinalAcceleration', column: 'longitudinal_acceleration',
    slot: 'longitudinalAcceleration', tier: 'drive', convert: null, delta: 0.05 },
  { field: 'CruiseSetSpeed', column: 'cruise_set_speed_kph', slot: 'cruiseSetSpeedKph',
    tier: 'static', convert: 'mphToKph', delta: null },
  { field: 'LifetimeEnergyUsed', column: 'lifetime_energy_used',
    slot: 'lifetimeEnergyUsed', tier: 'static', convert: null, delta: null },
  { field: 'LifetimeEnergyUsedDrive', column: 'lifetime_energy_used_drive',
    slot: 'lifetimeEnergyUsedDrive', tier: 'static', convert: null, delta: null },
  { field: 'BrakePedalPos', column: 'brake_pedal_pos', slot: 'brakePedalPos',
    tier: 'drive', convert: null, delta: 1 },
  { field: 'RouteLastUpdated', column: 'route_last_updated', slot: 'routeLastUpdated',
    tier: 'status', convert: null, delta: null },
  { field: 'RouteLine', column: 'route_line', slot: 'routeLine', tier: 'status',
    convert: null, delta: null },
  { field: 'MilesToArrival', column: 'km_to_arrival', slot: 'kmToArrival',
    tier: 'status', convert: 'milesToKm', delta: 0.5 },
  { field: 'MinutesToArrival', column: 'minutes_to_arrival', slot: 'minutesToArrival',
    tier: 'status', convert: null, delta: 1 },
  { field: 'OriginLocation', column: ['origin_location_lat', 'origin_location_lon'],
    slot: ['originLocationLat', 'originLocationLon'], tier: 'status', convert: null,
    delta: null },
  { field: 'DestinationLocation',
    column: ['destination_location_lat', 'destination_location_lon'],
    slot: ['destinationLocationLat', 'destinationLocationLon'], tier: 'status',
    convert: null, delta: null },
  { field: 'CarType', column: 'car_type', slot: 'carType', tier: 'static',
    convert: null, delta: null },
  { field: 'Trim', column: 'trim', slot: 'trim', tier: 'static', convert: null,
    delta: null },
  { field: 'ExteriorColor', column: 'exterior_color', slot: 'exteriorColor',
    tier: 'static', convert: null, delta: null },
  { field: 'RoofColor', column: 'roof_color', slot: 'roofColor', tier: 'static',
    convert: null, delta: null },
  { field: 'ChargePort', column: 'charge_port', slot: 'chargePort', tier: 'charge',
    convert: null, delta: null },
  { field: 'ChargePortLatch', column: 'charge_port_latch', slot: 'chargePortLatch',
    tier: 'charge', convert: null, delta: null },
  { field: 'GuestModeEnabled', column: 'guest_mode_enabled', slot: 'guestModeEnabled',
    tier: 'static', convert: null, delta: null },
  { field: 'PinToDriveEnabled', column: 'pin_to_drive_enabled',
    slot: 'pinToDriveEnabled', tier: 'static', convert: null, delta: null },
  { field: 'PairedPhoneKeyAndKeyFobQty', column: 'paired_phone_key_and_key_fob_qty',
    slot: 'pairedPhoneKeyAndKeyFobQty', tier: 'static', convert: null, delta: null },
  { field: 'CruiseFollowDistance', column: 'cruise_follow_distance',
    slot: 'cruiseFollowDistance', tier: 'static', convert: null, delta: null },
  { field: 'AutomaticBlindSpotCamera', column: 'automatic_blind_spot_camera',
    slot: 'automaticBlindSpotCamera', tier: 'static', convert: null, delta: null },
  { field: 'BlindSpotCollisionWarningChime',
    column: 'blind_spot_collision_warning_chime',
    slot: 'blindSpotCollisionWarningChime', tier: 'static', convert: null, delta: null },
  { field: 'SpeedLimitWarning', column: 'speed_limit_warning',
    slot: 'speedLimitWarning', tier: 'static', convert: null, delta: null },
  { field: 'ForwardCollisionWarning', column: 'forward_collision_warning',
    slot: 'forwardCollisionWarning', tier: 'static', convert: null, delta: null },
  { field: 'LaneDepartureAvoidance', column: 'lane_departure_avoidance',
    slot: 'laneDepartureAvoidance', tier: 'static', convert: null, delta: null },
  { field: 'EmergencyLaneDepartureAvoidance',
    column: 'emergency_lane_departure_avoidance',
    slot: 'emergencyLaneDepartureAvoidance', tier: 'static', convert: null, delta: null },
  { field: 'AutomaticEmergencyBrakingOff', column: 'automatic_emergency_braking_off',
    slot: 'automaticEmergencyBrakingOff', tier: 'static', convert: null, delta: null },
  { field: 'LifetimeEnergyGainedRegen', column: 'lifetime_energy_gained_regen',
    slot: 'lifetimeEnergyGainedRegen', tier: 'static', convert: null, delta: null },
  { field: 'DiStateF', column: 'di_state_f', slot: 'diStateF', tier: 'drive',
    convert: null, delta: null },
  { field: 'DiHeatsinkTF', column: 'di_heatsink_tf', slot: 'diHeatsinkTf',
    tier: 'status', convert: null, delta: 1 },
  { field: 'DiAxleSpeedF', column: 'di_axle_speed_f', slot: 'diAxleSpeedF',
    tier: 'drive', convert: null, delta: 10 },
  { field: 'DiSlaveTorqueCmd', column: 'di_slave_torque_cmd', slot: 'diSlaveTorqueCmd',
    tier: 'drive', convert: null, delta: 5 },
  { field: 'DiTorqueActualR', column: 'di_torque_actual_r', slot: 'diTorqueActualR',
    tier: 'drive', convert: null, delta: 5 },
  { field: 'DiTorqueActualF', column: 'di_torque_actual_f', slot: 'diTorqueActualF',
    tier: 'drive', convert: null, delta: 5 },
  { field: 'DiStatorTempF', column: 'di_stator_temp_f', slot: 'diStatorTempF',
    tier: 'status', convert: null, delta: 1 },
  { field: 'DiVBatF', column: 'di_v_bat_f', slot: 'diVBatF', tier: 'status',
    convert: null, delta: 1 },
  { field: 'DiMotorCurrentF', column: 'di_motor_current_f', slot: 'diMotorCurrentF',
    tier: 'drive', convert: null, delta: 5 },
  { field: 'EnergyRemaining', column: 'energy_remaining', slot: 'energyRemaining',
    tier: 'charge', convert: null, delta: 0.1 },
  { field: 'ServiceMode', column: 'service_mode', slot: 'serviceMode', tier: 'static',
    convert: null, delta: null },
  { field: 'BMSState', column: 'bms_state', slot: 'bmsState', tier: 'static',
    convert: null, delta: null },
  { field: 'GuestModeMobileAccessState', column: 'guest_mode_mobile_access_state',
    slot: 'guestModeMobileAccessState', tier: 'static', convert: null, delta: null },
  { field: 'DestinationName', column: 'destination_name', slot: 'destinationName',
    tier: 'status', convert: null, delta: null },
  { field: 'DiInverterTR', column: 'di_inverter_tr', slot: 'diInverterTr',
    tier: 'status', convert: null, delta: 1 },
  { field: 'DiInverterTF', column: 'di_inverter_tf', slot: 'diInverterTf',
    tier: 'status', convert: null, delta: 1 },
  { field: 'DetailedChargeState', column: 'charge_state', slot: 'chargeStateDetailed',
    tier: 'charge', convert: null, delta: null },
  { field: 'CabinOverheatProtectionMode', column: 'cabin_overheat_protection_mode',
    slot: 'cabinOverheatProtectionMode', tier: 'static', convert: null, delta: null },
  { field: 'CabinOverheatProtectionTemperatureLimit',
    column: 'cabin_overheat_protection_temperature_limit',
    slot: 'cabinOverheatProtectionTemperatureLimit', tier: 'static', convert: null,
    delta: null },
  { field: 'CenterDisplay', column: 'center_display', slot: 'centerDisplay',
    tier: 'static', convert: null, delta: null },
  { field: 'ChargePortDoorOpen', column: 'charge_port_door_open',
    slot: 'chargePortDoorOpen', tier: 'charge', convert: null, delta: null },
  { field: 'ChargerVoltage', column: 'charger_voltage', slot: 'chargerVoltage',
    tier: 'charge', convert: null, delta: 1 },
  { field: 'ChargingCableType', column: 'charging_cable_type',
    slot: 'chargingCableType', tier: 'static', convert: null, delta: null },
  { field: 'ClimateKeeperMode', column: 'climate_keeper_mode',
    slot: 'climateKeeperMode', tier: 'status', convert: null, delta: null },
  { field: 'DefrostForPreconditioning', column: 'defrost_for_preconditioning',
    slot: 'defrostForPreconditioning', tier: 'static', convert: null, delta: null },
  { field: 'DefrostMode', column: 'defrost_mode', slot: 'defrostMode', tier: 'status',
    convert: null, delta: null },
  { field: 'EfficiencyPackage', column: 'efficiency_package', slot: 'efficiencyPackage',
    tier: 'static', convert: null, delta: null },
  { field: 'EstimatedHoursToChargeTermination',
    column: 'estimated_hours_to_charge_termination',
    slot: 'estimatedHoursToChargeTermination', tier: 'charge', convert: null,
    delta: 0.1 },
  { field: 'EuropeVehicle', column: 'europe_vehicle', slot: 'europeVehicle',
    tier: 'static', convert: null, delta: null },
  { field: 'ExpectedEnergyPercentAtTripArrival',
    column: 'expected_energy_percent_at_trip_arrival',
    slot: 'expectedEnergyPercentAtTripArrival', tier: 'status', convert: null, delta: 1 },
  { field: 'FastChargerType', column: 'fast_charger_type', slot: 'fastChargerType',
    tier: 'static', convert: null, delta: null },
  { field: 'HomelinkDeviceCount', column: 'homelink_device_count',
    slot: 'homelinkDeviceCount', tier: 'static', convert: null, delta: null },
  { field: 'HomelinkNearby', column: 'homelink_nearby', slot: 'homelinkNearby',
    tier: 'static', convert: null, delta: null },
  { field: 'HvacACEnabled', column: 'hvac_ac_enabled', slot: 'hvacAcEnabled',
    tier: 'status', convert: null, delta: null },
  { field: 'HvacAutoMode', column: 'hvac_auto_mode', slot: 'hvacAutoMode',
    tier: 'status', convert: null, delta: null },
  { field: 'HvacFanSpeed', column: 'hvac_fan_speed', slot: 'hvacFanSpeed',
    tier: 'status', convert: null, delta: null },
  { field: 'HvacFanStatus', column: 'hvac_fan_status', slot: 'hvacFanStatus',
    tier: 'status', convert: null, delta: null },
  { field: 'HvacLeftTemperatureRequest', column: 'hvac_left_temperature_request',
    slot: 'hvacLeftTemperatureRequest', tier: 'status', convert: null, delta: null },
  { field: 'HvacPower', column: 'hvac_power', slot: 'hvacPower', tier: 'status',
    convert: null, delta: null },
  { field: 'HvacRightTemperatureRequest', column: 'hvac_right_temperature_request',
    slot: 'hvacRightTemperatureRequest', tier: 'status', convert: null, delta: null },
  { field: 'HvacSteeringWheelHeatAuto', column: 'hvac_steering_wheel_heat_auto',
    slot: 'hvacSteeringWheelHeatAuto', tier: 'static', convert: null, delta: null },
  { field: 'HvacSteeringWheelHeatLevel', column: 'hvac_steering_wheel_heat_level',
    slot: 'hvacSteeringWheelHeatLevel', tier: 'status', convert: null, delta: null },
  { field: 'RearDisplayHvacEnabled', column: 'rear_display_hvac_enabled',
    slot: 'rearDisplayHvacEnabled', tier: 'static', convert: null, delta: null },
  { field: 'RearSeatHeaters', column: 'rear_seat_heaters', slot: 'rearSeatHeaters',
    tier: 'status', convert: null, delta: null },
  { field: 'RemoteStartEnabled', column: 'remote_start_enabled',
    slot: 'remoteStartEnabled', tier: 'static', convert: null, delta: null },
  { field: 'RightHandDrive', column: 'right_hand_drive', slot: 'rightHandDrive',
    tier: 'static', convert: null, delta: null },
  { field: 'RouteTrafficMinutesDelay', column: 'route_traffic_minutes_delay',
    slot: 'routeTrafficMinutesDelay', tier: 'status', convert: null, delta: 1 },
  { field: 'SoftwareUpdateDownloadPercentComplete',
    column: 'software_update_download_percent_complete',
    slot: 'softwareUpdateDownloadPercentComplete', tier: 'static', convert: null,
    delta: null },
  { field: 'SoftwareUpdateExpectedDurationMinutes',
    column: 'software_update_expected_duration_minutes',
    slot: 'softwareUpdateExpectedDurationMinutes', tier: 'static', convert: null,
    delta: null },
  { field: 'SoftwareUpdateInstallationPercentComplete',
    column: 'software_update_installation_percent_complete',
    slot: 'softwareUpdateInstallationPercentComplete', tier: 'static', convert: null,
    delta: null },
  { field: 'SoftwareUpdateScheduledStartTime',
    column: 'software_update_scheduled_start_time',
    slot: 'softwareUpdateScheduledStartTime', tier: 'static', convert: null,
    delta: null },
  { field: 'SoftwareUpdateVersion', column: 'software_update_version',
    slot: 'softwareUpdateVersion', tier: 'static', convert: null, delta: null },
  { field: 'TpmsHardWarnings', column: 'tpms_hard_warnings', slot: 'tpmsHardWarnings',
    tier: 'static', convert: null, delta: null },
  { field: 'TpmsSoftWarnings', column: 'tpms_soft_warnings', slot: 'tpmsSoftWarnings',
    tier: 'static', convert: null, delta: null },
  { field: 'ValetModeEnabled', column: 'valet_mode_enabled', slot: 'valetModeEnabled',
    tier: 'static', convert: null, delta: null },
  { field: 'WheelType', column: 'wheel_type', slot: 'wheelType', tier: 'static',
    convert: null, delta: null },
  { field: 'WiperHeatEnabled', column: 'wiper_heat_enabled', slot: 'wiperHeatEnabled',
    tier: 'static', convert: null, delta: null },
  { field: 'LocatedAtHome', column: 'located_at_home', slot: 'locatedAtHome',
    tier: 'static', convert: null, delta: null },
  { field: 'LocatedAtWork', column: 'located_at_work', slot: 'locatedAtWork',
    tier: 'static', convert: null, delta: null },
  { field: 'LocatedAtFavorite', column: 'located_at_favorite',
    slot: 'locatedAtFavorite', tier: 'static', convert: null, delta: null },
  { field: 'SettingDistanceUnit', column: 'setting_distance_unit',
    slot: 'settingDistanceUnit', tier: 'static', convert: null, delta: null },
  { field: 'SettingTemperatureUnit', column: 'setting_temperature_unit',
    slot: 'settingTemperatureUnit', tier: 'static', convert: null, delta: null },
  { field: 'Setting24HourTime', column: 'setting_24_hour_time',
    slot: 'setting24HourTime', tier: 'static', convert: null, delta: null },
  { field: 'SettingTirePressureUnit', column: 'setting_tire_pressure_unit',
    slot: 'settingTirePressureUnit', tier: 'static', convert: null, delta: null },
  { field: 'SettingChargeUnit', column: 'setting_charge_unit',
    slot: 'settingChargeUnit', tier: 'static', convert: null, delta: null },
  { field: 'ClimateSeatCoolingFrontLeft', column: 'climate_seat_cooling_front_left',
    slot: 'climateSeatCoolingFrontLeft', tier: 'status', convert: null, delta: null },
  { field: 'ClimateSeatCoolingFrontRight', column: 'climate_seat_cooling_front_right',
    slot: 'climateSeatCoolingFrontRight', tier: 'status', convert: null, delta: null },
  { field: 'LightsHazardsActive', column: 'lights_hazards_active',
    slot: 'lightsHazardsActive', tier: 'static', convert: null, delta: null },
  { field: 'LightsTurnSignal', column: 'lights_turn_signal', slot: 'lightsTurnSignal',
    tier: 'static', convert: null, delta: null },
  { field: 'LightsHighBeams', column: 'lights_high_beams', slot: 'lightsHighBeams',
    tier: 'static', convert: null, delta: null },
  { field: 'SunroofInstalled', column: 'sunroof_installed', slot: 'sunroofInstalled',
    tier: 'static', convert: null, delta: null },
  { field: 'SeatVentEnabled', column: 'seat_vent_enabled', slot: 'seatVentEnabled',
    tier: 'static', convert: null, delta: null },
  { field: 'RearDefrostEnabled', column: 'rear_defrost_enabled',
    slot: 'rearDefrostEnabled', tier: 'status', convert: null, delta: null },
  { field: 'ChargeRateMilePerHour', column: 'charge_rate_km_per_hour',
    slot: 'chargeRateKmPerHour', tier: 'charge', convert: 'milesToKm', delta: 1 },
  { field: 'MilesSinceReset', column: 'km_since_reset', slot: 'kmSinceReset',
    tier: 'static', convert: 'milesToKm', delta: null },
  { field: 'SelfDrivingMilesSinceReset', column: 'self_driving_km_since_reset',
    slot: 'selfDrivingKmSinceReset', tier: 'static', convert: 'milesToKm', delta: null },
  { field: 'GpsAccuracyMeters', column: 'gps_accuracy_meters',
    slot: 'gpsAccuracyMeters', tier: 'static', convert: null, delta: 1 },
  { field: 'LifetimeEnergyChargedKwh', column: 'lifetime_energy_charged_kwh',
    slot: 'lifetimeEnergyChargedKwh', tier: 'static', convert: null, delta: null },
  { field: 'BrickSocMinPercent', column: 'brick_soc_min_percent',
    slot: 'brickSocMinPercent', tier: 'status', convert: null, delta: 0.5 },
  { field: 'NominalFullPackEnergyKwh', column: 'nominal_full_pack_energy_kwh',
    slot: 'nominalFullPackEnergyKwh', tier: 'static', convert: null, delta: 0.1 },
  { field: 'GradeEstimatePercent', column: 'grade_estimate_percent',
    slot: 'gradeEstimatePercent', tier: 'drive', convert: null, delta: 0.5 },
  { field: 'MaxSpeedToReachDestinationMph',
    column: 'max_speed_to_reach_destination_kph', slot: 'maxSpeedToReachDestinationKph',
    tier: 'status', convert: 'mphToKph', delta: 1 },
  { field: 'SoftwareUpdateAvailable', column: 'software_update_available',
    slot: 'softwareUpdateAvailable', tier: 'static', convert: null, delta: null },
  { field: 'SoftwareUpdateInProgress', column: 'software_update_in_progress',
    slot: 'softwareUpdateInProgress', tier: 'static', convert: null, delta: null },
  { field: 'RemoteStartActive', column: 'remote_start_active',
    slot: 'remoteStartActive', tier: 'static', convert: null, delta: null },
  { field: 'SemiCruiseSpeedLimitMph', column: 'semi_cruise_speed_limit_kph',
    slot: 'semiCruiseSpeedLimitKph', tier: 'static', convert: 'mphToKph', delta: null },
]

/** A group of proto members we deliberately do not ask for. */
export interface ExclusionGroup {
  readonly reason: string
  readonly fields: readonly string[]
}

/**
 * The 66 members we do not capture, BY NAME.
 *
 * By name rather than by pattern, because a pattern silently absorbs whatever a
 * future proto adds that happens to match it — and a signal we never notice we
 * are not asking for is the exact failure this design exists to prevent. Listing
 * them costs 66 lines once; matching them costs a signal we never learn about.
 *
 * Note that neither `LifetimeEnergyUsedDrive` nor `SemiCruiseSpeedLimitMph` is
 * here, even though the proto comments both Semi-only. The exclusion is by name
 * and neither carries the `Semitruck` prefix; a column a Model Y never fills
 * costs a slot and nothing else, whereas a silent omission is what we are
 * guarding against.
 */
export const EXCLUDED_FIELDS: readonly ExclusionGroup[] = [
  {
    reason: 'Placeholders with no meaning: reserved, retired, or unannounced.',
    fields: [
      'Unknown', 'Deprecated_2', 'Experimental_1', 'Experimental_2', 'Experimental_3',
      'Experimental_4', 'Deprecated_1', 'Experimental_5', 'Experimental_6',
      'Experimental_7', 'Experimental_8', 'Experimental_9', 'Experimental_10',
      'Experimental_11', 'Experimental_12', 'Experimental_13', 'Experimental_14',
      'Experimental_15', 'Deprecated_3',
    ],
  },
  {
    reason:
      'Semi and Cybertruck hardware. A Model Y has none of it and never sends these.',
    fields: [
      'SemitruckTpmsPressureRe1L0', 'SemitruckTpmsPressureRe1L1',
      'SemitruckTpmsPressureRe1R0', 'SemitruckTpmsPressureRe1R1',
      'SemitruckTpmsPressureRe2L0', 'SemitruckTpmsPressureRe2L1',
      'SemitruckTpmsPressureRe2R0', 'SemitruckTpmsPressureRe2R1',
      'SemitruckPassengerSeatFoldPosition', 'SemitruckTractorParkBrakeStatus',
      'SemitruckTrailerParkBrakeStatus', 'OffroadLightbarPresent',
      'PowershareHoursLeft', 'PowershareInstantaneousPowerKW', 'PowershareStatus',
      'PowershareStopReason', 'PowershareType', 'TonneauOpenPercent',
      'TonneauPosition', 'TonneauTentMode',
    ],
  },
  {
    reason:
      'Rear-left and rear-right drive units: tri- and quad-motor cars only. ' +
      'The F and R units this car does have are captured.',
    fields: [
      'DiStateREL', 'DiStateRER', 'DiHeatsinkTREL', 'DiHeatsinkTRER', 'DiAxleSpeedREL',
      'DiAxleSpeedRER', 'DiTorqueActualREL', 'DiTorqueActualRER', 'DiStatorTempREL',
      'DiStatorTempRER', 'DiVBatREL', 'DiVBatRER', 'DiMotorCurrentREL',
      'DiMotorCurrentRER', 'DiInverterTREL', 'DiInverterTRER',
    ],
  },
  {
    reason: 'Personal content. Excluded by decision, not by capability.',
    fields: [
      'MediaPlaybackStatus', 'MediaPlaybackSource', 'MediaAudioVolume',
      'MediaNowPlayingDuration', 'MediaNowPlayingElapsed', 'MediaNowPlayingArtist',
      'MediaNowPlayingTitle', 'MediaNowPlayingAlbum', 'MediaNowPlayingStation',
      'MediaAudioVolumeIncrement', 'MediaAudioVolumeMax',
    ],
  },
]

/** Days in the billing month the projection below is quoted in. */
const DAYS_PER_MONTH = 30

/**
 * Hours of driving a day the drive tier is billed over.
 *
 * Drive-tier fields pin to constants in Park — speed 0, gear P, torque 0 — so
 * they cost nothing over the rest of the car's awake hours. `Location` and
 * `GpsHeading` are the exception, since a stationary fix jitters, which is why
 * both carry a `delta`.
 */
const DRIVING_HOURS_PER_DAY = 1.5

/** What the four tiers cost in a month, per tier and in total. */
export type SignalProjection = Record<Tier, number> & { total: number }

/**
 * The worst case: every field of a tier changing at its interval's ceiling, and
 * no `delta` suppressing anything.
 *
 * Billing is $1 per 150,000 signals against a $10/month credit, so the budget is
 * ~1.5M signals a month and the alert threshold is 1.2M — before the credit runs
 * out, not after a bill. This is modelled here, from the tiers themselves, so
 * that adding twenty drive-tier signals fails the build rather than the bill;
 * `ev_ingest_messages_total` is what observes the real rate.
 */
export function projectMonthlySignals(awakeHoursPerDay: number): SignalProjection {
  const counts: Record<Tier, number> = { drive: 0, charge: 0, status: 0, static: 0 }
  for (const entry of TESLA_FIELDS) counts[entry.tier] += 1

  const perTier = (tier: Tier): number => {
    const hours = tier === 'drive' ? DRIVING_HOURS_PER_DAY : awakeHoursPerDay
    const sendsPerHour = 3600 / TIER_INTERVAL_SECONDS[tier]
    return counts[tier] * sendsPerHour * hours * DAYS_PER_MONTH
  }

  const projection = {
    drive: perTier('drive'),
    charge: perTier('charge'),
    status: perTier('status'),
    static: perTier('static'),
  }
  return { ...projection, total: Object.values(projection).reduce((a, b) => a + b, 0) }
}
