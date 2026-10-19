import { describe, expect, it, vi } from 'vitest'
import type { DbClient } from '@ev/db'
import type { Config } from '../src/config.js'

// Only the reads and deletes the replay makes are replaced, so that what is
// being asserted is the argument `streamRaw` was given and not a database.
const streamRaw = vi.hoisted(() => vi.fn())
vi.mock('@ev/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ev/db')>()),
  streamRaw,
  findOpenSessions: vi.fn(async () => []),
  ensurePartitions: vi.fn(async () => {}),
  deleteDerived: vi.fn(async () => {}),
}))

import { openOutsideWindow, replayWindow } from '../src/reprocess.js'

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

describe('replayWindow', () => {
  const config: Pick<Config, 'vendor' | 'vehicle' | 'cursorSource' | 'usableCapacityKwh' | 'home'> = {
    vendor: 'tesla',
    vehicle: { id: 'veh-7', vin: null, displayName: 'Seven' },
    cursorSource: 'tesla:mqtt',
    usableCapacityKwh: 75,
    home: null,
  }

  it('replays the configured vehicle\'s tape and no other', async () => {
    // `deleteDerived` clears one vehicle's rows, so a replay that streamed the
    // whole tape would push every OTHER vehicle's messages through this
    // worker's pipeline - and, now there are two vendors, through the wrong
    // vendor's profile.
    streamRaw.mockImplementation(async function* () { /* an empty tape */ })
    const client = {} as DbClient

    const count = await replayWindow(client, config, WINDOW)

    expect(count).toBe(0)
    expect(streamRaw).toHaveBeenCalledTimes(1)
    // The page size is left to streamRaw's default; the vehicle is the fifth argument.
    expect(streamRaw).toHaveBeenCalledWith(client, WINDOW.from, WINDOW.to, undefined, 'veh-7')
  })
})
