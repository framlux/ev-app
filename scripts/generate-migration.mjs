#!/usr/bin/env node
/**
 * Emits a `sample` migration from @ev/core's column catalogue.
 *
 *   pnpm --filter @ev/core build
 *   node scripts/generate-migration.mjs 004 full_signal_set \
 *     > packages/db/migrations/004_full_signal_set.sql
 *
 * WHY A SCRIPT AND NOT A RUNTIME STEP. There are two hundred columns and
 * hand-typing them once, let alone twice for the Down section, is a typo
 * waiting to become a column that exists in `VehicleSample` and not in the
 * database. But the OUTPUT is checked in as static SQL and is never regenerated
 * at migrate time: migrations are immutable history, and one that read the
 * catalogue when it ran would silently change meaning every time the catalogue
 * did — a database migrated last month and a database migrated today would end
 * up with different schemas from the same migration number. So this script is a
 * convenience for writing the file, not a participant in applying it, and once
 * the file is written it is ordinary hand-editable SQL.
 *
 * It is therefore also NOT idempotent-by-diff: re-running it after the
 * catalogue has grown emits a migration for the NEW columns only, because it
 * skips every column an earlier migration already created (see below). That is
 * what you want for `005`; it is also why no test compares the checked-in `004`
 * byte-for-byte against what this prints today.
 *
 * §3.3's location expansion. A location is two columns, `<name>_lat` and
 * `<name>_lon`, both DOUBLE PRECISION — and that expansion has already happened
 * by the time the catalogue reaches this script: `packages/core/src/signals.ts`
 * carries `origin_location_lat`/`_lon` and `destination_location_lat`/`_lon` as
 * ordinary entries, because the core catalogue is one entry per COLUMN. The
 * half of the rule this script owns is the other one: `Location` itself targets
 * the `lat`/`lon` that `001_initial.sql` created, so those must not be added a
 * second time. That falls out of the skip below, which is general — it protects
 * every pre-existing column, not just the two that would have failed loudly.
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SAMPLE_COLUMNS } from '../packages/core/dist/signals.js'

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDir = path.join(repoRoot, 'packages', 'db', 'migrations')

/**
 * The columns `sample` already has when the migration numbered `before` runs,
 * read out of the migrations that precede it. Read rather than restated: a
 * hardcoded list here could disagree with the schema and the disagreement would
 * surface as a "column already exists" failure in production, at wave 5, with
 * the workloads behind it.
 */
function existingSampleColumns(before) {
  const columns = new Set()
  for (const file of readdirSync(migrationsDir).sort()) {
    const n = /^(\d+)_/.exec(file)
    if (!n || Number(n[1]) >= Number(before)) continue
    const [up = ''] = readFileSync(path.join(migrationsDir, file), 'utf8')
      .split('-- Down Migration')

    const created = /CREATE TABLE sample \(([\s\S]*?)\n\)/.exec(up)
    for (const line of created?.[1].split('\n') ?? []) {
      const t = line.trim()
      if (t === '' || t.startsWith('--') || t.startsWith('PRIMARY KEY')) continue
      columns.add(t.split(/\s+/)[0])
    }
    for (const alter of up.matchAll(/ALTER TABLE sample\b([\s\S]*?);/g))
      for (const add of alter[1].matchAll(/ADD COLUMN\s+(\w+)/g)) columns.add(add[1])
  }
  return columns
}

const [, , number = '004', slug = 'full_signal_set'] = process.argv

const existing = existingSampleColumns(number)
const adding = SAMPLE_COLUMNS.filter((c) => !existing.has(c.column))

if (adding.length === 0) {
  console.error(`nothing to add: sample already has all ${SAMPLE_COLUMNS.length} catalogued columns`)
  process.exit(1)
}

// Align the types into a column, as 001_initial.sql does. Two hundred rows of
// unaligned SQL is unreadable in a diff, which is where this file is reviewed.
const width = Math.max(...adding.map((c) => c.column.length)) + 1
const list = (verb, body) => adding
  .map((c, i) => `  ${verb} ${body(c)}${i === adding.length - 1 ? ';' : ','}`)
  .join('\n')

process.stdout.write(`-- Up Migration

-- ${number}_${slug}: generated from @ev/core's column catalogue by
-- scripts/generate-migration.mjs. Regenerating it is not how it is maintained —
-- see that script's header — and a later catalogue entry arrives as a later
-- migration, never as an edit to this one.
--
-- ${adding.length} columns: one per catalogued signal \`sample\` does not have yet.
-- Measured on a populated partitioned parent, ADD COLUMN is a catalogue write
-- rather than a table rewrite, so this is milliseconds even against real data,
-- and a null column costs a bit in the row header rather than a byte on disk.
-- One ALTER TABLE rather than ${adding.length}, so the parent and each of its
-- partitions are locked once.
ALTER TABLE sample
${list('ADD COLUMN', (c) => `${c.column.padEnd(width)}${c.sql}`)}

-- Down Migration

-- Dropping a column does NOT reclaim its slot: Postgres allows 1600 columns per
-- table counting dropped ones, so a down-then-up cycle spends ${adding.length} of the
-- remaining headroom. Fine once, worth knowing before doing it in a loop.
ALTER TABLE sample
${list('DROP COLUMN', (c) => c.column)}
`)
