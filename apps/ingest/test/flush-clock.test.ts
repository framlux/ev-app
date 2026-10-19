import { describe, expect, it } from 'vitest'
import { flushClock } from '../src/flush-clock.js'

const WALL = Date.parse('2026-10-19T12:00:00.000Z')
const MIN = 60_000

describe('flushClock', () => {
  it('is wall time before any message has been seen', () => {
    const clock = flushClock(() => WALL)
    expect(clock.now()).toEqual(new Date(WALL))
  })

  it('runs behind wall time by how stale the newest message was', () => {
    // A backlog drain: the connector stamped this ten minutes ago. Judged against
    // our wall clock every pending burst would look overdue and be written alone.
    const clock = flushClock(() => WALL)
    clock.observe(new Date(WALL - 10 * MIN))
    expect(clock.now()).toEqual(new Date(WALL - 10 * MIN))
  })

  it('is wall time when the newest message is current', () => {
    // Tesla's stamp IS arrival time, so the skew is nothing and nothing changes.
    const clock = flushClock(() => WALL)
    clock.observe(new Date(WALL))
    expect(clock.now()).toEqual(new Date(WALL))
  })

  it('keeps the offset while wall time moves on, and follows the latest message', () => {
    let wall = WALL
    const clock = flushClock(() => wall)
    clock.observe(new Date(WALL - 10 * MIN))

    wall += 3 * MIN
    expect(clock.now()).toEqual(new Date(WALL - 7 * MIN))

    // The drain catches up: the next stamp is only a minute old.
    clock.observe(new Date(wall - MIN))
    expect(clock.now()).toEqual(new Date(wall - MIN))
  })

  it('runs ahead of wall time when the connector\'s clock is ahead of ours', () => {
    const clock = flushClock(() => WALL)
    clock.observe(new Date(WALL + 2 * MIN))
    expect(clock.now()).toEqual(new Date(WALL + 2 * MIN))
  })

  it('ignores a stamp that is not a date, rather than poisoning the clock', () => {
    const clock = flushClock(() => WALL)
    clock.observe(new Date(WALL - 5 * MIN))
    clock.observe(new Date(Number.NaN))
    expect(clock.now()).toEqual(new Date(WALL - 5 * MIN))
  })

  it('reads the real clock by default', () => {
    const before = Date.now()
    const t = flushClock().now().getTime()
    expect(t).toBeGreaterThanOrEqual(before)
    expect(t).toBeLessThanOrEqual(Date.now())
  })
})
