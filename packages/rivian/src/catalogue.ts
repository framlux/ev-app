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
 * plain `timeStamp value` shape. Anything else it finds is only recorded.
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
 * WHERE THE DOCUMENTS COME FROM. The facts in them (property, field and
 * argument names, and which type each field sits on) are facts about Rivian's
 * API. They are taken from the 2025-04 snapshot of the gateway schema that the
 * design cites (§2), and from the design itself (§2.3) for the one subscription,
 * `parallaxMessages`, that the snapshot does not contain. The snapshot is old,
 * which is why the connector bisects and discovers instead of trusting it. The
 * EXPRESSION is ours: one spelling for the variable (`$vehicleId`) in every
 * document, one field per line, and fields selected in the order the snapshot
 * declares them on their type. No code, `.proto` or schema file was copied from
 * the unlicensed `rivian-python-client` (design §2.4); names are facts, and a
 * document is only as copied as its wording is.
 */

/**
 * How a property is selected.
 *
 * Most properties are `TimeStamped*` scalars: `timeStamp value`. Three are not,
 * and selecting one with the wrong shape is a validation error that silences
 * its whole group, which is why the shape is data on the property rather than
 * something the connector infers.
 */
export type PropertyShape = 'value' | 'location' | 'cloudConnection' | 'locationError'

/** One `vehicleState` property, and the selection it is asked for with. */
export interface RivianProperty {
  /** The API's field name, exactly as it is spelled in the query. */
  readonly name: string
  readonly shape: PropertyShape
}

/**
 * Every property name, in ALPHABETICAL order (a plain sort by UTF-16 code unit,
 * so `ACFault` sorts before `All`). The order is checked by a test, and it
 * matters: `groupProperties` cuts this list into runs of sixteen, so the order
 * decides which properties share a group, and therefore which neighbours a
 * rejected name takes down with it. An order that depends on nothing but the
 * names means a new name has exactly one place to go, and that groups are
 * reproducible from the names alone.
 */
const PROPERTY_NAMES: readonly string[] = [
  'activeDriverName', 'alarmSoundStatus', 'batteryCapacity', 'batteryCellType',
  'batteryHvThermalEvent', 'batteryHvThermalEventPropagation', 'batteryLevel', 'batteryLimit',
  'batteryNeedsLfpCalibration', 'brakeFluidLow', 'btmFfHardwareFailureStatus',
  'btmIcHardwareFailureStatus', 'btmLfdHardwareFailureStatus', 'btmOcHardwareFailureStatus',
  'btmRfHardwareFailureStatus', 'btmRfdHardwareFailureStatus', 'cabinClimateDriverTemperature',
  'cabinClimateInteriorTemperature', 'cabinPreconditioningStatus', 'cabinPreconditioningType',
  'carWashMode', 'chargePortState', 'chargerDerateStatus', 'chargerState', 'chargerStatus',
  'chargingDisabledACFaultState', 'chargingDisabledAll', 'chargingTimeEstimationValidity',
  'chargingTripTargetMinsRemaining', 'chargingTripTargetSoc', 'closureChargePortDoorNextAction',
  'closureFrunkClosed', 'closureFrunkLocked', 'closureFrunkNextAction', 'closureLiftgateClosed',
  'closureLiftgateLocked', 'closureLiftgateNextAction', 'closureSideBinLeftClosed',
  'closureSideBinLeftLocked', 'closureSideBinLeftNextAction', 'closureSideBinRightClosed',
  'closureSideBinRightLocked', 'closureSideBinRightNextAction', 'closureTailgateClosed',
  'closureTailgateLocked', 'closureTailgateNextAction', 'closureTonneauClosed',
  'closureTonneauLocked', 'closureTonneauNextAction', 'cloudConnection', 'coldRangeNotification',
  'defrostDefogStatus', 'distanceToEmpty', 'doorFrontLeftClosed', 'doorFrontLeftLocked',
  'doorFrontRightClosed', 'doorFrontRightLocked', 'doorRearLeftClosed', 'doorRearLeftLocked',
  'doorRearRightClosed', 'doorRearRightLocked', 'driveMode', 'gearGuardLocked',
  'gearGuardVideoMode', 'gearGuardVideoStatus', 'gearGuardVideoTermsAccepted', 'gearStatus',
  'geoLocation', 'gnssAltitude', 'gnssBearing', 'gnssError', 'gnssLocation', 'gnssSpeed',
  'limitedAccelCold', 'limitedRegenCold', 'otaAvailableVersion', 'otaAvailableVersionGitHash',
  'otaAvailableVersionNumber', 'otaAvailableVersionWeek', 'otaAvailableVersionYear',
  'otaCurrentStatus', 'otaCurrentVersion', 'otaCurrentVersionGitHash', 'otaCurrentVersionNumber',
  'otaCurrentVersionWeek', 'otaCurrentVersionYear', 'otaDownloadProgress', 'otaInstallDuration',
  'otaInstallProgress', 'otaInstallReady', 'otaInstallTime', 'otaInstallType', 'otaStatus',
  'petModeStatus', 'petModeTemperatureStatus', 'powerState', 'rangeThreshold', 'rearHitchStatus',
  'remoteChargingAvailable', 'seatFrontLeftHeat', 'seatFrontLeftVent', 'seatFrontRightHeat',
  'seatFrontRightVent', 'seatRearLeftHeat', 'seatRearRightHeat', 'seatThirdRowLeftHeat',
  'seatThirdRowRightHeat', 'serviceMode', 'steeringWheelHeat', 'timeToEndOfCharge',
  'tirePressureFrontLeft', 'tirePressureFrontRight', 'tirePressureRearLeft',
  'tirePressureRearRight', 'tirePressureStatusFrontLeft', 'tirePressureStatusFrontRight',
  'tirePressureStatusRearLeft', 'tirePressureStatusRearRight', 'tirePressureStatusValidFrontLeft',
  'tirePressureStatusValidFrontRight', 'tirePressureStatusValidRearLeft',
  'tirePressureStatusValidRearRight', 'trailerStatus', 'twelveVoltBatteryHealth', 'vehicleMileage',
  'windowFrontLeftCalibrated', 'windowFrontLeftClosed', 'windowFrontRightCalibrated',
  'windowFrontRightClosed', 'windowRearLeftCalibrated', 'windowRearLeftClosed',
  'windowRearRightCalibrated', 'windowRearRightClosed', 'windowsNextAction', 'wiperFluidState',
]

/**
 * The three properties that are not `timeStamp value`. Every other name above
 * is a plain value, so this is the only place a shape is ever assigned.
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
 * A selection set, printed one field per line with two-space indentation:
 * `{`, the fields, `}`. Every document in this file is laid out this way, so
 * that the text the server validates is the text a reader sees, and a stray
 * token is a visible line rather than a character in a long one.
 */
function selectionSet(fields: readonly string[]): string {
  return ['{', ...fields.map((field) => `  ${field}`), '}'].join('\n')
}

/**
 * Prefix every line of `text` with `spaces` spaces. It is how a selection set,
 * printed on its own, is placed at its depth inside a document.
 */
function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces)
  return text
    .split('\n')
    .map((line) => `${pad}${line}`)
    .join('\n')
}

/**
 * The selection each shape is asked for with. The fields are listed in the
 * order the schema declares them on the shape's type (`TimeStamped*`,
 * `VehicleLocation`, `VehicleCloudConnection` and `VehicleLocationError`
 * respectively), and only the ones we use: `VehicleLocation` also declares a
 * `consentStatus`, which we do not select.
 */
export const SHAPE_SELECTIONS: Readonly<Record<PropertyShape, string>> = {
  value: selectionSet(['timeStamp', 'value']),
  location: selectionSet(['timeStamp', 'latitude', 'longitude', 'isAuthorized']),
  cloudConnection: selectionSet(['isOnline', 'lastSync']),
  locationError: selectionSet([
    'timeStamp',
    'bearing',
    'positionHorizontal',
    'positionVertical',
    'speed',
  ]),
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
 * such type is `timeStamp value`. A Map, not an object, so a name like
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
 * query is then a constant per operation, and an id is only ever data. The
 * variable is spelled `$vehicleId` in every document, whatever the argument it
 * feeds is called. That spelling is ours, the server does not care what a
 * variable is called, and one spelling is one fewer thing to get wrong.
 */
export interface SubscriptionDocument {
  operationName: string
  query: string
  variables: Record<string, unknown>
}

/**
 * What a `vehicleState` property name must look like before it may become query
 * text: a GraphQL name.
 *
 * The names come from our own list, but discovery (design §5.6) also feeds in
 * names read out of Rivian's introspection response. Remote text must never
 * become query text, so a name that is not a plain identifier is refused here,
 * where the query is built, rather than trusted to have been filtered upstream.
 */
const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/

/**
 * `vehicleState`, for one group of properties.
 *
 * Throws `RangeError` for an empty list, which would be a selection set with
 * nothing in it, and for any name that is not a GraphQL name (see
 * `GRAPHQL_NAME`). The message gives the position of the offending name and
 * never the name itself: it is remote text, and thrown messages carry none.
 * Callers that take names from discovery should filter first, so that one odd
 * name costs that name and not the group it was about to join.
 *
 * The argument is called `id` here, and `vehicleId` or `id` on the other
 * subscriptions, as the API has it; the variable feeding it is `$vehicleId`
 * throughout. A wrong ARGUMENT name is a validation error with no field to
 * blame.
 */
export function vehicleStateDocument(
  vehicleId: string,
  names: readonly string[],
): SubscriptionDocument {
  if (names.length === 0) {
    throw new RangeError('a vehicleState subscription needs at least one property')
  }
  names.forEach((name, index) => {
    if (!GRAPHQL_NAME.test(name)) {
      throw new RangeError(`property name at position ${index} is not a GraphQL name`)
    }
  })
  const properties = names
    .map((name) => indent(`${name} ${SHAPE_SELECTIONS[shapeOf(name)]}`, 4))
    .join('\n')
  return {
    operationName: 'VehicleState',
    query: [
      'subscription VehicleState($vehicleId: String!) {',
      '  vehicleState(id: $vehicleId) {',
      properties,
      '  }',
      '}',
    ].join('\n'),
    variables: { vehicleId },
  }
}

/**
 * `parallaxMessages`: the vehicle's raw protobuf topics (`rvm`), base64 in
 * `payload`. A null `rvms` means every topic, which is what we ask for until
 * the tape shows which are worth keeping (design §2.3).
 *
 * The topic filter is the variable `$topics`, an optional list, not a required
 * one, because null is the value that means "all": declaring it `[String!]!`
 * would make the all-topics subscription a validation error. It feeds the
 * argument the API calls `rvms`. This selection is the design's (§2.3): the
 * schema snapshot does not contain this subscription.
 */
export function parallaxDocument(
  vehicleId: string,
  rvms: readonly string[] | null,
): SubscriptionDocument {
  return {
    operationName: 'ParallaxMessages',
    query: `subscription ParallaxMessages($vehicleId: String!, $topics: [String!]) {
  parallaxMessages(vehicleId: $vehicleId, rvms: $topics) {
    payload
    timestamp
    rvm
  }
}`,
    variables: { vehicleId, topics: rvms === null ? null : [...rvms] },
  }
}

/**
 * `chargingSession`: live power and energy for a session in progress, and the
 * curve so far. `vehicleState` carries neither (design §2.4), and the HTTP query
 * that used to answer was removed on 2026-10-11, so this subscription is the
 * only live source of charge energy, if it still validates.
 *
 * Every field the design's §2.3 lists is selected, on purpose: this is a
 * capture of an unfamiliar subscription, and a field we leave out is one the
 * tape can never show us. The schema declares `chartData` before `liveData`, so
 * that is the order here. If Rivian rejects the selection, the subscription is
 * marked unavailable and charge energy is unknown (design §7.4), never zero.
 */
export function chargingSessionDocument(vehicleId: string): SubscriptionDocument {
  return {
    operationName: 'ChargingSession',
    query: `subscription ChargingSession($vehicleId: String!) {
  chargingSession(vehicleId: $vehicleId) {
    chartData {
      soc
      powerKW
      startTime
      endTime
      timeEstimationValidityStatus
      vehicleChargerState
    }
    liveData {
      powerKW
      kilometersChargedPerHour
      rangeAddedThisSession
      totalChargedEnergy
      timeElapsed
      timeRemaining
      price
      currency
      isFreeSession
      vehicleChargerState
      startTime
    }
  }
}`,
    variables: { vehicleId },
  }
}

/**
 * `vehicleCloudConnection`: whether the car is reachable, and when it last
 * synced. The API calls this subscription's argument `id`; the variable feeding
 * it is `$vehicleId` like every other document's.
 */
export function cloudConnectionDocument(vehicleId: string): SubscriptionDocument {
  return {
    operationName: 'VehicleCloudConnection',
    query: `subscription VehicleCloudConnection($vehicleId: String!) {
  vehicleCloudConnection(id: $vehicleId) {
    isOnline
    lastSync
  }
}`,
    variables: { vehicleId },
  }
}

/**
 * The subscriptions whose answer is a bare payload: `ParallaxMessageResponse`
 * in the schema snapshot, which is a base64 protobuf and a sequence number, and
 * NO topic field. That is not the shape `parallaxMessages` answers in, and the
 * two must not be confused: asking this type for `timestamp` or `rvm` is a
 * validation error, which would take the subscription down for nothing.
 *
 * The payload is taped and not decoded. These are the subscriptions whose
 * liveness is unverified, and the connector treats a rejected one as
 * unavailable and retries it daily rather than bisecting, since there are no
 * properties to bisect.
 */
function payloadDocument(
  operationName: string,
  field: string,
  vehicleId: string,
): SubscriptionDocument {
  return {
    operationName,
    query: `subscription ${operationName}($vehicleId: String!) {
  ${field}(vehicleId: $vehicleId) {
    payload
    sequenceNumber
  }
}`,
    variables: { vehicleId },
  }
}

/** `otaInstallState`: where an over-the-air update is in its install. */
export function otaInstallStateDocument(vehicleId: string): SubscriptionDocument {
  return payloadDocument('OtaInstallState', 'otaInstallState', vehicleId)
}

/** `otaInstallSchedules`: when an update is set to install. */
export function otaInstallSchedulesDocument(vehicleId: string): SubscriptionDocument {
  return payloadDocument('OtaInstallSchedules', 'otaInstallSchedules', vehicleId)
}

/** `vehicleGeofences`: the geofences set on the vehicle. */
export function geofencesDocument(vehicleId: string): SubscriptionDocument {
  return payloadDocument('VehicleGeofences', 'vehicleGeofences', vehicleId)
}

/**
 * `vehicleDepartureSchedules`: the user's scheduled departures, each with the
 * cabin and charge settings that go with it. Fields are in the order the schema
 * declares them on each type, which for `comfortSettings` puts
 * `surfaceHeatVentLevels` first.
 *
 * `occurrence` is selected through an inline fragment on the one kind we know,
 * `RepeatsWeekly`, plus `__typename`. The schema snapshot has `occurrence` as
 * plain `RepeatsWeekly`, but a fragment is valid whether the field is that type
 * or a union that includes it, so the document survives Rivian making it one.
 * A schedule of any other kind then arrives as its type name and nothing else,
 * which shows on the tape, instead of as a selection the server refuses.
 */
export function departureSchedulesDocument(vehicleId: string): SubscriptionDocument {
  return {
    operationName: 'VehicleDepartureSchedules',
    query: `subscription VehicleDepartureSchedules($vehicleId: String!) {
  vehicleDepartureSchedules(vehicleId: $vehicleId) {
    id
    name
    isEnabled
    occurrence {
      ... on RepeatsWeekly {
        days
        startsAtMin
        skippedOn
      }
      __typename
    }
    departureSettings {
      shouldOverrideChargeSchedule
      comfortSettings {
        surfaceHeatVentLevels {
          frontLeftSeat
          frontRightSeat
          rearLeftSeat
          rearRightSeat
          steeringWheel
        }
        cabinTempCelsius
        frontDefogDefrost
      }
    }
  }
}`,
    variables: { vehicleId },
  }
}
