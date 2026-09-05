import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SAMPLE_COLUMNS } from '@ev/core'
import { SAMPLE_INSERT_SQL } from '../src/repo/samples.js'

/**
 * The drift tests that need no database (spec §5): the checked-in migration and
 * the generated insert are both read as TEXT and compared against the column
 * catalogue they were generated from.
 *
 * These deliberately do NOT skip when PGHOST is unset. The failure they catch —
 * a column in `VehicleSample` that no migration ever adds, or an insert whose
 * column list has drifted from the catalogue — is a silently dropped signal,
 * and a developer without Postgres running should still see it.
 *
 * They also do NOT re-run the generator and compare byte for byte. A migration
 * is immutable history: once `004` is applied anywhere, a later catalogue entry
 * must arrive as `005`, and a test demanding that `004` still equals what the
 * generator emits today would force someone to edit applied history to get
 * green. So `004` is checked for internal consistency and for being a subset of
 * the catalogue; the "schema equals catalogue" half is asserted against the real
 * applied schema in migrate.test.ts, which stays true however many migrations
 * come later.
 */

const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

const read = (f: string) => readFileSync(path.join(migrationsDir, f), 'utf8')

const initial = read('001_initial.sql')
const full = read('004_full_signal_set.sql')

/**
 * The columns `sample` already had before this migration, parsed out of
 * `001_initial.sql` rather than restated here. Restating them would let this
 * test agree with a generator that is wrong about the same thing.
 */
const columnsFrom001 = (() => {
  const body = /CREATE TABLE sample \(([\s\S]*?)\n\) PARTITION BY/.exec(initial)?.[1]
  if (!body) throw new Error('could not find CREATE TABLE sample in 001_initial.sql')
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('--') && !l.startsWith('PRIMARY KEY'))
    .map((l) => l.split(/\s+/)[0]!)
})()

const [up = '', down = ''] = full.split('-- Down Migration')

const clauses = (sql: string, verb: 'ADD' | 'DROP') =>
  [...sql.matchAll(new RegExp(`^\\s*${verb} COLUMN\\s+(\\S+)(.*?)[,;]\\s*$`, 'gm'))]
    .map((m) => ({ column: m[1]!, type: m[2]!.trim() }))

const added = clauses(up, 'ADD')
const dropped = clauses(down, 'DROP')

const catalogued = SAMPLE_COLUMNS.map((c) => c.column)

describe('004_full_signal_set.sql', () => {
  it('adds every catalogued column that sample did not already have', () => {
    const expected = catalogued.filter((c) => !columnsFrom001.includes(c))
    expect(added.map((a) => a.column)).toEqual(expected)
  })

  it('adds nothing that is not in the catalogue', () => {
    for (const a of added) expect(catalogued).toContain(a.column)
  })

  it('declares each column with the catalogue\'s SQL type', () => {
    const sqlFor = new Map(SAMPLE_COLUMNS.map((c) => [c.column, c.sql as string]))
    for (const a of added) expect(a.type).toBe(sqlFor.get(a.column))
  })

  // §3.3: `Location` targets the columns 001 created; a second `lat` would be a
  // duplicate-column error rather than a silently wrong schema, but the same
  // rule protects every other pre-existing name, which would NOT fail loudly.
  it('re-adds none of the columns 001_initial.sql created', () => {
    for (const c of columnsFrom001) expect(added.map((a) => a.column)).not.toContain(c)
    expect(added.map((a) => a.column)).not.toContain('lat')
    expect(added.map((a) => a.column)).not.toContain('lon')
  })

  it('expands a location into a _lat and a _lon column', () => {
    const cols = added.map((a) => a.column)
    for (const base of ['origin_location', 'destination_location']) {
      expect(cols).toContain(`${base}_lat`)
      expect(cols).toContain(`${base}_lon`)
      expect(cols).not.toContain(base)
    }
  })

  it('drops in Down exactly what it adds in Up', () => {
    expect(dropped.map((d) => d.column)).toEqual(added.map((a) => a.column))
  })

  // Anchored to the start of a line so the prose above the statement, which
  // says the same thing in words, is not what makes this pass.
  it('adds the columns in one ALTER TABLE, so the table is locked once', () => {
    expect(up.match(/^ALTER TABLE/gm)).toHaveLength(1)
    expect(down.match(/^ALTER TABLE/gm)).toHaveLength(1)
  })
})

describe('the generated insert', () => {
  const columnList = /INSERT INTO sample \(([\s\S]*?)\)\s*VALUES/.exec(SAMPLE_INSERT_SQL)?.[1]
  const columns = (columnList ?? '').split(',').map((c) => c.trim()).filter(Boolean)

  it('binds the primary key and then every catalogued column, in order', () => {
    expect(columns).toEqual(['vehicle_id', 'ts', ...catalogued])
  })

  it('is still one statement with ON CONFLICT DO NOTHING', () => {
    expect(SAMPLE_INSERT_SQL.match(/INSERT INTO/g)).toHaveLength(1)
    expect(SAMPLE_INSERT_SQL).not.toContain(';')
    expect(SAMPLE_INSERT_SQL).toMatch(/ON CONFLICT \(vehicle_id, ts\) DO NOTHING/)
  })

  it('has one placeholder per column, numbered from $1, well inside 65535', () => {
    const placeholders = [...SAMPLE_INSERT_SQL.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]))
    expect(placeholders).toEqual(columns.map((_, i) => i + 1))
    expect(placeholders).toHaveLength(SAMPLE_COLUMNS.length + 2)
    // Postgres's wire protocol caps parameters at 65535. Two hundred is not
    // near it, and the assertion is here so that a future catalogue that IS
    // near it fails on a test rather than on a production insert.
    expect(placeholders.length).toBeLessThan(65535 / 4)
  })
})
