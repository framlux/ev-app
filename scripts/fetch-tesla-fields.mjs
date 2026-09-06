#!/usr/bin/env node
/**
 * Refresh `packages/tesla/reference/tesla-available-data.json` from Tesla's
 * published field reference.
 *
 * WHY THIS FILE IS VENDORED AT ALL. The field catalogue was built from
 * `vehicle_data.proto`, and the proto answers only one question: what is a
 * signal NAMED. It does not say which names `fleet_telemetry_config` will
 * accept, and the two sets are not equal — the proto gains a field when the
 * firmware is written, while the API accepts it some time later. Pushing a name
 * the API does not know fails the WHOLE configuration, so the difference costs
 * every signal, not one.
 *
 * That was learned twice, from a car, at one release each:
 *   400 Unknown field BrickSocMinPercent
 *   400 SelfDrivingMilesSinceReset requires minimum delta be explicitly set
 *
 * Both are visible in this table, which is why it is now vendored and tested
 * against. Every proto member absent from it is either a placeholder we exclude
 * outright or a field the API has refused — the correspondence is exact, which
 * is what makes `documented` the right gate on `pushed`.
 *
 * HOW IT IS FETCHED. The docs are a Gatsby site; the table is a static query
 * whose JSON the page itself downloads. The query hash changes when Tesla
 * rebuilds the site, so it is read from the page rather than pinned — if this
 * script stops finding it, open the page, look for `page-data/sq/d/*.json` in
 * the network tab, and fix the discovery below rather than editing the vendored
 * file by hand. A hand-edited reference is worth nothing.
 */

import { writeFileSync } from 'node:fs'

const PAGE = 'https://developer.tesla.com/docs/fleet-api/fleet-telemetry/available-data'
const OUT = new URL('../packages/tesla/reference/tesla-available-data.json', import.meta.url)

const fail = (message) => {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

// Gatsby keeps the page's data - including the hashes of the static queries it
// depends on - beside the route, not in the HTML.
const PAGE_DATA =
  'https://developer.tesla.com/docs/page-data/fleet-api/fleet-telemetry/available-data/page-data.json'

const meta = await fetch(PAGE_DATA)
if (!meta.ok) fail(`${PAGE_DATA} returned ${meta.status}`)
const hashes = (await meta.json())?.staticQueryHashes ?? []
if (hashes.length === 0) fail('no staticQueryHashes for the page; the docs site changed shape')

let nodes = null
for (const hash of new Set(hashes)) {
  const res = await fetch(`https://developer.tesla.com/docs/page-data/sq/d/${hash}.json`)
  if (!res.ok) continue
  const found = (await res.json())?.data?.allFleetStreamingFieldsCsv?.nodes
  if (Array.isArray(found) && found.length > 0) { nodes = found; break }
}
if (!nodes) fail('no allFleetStreamingFieldsCsv in any static query; the docs site changed shape')

// A truncated table would silently shrink the accepted set and withhold real
// signals, which is the failure this whole file exists to prevent.
if (nodes.length < 200) fail(`only ${nodes.length} fields; refusing to write a table that short`)

const reference = {
  source: PAGE,
  retrieved: new Date().toISOString().slice(0, 10),
  how: 'The page renders this table from a Gatsby static query. scripts/fetch-tesla-fields.mjs refreshes this file from the same JSON the page reads.',
  why: 'The proto says what a signal is NAMED. This says what fleet_telemetry_config will ACCEPT. They are not the same set, and pushing a name that is only in the proto fails the ENTIRE config, not the field.',
  fields: nodes
    .map((n) => ({
      field: n.field_name,
      category: n.category,
      type: n.type,
      description: String(n.description ?? '').replace(/\s+/g, ' ').trim(),
    }))
    .sort((a, b) => a.field.localeCompare(b.field)),
}

writeFileSync(OUT, `${JSON.stringify(reference, null, 2)}\n`)
process.stdout.write(`${reference.fields.length} fields -> ${OUT.pathname}\n`)
