import {
  readRivianCredential,
  readRivianCredentialStamp,
  readRivianStatus,
  withTransaction,
  writeRivianStatus,
  type DbPool,
  type RivianStatusRow,
} from '@ev/db'

/**
 * THE CONNECTOR'S ONLY WAY TO REACH POSTGRES (design §5.2, §5.7).
 *
 * A seam, so that `connector.ts` is tested without a database: the tests hand
 * it a store whose methods answer, hang or throw on command. The shape is also
 * a statement about how little the connector may do to the database. It reads
 * a stamp, reads the sealed credential, reads and writes one status row, and
 * that is all. Nothing on this list is on the websocket's critical path, and
 * the connector is built so that none of it can be: a failed call here costs a
 * poll, never a socket.
 *
 * Every method throws on a failed query, and a successful query that finds
 * nothing says so with `null`. The two are different facts and the connector
 * acts on them differently (a blip changes nothing; an empty answer is
 * `signed_out`), so no method here turns one into the other.
 */
export interface ConnectorStore {
  /** When the credential last changed; null for no row. Throws on query failure. */
  credentialStamp(): Promise<Date | null>
  /**
   * The saved status row, read once, in `starting`, for the dropped-property
   * list the last run found. Null for no row. A failure means the connector
   * does not know the list, which is a different thing from there being none.
   */
  status(): Promise<RivianStatusRow | null>
  /** The sealed credential; null for no row. The account's email is not returned. */
  credential(): Promise<{ sealed: string } | null>
  /** Replace the status row. Fire-and-forget on the connector's side. */
  writeStatus(s: Omit<RivianStatusRow, 'updatedAt'>): Promise<void>
}

export function pgConnectorStore(pool: DbPool): ConnectorStore {
  // `withTransaction` for the reads as well as the write: it is the one way the
  // repository functions are reached everywhere else in this repo, it releases
  // the connection however the query ends, and a single statement costs nothing
  // extra inside one.
  return {
    credentialStamp: () => withTransaction(pool, (c) => readRivianCredentialStamp(c)),
    status: () => withTransaction(pool, (c) => readRivianStatus(c)),
    credential: async () => {
      const row = await withTransaction(pool, (c) => readRivianCredential(c))
      return row === null ? null : { sealed: row.sealed }
    },
    writeStatus: (s) => withTransaction(pool, (c) => writeRivianStatus(c, s)),
  }
}
