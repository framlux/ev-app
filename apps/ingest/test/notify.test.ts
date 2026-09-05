import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { vehicleChangeFrom } from '../src/store.js'

const TS = new Date('2026-09-05T10:00:00.000Z')

const result = (over: Record<string, unknown> = {}) => ({
  samples: 0, sessionsOpened: 0, sessionsClosed: 0,
  fieldsApplied: 0, unmapped: 0, lastSampleTs: null,
  ...over,
})

describe('vehicleChangeFrom', () => {
  it('notifies for a transaction that wrote a sample', () => {
    expect(vehicleChangeFrom(result({ samples: 1, lastSampleTs: TS }), 'v1')).toEqual({
      vehicleId: 'v1', ts: TS.toISOString(), kind: 'sample',
    })
  })

  it('reports kind "session" when a session opened or closed', () => {
    expect(vehicleChangeFrom(result({ samples: 1, sessionsOpened: 1, lastSampleTs: TS }), 'v1')?.kind)
      .toBe('session')
    expect(vehicleChangeFrom(result({ samples: 1, sessionsClosed: 1, lastSampleTs: TS }), 'v1')?.kind)
      .toBe('session')
  })

  /**
   * The reason the notify is keyed off the result rather than issued once per
   * transaction. fleet-telemetry publishes ONE FIELD PER MESSAGE and the
   * accumulator debounces a burst into one sample, so transactions outnumber
   * samples by roughly ten to one and most of them write nothing anyone can
   * see. Notifying per transaction would make the web tier re-query for an
   * unchanged answer nine times out of ten.
   */
  it('does NOT notify for a message that only fed the accumulator', () => {
    expect(vehicleChangeFrom(result({ fieldsApplied: 1 }), 'v1')).toBeNull()
  })

  it('does NOT notify for an unmapped message', () => {
    expect(vehicleChangeFrom(result({ unmapped: 1 }), 'v1')).toBeNull()
  })

  it('returns null for anything that is not a PipelineResult', () => {
    for (const bad of [null, undefined, 'x', 42, {}, []]) {
      expect(vehicleChangeFrom(bad, 'v1')).toBeNull()
    }
  })
})

describe('pgRunner', () => {
  function fakePool(): { pool: any; sql: string[] } {
    const sql: string[] = []
    const client = {
      query: async (text: string) => { sql.push(text); return { rows: [] } },
      release: () => undefined,
    }
    return { pool: { connect: async () => client } as any, sql }
  }

  it('notifies inside the transaction when a sample was written', async () => {
    const { pool, sql } = fakePool()
    const { pgRunner } = await import('../src/store.js')
    await pgRunner(pool, 'test', 'v1').run(async () => ({
      samples: 1, sessionsOpened: 0, sessionsClosed: 0,
      fieldsApplied: 0, unmapped: 0, lastSampleTs: TS,
    }))
    const notifyAt = sql.findIndex((s) => s.includes('pg_notify'))
    expect(notifyAt).toBeGreaterThan(-1)
    expect(sql[0]).toBe('BEGIN')
    expect(sql[sql.length - 1]).toBe('COMMIT')
    expect(notifyAt).toBeLessThan(sql.length - 1)
  })

  it('does not notify when the transaction rolls back', async () => {
    const { pool, sql } = fakePool()
    const { pgRunner } = await import('../src/store.js')
    await pgRunner(pool, 'test', 'v1')
      .run(async () => { throw new Error('boom') })
      .catch(() => undefined)
    expect(sql.some((s) => s.includes('pg_notify'))).toBe(false)
    expect(sql).toContain('ROLLBACK')
  })

  it('does not notify for a message that only fed the accumulator', async () => {
    const { pool, sql } = fakePool()
    const { pgRunner } = await import('../src/store.js')
    await pgRunner(pool, 'test', 'v1').run(async () => ({
      samples: 0, sessionsOpened: 0, sessionsClosed: 0,
      fieldsApplied: 1, unmapped: 0, lastSampleTs: null,
    }))
    expect(sql.some((s) => s.includes('pg_notify'))).toBe(false)
  })
})

/**
 * The property the runner placement exists for, pinned so a later refactor
 * that "tidies" the notify onto the Store fails here instead of in production
 * during a tape replay.
 */
describe('reprocess', () => {
  it('constructs its own runner and therefore cannot notify', () => {
    const src = readFileSync(new URL('../src/reprocess.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/pgRunner/)
    expect(src).toMatch(/run:\s*\(fn\)\s*=>\s*fn\(storeOn\(/)
  })

  it('keeps the notify out of the Store interface', () => {
    const src = readFileSync(new URL('../src/pipeline.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/notify/i)
  })
})
