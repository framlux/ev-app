/**
 * Turning Tesla's typed enum values into something a person reads.
 *
 * With `prefer_typed: true` the car sends protobuf enum NAMES, and Tesla's
 * enums repeat the type in every value: `SentryModeState` has
 * `SentryModeStateOff`, `SentryModeStateArmed`, and so on. Rendered as-is, a
 * tile reads `CabinOverheatProtectionModeStateOff` — 35 characters of which 3
 * carry the information, overflowing a 140px tile by 82px.
 *
 * WHY THIS IS NOT THE TRANSLATION `format.ts` REFUSES TO DO. That refusal is
 * right and stands: mapping `ACSingleWireCAN` onto something friendlier would
 * be inventing a meaning nothing can check, and a wrong invention is
 * indistinguishable from a right one on screen. This does something narrower —
 * it deletes a prefix the proto itself defines, and the proto is vendored, so
 * the deletion is checkable rather than imagined. No value is renamed; only the
 * type name in front of it is dropped.
 *
 * DERIVED, NOT WRITTEN. Each prefix is the longest common prefix of one enum's
 * own values, cut back to a capital boundary so it can never eat into a word.
 * That handles the 49 values whose enum name and value prefix disagree
 * (`ChargingState`'s values all start `ChargeState`; `BMSStateValue`'s start
 * `BMSState`) without a single special case. `enum-labels.test.ts` recomputes
 * the whole list from the vendored proto and fails if this one drifts, so a
 * proto update that adds an enum lands as a failing build rather than as a
 * tile that silently keeps its prefix.
 */

/**
 * One prefix per enum in `vehicle_data.proto`, longest first at use.
 *
 * Regenerate with the test, do not hand-edit: a prefix that is one character
 * wrong turns `Off` into `ff` and nothing else notices.
 */
export const TESLA_ENUM_PREFIXES: readonly string[] = [
  'BMSState',
  'BuckleStatus',
  'CabinOverheatProtectionModeState',
  'CableType',
  'CarType',
  'ChargePort',
  'ChargePortLatch',
  'ChargeState',
  'ChargeUnit',
  'ClimateKeeperModeState',
  'ClimateOverheatProtectionTempLimit',
  'DefrostModeState',
  'DetailedChargeState',
  'DisplayState',
  'DistanceUnit',
  'DriveInverterState',
  'FastCharger',
  'Follow',
  'ForwardCollisionSensitivity',
  'GuestModeMobileAccess',
  'HvacAutoModeState',
  'HvacPowerState',
  'HvilStatus',
  'LaneAssistLevel',
  'MediaStatus',
  'PowershareState',
  'PowershareStopReasonStatus',
  'PowershareTypeStatus',
  'PressureUnit',
  'ScheduledChargingMode',
  'SeatFoldPosition',
  'SentryModeState',
  'ShiftState',
  'SpeedAssistLevel',
  'SunroofInstalledState',
  'TemperatureUnit',
  'TonneauPositionState',
  'TonneauTentModeState',
  'TractorAirStatus',
  'TrailerAirStatus',
  'TurnSignalState',
  'WindowState',
]

// Longest first, so `CabinOverheatProtectionModeState` wins over any shorter
// prefix that also matches. Sorted once at module load rather than per call.
const BY_LENGTH = [...TESLA_ENUM_PREFIXES].sort((a, b) => b.length - a.length)

/**
 * `HvacPowerStateOverheatProtect` -> `Overheat protect`.
 *
 * Unrecognised values are returned UNCHANGED, which is the important half: a
 * value from an enum this list does not know is still shown exactly as the car
 * sent it, because a mangled value is worse than a long one. Acronyms survive
 * for the same reason - `BMSStateSNA` becomes `SNA`, not `S n a`.
 */
export function teslaEnumLabel(value: string): string {
  // Free text is not an enum, and `formatText` sends every TEXT column through
  // here - vehicle names, destination names, software versions. A proto enum
  // value is one unbroken CamelCase token, so anything with whitespace is left
  // alone before a prefix can bite it: `Follow` is a real prefix, and without
  // this `Followers Cafe` would render as `ers Cafe`.
  if (/\s/.test(value)) return value

  const prefix = BY_LENGTH.find((p) =>
    value.startsWith(p) &&
    value.length > p.length &&
    // Every proto value continues with a capital after its prefix. Requiring it
    // means a name that merely begins with the same letters keeps its own word.
    value[p.length] === value[p.length]!.toUpperCase() &&
    value[p.length] !== value[p.length]!.toLowerCase())
  if (!prefix) return value
  const bare = value.slice(prefix.length)

  // Split CamelCase into words, but leave runs of capitals alone so an acronym
  // stays an acronym. Only the first word keeps its capital.
  const words = bare.match(/[A-Z]+(?![a-z])|[A-Z][a-z]*|[0-9]+/g)
  if (!words || words.length === 0) return bare
  return words
    .map((w, i) => (i === 0 || w === w.toUpperCase() ? w : w.toLowerCase()))
    .join(' ')
}
