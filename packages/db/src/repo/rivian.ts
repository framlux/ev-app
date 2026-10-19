import type { DbClient } from './types.js'

/**
 * The stored Rivian session, as the connector reads it (spec §4.2).
 *
 * `sealed` is a compact JWE the connector alone can open. It is returned to
 * whoever asks and decrypted by whoever holds the private key; this module
 * neither knows nor checks what is inside, which is the point of keeping the
 * crypto out of the database layer. The web pod never calls
 * `readRivianCredential`: it writes the row and cannot read it back, so a
 * compromise of that pod yields the NEXT sign-in and not this one. What it
 * reads for its settings page is `readRivianCredentialSummary`, whose query
 * does not name the `sealed` column.
 */
export interface RivianCredentialRow {
  sealed: string
  /** The email signed in with, for the settings page. Not a secret. */
  account: string
  createdAt: Date
  updatedAt: Date
}

/**
 * The stored credential, or null when nobody is signed in.
 *
 * NULL for "no row" and nothing else. The connector reads a successful query
 * that returns zero rows as `signed_out` and closes its socket (§5.2), so a
 * caller that turned an empty result into a placeholder row, or a failed query
 * into null, would either keep a dead session alive or hang up a live one. A
 * failed query THROWS, and the caller decides that a blip changes nothing.
 *
 * Takes a `DbClient` like every other repository function, so a caller reaches
 * it through `withTransaction(getPool(), …)`.
 */
export async function readRivianCredential(
  c: DbClient,
): Promise<RivianCredentialRow | null> {
  const { rows } = await c.query(
    `SELECT sealed, account, created_at, updated_at
       FROM rivian_credential WHERE id=1`)
  const r = rows[0]
  if (!r) return null
  return {
    sealed: r.sealed,
    account: r.account,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/**
 * Who is signed in and since when, WITHOUT the sealed credential.
 *
 * This is the web pod's reader. The settings page needs the account and the
 * stamps to say "signed in as X since Y", and nothing else, so the query does
 * not name the `sealed` column: the web pod's process never holds the sealed
 * string at all, whatever a later change to the page might otherwise pass on.
 * The sealed JWE is useless without the connector's private key, which is why
 * this is not about a secret leaking today; it is about keeping the rule in
 * the one place a reader cannot forget it, the SELECT list. A web-side reader
 * that could select it would need a reviewer to notice, on every future edit,
 * that the value was not being forwarded.
 *
 * Null for "no row" and nothing else, with the same meaning as in
 * `readRivianCredential`: a failed query throws.
 */
export async function readRivianCredentialSummary(
  c: DbClient,
): Promise<{ account: string; createdAt: Date; updatedAt: Date } | null> {
  const { rows } = await c.query(
    `SELECT account, created_at, updated_at
       FROM rivian_credential WHERE id=1`)
  const r = rows[0]
  if (!r) return null
  return { account: r.account, createdAt: r.created_at, updatedAt: r.updated_at }
}

/**
 * When the credential last changed, and nothing else.
 *
 * The connector's 15 s poll asks this, not `readRivianCredential`: it needs to
 * know whether the row moved, and fetching a JWE every fifteen seconds all day
 * to compare one timestamp would put the sealed value on the wire (and in a
 * driver's row buffer) a few thousand times a day for no reason. Only a stamp
 * that differs from the one it holds makes it read the value.
 *
 * Null means no row, with the same meaning as in `readRivianCredential`.
 */
export async function readRivianCredentialStamp(c: DbClient): Promise<Date | null> {
  const { rows } = await c.query(
    `SELECT updated_at FROM rivian_credential WHERE id=1`)
  return rows[0]?.updated_at ?? null
}

/**
 * Store a sealed credential, replacing any that was there.
 *
 * `updated_at = now()` is written EXPLICITLY on the update branch. The column's
 * default fires on INSERT only, so an upsert that merely replaced `sealed`
 * would leave the stamp where the last sign-in put it, and the connector - which
 * detects a new session by a changed stamp and by nothing else (§5.2) - would
 * never learn that a user had signed in again. That is the failure that leaves
 * a connector in `unauthenticated` for good after the owner has already fixed
 * it.
 *
 * `created_at` is left alone on update: it records when this account was first
 * connected, not when it was last refreshed.
 *
 * The caller seals first. Nothing here receives a plaintext token, and nothing
 * here may log `sealed`: it is useless without the private key, but there is no
 * reason for it to be anywhere else.
 */
export async function upsertRivianCredential(
  c: DbClient, v: { sealed: string; account: string },
): Promise<void> {
  await c.query(
    `INSERT INTO rivian_credential (id, sealed, account)
     VALUES (1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET
       sealed     = EXCLUDED.sealed,
       account    = EXCLUDED.account,
       updated_at = now()`,
    [v.sealed, v.account],
  )
}

/**
 * Sign out: remove the credential.
 *
 * Deleting an absent row is not an error, because a second click on "sign out"
 * (or a retry after a timeout whose first attempt had in fact succeeded) is
 * asking for a state that already holds. The connector notices within its poll
 * interval, sees a successful query with zero rows, and closes the socket.
 */
export async function deleteRivianCredential(c: DbClient): Promise<void> {
  await c.query(`DELETE FROM rivian_credential WHERE id=1`)
}

/**
 * Where the connector is, in §5.2's own words. Mirrors the CHECK on
 * `rivian_status.state`; a state added here without a migration is refused by
 * the database at the first write, which is the intended way to find out.
 */
export type RivianConnectorState =
  | 'signed_out' | 'starting' | 'credential_invalid' | 'finding_vehicle'
  | 'waiting_for_vehicle' | 'connecting' | 'subscribed' | 'backing_off'
  | 'unauthenticated'

/**
 * What the connector last reported about itself (spec §5.7).
 *
 * `lastError` is the §4.4 REDACTED message and nothing else: the Rivian
 * client's error type is built so that no token, password, OTP or body can be
 * in it, and this module stores whatever it is handed without looking. The
 * redaction has to happen before this call, once, at the source - a string
 * assembled here from anything else would sit outside it.
 */
export interface RivianStatusRow {
  state: RivianConnectorState
  vin: string | null
  rivianVehicleId: string | null
  lastFrameAt: Date | null
  lastError: string | null
  backoffUntil: Date | null
  /** `[]` is "nothing dropped"; it is never null, so it is never "unknown". */
  droppedProperties: string[]
  updatedAt: Date
}

/**
 * The connector's last status, or null before it has written one.
 *
 * NULL rather than a zero-valued row, for the reason `readTelemetryStatus`
 * returns null: "the connector has never reported" and "the connector reported
 * `signed_out`" are different sentences, and the page prints both. A row
 * invented here would claim an observation nobody made.
 */
export async function readRivianStatus(c: DbClient): Promise<RivianStatusRow | null> {
  const { rows } = await c.query(
    `SELECT state, vin, rivian_vehicle_id, last_frame_at, last_error,
            backoff_until, dropped_properties, updated_at
       FROM rivian_status WHERE id=1`)
  const r = rows[0]
  if (!r) return null
  return {
    state: r.state,
    vin: r.vin,
    rivianVehicleId: r.rivian_vehicle_id,
    lastFrameAt: r.last_frame_at,
    lastError: r.last_error,
    backoffUntil: r.backoff_until,
    droppedProperties: r.dropped_properties,
    updatedAt: r.updated_at,
  }
}

/**
 * Record the connector's status, replacing the whole row.
 *
 * Every field is REQUIRED, with `null` said explicitly, and every column is
 * assigned on conflict - unlike `recordTelemetryCheck`'s partial writers, here
 * there is exactly one writer and it always knows the full picture. A write
 * that left an unspecified column alone would keep a stale `backoff_until`
 * after the connector reached `subscribed`, and the page would report a car
 * that is streaming as backing off.
 *
 * `updated_at = now()` on every write, explicitly, so the page can say how old
 * the report is: "subscribed, as of an hour ago" is a different statement from
 * "subscribed".
 *
 * Best-effort by contract (§5.7): this throws on a failed write and the
 * connector logs it and retries with its next change. It must never be on the
 * socket's critical path, and nothing here makes it so.
 */
export async function writeRivianStatus(
  c: DbClient, s: Omit<RivianStatusRow, 'updatedAt'>,
): Promise<void> {
  await c.query(
    `INSERT INTO rivian_status (
       id, state, vin, rivian_vehicle_id, last_frame_at, last_error,
       backoff_until, dropped_properties, updated_at)
     VALUES (1,$1,$2,$3,$4,$5,$6,$7::text[],now())
     ON CONFLICT (id) DO UPDATE SET
       state              = EXCLUDED.state,
       vin                = EXCLUDED.vin,
       rivian_vehicle_id  = EXCLUDED.rivian_vehicle_id,
       last_frame_at      = EXCLUDED.last_frame_at,
       last_error         = EXCLUDED.last_error,
       backoff_until      = EXCLUDED.backoff_until,
       dropped_properties = EXCLUDED.dropped_properties,
       updated_at         = now()`,
    [s.state, s.vin, s.rivianVehicleId, s.lastFrameAt, s.lastError,
      s.backoffUntil, s.droppedProperties],
  )
}
