import { describe, expect, it } from 'vitest'
import { BACKOFF_CAP_MS, BACKOFF_FLOOR_MS, Backoff } from '../src/backoff.js'

/** Draw `n` delays from a fresh backoff whose jitter source always says `r`. */
function delays(r: number, n: number): number[] {
  const backoff = new Backoff(() => r)
  return Array.from({ length: n }, () => backoff.next())
}

describe('Backoff', () => {
  it('doubles from 30 s and stops at 900 s when there is no jitter', () => {
    expect(delays(0, 8)).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000,
    ])
  })

  it('adds up to one more floor of jitter, and the cap still holds', () => {
    // random() = 1 is the top of the jitter range (the real source never quite
    // reaches it), so these are the largest delays a given attempt can draw.
    expect(delays(1, 8)).toEqual([
      60_000, 90_000, 150_000, 270_000, 510_000, 900_000, 900_000, 900_000,
    ])
  })

  it('scales the jitter by the draw', () => {
    expect(delays(0.5, 2)).toEqual([45_000, 75_000])
  })

  it('counts the attempts it has handed out, and reset starts the climb over', () => {
    const backoff = new Backoff(() => 0)
    expect(backoff.attempt).toBe(0)
    backoff.next()
    backoff.next()
    expect(backoff.attempt).toBe(2)
    backoff.reset()
    expect(backoff.attempt).toBe(0)
    expect(backoff.next()).toBe(30_000)
  })

  it('never hands out less than the floor, however the jitter source misbehaves', () => {
    // A jitter source that returns NaN or a negative would otherwise give a
    // timer of NaN or under 30 s, and a timer of NaN fires at once: the very
    // reconnect storm this class exists to prevent.
    for (const r of [0, 0.25, 0.999999, 1, -5, Number.NaN, Number.NEGATIVE_INFINITY, 7]) {
      for (const d of delays(r, 12)) {
        expect(d, `draw ${r}`).toBeGreaterThanOrEqual(BACKOFF_FLOOR_MS)
        expect(d, `draw ${r}`).toBeLessThanOrEqual(BACKOFF_CAP_MS)
      }
    }
  })

  it('stays at the cap after thousands of failures', () => {
    // 2 ** attempt overflows to Infinity near attempt 1024; the cap must still
    // win, and not turn into NaN.
    const backoff = new Backoff(() => 0.3)
    let last = 0
    for (let i = 0; i < 3000; i++) last = backoff.next()
    expect(last).toBe(BACKOFF_CAP_MS)
  })

  it('draws jitter from Math.random by default', () => {
    const d = new Backoff().next()
    expect(d).toBeGreaterThanOrEqual(30_000)
    expect(d).toBeLessThan(60_000)
  })
})
