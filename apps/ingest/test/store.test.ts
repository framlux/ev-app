import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeSample } from '@ev/core'
import type { DbClient } from '@ev/db'
import type { Store } from '../src/pipeline.js'
import { STALE_VALUE_MS } from '../src/pipeline.js'
import { replayStoreOn, resumeOrStartCold, resumeWindowStart, storeOn } from '../src/store.js'

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

  /**
   * A replay READS the tape, so writing each message back onto it doubles the
   * tape - and the copy carries the same received_at with a higher id, so
   * streamRaw's keyset page reads it straight back and the replay never ends.
   */
  it('does not write the tape it is replaying', async () => {
    const client = new RecordingClient()
    await replayStoreOn(client as unknown as DbClient, 'test').insertRaw({
      vehicleId: 'v1',
      vendor: 'tesla',
      receivedAt: new Date('2026-09-20T10:00:00.000Z'),
      source: 'telemetry',
      payload: { kind: 'metrics', vin: 'VIN', field: 'Soc', value: 80 },
    })
    expect(client.sql).toEqual([])
  })

  /**
   * The cursor row is the live worker's. A replay is one long transaction, so
   * writing it held that row's lock for the whole rebuild and stalled every
   * live message behind it - with a deadlock waiting at the tail, where the
   * replay's upsert meets a sample the blocked live transaction already wrote.
   */
  it('does not move the live cursor', async () => {
    const client = new RecordingClient()
    await replayStoreOn(client as unknown as DbClient, 'test')
      .advanceCursor(new Date('2026-09-20T10:00:00.000Z'))
    expect(client.sql).toEqual([])
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

describe('resumeWindowStart', () => {
  const now = new Date('2026-09-26T21:33:00.000Z')
  const hours = (h: number) => h * 60 * 60_000

  it('replays the carried-value window when nothing is open', () => {
    expect(resumeWindowStart([], now)).toEqual(new Date(now.getTime() - STALE_VALUE_MS))
  })

  it('reaches back to warm up before the earliest open session', () => {
    const started = new Date('2026-09-26T16:00:45.454Z')
    const open = [
      { id: 'd', kind: 'drive' as const, startedAt: new Date('2026-09-26T21:00:00.000Z') },
      { id: 'c', kind: 'charge' as const, startedAt: started },
    ]
    expect(resumeWindowStart(open, now)).toEqual(new Date(started.getTime() - STALE_VALUE_MS))
  })

  it('stops at two days, leaving an older row to be abandoned', () => {
    const open = [{ id: 'o', kind: 'drive' as const, startedAt: new Date(now.getTime() - hours(24 * 9)) }]
    expect(resumeWindowStart(open, now)).toEqual(new Date(now.getTime() - hours(48)))
  })
})

describe('resumeOrStartCold', () => {
  /**
   * main()'s catch exits, so a resume that threw there would crash-loop and
   * ingest nothing - the six-day outage again. A worker that cannot resume
   * must start cold instead, on a pipeline the failed replay never touched.
   */
  it('starts on a fresh pipeline when the resume fails', async () => {
    const made: object[] = []
    const make = () => { const p = { n: made.length }; made.push(p); return p }
    const errors: unknown[] = []
    const started = await resumeOrStartCold(
      make, async () => { throw new Error('tape unreadable') }, (e) => errors.push(e))
    expect(made).toHaveLength(2)
    expect(started.pipeline).toBe(made[1])
    expect(started.report).toBeNull()
    expect(errors).toHaveLength(1)
  })

  it('keeps the resumed pipeline and its report when the resume succeeds', async () => {
    const made: object[] = []
    const make = () => { const p = { n: made.length }; made.push(p); return p }
    const report = { replayed: 3, resumed: null, closed: [], abandoned: [] }
    const started = await resumeOrStartCold(make, async () => report, () => {})
    expect(made).toHaveLength(1)
    expect(started).toEqual({ pipeline: made[0], report })
  })
})
