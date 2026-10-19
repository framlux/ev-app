import {
  closePool,
  getPool,
  runMigrationsUnderGate,
  upsertRivianCredential,
  withTransaction,
  writeRivianStatus,
} from '@ev/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pgConnectorStore } from '../src/store.js'

/**
 * `pgConnectorStore` against a real Postgres.
 *
 * The connector's tests use a fake store, so this is the one place the seam
 * itself is checked, and what matters about it is a distinction the connector
 * builds its whole safety on (design §5.2): a successful query that finds
 * nothing says `null`, and a query that FAILS throws. The first is a user
 * signing out and closes the socket; the second is a Postgres blip and changes
 * nothing. A store that answered a failed query with `null` would hang up on a
 * live session every time the database sneezed.
 *
 * Both tables hold at most one row, and `beforeEach` empties them wholesale,
 * which is safe because this project's tests run in a database of their own
 * (see packages/db/test/support/isolated-database.ts and vitest.config.ts).
 *
 * See packages/db/test/migrate.test.ts for how to run a throwaway Postgres locally.
 */
const hasDb = Boolean(process.env['PGHOST'])

if (!hasDb && process.env['CI']) {
  throw new Error(
    'PGHOST is unset in CI: the connector store tests must run against a real Postgres. ' +
      'See the postgres service in .github/workflows/test.yml.',
  )
}

const empty = () => getPool().query('DELETE FROM rivian_credential; DELETE FROM rivian_status')

describe.skipIf(!hasDb)('pgConnectorStore', () => {
  // Generous timeout: this hook may spend most of it waiting on the migration
  // gate while a sibling file migrates.
  beforeAll(async () => {
    await runMigrationsUnderGate()
  }, 60_000)

  beforeEach(async () => {
    await empty()
  })

  afterAll(async () => {
    // A sealed credential left in a database is the one fixture here that
    // something else could mistake for a sign-in.
    await empty()
    await closePool()
  })

  it('answers null for an empty database, which is how a sign-out looks', async () => {
    const store = pgConnectorStore(getPool())

    expect(await store.credentialStamp()).toBeNull()
    expect(await store.credential()).toBeNull()
    expect(await store.status()).toBeNull()
  })

  it('reads the stamp, and the sealed value alone, of a stored credential', async () => {
    const pool = getPool()
    await withTransaction(pool, (c) =>
      upsertRivianCredential(c, { sealed: 'jwe-one', account: 'owner@example.com' }),
    )
    const store = pgConnectorStore(pool)

    expect(await store.credentialStamp()).toBeInstanceOf(Date)
    // Only `sealed`: the account's email is not the connector's business.
    expect(await store.credential()).toEqual({ sealed: 'jwe-one' })
  })

  it('moves the stamp when the credential is stored again, which is what restarts the connector', async () => {
    const pool = getPool()
    const store = pgConnectorStore(pool)
    await withTransaction(pool, (c) => upsertRivianCredential(c, { sealed: 'jwe-one', account: 'a@example.com' }))
    const first = await store.credentialStamp()

    await new Promise((resolve) => setTimeout(resolve, 20))
    await withTransaction(pool, (c) => upsertRivianCredential(c, { sealed: 'jwe-two', account: 'a@example.com' }))

    const second = await store.credentialStamp()
    expect(second!.getTime()).toBeGreaterThan(first!.getTime())
    expect(await store.credential()).toEqual({ sealed: 'jwe-two' })
  })

  it('writes a status row, replaces it whole, and reads it back', async () => {
    const store = pgConnectorStore(getPool())
    const lastFrameAt = new Date('2026-10-19T17:00:00.000Z')
    const backoffUntil = new Date('2026-10-19T17:05:00.000Z')

    await store.writeStatus({
      state: 'backing_off',
      vin: '7PD2EAAB2VN016249',
      rivianVehicleId: 'rv-1',
      lastFrameAt,
      lastError: 'websocket closed: rate limited',
      backoffUntil,
      droppedProperties: ['batteryLevel', 'activeDriverName'],
    })
    expect(await store.status()).toMatchObject({
      state: 'backing_off',
      vin: '7PD2EAAB2VN016249',
      rivianVehicleId: 'rv-1',
      lastFrameAt,
      lastError: 'websocket closed: rate limited',
      backoffUntil,
      droppedProperties: ['batteryLevel', 'activeDriverName'],
    })

    // Replaced whole: nothing of the first write survives into the second.
    await store.writeStatus({
      state: 'subscribed',
      vin: '7PD2EAAB2VN016249',
      rivianVehicleId: null,
      lastFrameAt: null,
      lastError: null,
      backoffUntil: null,
      droppedProperties: [],
    })
    expect(await store.status()).toMatchObject({
      state: 'subscribed',
      rivianVehicleId: null,
      lastFrameAt: null,
      lastError: null,
      backoffUntil: null,
      droppedProperties: [],
    })
  })

  it('reads a status row somebody else wrote', async () => {
    await withTransaction(getPool(), (c) =>
      writeRivianStatus(c, {
        state: 'waiting_for_vehicle',
        vin: null,
        rivianVehicleId: null,
        lastFrameAt: null,
        lastError: null,
        backoffUntil: null,
        droppedProperties: ['x'],
      }),
    )

    expect(await pgConnectorStore(getPool()).status()).toMatchObject({
      state: 'waiting_for_vehicle',
      droppedProperties: ['x'],
    })
  })

  describe('a query that fails throws, and never answers null', () => {
    it('on a pool that cannot connect', async () => {
      // A pool that has been ended is the plainest dead connection there is:
      // every call on it rejects, and none of them has a result to be null.
      const store = pgConnectorStore(getPool())
      await closePool()

      await expect(store.credentialStamp()).rejects.toThrow()
      await expect(store.credential()).rejects.toThrow()
      await expect(store.status()).rejects.toThrow()
      await expect(
        store.writeStatus({
          state: 'subscribed',
          vin: null,
          rivianVehicleId: null,
          lastFrameAt: null,
          lastError: null,
          backoffUntil: null,
          droppedProperties: [],
        }),
      ).rejects.toThrow()
    })

    it('on a write the database refuses', async () => {
      const store = pgConnectorStore(getPool())

      // The CHECK on `state` is what refuses it: a state the connector has no
      // such name for would otherwise be written, and read back, as a fact.
      await expect(
        store.writeStatus({
          state: 'no_such_state' as never,
          vin: null,
          rivianVehicleId: null,
          lastFrameAt: null,
          lastError: null,
          backoffUntil: null,
          droppedProperties: [],
        }),
      ).rejects.toThrow()
      // And it left nothing behind.
      expect(await store.status()).toBeNull()
    })
  })
})
