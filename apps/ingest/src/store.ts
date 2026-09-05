import {
  advanceCursor,
  appendPoint,
  closeSession,
  ensurePartitions,
  insertRaw,
  insertSample,
  openSession,
  upsertBatteryHealth,
  withTransaction,
  type DbClient,
  type DbPool,
} from '@ev/db'
import type { Store, StoreRunner } from './pipeline.js'

/** Bind the repo layer's (client, ...) functions to one connection. */
export function storeOn(client: DbClient, cursorSource: string): Store {
  return {
    ensurePartitions: (when) => ensurePartitions(client, when),
    insertRaw: (m) => insertRaw(client, m),
    insertSample: (s) => insertSample(client, s),
    openSession: (kind, vehicleId, at) => openSession(client, vehicleId, kind, at),
    appendPoint: (sessionId, s) => appendPoint(client, sessionId, s),
    closeSession: (sessionId, summary) => closeSession(client, sessionId, summary),
    recordBatteryHealth: (row) => upsertBatteryHealth(client, row),
    advanceCursor: (at) => advanceCursor(client, cursorSource, at),
  }
}

/**
 * One `run()` is one transaction. Everything a single MQTT message produces —
 * the raw row, its samples, the session rows, the watermark — commits together
 * or not at all, which is what lets the caller ack only after a commit.
 */
export function pgRunner(pool: DbPool, cursorSource: string): StoreRunner {
  return {
    run: (fn) => withTransaction(pool, (client) => fn(storeOn(client, cursorSource))),
  }
}
