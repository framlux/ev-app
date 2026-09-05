#!/usr/bin/env node
/**
 * Prints the `fields` map of the Fleet Telemetry configuration, as JSON.
 *
 *   pnpm --filter @ev/tesla build
 *   node scripts/telemetry-fields.mjs
 *
 * `push-telemetry-config.sh` used to carry this list as a python dict of 21
 * names. It is 204 now, and more to the point it has to AGREE with three other
 * things — the normaliser's decoders, the column catalogue and the schema —
 * none of which the shell can see. So the list lives in
 * `packages/tesla/src/catalogue.ts` with everything else that must agree, and
 * this script is the only thing that turns it into the shape Tesla's API takes:
 *
 *   { "VehicleSpeed": { "interval_seconds": 10, "minimum_delta": 1 }, ... }
 *
 * `interval_seconds` comes from the entry's tier (§3.5) and `minimum_delta`
 * from its `delta`, omitted where the catalogue leaves it null. Both are in the
 * units the CAR uses — miles, mph, metres — because it does the comparison
 * before it sends. `packages/tesla/test/push-config.test.ts` asserts that what
 * this prints is the catalogue and nothing else; without that, a signal asked
 * for but not stored, or stored but never asked for, is silent in both
 * directions.
 *
 * It only prints. Nothing here talks to Tesla or to the cluster, which is what
 * lets a test run it.
 */

// A relative path, not the `@ev/tesla` specifier: the workspace root has no
// node_modules/@ev, so a bare specifier does not resolve from scripts/. dist,
// not src, because this is plain node - build the package first.
import { TESLA_FIELDS, TIER_INTERVAL_SECONDS } from '../packages/tesla/dist/catalogue.js'

const fields = {}
for (const entry of TESLA_FIELDS) {
  fields[entry.field] = {
    interval_seconds: TIER_INTERVAL_SECONDS[entry.tier],
    ...(entry.delta !== null && { minimum_delta: entry.delta }),
  }
}

// Pretty-printed: the push script echoes the file on a failure, and a 204-key
// object on one line is unreadable in a terminal at the exact moment someone is
// trying to work out what was about to be sent to their car.
process.stdout.write(`${JSON.stringify(fields, null, 2)}\n`)
