#!/usr/bin/env node
/**
 * Prints the parts of the Fleet Telemetry configuration that live in the
 * catalogue: the `fields` map, and the collector's hostname and port.
 *
 *   pnpm --filter @ev/tesla build
 *   node scripts/telemetry-fields.mjs
 *
 * `push-telemetry-config.sh` used to carry this list as a python dict of 21
 * names. It is 194 now (204 catalogued, less the 10 the Fleet API refuses -
 * see `WITHHELD_FIELDS`), and more to the point it has to AGREE with three other
 * things — the normaliser's decoders, the column catalogue and the schema —
 * none of which the shell can see. So the list lives in
 * `packages/tesla/src/catalogue.ts` with everything else that must agree.
 *
 * Turning it into the shape Tesla's API takes —
 *
 *   { "VehicleSpeed": { "interval_seconds": 10, "minimum_delta": 1 }, ... }
 *
 * — used to be this file's own loop. It is now `buildTelemetryFields` in
 * `packages/tesla/src/telemetry-config.ts`, because the web app pushes the same
 * configuration and two producers of one JSON document is exactly the drift the
 * catalogue exists to prevent. This script is a SHIM: it prints the field map
 * and nothing else, so the shell script's python still assembles the envelope
 * (hostname, port, ca, prefer_typed) around it and `push-config.test.ts`'s
 * assertions on that literal text stay green.
 *
 * `interval_seconds` comes from the entry's tier (§3.5) and `minimum_delta`
 * from its `delta`, omitted where the catalogue leaves it null. Both are in the
 * units the CAR uses — miles, mph, metres — because it does the comparison
 * before it sends. `packages/tesla/test/push-config.test.ts` asserts that what
 * this prints is the catalogue and nothing else, and
 * `test/telemetry-config.test.ts` asserts that it is what the web app pushes;
 * without those, a signal asked for but not stored, or asked for by one caller
 * and not the other, is silent in every direction.
 *
 * It only prints. Nothing here talks to Tesla or to the cluster, which is what
 * lets a test run it.
 */

// A relative path, not the `@ev/tesla` specifier: the workspace root has no
// node_modules/@ev, so a bare specifier does not resolve from scripts/. dist,
// not src, because this is plain node - build the package first.
import {
  buildTelemetryFields,
  TELEMETRY_HOSTNAME,
  TELEMETRY_PORT,
} from '../packages/tesla/dist/telemetry-config.js'

// Throws on an empty catalogue rather than printing `{}`: a configuration with
// no fields is accepted by Tesla and stops the car streaming anything. The
// script's own `-gt 0` guard still stands behind this one, because the shell is
// what a human reads at 2am.
const fields = buildTelemetryFields()

// Pretty-printed: the push script echoes the file on a failure, and a 194-key
// object on one line is unreadable in a terminal at the exact moment someone is
// trying to work out what was about to be sent to their car.
process.stdout.write(
  `${JSON.stringify({ hostname: TELEMETRY_HOSTNAME, port: TELEMETRY_PORT, fields }, null, 2)}\n`
)
