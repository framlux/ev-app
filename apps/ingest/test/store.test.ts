import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeSample } from '@ev/core'
import type { DbClient } from '@ev/db'
import type { Store } from '../src/pipeline.js'
import { replayStoreOn, storeOn } from '../src/store.js'

/**
 * Which sample-writing statement each caller gets (spec §4's last row).
 *
 * The two paths are one line apart and their difference is invisible at
 * runtime: both write a row, and the wrong one merely fails to write the
 * columns the backfill exists for. So the seam is tested rather than trusted.
 */
class RecordingClient {
  readonly sql: string[] = []
  async query(text: string): Promise<{ rows: unknown[] }> {
    this.sql.push(text)
    return { rows: [] }
  }
}

const sample = makeSample({
  vehicleId: 'v1', ts: new Date('2026-09-20T10:00:00.000Z'), socPct: 80, gear: 'D',
})

/** The SQL one store issues for one sample. */
async function sqlFor(bind: (c: DbClient, source: string) => Store): Promise<string> {
  const client = new RecordingClient()
  await bind(client as unknown as DbClient, 'test').insertSample(sample)
  return client.sql.join('\n')
}

describe('the sample write path', () => {
  it('leaves the live path doing nothing on a redelivery', async () => {
    const sql = await sqlFor(storeOn)
    expect(sql).toContain('ON CONFLICT (vehicle_id, ts) DO NOTHING')
    expect(sql).not.toContain('DO UPDATE')
  })

  it('gives the replay path an explicit update', async () => {
    const sql = await sqlFor(replayStoreOn)
    expect(sql).toContain('ON CONFLICT (vehicle_id, ts) DO UPDATE SET')
    expect(sql).toContain('gear = COALESCE(EXCLUDED.gear, sample.gear)')
  })

  it('changes nothing else about the store', () => {
    const client = new RecordingClient() as unknown as DbClient
    expect(Object.keys(replayStoreOn(client, 'test')))
      .toEqual(Object.keys(storeOn(client, 'test')))
  })

  /**
   * Read as text because `reprocess.ts`'s replay lives inside `main()`, which
   * loads the config and opens a pool; there is nothing to call that does not
   * need a database. The wiring is one identifier, and getting it wrong writes
   * every row and backfills nothing.
   */
  it('is what reprocess wires up', () => {
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'reprocess.ts'),
      'utf8',
    )
    // The call, not a mention: the comment above it names both.
    expect(source).toMatch(/fn\(replayStoreOn\(/)
    expect(source).not.toMatch(/fn\(storeOn\(/)
  })
})
