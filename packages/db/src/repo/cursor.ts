import type { DbClient } from './types.js'

export interface Cursor {
  lastProcessedAt: Date
  lastMessageId: string | null
}

export async function readCursor(c: DbClient, source: string): Promise<Cursor | null> {
  const { rows } = await c.query(
    `SELECT last_processed_at, last_message_id FROM ingest_cursor WHERE source=$1`,
    [source])
  const r = rows[0]
  return r ? { lastProcessedAt: r.last_processed_at, lastMessageId: r.last_message_id } : null
}

/**
 * Move the watermark forward, never backwards.
 *
 * The GREATEST guard is what makes this safe under MQTT redelivery: after a
 * crash the broker replays messages we already committed, and an unguarded
 * assignment would rewind the watermark to a point history has already passed.
 * The cursor is written inside the same transaction as the rows it describes,
 * so it can never claim progress that was rolled back.
 *
 * It is deliberately NOT used to skip messages. Records can arrive out of order
 * after the car replays its own buffer, and gating on the watermark would
 * discard a genuinely new late message as though it were a redelivery;
 * idempotency comes from ON CONFLICT DO NOTHING instead. What the watermark is
 * for is answering "how far did the tape get" — the default `--from` of a
 * reprocess run, and an operator's first question after an outage.
 */
export async function advanceCursor(
  c: DbClient, source: string, at: Date, messageId: string | null = null,
): Promise<void> {
  await c.query(
    `INSERT INTO ingest_cursor (source, last_processed_at, last_message_id)
     VALUES ($1,$2,$3)
     ON CONFLICT (source) DO UPDATE SET
       last_processed_at = GREATEST(ingest_cursor.last_processed_at, EXCLUDED.last_processed_at),
       last_message_id   = CASE
         WHEN EXCLUDED.last_processed_at >= ingest_cursor.last_processed_at
           THEN EXCLUDED.last_message_id ELSE ingest_cursor.last_message_id END`,
    [source, at, messageId],
  )
}
