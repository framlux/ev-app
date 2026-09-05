import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RawMessage } from '@ev/core'
import { closePool, getPool, runMigrationsUnderGate } from '@ev/db'
import { Pipeline } from '../src/pipeline.js'
import { pgRunner, registerVehicle } from '../src/store.js'

/**
 * The one thing about the worker that only a real Postgres can answer: does a
 * FRESH DEPLOYMENT ingest anything at all?
 *
 * Every other ingest test drives the pipeline through `FakeDb`, which models
 * the schema's idempotency rules but not its foreign keys — so it cannot see
 * the failure this file exists for. `raw_message`, `sample` and `session` all
 * reference `vehicle(id)`. Without a row there, the first message of a new
 * install rolls back on a FK violation; because the handler throws, the message
 * is never acked, so it is redelivered forever and NOTHING is ever recorded.
 * The visible symptom is an empty garage on a car that has been driving.
 *
 * See migrate.test.ts for how to run a throwaway Postgres locally.
 */
const hasDb = Boolean(process.env['PGHOST'])

if (!hasDb && process.env['CI']) {
  throw new Error(
    'PGHOST is unset in CI: the startup test must run against a real Postgres. ' +
      'See the postgres service in .github/workflows/test.yml.',
  )
}

const VEHICLE = 'startup-test-v1'
const VIN = '5YJ3E1EA1JF000001'
const TS = new Date('2026-09-04T10:00:00.000Z')

const identity = { id: VEHICLE, vin: VIN, displayName: 'Startup Test' }

function field(name: string, value: unknown): RawMessage {
  return {
    vehicleId: VEHICLE,
    vendor: 'tesla',
    receivedAt: TS,
    source: 'telemetry',
    payload: { kind: 'metrics', vin: VIN, field: name, value },
  }
}

describe.skipIf(!hasDb)('worker startup', () => {
  // Generous timeout: this hook may spend most of it waiting on the migration
  // gate while a sibling file migrates.
  beforeAll(async () => {
    await runMigrationsUnderGate()
    await getPool().query('DELETE FROM vehicle WHERE id=$1', [VEHICLE])
  }, 60_000)

  afterAll(async () => {
    const p = getPool()
    await p.query('DELETE FROM raw_message WHERE vehicle_id=$1', [VEHICLE])
    await p.query('DELETE FROM sample WHERE vehicle_id=$1', [VEHICLE])
    await p.query('DELETE FROM ingest_cursor WHERE source=$1', ['startup-test'])
    await p.query('DELETE FROM vehicle WHERE id=$1', [VEHICLE])
    await closePool()
  })

  it('registers the configured vehicle, so the first message is ingested', async () => {
    await registerVehicle(getPool(), identity)

    const pipeline = new Pipeline(pgRunner(getPool(), 'startup-test', VEHICLE), {
      usableCapacityKwh: 75,
    })
    await pipeline.handle(field('Soc', 80))

    const { rows } = await getPool().query(
      'SELECT count(*)::int AS n FROM raw_message WHERE vehicle_id=$1',
      [VEHICLE],
    )
    expect(rows[0]?.n).toBe(1)
  })

  it('is idempotent across restarts and does not overwrite the display name', async () => {
    await registerVehicle(getPool(), identity)
    await getPool().query('UPDATE vehicle SET display_name=$2 WHERE id=$1', [VEHICLE, 'Renamed'])
    // The restart.
    await registerVehicle(getPool(), identity)

    const { rows } = await getPool().query(
      'SELECT display_name FROM vehicle WHERE id=$1',
      [VEHICLE],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.display_name).toBe('Renamed')
  })
})
