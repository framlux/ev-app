import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closePool, getPool } from '../src/pool.js'
import { runMigrationsUnderGate } from '../src/migrate.js'
import { withTransaction } from '../src/repo/types.js'
import {
  deleteRivianCredential, readRivianCredential, readRivianCredentialStamp,
  readRivianStatus, upsertRivianCredential, writeRivianStatus,
  type RivianConnectorState,
} from '../src/repo/rivian.js'

/**
 * 009_rivian.sql and its repository, against a real Postgres.
 *
 * What is under test is mostly SQL, so a fake store could only restate it: that
 * `updated_at` moves on the SECOND upsert (the column default fires on insert
 * only, and the connector's poll treats a changed stamp as "a new credential,
 * restart"), that an upsert does not disturb `created_at`, that a status row
 * round-trips a `TEXT[]`, and that the database itself refuses a second row.
 *
 * Both tables hold at most one row, and `beforeEach` empties them wholesale
 * rather than by key, because there is no key to scope by: that is the design.
 * It is safe only because nothing else writes these tables in this test
 * database, which is a property of how the suites are isolated and not of this
 * file: each vitest project gets a database of its own (see
 * test/support/isolated-database.ts), so a web or ingest test that one day
 * stores a credential cannot be emptied from under it by this one.
 *
 * See migrate.test.ts for how to run a throwaway Postgres locally.
 */
const hasDb = Boolean(process.env['PGHOST'])

if (!hasDb && process.env['CI']) {
  throw new Error(
    'PGHOST is unset in CI: the repository tests must run against a real Postgres. ' +
      'See the postgres service in .github/workflows/test.yml.',
  )
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Every state §5.2 names, so the CHECK on `state` is tested against the list and not a sample of it. */
const STATES: RivianConnectorState[] = [
  'signed_out', 'starting', 'credential_invalid', 'finding_vehicle',
  'waiting_for_vehicle', 'connecting', 'subscribed', 'backing_off',
  'unauthenticated',
]

describe.skipIf(!hasDb)('009_rivian', () => {
  // Generous timeout: this hook may spend most of it waiting on the migration
  // gate while a sibling file migrates.
  beforeAll(async () => { await runMigrationsUnderGate() }, 60_000)

  beforeEach(async () => {
    await getPool().query('DELETE FROM rivian_credential; DELETE FROM rivian_status')
  })

  afterAll(async () => {
    // Leave nothing behind: a sealed credential row left in a database is the
    // one fixture here that something else could mistake for a sign-in.
    await getPool().query('DELETE FROM rivian_credential; DELETE FROM rivian_status')
    await closePool()
  })

  describe('rivian_credential', () => {
    it('is null while nobody has signed in', async () => {
      expect(await withTransaction(getPool(), (c) => readRivianCredential(c))).toBeNull()
      expect(await withTransaction(getPool(), (c) => readRivianCredentialStamp(c))).toBeNull()
    })

    it('stores a credential and reads it back', async () => {
      await withTransaction(getPool(), (c) =>
        upsertRivianCredential(c, { sealed: 'jwe-one', account: 'owner@example.com' }))

      const row = await withTransaction(getPool(), (c) => readRivianCredential(c))
      expect(row?.sealed).toBe('jwe-one')
      expect(row?.account).toBe('owner@example.com')
      expect(row?.createdAt).toBeInstanceOf(Date)
      expect(row?.updatedAt).toBeInstanceOf(Date)
    })

    it('moves updated_at forwards on a second sign-in, and leaves created_at alone', async () => {
      // The column default applies on INSERT only. Without the explicit
      // `updated_at = now()` in the DO UPDATE branch a re-sign-in changes the
      // sealed value and the stamp stays put, so the connector - which polls
      // the stamp, not the value - would never notice the new session and
      // would sit in `unauthenticated` for good.
      await withTransaction(getPool(), (c) =>
        upsertRivianCredential(c, { sealed: 'jwe-one', account: 'owner@example.com' }))
      const first = await withTransaction(getPool(), (c) => readRivianCredential(c))

      await sleep(10)
      await withTransaction(getPool(), (c) =>
        upsertRivianCredential(c, { sealed: 'jwe-two', account: 'second@example.com' }))
      const second = await withTransaction(getPool(), (c) => readRivianCredential(c))

      expect(second?.sealed).toBe('jwe-two')
      // The account moves with the session: a re-sign-in as a different user
      // that kept showing the old email would tell the owner the wrong car is
      // connected.
      expect(second?.account).toBe('second@example.com')
      expect(second!.updatedAt.getTime()).toBeGreaterThan(first!.updatedAt.getTime())
      expect(second?.createdAt.getTime()).toBe(first?.createdAt.getTime())

      // One account, one row: the second sign-in replaced the first.
      const { rows } = await getPool().query('SELECT count(*)::int AS n FROM rivian_credential')
      expect(rows[0]?.n).toBe(1)
    })

    it('reads the stamp without the sealed value', async () => {
      await withTransaction(getPool(), (c) =>
        upsertRivianCredential(c, { sealed: 'jwe-one', account: 'owner@example.com' }))
      const row = await withTransaction(getPool(), (c) => readRivianCredential(c))
      const stamp = await withTransaction(getPool(), (c) => readRivianCredentialStamp(c))

      expect(stamp).toBeInstanceOf(Date)
      expect(stamp?.getTime()).toBe(row?.updatedAt.getTime())
    })

    it('deletes the credential, which is what signing out is', async () => {
      await withTransaction(getPool(), (c) =>
        upsertRivianCredential(c, { sealed: 'jwe-one', account: 'owner@example.com' }))
      await withTransaction(getPool(), (c) => deleteRivianCredential(c))

      expect(await withTransaction(getPool(), (c) => readRivianCredential(c))).toBeNull()
      expect(await withTransaction(getPool(), (c) => readRivianCredentialStamp(c))).toBeNull()
    })

    it('treats deleting an absent credential as done', async () => {
      await expect(
        withTransaction(getPool(), (c) => deleteRivianCredential(c)),
      ).resolves.toBeUndefined()
    })

    it('refuses a second row, whatever the repository would have done', async () => {
      await withTransaction(getPool(), (c) =>
        upsertRivianCredential(c, { sealed: 'jwe-one', account: 'owner@example.com' }))
      await expect(
        getPool().query(
          `INSERT INTO rivian_credential (id, sealed, account) VALUES (2, 'x', 'other@example.com')`),
      ).rejects.toThrow(/rivian_credential_id_check/)
    })
  })

  describe('rivian_status', () => {
    const status = (over: Partial<Parameters<typeof writeRivianStatus>[1]> = {}) => ({
      state: 'subscribed' as RivianConnectorState,
      vin: '7PDSGABA0RN000001',
      rivianVehicleId: '01-abc-def',
      lastFrameAt: new Date('2026-10-19T09:30:00.000Z'),
      lastError: 'Rivian error BAD_USER_INPUT',
      backoffUntil: new Date('2026-10-19T09:45:00.000Z'),
      droppedProperties: ['a', 'b'],
      ...over,
    })

    it('is null before the connector has written anything', async () => {
      expect(await withTransaction(getPool(), (c) => readRivianStatus(c))).toBeNull()
    })

    it('round-trips every field, including the dropped list', async () => {
      await withTransaction(getPool(), (c) => writeRivianStatus(c, status()))

      const row = await withTransaction(getPool(), (c) => readRivianStatus(c))
      expect(row).toMatchObject(status())
      expect(row?.updatedAt).toBeInstanceOf(Date)
    })

    it('reads back the empty list and the nulls as they were written', async () => {
      // "Absent" must come back as null and an empty list as [], never as
      // each other: a null `lastFrameAt` is "no frame yet", which the page
      // says in words, and a `[]` is "nothing dropped", which it says by
      // saying nothing.
      await withTransaction(getPool(), (c) => writeRivianStatus(c, status({
        state: 'signed_out', vin: null, rivianVehicleId: null, lastFrameAt: null,
        lastError: null, backoffUntil: null, droppedProperties: [],
      })))

      const row = await withTransaction(getPool(), (c) => readRivianStatus(c))
      expect(row).toMatchObject({
        state: 'signed_out', vin: null, rivianVehicleId: null, lastFrameAt: null,
        lastError: null, backoffUntil: null, droppedProperties: [],
      })
    })

    it('replaces the whole row on each write, so a cleared field is cleared', async () => {
      // An upsert that left unspecified columns alone would keep a stale
      // `backoffUntil` after the connector reached `subscribed`, and the page
      // would report a car that is streaming as backing off.
      await withTransaction(getPool(), (c) => writeRivianStatus(c, status({ state: 'backing_off' })))
      await sleep(10)
      const before = await withTransaction(getPool(), (c) => readRivianStatus(c))
      await withTransaction(getPool(), (c) => writeRivianStatus(c, status({
        state: 'subscribed', lastError: null, backoffUntil: null, droppedProperties: [],
      })))

      const after = await withTransaction(getPool(), (c) => readRivianStatus(c))
      expect(after).toMatchObject({
        state: 'subscribed', lastError: null, backoffUntil: null, droppedProperties: [],
      })
      expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime())

      const { rows } = await getPool().query('SELECT count(*)::int AS n FROM rivian_status')
      expect(rows[0]?.n).toBe(1)
    })

    it('accepts all nine states', async () => {
      for (const state of STATES) {
        await withTransaction(getPool(), (c) => writeRivianStatus(c, status({ state })))
        const row = await withTransaction(getPool(), (c) => readRivianStatus(c))
        expect(row?.state).toBe(state)
      }
    })

    it('refuses a state the connector does not have', async () => {
      // A misspelt state would otherwise be stored happily and rendered as
      // nothing by the page, which is indistinguishable from a healthy idle.
      await expect(
        withTransaction(getPool(), (c) =>
          writeRivianStatus(c, status({ state: 'subscribd' as RivianConnectorState }))),
      ).rejects.toThrow(/rivian_status_state_check/)
    })

    it('refuses a second row, whatever the repository would have done', async () => {
      await withTransaction(getPool(), (c) => writeRivianStatus(c, status()))
      await expect(
        getPool().query(`INSERT INTO rivian_status (id, state) VALUES (2, 'signed_out')`),
      ).rejects.toThrow(/rivian_status_id_check/)
    })
  })
})
