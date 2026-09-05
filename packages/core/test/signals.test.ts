import { describe, expect, it } from 'vitest'
import { SAMPLE_COLUMNS, TS_TYPES_FOR_SQL, type SampleColumn } from '../src/signals.js'
import { makeSample } from '../src/model.js'

/** The catalogue's own naming rule, restated independently of the catalogue. */
const camel = (column: string): string =>
  column.split('_')
    .map((p, i) => (i === 0 ? p : p[0]!.toUpperCase() + p.slice(1)))
    .join('')

describe('SAMPLE_COLUMNS', () => {
  it('has no duplicate column names', () => {
    const seen = new Map<string, number>()
    for (const c of SAMPLE_COLUMNS) seen.set(c.column, (seen.get(c.column) ?? 0) + 1)
    expect([...seen].filter(([, n]) => n > 1)).toEqual([])
  })

  it('has no duplicate TypeScript keys', () => {
    const seen = new Map<string, number>()
    for (const c of SAMPLE_COLUMNS) seen.set(c.key, (seen.get(c.key) ?? 0) + 1)
    expect([...seen].filter(([, n]) => n > 1)).toEqual([])
  })

  // vehicle_id and ts are the primary key, structural rather than catalogued;
  // a catalogue entry for either would generate a duplicate column.
  it('does not catalogue the primary key columns', () => {
    expect(SAMPLE_COLUMNS.map((c) => c.column)).not.toContain('vehicle_id')
    expect(SAMPLE_COLUMNS.map((c) => c.column)).not.toContain('ts')
  })

  it('names every column in snake_case and every key as its camelCase', () => {
    const snake = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/
    for (const c of SAMPLE_COLUMNS) {
      expect(c.column, `${c.column} is not snake_case`).toMatch(snake)
      expect(c.key, `${c.column} -> ${c.key}`).toBe(camel(c.column))
    }
  })

  // §3.4: a value the column rejects wedges ingest, so the SQL type and the TS
  // type a decoder must produce have to agree entry by entry.
  it('pairs every sql type with a ts type that can be bound to it', () => {
    for (const c of SAMPLE_COLUMNS) {
      expect(TS_TYPES_FOR_SQL[c.sql], `${c.column} (${c.sql}/${c.ts})`).toContain(c.ts)
    }
  })

  // A truncated regeneration would still satisfy every rule above; the point of
  // the catalogue is that it covers the whole applicable signal set (§3.2).
  it('covers the full signal set, not a subset', () => {
    expect(SAMPLE_COLUMNS.length).toBeGreaterThanOrEqual(195)
  })

  /**
   * The 17 columns `sample` has had since 001_initial.sql. These names are in
   * the REST contract and the UI; renaming or retyping one is a breaking change,
   * so they are pinned here verbatim rather than derived from anything.
   */
  it('keeps the legacy sample columns exactly as they are', () => {
    const legacy = [
      { column: 'soc_pct', key: 'socPct', sql: 'REAL', ts: 'number' },
      { column: 'range_km', key: 'rangeKm', sql: 'REAL', ts: 'number' },
      { column: 'odometer_km', key: 'odometerKm', sql: 'DOUBLE PRECISION', ts: 'number' },
      { column: 'lat', key: 'lat', sql: 'DOUBLE PRECISION', ts: 'number' },
      { column: 'lon', key: 'lon', sql: 'DOUBLE PRECISION', ts: 'number' },
      { column: 'speed_kph', key: 'speedKph', sql: 'REAL', ts: 'number' },
      { column: 'power_state', key: 'powerState', sql: 'TEXT', ts: 'PowerState' },
      { column: 'charge_state', key: 'chargeState', sql: 'TEXT', ts: 'ChargeState' },
      { column: 'charge_power_kw', key: 'chargePowerKw', sql: 'REAL', ts: 'number' },
      {
        column: 'charge_energy_added_kwh', key: 'chargeEnergyAddedKwh',
        sql: 'REAL', ts: 'number',
      },
      { column: 'inside_temp_c', key: 'insideTempC', sql: 'REAL', ts: 'number' },
      { column: 'outside_temp_c', key: 'outsideTempC', sql: 'REAL', ts: 'number' },
      { column: 'locked', key: 'locked', sql: 'BOOLEAN', ts: 'boolean' },
      { column: 'doors_open', key: 'doorsOpen', sql: 'BOOLEAN', ts: 'boolean' },
      { column: 'tpms', key: 'tpms', sql: 'JSONB', ts: 'TpmsMap' },
    ]
    const byColumn = new Map<string, SampleColumn>(
      SAMPLE_COLUMNS.map((c) => [c.column, c]),
    )
    for (const want of legacy) expect(byColumn.get(want.column)).toEqual(want)
  })

  // §3.3: a REAL carries ~7 significant digits, which tens of thousands of kWh
  // with a decimal exhausts. These are all odometers by another name.
  it('gives every cumulative counter DOUBLE PRECISION', () => {
    const counters = [
      'lifetime_energy_used', 'lifetime_energy_used_drive',
      'lifetime_energy_gained_regen', 'lifetime_energy_charged_kwh',
      'km_since_reset', 'self_driving_km_since_reset', 'odometer_km',
    ]
    const byColumn = new Map<string, SampleColumn>(
      SAMPLE_COLUMNS.map((c) => [c.column, c]),
    )
    for (const c of counters) expect(byColumn.get(c)?.sql, c).toBe('DOUBLE PRECISION')
  })

  // §3.3: position is DOUBLE PRECISION everywhere. A REAL latitude is accurate
  // to a couple of metres at best, which is worse than the GPS it stores.
  it('gives every position column DOUBLE PRECISION', () => {
    for (const c of SAMPLE_COLUMNS) {
      if (!/(^|_)(lat|lon)$/.test(c.column)) continue
      expect(c.sql, c.column).toBe('DOUBLE PRECISION')
    }
  })

  // §3.4: guessing a type costs a re-typing and loses the value until then;
  // TEXT costs nothing. These are the fields the spec names as traps.
  it('parks the fields of unobserved shape at TEXT', () => {
    const unobserved = [
      'route_last_updated', 'software_update_scheduled_start_time',
      'tpms_last_seen_pressure_time_fl', 'tpms_last_seen_pressure_time_fr',
      'tpms_last_seen_pressure_time_rl', 'tpms_last_seen_pressure_time_rr',
      'scheduled_charging_start_time', 'scheduled_departure_time',
    ]
    const byColumn = new Map<string, SampleColumn>(
      SAMPLE_COLUMNS.map((c) => [c.column, c]),
    )
    for (const c of unobserved) expect(byColumn.get(c)?.sql, c).toBe('TEXT')
  })

  // §3.3: converted columns carry the unit in the name, so a miles-named
  // column would be a lie about what is stored in it.
  it('leaves no US customary unit in a column name', () => {
    for (const c of SAMPLE_COLUMNS) {
      expect(c.column, c.column).not.toMatch(/(^|_)(miles?|mph)(_|$)/)
    }
  })
})

describe('makeSample over the catalogue', () => {
  it('fills every catalogued column with null, not undefined and not zero', () => {
    const s = makeSample({ vehicleId: 'v1', ts: new Date('2026-09-05T10:00:00Z') }) as
      unknown as Record<string, unknown>
    for (const c of SAMPLE_COLUMNS) {
      expect(Object.hasOwn(s, c.key), `${c.key} missing`).toBe(true)
      expect(s[c.key], c.key).toBeNull()
    }
  })

  it('carries the new columns through when they are given', () => {
    const s = makeSample({
      vehicleId: 'v1',
      ts: new Date('2026-09-05T10:00:00Z'),
      gear: 'D',
      packVoltage: 388.4,
      nominalFullPackEnergyKwh: 74.2,
      sentryMode: 'Armed',
    })
    expect(s.gear).toBe('D')
    expect(s.packVoltage).toBe(388.4)
    expect(s.nominalFullPackEnergyKwh).toBe(74.2)
    expect(s.sentryMode).toBe('Armed')
    // and still nulls everything it was not given
    expect(s.socPct).toBeNull()
    expect(s.brickVoltageMin).toBeNull()
  })
})
