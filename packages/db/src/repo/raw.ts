import type { RawMessage } from '@ev/core'
import type { DbClient } from './types.js'

/**
 * Append to the replay tape. Every derived table is rebuildable from this one,
 * so this insert happens before anything derived and inside the same
 * transaction: a crash must never leave a sample whose raw message is missing.
 */
export async function insertRaw(c: DbClient, m: RawMessage): Promise<void> {
  await c.query(
    `INSERT INTO raw_message (vehicle_id, received_at, vendor, source, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [m.vehicleId, m.receivedAt, m.vendor, m.source, JSON.stringify(m.payload)],
  )
}

export interface RawRow {
  id: string
  vehicleId: string
  vendor: RawMessage['vendor']
  source: RawMessage['source']
  receivedAt: Date
  payload: unknown
}

/**
 * Stream the tape for a window, oldest first. Used by the reprocess entrypoint;
 * ordering is what lets a forward-only segmenter rebuild history correctly.
 * `to` is exclusive so that adjacent windows neither overlap nor leave a hole.
 */
export async function* streamRaw(
  c: DbClient,
  from: Date,
  to: Date,
  batchSize = 1000,
): AsyncGenerator<RawRow> {
  let afterAt = from
  let afterId = '0'
  for (;;) {
    const { rows } = await c.query(
      `SELECT id, vehicle_id, vendor, source, received_at, payload
         FROM raw_message
        WHERE received_at >= $1 AND received_at < $2
          AND (received_at, id) > ($3, $4)
        ORDER BY received_at, id
        LIMIT $5`,
      [afterAt, to, afterAt, afterId, batchSize],
    )
    if (rows.length === 0) return
    for (const r of rows) {
      yield {
        id: String(r.id),
        vehicleId: r.vehicle_id,
        vendor: r.vendor,
        source: r.source,
        receivedAt: r.received_at,
        payload: r.payload,
      }
    }
    // Keyset pagination, not OFFSET: the tape is being appended to while this
    // runs, and OFFSET would skip rows as earlier pages grow.
    const last = rows[rows.length - 1]
    afterAt = last.received_at
    afterId = String(last.id)
  }
}
