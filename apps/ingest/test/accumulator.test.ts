import { describe, expect, it } from 'vitest'
import { FieldAccumulator, STALE_VALUE_MS, VOLATILE_STALE_MS } from '../src/pipeline.js'
import type { VendorProfile } from '../src/profile.js'

/**
 * `observedAt` is the one thing Tesla never sets, so nothing in pipeline.test.ts
 * reaches it. These tests drive the accumulator with a small profile of its own
 * rather than a vendor's: `power` and `speed` are volatile, `state` is the charge
 * state a sign of charging refreshes, `energy` is a counter, everything else is a
 * level.
 */
const profile: VendorProfile = {
  vendor: 'rivian',
  decode: () => null,
  toSample: () => { throw new Error('the accumulator never builds a sample') },
  staleWindowFor: (slot) => (slot === 'speed' || slot === 'power' ? VOLATILE_STALE_MS : STALE_VALUE_MS),
  chargeStateSlots: ['state'],
  chargingPowerSlots: ['power'],
  chargingEnergySlots: ['energy'],
}

const HOUR = 60 * 60_000
const at = (ms: number) => new Date(ms)
const fresh = () => new FieldAccumulator(profile)

/** The state a sample would carry if a bare frame arrived at `arrival`. */
function carried(acc: FieldAccumulator, arrival: number): Record<string, unknown> {
  acc.apply({ slots: { odometer: 1 } }, at(arrival))
  return acc.take()?.state ?? {}
}

describe('FieldAccumulator: the vehicle\'s own observation time', () => {
  it('stamps a value observed in the future at its arrival, never later', () => {
    // A vehicle clock ahead of ours must not make a value look fresher than the
    // frame that carried it. Unclamped, this speed would be "observed" at
    // 10,000,000 and still be carried an hour later.
    const expired = fresh()
    expired.apply({ slots: { speed: 50 }, observedAt: { speed: 10_000_000 } }, at(1_000))
    expect(carried(expired, 1_000 + VOLATILE_STALE_MS).speed).toBeUndefined()

    const held = fresh()
    held.apply({ slots: { speed: 50 }, observedAt: { speed: 10_000_000 } }, at(1_000))
    expect(carried(held, 1_000 + VOLATILE_STALE_MS - 1).speed).toBe(50)
  })

  it('carries from the observation, not from the arrival', () => {
    // A re-sent snapshot: the car saw this speed long ago and we are only now
    // hearing it. It is already stale on arrival.
    const acc = fresh()
    acc.apply({ slots: { speed: 50 }, observedAt: { speed: 0 } }, at(VOLATILE_STALE_MS))
    expect(carried(acc, VOLATILE_STALE_MS).speed).toBeUndefined()
  })

  it('does not let an older observation overwrite a newer one', () => {
    const acc = fresh()
    acc.apply({ slots: { speed: 50 }, observedAt: { speed: 2_000 } }, at(3_000))
    acc.apply({ slots: { speed: 99 }, observedAt: { speed: 1_000 } }, at(4_000))
    expect(carried(acc, 4_000).speed).toBe(50)

    // ... and a newer one still does.
    acc.apply({ slots: { speed: 60 }, observedAt: { speed: 3_500 } }, at(4_500))
    expect(carried(acc, 4_500).speed).toBe(60)
  })

  it('applies a different value at the same observation instant', () => {
    const acc = fresh()
    acc.apply({ slots: { speed: 50 }, observedAt: { speed: 1_000 } }, at(1_000))
    acc.apply({ slots: { speed: 60 }, observedAt: { speed: 1_000 } }, at(1_000))
    expect(carried(acc, 1_000).speed).toBe(60)
  })

  it('treats the same value at the same observation instant as a replay, and leaves it alone', () => {
    // The charge refresh moved `state`'s `at` to 4h. Replaying the very same
    // observation must not put it back at 1s, or the carry window the refresh
    // bought is gone: at 10h - 1ms the refreshed state is 6h - 1ms old and
    // carried; rewritten, it would be nearly 10h old and expired.
    const acc = fresh()
    acc.apply({ slots: { state: 'charging' }, observedAt: { state: 1_000 } }, at(1_000))
    acc.apply({ slots: { power: 7 } }, at(4 * HOUR))
    acc.apply({ slots: { state: 'charging' }, observedAt: { state: 1_000 } }, at(5 * HOUR))
    expect(carried(acc, 10 * HOUR - 1).state).toBe('charging')
  })

  it('compares structured values by content, not identity', () => {
    // A replay builds a fresh object for the same reading. Compared by identity
    // it would look like news, and rewrite the refreshed entry as above.
    const acc = fresh()
    acc.apply({ slots: { state: { mode: 'charging' } }, observedAt: { state: 1_000 } }, at(1_000))
    acc.apply({ slots: { power: 7 } }, at(4 * HOUR))
    acc.apply({ slots: { state: { mode: 'charging' } }, observedAt: { state: 1_000 } }, at(5 * HOUR))
    expect(carried(acc, 10 * HOUR - 1).state).toEqual({ mode: 'charging' })
  })
})

describe('FieldAccumulator: the charge refresh and the observation guard', () => {
  it('keeps a refreshed charge state ahead of an older replay of it', () => {
    // The sequence the guard exists for. `state` is observed at T1; a power frame
    // refreshes it (moving `at`, not `observed`); then a re-sent snapshot brings
    // an OLDER observation of the same slot. If the refresh forgot `observed`,
    // the guard would have nothing to compare and the old value would win.
    const acc = fresh()
    acc.apply({ slots: { state: 'charging' }, observedAt: { state: 2_000 } }, at(2_000))
    acc.apply({ slots: { power: 7 } }, at(3_000))
    acc.apply({ slots: { state: 'idle' }, observedAt: { state: 1_000 } }, at(4_000))
    expect(carried(acc, 4_000).state).toBe('charging')
  })

  it('does not let a skipped older power value refresh the charge state', () => {
    // `state` was observed at 0 and would expire at 6h. `power` was observed at
    // 2s; the frame at 6h replays an older, positive power. A replay is not the
    // car saying it is charging, so `state` must still expire.
    const acc = fresh()
    acc.apply({ slots: { state: 'charging', power: 0 }, observedAt: { state: 0, power: 2_000 } }, at(2_000))
    acc.apply({ slots: { power: 7 }, observedAt: { power: 1_000 } }, at(STALE_VALUE_MS))
    expect(acc.take()?.state.state).toBeUndefined()
  })

  it('does refresh it when the same power value is observed newer', () => {
    // The control for the test above: same shapes, but the power really is newer.
    const acc = fresh()
    acc.apply({ slots: { state: 'charging', power: 0 }, observedAt: { state: 0, power: 2_000 } }, at(2_000))
    acc.apply({ slots: { power: 7 }, observedAt: { power: 3_000 } }, at(STALE_VALUE_MS))
    expect(acc.take()?.state.state).toBe('charging')
  })

  it('does not let a skipped older energy counter refresh the charge state', () => {
    const acc = fresh()
    acc.apply({ slots: { state: 'charging', energy: 10 }, observedAt: { state: 0, energy: 2_000 } }, at(2_000))
    acc.apply({ slots: { energy: 11 }, observedAt: { energy: 1_000 } }, at(STALE_VALUE_MS))
    expect(acc.take()?.state.state).toBeUndefined()
  })

  it('does refresh it when the counter really rose, judged against the value held before the frame', () => {
    const acc = fresh()
    acc.apply({ slots: { state: 'charging', energy: 10 }, observedAt: { state: 0, energy: 2_000 } }, at(2_000))
    acc.apply({ slots: { energy: 11 }, observedAt: { energy: 3_000 } }, at(STALE_VALUE_MS))
    expect(acc.take()?.state.state).toBe('charging')
  })

  it('does not count the replay of an applied value as a fresh sign of charging', () => {
    // The same power observation, delivered twice: the first delivery refreshed,
    // the second is a no-op and must not refresh again.
    const acc = fresh()
    acc.apply({ slots: { state: 'charging' }, observedAt: { state: 0 } }, at(0))
    acc.apply({ slots: { power: 7 }, observedAt: { power: 1_000 } }, at(1_000))
    acc.apply({ slots: { power: 7 }, observedAt: { power: 1_000 } }, at(STALE_VALUE_MS + 1_000))
    // Refreshed once, at 1s, so exactly six hours old by the replay's arrival.
    // Had the replay refreshed it again it would be brand new.
    expect(acc.take()?.state.state).toBeUndefined()
  })
})
