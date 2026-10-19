import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  closePool, ensurePartitions, ensureVehicle, getPool, insertSample, runMigrationsUnderGate,
  withTransaction,
} from '@ev/db'
import { makeSample } from '@ev/core'
import type { Vendor } from '../src/deps.js'
import { replayWindow } from '../src/reprocess.js'
import { registerVehicle } from '../src/store.js'

/**
 * One EV_VEHICLE_ID, one car. `ensureVehicle` is DO NOTHING on conflict, so a
 * worker configured with the id of a row that belongs to another vendor's car
 * registered itself, changed nothing, and then filed every message it received
 * under that car: a Rivian worker started with the Tesla's EV_VEHICLE_ID put the
 * R2's tape and samples on the Tesla, silently and permanently, and `reprocess`
 * with the wrong EV_VENDOR deleted the Tesla's derived rows and rebuilt nothing.
 *
 * Against a real Postgres, because the thing under test is what the row holds
 * and the order in which a worker reads it and writes (spec §8.2).
 *
 * See migrate.test.ts for how to run a throwaway Postgres locally.
 */
const hasDb = Boolean(process.env['PGHOST'])

if (!hasDb && process.env['CI']) {
  throw new Error(
    'PGHOST is unset in CI: the vehicle guard tests must run against a real Postgres. ' +
      'See the postgres service in .github/workflows/test.yml.',
  )
}

/**
 * A VIN per seeded row: `(vendor, vendor_vehicle_id)` is UNIQUE, so two rows of
 * one vendor cannot share one. Tesla's start 5YJ, Rivian's 7PD.
 */
const RIVIAN_VIN = '7PDSGABA1RN000001'
const teslaVin = (n: number) => `5YJ3E1EA1JF00000${n}`
const IDS = ['guard-test-a', 'guard-test-b', 'guard-test-c', 'guard-test-d', 'guard-test-e', 'guard-test-f']
const [SHARED, SAME, CASE, FALLBACK, NOVIN, REPLAY] = IDS as [string, string, string, string, string, string]

const NOW = new Date('2027-03-10T12:00:00.000Z')
const WINDOW = { from: new Date('2027-03-10T00:00:00.000Z'), to: new Date('2027-03-11T00:00:00.000Z') }

function identity(id: string, vin: string | null) {
  return { id, vin, displayName: `Guard ${id}` }
}

const seed = (id: string, vendor: Vendor, vendorVehicleId: string) =>
  withTransaction(getPool(), (c) =>
    ensureVehicle(c, { id, vendor, vendorVehicleId, displayName: `Seeded ${id}` }))

const rowOf = async (id: string) =>
  (await getPool().query('SELECT vendor, vendor_vehicle_id, display_name FROM vehicle WHERE id=$1', [id])).rows

describe.skipIf(!hasDb)('the vehicle row guard', () => {
  beforeAll(async () => {
    await runMigrationsUnderGate()
    const p = getPool()
    for (const id of IDS) {
      await p.query('DELETE FROM sample WHERE vehicle_id=$1', [id])
      await p.query('DELETE FROM vehicle WHERE id=$1', [id])
    }
    await withTransaction(p, (c) => ensurePartitions(c, NOW))
  }, 60_000)

  afterAll(async () => {
    const p = getPool()
    for (const id of IDS) {
      await p.query('DELETE FROM sample WHERE vehicle_id=$1', [id])
      await p.query('DELETE FROM vehicle WHERE id=$1', [id])
    }
    await closePool()
  })

  describe('at startup', () => {
    it('refuses a worker whose EV_VENDOR is not the vendor of the row its EV_VEHICLE_ID names', async () => {
      await seed(SHARED, 'tesla', teslaVin(2))

      const err = await registerVehicle(getPool(), identity(SHARED, RIVIAN_VIN), 'rivian').then(
        () => null, (e: unknown) => e as Error)

      expect(err).toBeInstanceOf(Error)
      // It names the settings to look at, and carries no other data: neither VIN,
      // nor the id's value.
      expect(err!.message).toContain('EV_VEHICLE_ID')
      expect(err!.message).toContain('EV_VENDOR')
      for (const leaked of [teslaVin(2), RIVIAN_VIN, SHARED]) expect(err!.message).not.toContain(leaked)
      // And it changed nothing.
      expect(await rowOf(SHARED)).toEqual([
        { vendor: 'tesla', vendor_vehicle_id: teslaVin(2), display_name: `Seeded ${SHARED}` },
      ])
    })

    it('refuses the same vendor with a different VIN', async () => {
      await seed(SAME, 'rivian', RIVIAN_VIN)

      const other = '7PDSGABA1RN999999'
      const err = await registerVehicle(getPool(), identity(SAME, other), 'rivian').then(
        () => null, (e: unknown) => e as Error)

      expect(err).toBeInstanceOf(Error)
      expect(err!.message).toContain('EV_VEHICLE_ID')
      expect(err!.message).toContain('EV_VEHICLE_VIN')
      for (const leaked of [RIVIAN_VIN, other, SAME]) expect(err!.message).not.toContain(leaked)
      expect((await rowOf(SAME))[0]?.vendor_vehicle_id).toBe(RIVIAN_VIN)
    })

    it('lets a worker that matches its row restart', async () => {
      await registerVehicle(getPool(), identity(SAME, RIVIAN_VIN), 'rivian')
      expect(await rowOf(SAME)).toEqual([
        { vendor: 'rivian', vendor_vehicle_id: RIVIAN_VIN, display_name: `Seeded ${SAME}` },
      ])
    })

    it('compares VINs without regard to case, as VINs are the same identifier either way', async () => {
      // A row written before config upper-cased the VIN may hold it as typed.
      await seed(CASE, 'tesla', teslaVin(3).toLowerCase())
      await registerVehicle(getPool(), identity(CASE, teslaVin(3)), 'tesla')
    })

    it('does not mistake the id the row stores when no VIN was configured for a VIN', async () => {
      // `registerVehicle` files `vin ?? id` as the vendor id, so a Tesla worker
      // started without EV_VEHICLE_VIN leaves a row whose vendor id is its own
      // id. Adding the VIN later is a legitimate change, not a different car.
      await registerVehicle(getPool(), identity(FALLBACK, null), 'tesla')
      expect((await rowOf(FALLBACK))[0]?.vendor_vehicle_id).toBe(FALLBACK)
      await registerVehicle(getPool(), identity(FALLBACK, teslaVin(4)), 'tesla')
    })

    it('has no VIN to compare when none is configured, and leaves the row as it was', async () => {
      await seed(NOVIN, 'tesla', teslaVin(5))
      await registerVehicle(getPool(), identity(NOVIN, null), 'tesla')
      expect((await rowOf(NOVIN))[0]?.vendor_vehicle_id).toBe(teslaVin(5))
    })
  })

  describe('before a replay deletes anything', () => {
    const replayConfig = (vendor: Vendor, vin: string | null) => ({
      vendor,
      vehicle: identity(REPLAY, vin),
      cursorSource: 'guard-test',
      usableCapacityKwh: 75,
      home: null,
    })

    const samplesOf = async () =>
      (await getPool().query('SELECT count(*)::int AS n FROM sample WHERE vehicle_id=$1', [REPLAY])).rows[0]!.n

    /**
     * A bare pool client, not `withTransaction`: with no BEGIN every statement
     * commits as it runs, so a delete that came before the refusal would still
     * be gone afterwards. Inside a transaction the throw would roll it back and
     * the test could not tell.
     */
    const replayOn = async (vendor: Vendor, vin: string | null) => {
      const client = await getPool().connect()
      try {
        return await replayWindow(client, replayConfig(vendor, vin), WINDOW)
      } finally {
        client.release()
      }
    }

    it('refuses a replay under another vendor, and deletes nothing', async () => {
      await seed(REPLAY, 'tesla', teslaVin(6))
      await withTransaction(getPool(), (c) => insertSample(c, makeSample({
        vehicleId: REPLAY, ts: new Date('2027-03-10T10:00:00.000Z'), socPct: 80,
      })))
      expect(await samplesOf()).toBe(1)

      const err = await replayOn('rivian', RIVIAN_VIN).then(() => null, (e: unknown) => e as Error)

      expect(err).toBeInstanceOf(Error)
      expect(err!.message).toContain('EV_VENDOR')
      expect(await samplesOf()).toBe(1)
    })

    it('refuses a replay under another VIN, and deletes nothing', async () => {
      const err = await replayOn('tesla', teslaVin(9)).then(() => null, (e: unknown) => e as Error)
      expect(err).toBeInstanceOf(Error)
      expect(err!.message).toContain('EV_VEHICLE_VIN')
      expect(await samplesOf()).toBe(1)
    })

    it('replays the vehicle that matches its row', async () => {
      // An empty tape for this vehicle: the delete runs, the replay writes nothing.
      expect(await replayOn('tesla', teslaVin(6))).toBe(0)
      expect(await samplesOf()).toBe(0)
    })

    it('replays an id with no row, which has nothing for a mismatch to damage', async () => {
      await getPool().query('DELETE FROM vehicle WHERE id=$1', [REPLAY])
      expect(await replayOn('rivian', RIVIAN_VIN)).toBe(0)
    })
  })

  /**
   * `backfill-costs` and `parallax-dump` run from `main()`, which loads the
   * environment and opens a pool, so there is nothing to call that does not need
   * both. What can be checked is that each makes the same read before it does
   * anything, and the function itself is what the cases above exercise.
   */
  it('is made by every tool that takes the worker\'s environment', () => {
    const src = (file: string) =>
      readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', file), 'utf8')
    for (const file of ['backfill-costs.ts', 'parallax-dump.ts']) {
      expect(src(file), file).toMatch(/\bassertVehicleMatchesConfig\(/)
    }
  })
})
