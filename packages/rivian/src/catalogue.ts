/**
 * THE PROPERTY CATALOGUE: which `vehicleState` properties we subscribe to, how
 * each one is selected, and the GraphQL document behind every subscription the
 * connector opens.
 *
 * It is the Rivian counterpart to `packages/tesla/src/catalogue.ts`, and much
 * smaller, because Rivian has no equivalent of Tesla's pushed field config: the
 * client names the properties it wants in the query itself, and the server
 * answers with exactly those. So this file says WHAT TO ASK FOR and HOW; what a
 * value means, and which column it fills, is `normalise.ts`'s business.
 *
 * THE LIST IS R1-DERIVED, AND IT IS A FLOOR. The names below are properties the
 * R1T and R1S are known to carry (the design's §2.3 counts about 140 for the R1).
 * The R2 is a different platform: it may lack some of these and carry others
 * this list has never heard of. Because `vehicleState` returns only the fields
 * the query names, a property missing from the list would be missing from the
 * tape for good, with no error to say so. So the connector widens this list at
 * runtime (design §5.6): it introspects the `VehicleState` type every 24 h and
 * adds any field typed `TimeStamped*` that is not listed here, selected with the
 * plain `{ timeStamp value }` shape. Anything else it finds is only recorded.
 *
 * WHY PROPERTIES ARE SUBSCRIBED IN GROUPS. Rivian rejects a selection that
 * contains an unknown field with `GRAPHQL_VALIDATION_FAILED`, and the error does
 * not name the field (design §2.3, §5.4). One property Rivian has renamed or
 * withdrawn would therefore silence the whole subscription, and with 140
 * properties in one query there would be nothing to say which. Groups of at
 * most `MAX_GROUP_SIZE` bound the damage to the 15 neighbours of the bad name,
 * and let the connector find it by halving the rejected group: sixteen
 * properties settle in at most eight probes.
 *
 * WRITTEN FROM FIELD NAMES, NOT COPIED. The property names are facts about
 * Rivian's API, as are the argument names and selection sets below. Nothing
 * here was taken from the unlicensed `rivian-python-client`: its code, its
 * `.proto` files and its schema files are not to be copied (design §2.4), and
 * the documents were composed from the shapes the design records.
 */

/**
 * How a property is selected.
 *
 * Most properties are `TimeStamped*` scalars: `{ timeStamp value }`. Three are
 * not, and selecting one with the wrong template is a validation error that
 * silences its whole group, which is why the shape is data on the property
 * rather than something the connector infers.
 */
export type PropertyShape = 'value' | 'location' | 'cloudConnection' | 'locationError'

/** One `vehicleState` property, and the selection it is asked for with. */
export interface RivianProperty {
  /** The API's field name, exactly as it is spelled in the query. */
  readonly name: string
  readonly shape: PropertyShape
}

/**
 * Every property name, in the order the design lists them. The order is not
 * decorative: `groupProperties` cuts this list into runs of sixteen, so the
 * order decides which properties share a group, and a reordering would change
 * which neighbours a rejected name takes down with it.
 */
const PROPERTY_NAMES: readonly string[] = [
  'cloudConnection', 'geoLocation', 'gnssLocation', 'gnssError', 'alarmSoundStatus',
  'batteryCapacity', 'batteryCellType', 'batteryHvThermalEvent', 'batteryHvThermalEventPropagation',
  'batteryLevel', 'batteryLimit', 'batteryNeedsLfpCalibration', 'brakeFluidLow',
  'btmFfHardwareFailureStatus', 'btmIcHardwareFailureStatus', 'btmLfdHardwareFailureStatus',
  'btmOcHardwareFailureStatus', 'btmRfdHardwareFailureStatus', 'btmRfHardwareFailureStatus',
  'cabinClimateDriverTemperature', 'cabinClimateInteriorTemperature', 'cabinPreconditioningStatus',
  'cabinPreconditioningType', 'carWashMode', 'chargerDerateStatus', 'chargerState', 'chargerStatus',
  'chargePortState', 'chargingDisabledAll', 'closureFrunkClosed', 'closureFrunkLocked',
  'closureFrunkNextAction', 'closureLiftgateClosed', 'closureLiftgateLocked',
  'closureLiftgateNextAction', 'closureSideBinLeftClosed', 'closureSideBinLeftLocked',
  'closureSideBinLeftNextAction', 'closureSideBinRightClosed', 'closureSideBinRightLocked',
  'closureSideBinRightNextAction', 'closureTailgateClosed', 'closureTailgateLocked',
  'closureTailgateNextAction', 'closureTonneauClosed', 'closureTonneauLocked',
  'closureTonneauNextAction', 'defrostDefogStatus', 'distanceToEmpty', 'doorFrontLeftClosed',
  'doorFrontLeftLocked', 'doorFrontRightClosed', 'doorFrontRightLocked', 'doorRearLeftClosed',
  'doorRearLeftLocked', 'doorRearRightClosed', 'doorRearRightLocked', 'driveMode',
  'gearGuardLocked', 'gearGuardVideoMode', 'gearGuardVideoStatus', 'gearGuardVideoTermsAccepted',
  'gearStatus', 'gnssAltitude', 'gnssBearing', 'gnssSpeed', 'limitedRegenCold', 'limitedAccelCold',
  'otaAvailableVersion', 'otaAvailableVersionGitHash', 'otaAvailableVersionNumber',
  'otaAvailableVersionWeek', 'otaAvailableVersionYear', 'otaCurrentStatus', 'otaCurrentVersion',
  'otaCurrentVersionGitHash', 'otaCurrentVersionNumber', 'otaCurrentVersionWeek',
  'otaCurrentVersionYear', 'otaDownloadProgress', 'otaInstallDuration', 'otaInstallProgress',
  'otaInstallReady', 'otaInstallTime', 'otaInstallType', 'otaStatus', 'petModeStatus',
  'petModeTemperatureStatus', 'powerState', 'rangeThreshold', 'rearHitchStatus',
  'remoteChargingAvailable', 'seatFrontLeftHeat', 'seatFrontLeftVent', 'seatFrontRightHeat',
  'seatFrontRightVent', 'seatRearLeftHeat', 'seatRearRightHeat', 'seatThirdRowLeftHeat',
  'seatThirdRowRightHeat', 'serviceMode', 'steeringWheelHeat', 'timeToEndOfCharge',
  'tirePressureStatusFrontLeft', 'tirePressureStatusFrontRight', 'tirePressureStatusRearLeft',
  'tirePressureStatusRearRight', 'tirePressureStatusValidFrontLeft',
  'tirePressureStatusValidFrontRight', 'tirePressureStatusValidRearLeft',
  'tirePressureStatusValidRearRight', 'trailerStatus', 'twelveVoltBatteryHealth', 'vehicleMileage',
  'windowFrontLeftCalibrated', 'windowFrontLeftClosed', 'windowFrontRightCalibrated',
  'windowFrontRightClosed', 'windowRearLeftCalibrated', 'windowRearLeftClosed',
  'windowRearRightCalibrated', 'windowRearRightClosed', 'windowsNextAction', 'wiperFluidState',
  'activeDriverName', 'chargingDisabledACFaultState', 'chargingTimeEstimationValidity',
  'chargingTripTargetSoc', 'chargingTripTargetMinsRemaining', 'closureChargePortDoorNextAction',
  'coldRangeNotification', 'tirePressureFrontLeft', 'tirePressureFrontRight',
  'tirePressureRearLeft', 'tirePressureRearRight',
]

/**
 * The three properties that are not `{ timeStamp value }`. Every other name
 * above is a plain value, so this is the only place a shape is ever assigned.
 */
const STRUCTURED_SHAPES: ReadonlyMap<string, PropertyShape> = new Map<string, PropertyShape>([
  ['cloudConnection', 'cloudConnection'],
  ['gnssLocation', 'location'],
  ['gnssError', 'locationError'],
])

export const RIVIAN_PROPERTIES: readonly RivianProperty[] = PROPERTY_NAMES.map((name) => ({
  name,
  shape: STRUCTURED_SHAPES.get(name) ?? 'value',
}))

/**
 * The selection set each shape is asked for with.
 *
 * These are spelled out, not assembled from field lists, so that the text the
 * server validates is the text a reader sees. A stray token here silences every
 * property that shares the group.
 */
export const SHAPE_SELECTIONS: Readonly<Record<PropertyShape, string>> = {
  value: '{ timeStamp value }',
  location: '{ latitude longitude timeStamp isAuthorized }',
  cloudConnection: '{ lastSync isOnline }',
  locationError: '{ timeStamp positionVertical positionHorizontal speed bearing }',
}

/**
 * The most properties one `vehicleState` subscription may name (global
 * constraint; design §5.4). It bounds how many healthy properties a single
 * rejected one can take down while the connector looks for it.
 */
export const MAX_GROUP_SIZE = 16

const SHAPE_BY_NAME: ReadonlyMap<string, PropertyShape> = new Map(
  RIVIAN_PROPERTIES.map((p) => [p.name, p.shape]),
)

/**
 * The shape a property is selected with: its catalogue shape, and `'value'` for
 * a name the catalogue has never seen.
 *
 * The fallback is right for the only way an unknown name gets here, which is
 * discovery: it adds a field only when its type is `TimeStamped*`, and every
 * such type is `{ timeStamp value }`. A Map, not an object, so a name like
 * `constructor` is an unknown name and not a function.
 */
export function shapeOf(name: string): PropertyShape {
  return SHAPE_BY_NAME.get(name) ?? 'value'
}

/**
 * Cut a property list into subscription-sized groups, in order.
 *
 * `size` exists for the bisection, which halves a rejected group, so it may be
 * anything from 1 to `MAX_GROUP_SIZE`. It may not exceed it: a larger group
 * would be a way to quietly break the constraint this file exists to keep. A
 * size of 0 or a fraction would never advance the cut, so those throw too,
 * rather than hang the connector in a loop that builds empty groups.
 */
export function groupProperties(
  names: readonly string[],
  size: number = MAX_GROUP_SIZE,
): string[][] {
  if (!Number.isInteger(size) || size < 1 || size > MAX_GROUP_SIZE) {
    throw new RangeError(`group size must be an integer from 1 to ${MAX_GROUP_SIZE}`)
  }
  const groups: string[][] = []
  for (let i = 0; i < names.length; i += size) groups.push(names.slice(i, i + size))
  return groups
}

/**
 * One subscription, as the `subscribe` message's payload carries it
 * (design §2.3).
 *
 * The vehicle id is always a VARIABLE, never spliced into the query text: the
 * query is then a constant per operation, and an id is only ever data.
 */
export interface SubscriptionDocument {
  operationName: string
  query: string
  variables: Record<string, unknown>
}

/**
 * `vehicleState`, for one group of properties.
 *
 * This is the one subscription whose argument is spelled `$vehicleID` (capital
 * ID) and named `id`; the others below spell theirs `$vehicleId`, or `$id`, as
 * the API does. They are not interchangeable, and a wrong spelling is a
 * validation error with no field to blame.
 */
export function vehicleStateDocument(
  vehicleId: string,
  names: readonly string[],
): SubscriptionDocument {
  const selection = names.map((name) => `${name} ${SHAPE_SELECTIONS[shapeOf(name)]}`).join(' ')
  return {
    operationName: 'VehicleState',
    query: `subscription VehicleState($vehicleID: String!) { vehicleState(id: $vehicleID) { ${selection} } }`,
    variables: { vehicleID: vehicleId },
  }
}

/**
 * `parallaxMessages`: the vehicle's raw protobuf topics (`rvm`), base64 in
 * `payload`. A null `rvms` means every topic, which is what we ask for until
 * the tape shows which are worth keeping (design §2.3).
 *
 * `$rvms` is declared as an optional list, not a required one, because null is
 * the value that means "all": declaring it `[String!]!` would make the
 * all-topics subscription a validation error.
 */
export function parallaxDocument(
  vehicleId: string,
  rvms: readonly string[] | null,
): SubscriptionDocument {
  return {
    operationName: 'ParallaxMessages',
    query:
      'subscription ParallaxMessages($vehicleId: String!, $rvms: [String!]) { parallaxMessages(vehicleId: $vehicleId, rvms: $rvms) { payload timestamp rvm } }',
    variables: { vehicleId, rvms: rvms === null ? null : [...rvms] },
  }
}

/**
 * `chargingSession`: live power and energy for a session in progress, and the
 * curve so far. `vehicleState` carries neither (design §2.4), and the HTTP query
 * that used to answer was removed on 2026-10-11, so this subscription is the
 * only live source of charge energy, if it still validates.
 *
 * Every field in the design's §2.3 is selected, on purpose: this is a capture
 * of an unfamiliar subscription, and a field we leave out is one the tape can
 * never show us. If Rivian rejects the selection, the subscription is marked
 * unavailable and charge energy is unknown (design §7.4), never zero.
 */
export function chargingSessionDocument(vehicleId: string): SubscriptionDocument {
  return {
    operationName: 'ChargingSession',
    query:
      'subscription ChargingSession($vehicleId: String!) { chargingSession(vehicleId: $vehicleId) { liveData { powerKW kilometersChargedPerHour rangeAddedThisSession totalChargedEnergy timeElapsed timeRemaining price currency isFreeSession vehicleChargerState startTime } chartData { soc powerKW startTime endTime timeEstimationValidityStatus vehicleChargerState } } }',
    variables: { vehicleId },
  }
}

/**
 * `vehicleCloudConnection`: whether the car is reachable, and when it last
 * synced. It takes `$id`, not `$vehicleId`.
 */
export function cloudConnectionDocument(vehicleId: string): SubscriptionDocument {
  return {
    operationName: 'VehicleCloudConnection',
    query:
      'subscription VehicleCloudConnection($id: String!) { vehicleCloudConnection(id: $id) { lastSync isOnline } }',
    variables: { id: vehicleId },
  }
}

/**
 * The subscriptions that answer in the Parallax shape, `{ payload timestamp
 * rvm }`: a payload we tape and do not decode.
 *
 * Their selection is the design's (§2.3, "Parallax-shaped messages"), taken on
 * trust: these are the subscriptions whose liveness is unverified, and the
 * connector treats a rejected one as unavailable and retries it daily rather
 * than bisecting, since there are no properties to bisect.
 */
function parallaxShapedDocument(
  operationName: string,
  field: string,
  vehicleId: string,
): SubscriptionDocument {
  return {
    operationName,
    query: `subscription ${operationName}($vehicleId: String!) { ${field}(vehicleId: $vehicleId) { payload timestamp rvm } }`,
    variables: { vehicleId },
  }
}

/** `otaInstallState`: where an over-the-air update is in its install. */
export function otaInstallStateDocument(vehicleId: string): SubscriptionDocument {
  return parallaxShapedDocument('OtaInstallState', 'otaInstallState', vehicleId)
}

/** `otaInstallSchedules`: when an update is set to install. */
export function otaInstallSchedulesDocument(vehicleId: string): SubscriptionDocument {
  return parallaxShapedDocument('OtaInstallSchedules', 'otaInstallSchedules', vehicleId)
}

/** `vehicleGeofences`: the geofences set on the vehicle. */
export function geofencesDocument(vehicleId: string): SubscriptionDocument {
  return parallaxShapedDocument('VehicleGeofences', 'vehicleGeofences', vehicleId)
}

/**
 * `vehicleDepartureSchedules`: the user's scheduled departures, each with the
 * cabin and charge settings that go with it.
 *
 * `occurrence` is a union, so it is selected through the one member we know,
 * `RepeatsWeekly`, plus `__typename`: a schedule of any other kind then arrives
 * as its type name and nothing else, which is visible on the tape, instead of
 * as a selection the server refuses.
 */
export function departureSchedulesDocument(vehicleId: string): SubscriptionDocument {
  return {
    operationName: 'VehicleDepartureSchedules',
    query:
      'subscription VehicleDepartureSchedules($vehicleId: String!) { vehicleDepartureSchedules(vehicleId: $vehicleId) { id name isEnabled occurrence { __typename ... on RepeatsWeekly { days startsAtMin skippedOn } } departureSettings { shouldOverrideChargeSchedule comfortSettings { cabinTempCelsius frontDefogDefrost surfaceHeatVentLevels { frontLeftSeat frontRightSeat rearLeftSeat rearRightSeat steeringWheel } } } } }',
    variables: { vehicleId },
  }
}
