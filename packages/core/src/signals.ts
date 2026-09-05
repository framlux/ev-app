/**
 * THE COLUMN CATALOGUE: one entry per column on `sample`, vendor-neutral.
 *
 * Three things have to agree about every signal we capture — what the pushed
 * telemetry config asks the car for, what the normaliser decodes, and what the
 * schema stores — and none of the three fails loudly when they disagree: the car
 * silently ignores a config entry it does not recognise, and the normaliser
 * silently ignores a field it cannot place. So the agreement is made checkable
 * by making it data. This file is one half of that: the canonical set of columns
 * and their types. `packages/tesla/src/catalogue.ts` is the other half, mapping
 * Tesla's proto field names onto these columns; the dependency runs tesla ->
 * core, never the reverse, which is why nothing Tesla-shaped appears here.
 *
 * WHAT THIS GENERATES: `VehicleSample` and `NULL_SAMPLE` (see `model.ts`),
 * `@ev/db`'s `insertSample` column list, and the checked-in migration.
 *
 * WHY IT IS SOURCE AND NOT GENERATED. It was drafted mechanically from the
 * vendored `vehicle_data.proto`, but it is checked in as hand-editable truth
 * rather than regenerated at build time. A type here is a judgement, not a fact
 * the proto contains (see below), and judgements belong in a file a person can
 * edit and a reviewer can read in a diff.
 *
 * ORDER. The fifteen columns `sample` has had since `001_initial.sql` come
 * first, in table order; everything after them is in proto field-number order,
 * which is the order the migration adds them in and the order `insertSample`
 * binds them in. `vehicle_id` and `ts` are deliberately absent: they are the
 * primary key, structural rather than catalogued, and an entry for either would
 * generate a duplicate column.
 *
 * NAMING. Existing columns keep their names — `soc_pct`, `speed_kph`,
 * `range_km`, `odometer_km` and the rest are in the REST contract and the UI
 * already. New ones are the proto name in snake_case. Tesla streams miles and
 * mph regardless of what the touchscreen displays, so anything converted at the
 * normaliser carries its real unit in the column name: a `Mph`/`Miles` in a
 * proto name becomes `kph`/`km` here rather than a lie about what is stored.
 * `key` is always the exact camelCase of `column`, and is spelled out per entry
 * rather than derived, because the mapped type in `model.ts` needs it as a
 * literal.
 *
 * TYPES ARE OUR DETERMINATION, NOT THE PROTO'S. The MQTT transport unwraps the
 * protobuf `oneof` before publishing, so a payload arrives as a bare number,
 * string, boolean, `{latitude, longitude}` or null and the proto gives no
 * field -> type mapping at all. Hence:
 *
 *   - Floats are `REAL`, except position and the cumulative counters, which are
 *     `DOUBLE PRECISION`: a `REAL` carries about seven significant digits, and
 *     tens of thousands of kWh with a decimal exhausts that, as does a latitude
 *     that has to resolve to better than a couple of metres.
 *   - Enums are `TEXT`, holding the vendor's own name for the value. The pushed
 *     config sets `prefer_typed`, so the car sends enum names rather than
 *     ordinals, and storing the name verbatim means a firmware release that adds
 *     a member needs no change here.
 *   - ANYTHING WHOSE SHAPE WE HAVE NOT OBSERVED IS `TEXT`, storing what the car
 *     sent. The time-shaped fields are the trap a naming rule gets wrong: the
 *     proto's `Time` is `{hour, minute, second}` with no date and no zone, some
 *     "time" fields are Unix epochs instead, and a `REAL` holding an epoch has a
 *     128-second resolution — silently lossy. Once real payloads are in hand a
 *     follow-up migration plus `reprocess` promotes a column from the tape.
 *     Guessing costs a re-typing and loses the value until then; `TEXT` costs
 *     nothing.
 *
 * AND A WRONG TYPE IS NOT MERELY A NULL. `insertSample` binds every column in
 * one statement inside the ingest transaction, so a value the column rejects
 * rolls the transaction back, is never acked, and is redelivered forever. That
 * is why each type owns a decoder that coerces into the column's domain or
 * returns null, and why the cautious choice above is the cheap one.
 */

/** The SQL types a column may have. Anything else needs a decoder first. */
export type SqlType =
  | 'REAL'
  | 'DOUBLE PRECISION'
  | 'INT'
  | 'BOOLEAN'
  | 'TEXT'
  | 'TIME'
  | 'TIMESTAMPTZ'
  | 'JSONB'

/**
 * The TypeScript side of a column. `PowerState`, `ChargeState` and `TpmsMap` are
 * named rather than widened to `string`/`object` because the engine reasons
 * about them and `model.ts` binds each to its real type.
 */
export type TsType =
  | 'number'
  | 'string'
  | 'boolean'
  | 'Date'
  | 'PowerState'
  | 'ChargeState'
  | 'TpmsMap'

/**
 * Which TypeScript types a decoder may produce for a given SQL type.
 *
 * This is the bindability rule from the wedge above, as data: a decoder whose
 * output is not in this list for its column's SQL type will fail the insert
 * rather than write a null. `TIME` and `TIMESTAMPTZ` have no entries in the
 * catalogue yet on purpose — every time-shaped field is parked at `TEXT` until
 * we have seen what the car actually sends — but they are declared because
 * promoting one of those columns is a planned, not hypothetical, step.
 */
export const TS_TYPES_FOR_SQL: Record<SqlType, readonly TsType[]> = {
  'REAL': ['number'],
  'DOUBLE PRECISION': ['number'],
  'INT': ['number'],
  'BOOLEAN': ['boolean'],
  'TEXT': ['string', 'PowerState', 'ChargeState'],
  'TIME': ['string'],
  'TIMESTAMPTZ': ['Date'],
  'JSONB': ['TpmsMap'],
}

/** One column of `sample`. */
export interface SampleColumn {
  /** snake_case SQL name, unique across the catalogue. */
  readonly column: string
  /** The `VehicleSample` property: the exact camelCase of `column`. */
  readonly key: string
  readonly sql: SqlType
  readonly ts: TsType
}

/**
 * `as const` because `model.ts` maps over the literal `key`/`ts` of every entry
 * to build `VehicleSample`; `satisfies` because that must not cost the shape
 * check.
 */
export const SAMPLE_COLUMNS = [
  { column: 'soc_pct', key: 'socPct', sql: 'REAL', ts: 'number' },
  { column: 'range_km', key: 'rangeKm', sql: 'REAL', ts: 'number' },
  { column: 'odometer_km', key: 'odometerKm', sql: 'DOUBLE PRECISION', ts: 'number' },
  { column: 'lat', key: 'lat', sql: 'DOUBLE PRECISION', ts: 'number' },
  { column: 'lon', key: 'lon', sql: 'DOUBLE PRECISION', ts: 'number' },
  { column: 'speed_kph', key: 'speedKph', sql: 'REAL', ts: 'number' },
  { column: 'power_state', key: 'powerState', sql: 'TEXT', ts: 'PowerState' },
  { column: 'charge_state', key: 'chargeState', sql: 'TEXT', ts: 'ChargeState' },
  { column: 'charge_power_kw', key: 'chargePowerKw', sql: 'REAL', ts: 'number' },
  { column: 'charge_energy_added_kwh',
    key: 'chargeEnergyAddedKwh', sql: 'REAL', ts: 'number' },
  { column: 'inside_temp_c', key: 'insideTempC', sql: 'REAL', ts: 'number' },
  { column: 'outside_temp_c', key: 'outsideTempC', sql: 'REAL', ts: 'number' },
  { column: 'locked', key: 'locked', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'doors_open', key: 'doorsOpen', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'tpms', key: 'tpms', sql: 'JSONB', ts: 'TpmsMap' },

  // ── Everything below is new in `004_full_signal_set.sql`, in proto field
  // order. The four TPMS corner pressures, both charging rails' power and
  // energy, and both charge-state enums are absent because they collapse into
  // the legacy columns above exactly as `normalise.ts` already collapses them.

  // shape unobserved
  { column: 'drive_rail', key: 'driveRail', sql: 'TEXT', ts: 'string' },
  { column: 'bms_fullchargecomplete',
    key: 'bmsFullchargecomplete', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'pack_voltage', key: 'packVoltage', sql: 'REAL', ts: 'number' },
  { column: 'pack_current', key: 'packCurrent', sql: 'REAL', ts: 'number' },
  { column: 'dcdc_enable', key: 'dcdcEnable', sql: 'BOOLEAN', ts: 'boolean' },
  // ShiftState, as the vendor names it
  { column: 'gear', key: 'gear', sql: 'TEXT', ts: 'string' },
  { column: 'isolation_resistance',
    key: 'isolationResistance', sql: 'REAL', ts: 'number' },
  { column: 'pedal_position', key: 'pedalPosition', sql: 'REAL', ts: 'number' },
  // shape unobserved: flag or position
  { column: 'brake_pedal', key: 'brakePedal', sql: 'TEXT', ts: 'string' },
  { column: 'di_state_r', key: 'diStateR', sql: 'TEXT', ts: 'string' },
  { column: 'di_heatsink_tr', key: 'diHeatsinkTr', sql: 'REAL', ts: 'number' },
  { column: 'di_axle_speed_r', key: 'diAxleSpeedR', sql: 'REAL', ts: 'number' },
  { column: 'di_torquemotor', key: 'diTorquemotor', sql: 'REAL', ts: 'number' },
  { column: 'di_stator_temp_r', key: 'diStatorTempR', sql: 'REAL', ts: 'number' },
  { column: 'di_v_bat_r', key: 'diVBatR', sql: 'REAL', ts: 'number' },
  { column: 'di_motor_current_r', key: 'diMotorCurrentR', sql: 'REAL', ts: 'number' },
  { column: 'gps_state', key: 'gpsState', sql: 'TEXT', ts: 'string' },
  { column: 'gps_heading', key: 'gpsHeading', sql: 'REAL', ts: 'number' },
  { column: 'num_brick_voltage_max',
    key: 'numBrickVoltageMax', sql: 'INT', ts: 'number' },
  { column: 'brick_voltage_max', key: 'brickVoltageMax', sql: 'REAL', ts: 'number' },
  { column: 'num_brick_voltage_min',
    key: 'numBrickVoltageMin', sql: 'INT', ts: 'number' },
  { column: 'brick_voltage_min', key: 'brickVoltageMin', sql: 'REAL', ts: 'number' },
  { column: 'num_module_temp_max', key: 'numModuleTempMax', sql: 'INT', ts: 'number' },
  { column: 'module_temp_max', key: 'moduleTempMax', sql: 'REAL', ts: 'number' },
  { column: 'num_module_temp_min', key: 'numModuleTempMin', sql: 'INT', ts: 'number' },
  { column: 'module_temp_min', key: 'moduleTempMin', sql: 'REAL', ts: 'number' },
  { column: 'hvil', key: 'hvil', sql: 'TEXT', ts: 'string' },
  { column: 'charge_limit_soc', key: 'chargeLimitSoc', sql: 'REAL', ts: 'number' },
  { column: 'fast_charger_present',
    key: 'fastChargerPresent', sql: 'BOOLEAN', ts: 'boolean' },
  // miles on the wire
  { column: 'est_battery_range_km', key: 'estBatteryRangeKm', sql: 'REAL', ts: 'number' },
  // miles on the wire
  { column: 'ideal_battery_range_km',
    key: 'idealBatteryRangeKm', sql: 'REAL', ts: 'number' },
  { column: 'battery_level', key: 'batteryLevel', sql: 'REAL', ts: 'number' },
  // a duration, not a time
  { column: 'time_to_full_charge_hours',
    key: 'timeToFullChargeHours', sql: 'REAL', ts: 'number' },
  // shape unobserved: proto Time, epoch or string
  { column: 'scheduled_charging_start_time',
    key: 'scheduledChargingStartTime', sql: 'TEXT', ts: 'string' },
  { column: 'scheduled_charging_pending',
    key: 'scheduledChargingPending', sql: 'BOOLEAN', ts: 'boolean' },
  // shape unobserved: proto Time, epoch or string
  { column: 'scheduled_departure_time',
    key: 'scheduledDepartureTime', sql: 'TEXT', ts: 'string' },
  { column: 'preconditioning_enabled',
    key: 'preconditioningEnabled', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'scheduled_charging_mode',
    key: 'scheduledChargingMode', sql: 'TEXT', ts: 'string' },
  { column: 'charge_amps', key: 'chargeAmps', sql: 'REAL', ts: 'number' },
  { column: 'charge_enable_request',
    key: 'chargeEnableRequest', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'charger_phases', key: 'chargerPhases', sql: 'INT', ts: 'number' },
  { column: 'charge_port_cold_weather_mode',
    key: 'chargePortColdWeatherMode', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'charge_current_request',
    key: 'chargeCurrentRequest', sql: 'REAL', ts: 'number' },
  { column: 'charge_current_request_max',
    key: 'chargeCurrentRequestMax', sql: 'REAL', ts: 'number' },
  { column: 'battery_heater_on', key: 'batteryHeaterOn', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'not_enough_power_to_heat',
    key: 'notEnoughPowerToHeat', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'supercharger_session_trip_planner',
    key: 'superchargerSessionTripPlanner', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'fd_window', key: 'fdWindow', sql: 'TEXT', ts: 'string' },
  { column: 'fp_window', key: 'fpWindow', sql: 'TEXT', ts: 'string' },
  { column: 'rd_window', key: 'rdWindow', sql: 'TEXT', ts: 'string' },
  { column: 'rp_window', key: 'rpWindow', sql: 'TEXT', ts: 'string' },
  { column: 'vehicle_name', key: 'vehicleName', sql: 'TEXT', ts: 'string' },
  { column: 'sentry_mode', key: 'sentryMode', sql: 'TEXT', ts: 'string' },
  { column: 'speed_limit_mode', key: 'speedLimitMode', sql: 'BOOLEAN', ts: 'boolean' },
  // mph on the wire
  { column: 'current_limit_kph', key: 'currentLimitKph', sql: 'REAL', ts: 'number' },
  { column: 'version', key: 'version', sql: 'TEXT', ts: 'string' },
  // shape unobserved
  { column: 'tpms_last_seen_pressure_time_fl',
    key: 'tpmsLastSeenPressureTimeFl', sql: 'TEXT', ts: 'string' },
  // shape unobserved
  { column: 'tpms_last_seen_pressure_time_fr',
    key: 'tpmsLastSeenPressureTimeFr', sql: 'TEXT', ts: 'string' },
  // shape unobserved
  { column: 'tpms_last_seen_pressure_time_rl',
    key: 'tpmsLastSeenPressureTimeRl', sql: 'TEXT', ts: 'string' },
  // shape unobserved
  { column: 'tpms_last_seen_pressure_time_rr',
    key: 'tpmsLastSeenPressureTimeRr', sql: 'TEXT', ts: 'string' },
  { column: 'seat_heater_left', key: 'seatHeaterLeft', sql: 'INT', ts: 'number' },
  { column: 'seat_heater_right', key: 'seatHeaterRight', sql: 'INT', ts: 'number' },
  { column: 'seat_heater_rear_left',
    key: 'seatHeaterRearLeft', sql: 'INT', ts: 'number' },
  { column: 'seat_heater_rear_right',
    key: 'seatHeaterRearRight', sql: 'INT', ts: 'number' },
  { column: 'seat_heater_rear_center',
    key: 'seatHeaterRearCenter', sql: 'INT', ts: 'number' },
  { column: 'auto_seat_climate_left',
    key: 'autoSeatClimateLeft', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'auto_seat_climate_right',
    key: 'autoSeatClimateRight', sql: 'BOOLEAN', ts: 'boolean' },
  // BuckleStatus or bool; TEXT takes either
  { column: 'driver_seat_belt', key: 'driverSeatBelt', sql: 'TEXT', ts: 'string' },
  // BuckleStatus or bool; TEXT takes either
  { column: 'passenger_seat_belt', key: 'passengerSeatBelt', sql: 'TEXT', ts: 'string' },
  { column: 'driver_seat_occupied',
    key: 'driverSeatOccupied', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'lateral_acceleration',
    key: 'lateralAcceleration', sql: 'REAL', ts: 'number' },
  { column: 'longitudinal_acceleration',
    key: 'longitudinalAcceleration', sql: 'REAL', ts: 'number' },
  // mph on the wire
  { column: 'cruise_set_speed_kph', key: 'cruiseSetSpeedKph', sql: 'REAL', ts: 'number' },
  // cumulative
  { column: 'lifetime_energy_used',
    key: 'lifetimeEnergyUsed', sql: 'DOUBLE PRECISION', ts: 'number' },
  // cumulative. Proto-marked Semi-only, but named as a counter to capture, so
  // it is catalogued on the same reasoning as `semi_cruise_speed_limit_kph`.
  { column: 'lifetime_energy_used_drive',
    key: 'lifetimeEnergyUsedDrive', sql: 'DOUBLE PRECISION', ts: 'number' },
  { column: 'brake_pedal_pos', key: 'brakePedalPos', sql: 'REAL', ts: 'number' },
  // shape unobserved; a REAL epoch is 128s-lossy
  { column: 'route_last_updated', key: 'routeLastUpdated', sql: 'TEXT', ts: 'string' },
  { column: 'route_line', key: 'routeLine', sql: 'TEXT', ts: 'string' },
  // miles on the wire
  { column: 'km_to_arrival', key: 'kmToArrival', sql: 'REAL', ts: 'number' },
  // a duration
  { column: 'minutes_to_arrival', key: 'minutesToArrival', sql: 'REAL', ts: 'number' },
  { column: 'origin_location_lat',
    key: 'originLocationLat', sql: 'DOUBLE PRECISION', ts: 'number' },
  { column: 'origin_location_lon',
    key: 'originLocationLon', sql: 'DOUBLE PRECISION', ts: 'number' },
  { column: 'destination_location_lat',
    key: 'destinationLocationLat', sql: 'DOUBLE PRECISION', ts: 'number' },
  { column: 'destination_location_lon',
    key: 'destinationLocationLon', sql: 'DOUBLE PRECISION', ts: 'number' },
  { column: 'car_type', key: 'carType', sql: 'TEXT', ts: 'string' },
  { column: 'trim', key: 'trim', sql: 'TEXT', ts: 'string' },
  { column: 'exterior_color', key: 'exteriorColor', sql: 'TEXT', ts: 'string' },
  { column: 'roof_color', key: 'roofColor', sql: 'TEXT', ts: 'string' },
  { column: 'charge_port', key: 'chargePort', sql: 'TEXT', ts: 'string' },
  { column: 'charge_port_latch', key: 'chargePortLatch', sql: 'TEXT', ts: 'string' },
  { column: 'guest_mode_enabled',
    key: 'guestModeEnabled', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'pin_to_drive_enabled',
    key: 'pinToDriveEnabled', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'paired_phone_key_and_key_fob_qty',
    key: 'pairedPhoneKeyAndKeyFobQty', sql: 'INT', ts: 'number' },
  // FollowDistance, an enum despite the number
  { column: 'cruise_follow_distance',
    key: 'cruiseFollowDistance', sql: 'TEXT', ts: 'string' },
  { column: 'automatic_blind_spot_camera',
    key: 'automaticBlindSpotCamera', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'blind_spot_collision_warning_chime',
    key: 'blindSpotCollisionWarningChime', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'speed_limit_warning', key: 'speedLimitWarning', sql: 'TEXT', ts: 'string' },
  { column: 'forward_collision_warning',
    key: 'forwardCollisionWarning', sql: 'TEXT', ts: 'string' },
  { column: 'lane_departure_avoidance',
    key: 'laneDepartureAvoidance', sql: 'TEXT', ts: 'string' },
  { column: 'emergency_lane_departure_avoidance',
    key: 'emergencyLaneDepartureAvoidance', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'automatic_emergency_braking_off',
    key: 'automaticEmergencyBrakingOff', sql: 'BOOLEAN', ts: 'boolean' },
  // cumulative
  { column: 'lifetime_energy_gained_regen',
    key: 'lifetimeEnergyGainedRegen', sql: 'DOUBLE PRECISION', ts: 'number' },
  { column: 'di_state_f', key: 'diStateF', sql: 'TEXT', ts: 'string' },
  { column: 'di_heatsink_tf', key: 'diHeatsinkTf', sql: 'REAL', ts: 'number' },
  { column: 'di_axle_speed_f', key: 'diAxleSpeedF', sql: 'REAL', ts: 'number' },
  { column: 'di_slave_torque_cmd', key: 'diSlaveTorqueCmd', sql: 'REAL', ts: 'number' },
  { column: 'di_torque_actual_r', key: 'diTorqueActualR', sql: 'REAL', ts: 'number' },
  { column: 'di_torque_actual_f', key: 'diTorqueActualF', sql: 'REAL', ts: 'number' },
  { column: 'di_stator_temp_f', key: 'diStatorTempF', sql: 'REAL', ts: 'number' },
  { column: 'di_v_bat_f', key: 'diVBatF', sql: 'REAL', ts: 'number' },
  { column: 'di_motor_current_f', key: 'diMotorCurrentF', sql: 'REAL', ts: 'number' },
  { column: 'energy_remaining', key: 'energyRemaining', sql: 'REAL', ts: 'number' },
  { column: 'service_mode', key: 'serviceMode', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'bms_state', key: 'bmsState', sql: 'TEXT', ts: 'string' },
  { column: 'guest_mode_mobile_access_state',
    key: 'guestModeMobileAccessState', sql: 'TEXT', ts: 'string' },
  { column: 'destination_name', key: 'destinationName', sql: 'TEXT', ts: 'string' },
  { column: 'di_inverter_tr', key: 'diInverterTr', sql: 'REAL', ts: 'number' },
  { column: 'di_inverter_tf', key: 'diInverterTf', sql: 'REAL', ts: 'number' },
  { column: 'cabin_overheat_protection_mode',
    key: 'cabinOverheatProtectionMode', sql: 'TEXT', ts: 'string' },
  // High/Medium/Low, not a temperature
  { column: 'cabin_overheat_protection_temperature_limit',
    key: 'cabinOverheatProtectionTemperatureLimit', sql: 'TEXT', ts: 'string' },
  { column: 'center_display', key: 'centerDisplay', sql: 'TEXT', ts: 'string' },
  { column: 'charge_port_door_open',
    key: 'chargePortDoorOpen', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'charger_voltage', key: 'chargerVoltage', sql: 'REAL', ts: 'number' },
  { column: 'charging_cable_type', key: 'chargingCableType', sql: 'TEXT', ts: 'string' },
  { column: 'climate_keeper_mode', key: 'climateKeeperMode', sql: 'TEXT', ts: 'string' },
  { column: 'defrost_for_preconditioning',
    key: 'defrostForPreconditioning', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'defrost_mode', key: 'defrostMode', sql: 'TEXT', ts: 'string' },
  { column: 'efficiency_package', key: 'efficiencyPackage', sql: 'TEXT', ts: 'string' },
  // a duration
  { column: 'estimated_hours_to_charge_termination',
    key: 'estimatedHoursToChargeTermination', sql: 'REAL', ts: 'number' },
  { column: 'europe_vehicle', key: 'europeVehicle', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'expected_energy_percent_at_trip_arrival',
    key: 'expectedEnergyPercentAtTripArrival', sql: 'REAL', ts: 'number' },
  { column: 'fast_charger_type', key: 'fastChargerType', sql: 'TEXT', ts: 'string' },
  { column: 'homelink_device_count',
    key: 'homelinkDeviceCount', sql: 'INT', ts: 'number' },
  { column: 'homelink_nearby', key: 'homelinkNearby', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'hvac_ac_enabled', key: 'hvacAcEnabled', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'hvac_auto_mode', key: 'hvacAutoMode', sql: 'TEXT', ts: 'string' },
  { column: 'hvac_fan_speed', key: 'hvacFanSpeed', sql: 'INT', ts: 'number' },
  // shape unobserved: level or state name
  { column: 'hvac_fan_status', key: 'hvacFanStatus', sql: 'TEXT', ts: 'string' },
  { column: 'hvac_left_temperature_request',
    key: 'hvacLeftTemperatureRequest', sql: 'REAL', ts: 'number' },
  // HvacPowerState, not a wattage
  { column: 'hvac_power', key: 'hvacPower', sql: 'TEXT', ts: 'string' },
  { column: 'hvac_right_temperature_request',
    key: 'hvacRightTemperatureRequest', sql: 'REAL', ts: 'number' },
  { column: 'hvac_steering_wheel_heat_auto',
    key: 'hvacSteeringWheelHeatAuto', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'hvac_steering_wheel_heat_level',
    key: 'hvacSteeringWheelHeatLevel', sql: 'INT', ts: 'number' },
  { column: 'rear_display_hvac_enabled',
    key: 'rearDisplayHvacEnabled', sql: 'BOOLEAN', ts: 'boolean' },
  // shape unobserved: level or flag
  { column: 'rear_seat_heaters', key: 'rearSeatHeaters', sql: 'TEXT', ts: 'string' },
  { column: 'remote_start_enabled',
    key: 'remoteStartEnabled', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'right_hand_drive', key: 'rightHandDrive', sql: 'BOOLEAN', ts: 'boolean' },
  // a duration
  { column: 'route_traffic_minutes_delay',
    key: 'routeTrafficMinutesDelay', sql: 'REAL', ts: 'number' },
  { column: 'software_update_download_percent_complete',
    key: 'softwareUpdateDownloadPercentComplete', sql: 'REAL', ts: 'number' },
  // a duration
  { column: 'software_update_expected_duration_minutes',
    key: 'softwareUpdateExpectedDurationMinutes', sql: 'REAL', ts: 'number' },
  { column: 'software_update_installation_percent_complete',
    key: 'softwareUpdateInstallationPercentComplete', sql: 'REAL', ts: 'number' },
  // shape unobserved; a REAL epoch is 128s-lossy
  { column: 'software_update_scheduled_start_time',
    key: 'softwareUpdateScheduledStartTime', sql: 'TEXT', ts: 'string' },
  { column: 'software_update_version',
    key: 'softwareUpdateVersion', sql: 'TEXT', ts: 'string' },
  // shape unobserved: count or TireLocation
  { column: 'tpms_hard_warnings', key: 'tpmsHardWarnings', sql: 'TEXT', ts: 'string' },
  // shape unobserved: count or TireLocation
  { column: 'tpms_soft_warnings', key: 'tpmsSoftWarnings', sql: 'TEXT', ts: 'string' },
  { column: 'valet_mode_enabled',
    key: 'valetModeEnabled', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'wheel_type', key: 'wheelType', sql: 'TEXT', ts: 'string' },
  { column: 'wiper_heat_enabled',
    key: 'wiperHeatEnabled', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'located_at_home', key: 'locatedAtHome', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'located_at_work', key: 'locatedAtWork', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'located_at_favorite',
    key: 'locatedAtFavorite', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'setting_distance_unit',
    key: 'settingDistanceUnit', sql: 'TEXT', ts: 'string' },
  { column: 'setting_temperature_unit',
    key: 'settingTemperatureUnit', sql: 'TEXT', ts: 'string' },
  { column: 'setting_24_hour_time',
    key: 'setting24HourTime', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'setting_tire_pressure_unit',
    key: 'settingTirePressureUnit', sql: 'TEXT', ts: 'string' },
  { column: 'setting_charge_unit', key: 'settingChargeUnit', sql: 'TEXT', ts: 'string' },
  { column: 'climate_seat_cooling_front_left',
    key: 'climateSeatCoolingFrontLeft', sql: 'INT', ts: 'number' },
  { column: 'climate_seat_cooling_front_right',
    key: 'climateSeatCoolingFrontRight', sql: 'INT', ts: 'number' },
  { column: 'lights_hazards_active',
    key: 'lightsHazardsActive', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'lights_turn_signal', key: 'lightsTurnSignal', sql: 'TEXT', ts: 'string' },
  { column: 'lights_high_beams', key: 'lightsHighBeams', sql: 'BOOLEAN', ts: 'boolean' },
  // names a generation, not a yes/no
  { column: 'sunroof_installed', key: 'sunroofInstalled', sql: 'TEXT', ts: 'string' },
  { column: 'seat_vent_enabled', key: 'seatVentEnabled', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'rear_defrost_enabled',
    key: 'rearDefrostEnabled', sql: 'BOOLEAN', ts: 'boolean' },
  // range miles/hour on the wire
  { column: 'charge_rate_km_per_hour',
    key: 'chargeRateKmPerHour', sql: 'REAL', ts: 'number' },
  // cumulative; miles on the wire
  { column: 'km_since_reset',
    key: 'kmSinceReset', sql: 'DOUBLE PRECISION', ts: 'number' },
  // cumulative; miles on the wire
  { column: 'self_driving_km_since_reset',
    key: 'selfDrivingKmSinceReset', sql: 'DOUBLE PRECISION', ts: 'number' },
  { column: 'gps_accuracy_meters', key: 'gpsAccuracyMeters', sql: 'REAL', ts: 'number' },
  // cumulative
  { column: 'lifetime_energy_charged_kwh',
    key: 'lifetimeEnergyChargedKwh', sql: 'DOUBLE PRECISION', ts: 'number' },
  { column: 'brick_soc_min_percent',
    key: 'brickSocMinPercent', sql: 'REAL', ts: 'number' },
  // the pack measurement §3.7 replaces the estimate with
  { column: 'nominal_full_pack_energy_kwh',
    key: 'nominalFullPackEnergyKwh', sql: 'REAL', ts: 'number' },
  { column: 'grade_estimate_percent',
    key: 'gradeEstimatePercent', sql: 'REAL', ts: 'number' },
  // mph on the wire
  { column: 'max_speed_to_reach_destination_kph',
    key: 'maxSpeedToReachDestinationKph', sql: 'REAL', ts: 'number' },
  { column: 'software_update_available',
    key: 'softwareUpdateAvailable', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'software_update_in_progress',
    key: 'softwareUpdateInProgress', sql: 'BOOLEAN', ts: 'boolean' },
  { column: 'remote_start_active',
    key: 'remoteStartActive', sql: 'BOOLEAN', ts: 'boolean' },
  // mph on the wire. The proto marks this Semi-only, but the exclusion is by
  // name (`Semitruck*`) and this is not one, so it is catalogued rather than
  // quietly dropped — a column a Model Y never fills costs a slot and nothing
  // else, while a silent omission is exactly what §3.2's test exists to prevent.
  { column: 'semi_cruise_speed_limit_kph',
    key: 'semiCruiseSpeedLimitKph', sql: 'REAL', ts: 'number' },
] as const satisfies readonly SampleColumn[]


/**
 * The catalogue's numeric columns, as a union of their TS keys.
 *
 * Exists for the read API's sample series: a series point is `number | null`
 * per field, and a caller that writes `point.outsideTempC` should get a number
 * back rather than the widest thing an index signature could hold. Derived from
 * the catalogue, so a numeric column added tomorrow is chartable with no edit
 * here — and a column that stops being numeric stops being offered.
 */
export type NumericSampleKey = Extract<
  (typeof SAMPLE_COLUMNS)[number],
  { readonly ts: 'number' }
>['key']
