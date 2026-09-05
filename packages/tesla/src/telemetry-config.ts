/**
 * THE ONE PRODUCER of the Fleet Telemetry configuration, and the one rule for
 * deciding whether the car already has it.
 *
 * Until now `scripts/push-telemetry-config.sh` assembled the configuration in
 * python and `scripts/telemetry-fields.mjs` printed the field map for it. The
 * web app now pushes the same configuration, and two producers of the same JSON
 * is precisely the drift the field catalogue exists to prevent — so the
 * assembly moved here and the shim became a caller. The script keeps its python
 * (its four pinned text assertions in `test/push-config.test.ts` say so), but
 * the only thing it can still decide about the configuration is the VIN.
 *
 * `hostname` and `port` are CONSTANTS here rather than arguments. They were
 * hard-coded in the shell script, and a value both callers must agree on is
 * exactly what a shared module is for: passing them in would put the drift back
 * one level up.
 *
 * The two guards below moved out of the script with the assembly. They are the
 * reason this is not a one-liner, and both defend against a push that SUCCEEDS
 * and then silently stops the data.
 */

import { TESLA_FIELDS, TIER_INTERVAL_SECONDS, type TeslaField } from './catalogue.js'
import type {
  AppliedTelemetryConfig, TelemetryConfigRequest, TelemetryFields,
} from './fleet-api.js'

/**
 * Where the car sends its telemetry. Public DNS, not a cluster name: this is
 * dialled from the vehicle, over the internet.
 */
export const TELEMETRY_HOSTNAME = 'ev-telemetry.framlux.io'

/** 443, because it must survive whatever network the car happens to be on. */
export const TELEMETRY_PORT = 443

/** What "the CA is really a CA" means, in both the builder and the comparison. */
const looksLikeCertificate = (ca: string): boolean => ca.includes('BEGIN CERTIFICATE')

/**
 * The `fields` map in Tesla's shape, in catalogue order.
 *
 * `interval_seconds` comes from the entry's tier and `minimum_delta` from its
 * `delta`, omitted where the catalogue leaves it null — both in the units on
 * the WIRE (miles, mph, metres), because the car does the delta arithmetic
 * before it sends.
 *
 * Exported on its own because `scripts/telemetry-fields.mjs` prints this half
 * and nothing else: the shell script's python still assembles the envelope
 * around it, and `push-config.test.ts` pins that it does.
 *
 * @param catalogue Overridable ONLY so the empty-set guard below is testable —
 *   the real catalogue cannot be emptied from a test, and a guard against the
 *   worst failure in the flow should not be taken on trust.
 */
export function buildTelemetryFields(
  catalogue: readonly TeslaField[] = TESLA_FIELDS,
): TelemetryFields {
  const fields: TelemetryFields = {}
  for (const entry of catalogue) {
    fields[entry.field] = {
      interval_seconds: TIER_INTERVAL_SECONDS[entry.tier],
      // Conditional spread rather than an assignment of `undefined`: an
      // explicit `minimum_delta: undefined` would serialise to nothing here but
      // is a different type under exactOptionalPropertyTypes, and the whole
      // point is that absent means "the car decides", not "zero".
      ...(entry.delta !== null && { minimum_delta: entry.delta }),
    }
  }

  // A configuration with no fields is ACCEPTED by Tesla, reported as a success,
  // and stops the car streaming anything at all — which downstream is
  // indistinguishable from a car that is asleep. It is the highest-consequence
  // failure in the whole flow, so it throws here where both callers get it
  // rather than only in the script's `[ "$COUNT" -gt 0 ] || fail`.
  if (Object.keys(fields).length === 0) {
    throw new Error(
      'the field catalogue emitted no fields: a telemetry configuration with no ' +
      'fields is accepted by Tesla and stops the car streaming anything.')
  }
  return fields
}

/**
 * The complete push body for one vehicle.
 *
 * It returns the WRAPPED body — `{ vins, config }` — because that is what
 * `setTelemetryConfig` sends verbatim; nothing between here and Tesla is
 * allowed to reshape it.
 */
export function buildTelemetryConfig(input: {
  vin: string
  ca: string
  /** See `buildTelemetryFields`: present for the empty-set guard's test. */
  catalogue?: readonly TeslaField[]
}): TelemetryConfigRequest {
  // The CA the CAR PINS — our private root, not the collector's leaf and not a
  // public chain. A mis-projected or empty mount yields a configuration the car
  // accepts and then fails every connection against, which looks exactly like a
  // car that never wakes. The script greps for this; so do we.
  if (!looksLikeCertificate(input.ca)) {
    throw new Error(
      'the telemetry CA holds no BEGIN CERTIFICATE: the car pins this, and a ' +
      'configuration carrying the wrong bytes fails every connection silently.')
  }

  return {
    vins: [input.vin],
    config: {
      hostname: TELEMETRY_HOSTNAME,
      port: TELEMETRY_PORT,
      ca: input.ca,
      // Typed enums rather than raw ints, decided before the normaliser was
      // written so its fixtures match production.
      prefer_typed: true,
      fields: buildTelemetryFields(input.catalogue),
    },
  }
}

/** Why an applied configuration is not the one we would push, in words. */
export interface TelemetryConfigComparison {
  matches: boolean
  /** Empty when it matches. Rendered by the settings page, so it reads as prose. */
  differences: string[]
}

/**
 * Spec §3.6: does the car already have the configuration we would push?
 *
 * BOTH WAYS OF GETTING THIS WRONG ARE SILENT, which is why the rule is written
 * down rather than left to a deep equality. Too strict — comparing whatever
 * Tesla echoes — and a reformatted PEM or an omitted defaulted `minimum_delta`
 * means it never matches, so the page pushes to a physical car on every check.
 * Too loose and it reports "already applied" over a configuration the car never
 * received, which costs every signal the change was about.
 *
 * The rule, exactly:
 *   - the SET of field names, and for each, `interval_seconds` and
 *     `minimum_delta` — an absent `minimum_delta` meaning the default, because
 *     the catalogue omits it on most fields and Tesla does not echo it back;
 *   - `hostname` and `port`;
 *   - `ca` ON PRESENCE ONLY. Line endings and trailing newlines survive a round
 *     trip through Tesla unpredictably and are not ours to control — but a
 *     config applied with NO certificate is broken and must be re-pushed, so
 *     presence is still checked.
 *
 * Everything else Tesla echoes (`alert_types`, `exp`, the vins, `prefer_typed`)
 * is ignored.
 */
export function compareTelemetryConfig(
  applied: AppliedTelemetryConfig | undefined,
  desired: AppliedTelemetryConfig,
): TelemetryConfigComparison {
  const differences: string[] = []

  // Absent until the first push is applied: Tesla omits the key entirely while
  // `synced` is false. A difference, not an error.
  if (!applied) {
    return { matches: false, differences: ['the car has no telemetry configuration applied'] }
  }

  if (applied.hostname !== desired.hostname) {
    differences.push(`hostname: applied ${applied.hostname}, would push ${desired.hostname}`)
  }
  if (applied.port !== desired.port) {
    differences.push(`port: applied ${applied.port}, would push ${desired.port}`)
  }
  if (!looksLikeCertificate(applied.ca ?? '')) {
    differences.push('ca: the applied configuration carries no certificate')
  }

  const appliedFields = applied.fields ?? {}
  for (const name of Object.keys(desired.fields)) {
    if (!(name in appliedFields)) differences.push(`${name}: not applied`)
  }
  for (const name of Object.keys(appliedFields)) {
    if (!(name in desired.fields)) differences.push(`${name}: applied but no longer catalogued`)
  }

  for (const [name, want] of Object.entries(desired.fields)) {
    const got = appliedFields[name]
    if (!got) continue // already reported as missing
    if (got.interval_seconds !== want.interval_seconds) {
      differences.push(
        `${name}: interval ${got.interval_seconds}s applied, would push ${want.interval_seconds}s`)
    }
    // Absent and 0 are the same thing to the car, and the catalogue leaves
    // `delta` null on most fields — so normalise before comparing, or the
    // configuration would never match itself.
    const gotDelta = got.minimum_delta ?? 0
    const wantDelta = want.minimum_delta ?? 0
    if (gotDelta !== wantDelta) {
      differences.push(
        `${name}: minimum_delta ${gotDelta} applied, would push ${wantDelta}`)
    }
  }

  return { matches: differences.length === 0, differences }
}
