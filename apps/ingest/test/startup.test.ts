import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RawMessage } from '@ev/core'
import {
  closePool, ensurePartitions, getPool, insertRaw, openSession, runMigrationsUnderGate,
  withTransaction,
} from '@ev/db'
import { Pipeline } from '../src/pipeline.js'
import { pgRunner, registerVehicle, resumeFromTape } from '../src/store.js'

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
    await p.query('DELETE FROM session WHERE vehicle_id=$1', [VEHICLE])
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

  /**
   * The tape a drive leaves: a minute of it at a time, moving and then parked.
   * In 2027 so that no other test's rows for this vehicle share the window.
   */
  const drive = (minute: number, fields: Record<string, unknown>): RawMessage[] =>
    Object.entries(fields).map(([name, value]) => ({
      vehicleId: VEHICLE,
      vendor: 'tesla' as const,
      receivedAt: new Date(Date.UTC(2027, 1, 10, 10, minute)),
      source: 'telemetry' as const,
      payload: { kind: 'metrics', vin: VIN, field: name, value },
    }))

  it('resumes from the tape, closing an open drive the tape shows had parked', async () => {
    const pool = getPool()
    await registerVehicle(pool, identity)
    const tape = [
      ...[0, 1, 2, 3, 4, 5].flatMap((m) => drive(m, { VehicleSpeed: 40, Odometer: 1000 + m })),
      ...[6, 7, 8, 9, 10, 11, 12, 13].flatMap((m) => drive(m, { VehicleSpeed: 0 })),
    ]
    const id = await withTransaction(pool, async (c) => {
      await ensurePartitions(c, tape[0]!.receivedAt)
      for (const m of tape) await insertRaw(c, m)
      return openSession(c, VEHICLE, 'drive', tape[0]!.receivedAt)
    })

    const pipeline = new Pipeline(pgRunner(pool, 'startup-test', VEHICLE), { usableCapacityKwh: 75 })
    const report = await resumeFromTape(pool, pipeline, VEHICLE, new Date(Date.UTC(2027, 1, 10, 10, 20)))

    expect(report.closed.map((r) => r.id)).toEqual([id])
    const { rows } = await pool.query('SELECT is_open, distance_km FROM session WHERE id=$1', [id])
    expect(rows[0]?.is_open).toBe(false)
    // Five miles of odometer, in kilometres.
    expect(rows[0]?.distance_km).toBeCloseTo(8.05, 1)
  })

  /**
   * The wiring, in the built worker: a row left open by an earlier worker,
   * older than anything a resume replays, is closed before the worker
   * subscribes, so it cannot absorb the next drive. The broker is unreachable
   * on purpose; the resume happens before the worker ever needs it.
   */
  it('closes an orphaned session when the worker starts', async () => {
    const pool = getPool()
    await registerVehicle(pool, identity)
    const orphan = await withTransaction(pool, (c) =>
      openSession(c, VEHICLE, 'drive', new Date('2026-01-01T09:00:00.000Z')))

    const closed = async () => {
      const port = await new Promise<number>((resolve) => {
        const server = createServer().listen(0, '127.0.0.1', () => {
          const address = server.address()
          server.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
        })
      })
      return port
    }
    const worker = spawn(process.execPath, [fileURLToPath(new URL('../dist/main.js', import.meta.url))], {
      env: {
        PATH: process.env['PATH'],
        PGHOST: process.env['PGHOST'], PGPORT: process.env['PGPORT'],
        PGUSER: process.env['PGUSER'], PGPASSWORD: process.env['PGPASSWORD'],
        PGDATABASE: process.env['PGDATABASE'],
        EV_VEHICLE_ID: VEHICLE, EV_VEHICLE_VIN: VIN, EV_USABLE_CAPACITY_KWH: '75',
        MQTT_PASSWORD: 'unused', MQTT_URL: `mqtt://127.0.0.1:${await closed()}`,
        METRICS_PORT: String(await closed()),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    worker.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    worker.stderr.on('data', (chunk: Buffer) => { out += chunk.toString() })
    try {
      let open = true
      for (let i = 0; i < 75 && open; i++) {
        await new Promise((r) => setTimeout(r, 200))
        const { rows } = await pool.query('SELECT is_open FROM session WHERE id=$1', [orphan])
        open = rows[0]?.is_open !== false
      }
      expect({ open, out }).toMatchObject({ open: false })
      expect(out).toMatch(/resumed from \d+ taped messages: .*abandoned drive/)
    } finally {
      worker.kill('SIGKILL')
    }
  }, 30_000)
})
