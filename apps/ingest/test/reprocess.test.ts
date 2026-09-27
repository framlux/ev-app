import { describe, expect, it } from 'vitest'
import { openOutsideWindow } from '../src/reprocess.js'

const t = (iso: string) => new Date(iso)
const WINDOW = { from: t('2026-09-19T13:00:00.000Z'), to: t('2026-09-26T21:30:00.000Z') }

/**
 * A replay deletes the sessions that START inside its window and rebuilds them,
 * but `openSession` adopts whatever row of that kind is already open. So a
 * session left open outside the window swallows the first rebuilt session of
 * its kind: that is how a Sep 12 charge was once written onto a Sep 26 row.
 */
describe('openOutsideWindow', () => {
  it('passes a session that is open inside the window, which the replay rebuilds', () => {
    const open = [{ id: 'c', kind: 'charge' as const, startedAt: t('2026-09-26T16:00:45.000Z') }]
    expect(openOutsideWindow(open, WINDOW)).toEqual([])
  })

  it('names a session that opened before the window', () => {
    const open = [{ id: 'd', kind: 'drive' as const, startedAt: t('2026-09-19T12:59:59.000Z') }]
    expect(openOutsideWindow(open, WINDOW)).toEqual(open)
  })

  it('names a session that opened at or after the end of the window', () => {
    const open = [{ id: 'c', kind: 'charge' as const, startedAt: t('2026-09-26T21:30:00.000Z') }]
    expect(openOutsideWindow(open, WINDOW)).toEqual(open)
  })
})
