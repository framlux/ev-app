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
    // Read at the replay's arrival. A frame that landed nothing does not move
    // the accumulator's clock, so a bare frame is what asks the question.
    expect(carried(acc, STALE_VALUE_MS).state).toBeUndefined()
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
    expect(carried(acc, STALE_VALUE_MS).state).toBeUndefined()
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
    expect(carried(acc, STALE_VALUE_MS + 1_000).state).toBeUndefined()
  })
})

describe('FieldAccumulator: a message that changes nothing', () => {
  const MINUTE = 60_000

  it('reports that nothing landed, and schedules no sample, when every slot is superseded', () => {
    const acc = fresh()
    expect(acc.apply(
      { slots: { speed: 50, state: 'charging' }, observedAt: { speed: 1_000, state: 1_000 } },
      at(1_000),
    )).toBe(true)
    acc.take()
    expect(acc.pending).toBe(false)

    // A resubscribe's snapshot: an older observation of one slot, and the very
    // same observation of the same value for the other.
    const landed = acc.apply(
      { slots: { speed: 99, state: 'charging' }, observedAt: { speed: 500, state: 1_000 } },
      at(1_000 + MINUTE),
    )
    expect(landed).toBe(false)
    expect(acc.pending).toBe(false)
    expect(acc.due(at(1_000 + 10 * MINUTE))).toBe(false)
  })

  it('leaves a pending burst\'s timing where it was', () => {
    // The burst was last added to at 1s. A superseded frame at 2.5s is not part
    // of it, so the quiet period still runs from 1s: due at 3s, and stamped 1s.
    // Counted as the burst's newest member it would push both to 2.5s.
    const acc = fresh()
    acc.apply({ slots: { speed: 50 }, observedAt: { speed: 1_000 } }, at(1_000))
    expect(acc.apply({ slots: { speed: 99 }, observedAt: { speed: 500 } }, at(2_500))).toBe(false)
    expect(acc.due(at(3_000))).toBe(true)
    expect(acc.take()?.ts).toEqual(at(1_000))
  })

  it('schedules a sample when even one slot among the superseded ones is newer', () => {
    const acc = fresh()
    acc.apply({ slots: { speed: 50 }, observedAt: { speed: 1_000 } }, at(1_000))
    acc.take()
    expect(acc.pending).toBe(false)

    const landed = acc.apply(
      { slots: { speed: 99, odometer: 7 }, observedAt: { speed: 500, odometer: 2_000 } },
      at(2_500),
    )
    expect(landed).toBe(true)
    expect(acc.pending).toBe(true)
    const taken = acc.take()
    expect(taken?.ts).toEqual(at(2_500))
    // The newer slot landed and the superseded one did not overwrite anything.
    expect(taken?.state).toEqual({ speed: 50, odometer: 7 })
  })

  it('always lands what carries no observation time, as every Tesla value does', () => {
    const acc = fresh()
    expect(acc.apply({ slots: { state: 'charging' } }, at(1_000))).toBe(true)
    expect(acc.apply({ slots: { state: 'charging' } }, at(2_000))).toBe(true)
  })
})

/**
 * Slots the decoder stamped with the frame's arrival because the source gave no
 * observation time of its own (Rivian's `cloudConnection` and its `charging`
 * stream). The newer-wins guard cannot tell an unchanged one from news, since
 * every arrival is strictly newer than the last: a resubscribe snapshot every
 * minute would land, schedule a carried-state sample, and hold a session open
 * for as long as the snapshots kept coming.
 *
 * So `Decoded.arrivalStamped` names them, and an UNCHANGED one is a refresh of
 * the carry and not a landing.
 */
describe('FieldAccumulator: slots stamped with their arrival', () => {
  const MINUTE = 60_000
  const stamped = (slots: Record<string, unknown>, arrival: number) => ({
    slots,
    observedAt: Object.fromEntries(Object.keys(slots).map((k) => [k, arrival])),
    arrivalStamped: new Set(Object.keys(slots)),
  })

  it('does not count an unchanged value as landing, and schedules no sample', () => {
    const acc = fresh()
    expect(acc.apply(stamped({ power: 7 }, 1_000), at(1_000))).toBe(true)
    acc.take()
    expect(acc.pending).toBe(false)

    // The same value, a minute later, observed (that is, arrived) strictly later.
    expect(acc.apply(stamped({ power: 7 }, 1_000 + MINUTE), at(1_000 + MINUTE))).toBe(false)
    expect(acc.pending).toBe(false)
    expect(acc.due(at(1_000 + 10 * MINUTE))).toBe(false)
  })

  it('refreshes the held value, so its carry outlives the window it was first given', () => {
    // `power` is volatile: five minutes. Said at 0 and re-said at 4 minutes, it
    // is carried at 8 minutes, which it would not be had the re-say been dropped.
    const acc = fresh()
    acc.apply(stamped({ power: 7 }, 0), at(0))
    acc.take()
    acc.apply(stamped({ power: 7 }, 4 * MINUTE), at(4 * MINUTE))
    expect(carried(acc, 8 * MINUTE).power).toBe(7)
  })

  it('lets the refreshed value expire a window after the last re-say, and not before', () => {
    const acc = fresh()
    acc.apply(stamped({ power: 7 }, 0), at(0))
    acc.take()
    acc.apply(stamped({ power: 7 }, 4 * MINUTE), at(4 * MINUTE))
    expect(carried(acc, 4 * MINUTE + VOLATILE_STALE_MS - 1).power).toBe(7)
    expect(carried(acc, 4 * MINUTE + VOLATILE_STALE_MS).power).toBeUndefined()
  })

  it('leaves a pending burst\'s timing where it was', () => {
    const acc = fresh()
    acc.apply({ slots: { odometer: 5 } }, at(1_000))
    expect(acc.apply(stamped({ power: 7 }, 2_000), at(2_000))).toBe(true)
    // The unchanged re-say at 2.5 s is not part of the burst: due at 4 s (2 s
    // after the last thing that landed), stamped at 2 s.
    expect(acc.apply(stamped({ power: 7 }, 2_500), at(2_500))).toBe(false)
    expect(acc.due(at(4_000))).toBe(true)
    expect(acc.take()?.ts).toEqual(at(2_000))
  })

  it('lands a changed value as news', () => {
    const acc = fresh()
    acc.apply(stamped({ power: 7 }, 1_000), at(1_000))
    acc.take()

    expect(acc.apply(stamped({ power: 11 }, 1_000 + MINUTE), at(1_000 + MINUTE))).toBe(true)
    expect(acc.pending).toBe(true)
    expect(acc.take()?.state.power).toBe(11)
  })

  it('lands a value it does not hold yet', () => {
    const acc = fresh()
    expect(acc.apply(stamped({ power: 7 }, 1_000), at(1_000))).toBe(true)
    expect(acc.pending).toBe(true)
  })

  it('lands a changed value even where the held one carried the car\'s own timestamp', () => {
    // The charging stream says `charging_active` at arrival; the vehicleState
    // `chargerState` it replaces was timed by the car. A different word is news
    // whichever clock the held one had.
    const acc = fresh()
    acc.apply({ slots: { state: 'idle' }, observedAt: { state: 500 } }, at(500))
    acc.take()
    expect(acc.apply(stamped({ state: 'charging' }, 1_000), at(1_000))).toBe(true)
  })

  it('treats an arrival-stamped re-say of a timed value as unchanged, and refreshes it', () => {
    const acc = fresh()
    acc.apply({ slots: { power: 7 }, observedAt: { power: 0 } }, at(0))
    acc.take()
    expect(acc.apply(stamped({ power: 7 }, 4 * MINUTE), at(4 * MINUTE))).toBe(false)
    expect(carried(acc, 8 * MINUTE).power).toBe(7)
  })

  describe('in a charge-state slot', () => {
    // `state` is the test profile's charge state. An unchanged re-say there is
    // neither news nor a refresh: the word's window runs from its last REAL
    // change, so a replayed `charging_active` cannot hold a session open. What
    // keeps a genuine charge's word alive is the charge refresh (power moving or
    // the counter rising), which is judged over what landed.
    it('neither lands nor moves the held entry', () => {
      const acc = fresh()
      acc.apply(stamped({ state: 'charging' }, 0), at(0))
      acc.take()
      expect(acc.apply(stamped({ state: 'charging' }, 5 * HOUR), at(5 * HOUR))).toBe(false)
      expect(acc.pending).toBe(false)
      // Still running out at 6 h from the change, not from the re-say at 5 h.
      expect(carried(acc, STALE_VALUE_MS - 1).state).toBe('charging')
      expect(carried(acc, STALE_VALUE_MS).state).toBeUndefined()
    })

    it('does the same to a word the car timed itself', () => {
      const acc = fresh()
      acc.apply({ slots: { state: 'charging' }, observedAt: { state: 0 } }, at(0))
      acc.take()
      expect(acc.apply(stamped({ state: 'charging' }, 5 * HOUR), at(5 * HOUR))).toBe(false)
      expect(carried(acc, STALE_VALUE_MS).state).toBeUndefined()
    })

    it('still lands a changed word', () => {
      const acc = fresh()
      acc.apply(stamped({ state: 'charging' }, 0), at(0))
      acc.take()
      expect(acc.apply(stamped({ state: 'complete' }, 5 * HOUR), at(5 * HOUR))).toBe(true)
      expect(acc.take()?.state.state).toBe('complete')
    })

    it('is still not news once the held word has expired and been dropped', () => {
      // `take()` deletes what has run out of its window, and with it the thing a
      // re-send is compared against. The accumulator remembers what the stream
      // last said apart from what it holds, so the word does not come back for
      // as long as the stream keeps repeating it.
      const acc = fresh()
      acc.apply(stamped({ state: 'charging' }, 0), at(0))
      acc.take()
      acc.apply(stamped({ state: 'charging' }, 3 * HOUR), at(3 * HOUR))
      acc.apply(stamped({ state: 'charging' }, 5 * HOUR), at(5 * HOUR))
      // 6 h 1 min: another value lands and emits, and the word is dropped.
      acc.apply({ slots: { odometer: 1 } }, at(STALE_VALUE_MS + MINUTE))
      expect(acc.take()?.state.state).toBeUndefined()

      expect(acc.apply(stamped({ state: 'charging' }, STALE_VALUE_MS + 2 * MINUTE), at(STALE_VALUE_MS + 2 * MINUTE)))
        .toBe(false)
      expect(acc.pending).toBe(false)
      expect(carried(acc, STALE_VALUE_MS + 3 * MINUTE).state).toBeUndefined()
    })

    it('lands a different word after that, and a flip back to the old one is news again', () => {
      const acc = fresh()
      acc.apply(stamped({ state: 'charging' }, 0), at(0))
      acc.apply({ slots: { odometer: 1 } }, at(STALE_VALUE_MS + MINUTE))
      acc.take()

      expect(acc.apply(stamped({ state: 'complete' }, STALE_VALUE_MS + 2 * MINUTE), at(STALE_VALUE_MS + 2 * MINUTE)))
        .toBe(true)
      expect(acc.apply(stamped({ state: 'charging' }, STALE_VALUE_MS + 3 * MINUTE), at(STALE_VALUE_MS + 3 * MINUTE)))
        .toBe(true)
    })

    it('is remembered from a word the car timed itself, once the stream has said the same', () => {
      const acc = fresh()
      acc.apply({ slots: { state: 'charging' }, observedAt: { state: 0 } }, at(0))
      // The stream repeats it from then on, often enough to still be heard.
      for (const t of [MINUTE, 3 * HOUR, 5 * HOUR]) acc.apply(stamped({ state: 'charging' }, t), at(t))
      acc.apply({ slots: { odometer: 1 } }, at(STALE_VALUE_MS + MINUTE))
      expect(acc.take()?.state.state).toBeUndefined()
      expect(acc.apply(stamped({ state: 'charging' }, STALE_VALUE_MS + 2 * MINUTE), at(STALE_VALUE_MS + 2 * MINUTE)))
        .toBe(false)
    })

    it('forgets what the stream said once it has been silent for longer than the word\'s window', () => {
      // A genuinely new session, a day later, whose first word is the same one.
      const acc = fresh()
      acc.apply(stamped({ state: 'charging' }, 0), at(0))
      acc.apply({ slots: { odometer: 1 } }, at(STALE_VALUE_MS + MINUTE))
      acc.take()
      const later = 24 * HOUR
      expect(acc.apply(stamped({ state: 'charging' }, later), at(later))).toBe(true)
    })

    it('is kept alive by the charge refresh, as before, when the power really moves', () => {
      const acc = fresh()
      acc.apply(stamped({ state: 'charging' }, 0), at(0))
      acc.apply({ slots: { power: 7 }, observedAt: { power: 5 * HOUR } }, at(5 * HOUR))
      // The re-say beside it changes nothing; the landed power refreshed the word at 5 h.
      acc.apply(stamped({ state: 'charging' }, 5 * HOUR + MINUTE), at(5 * HOUR + MINUTE))
      expect(carried(acc, STALE_VALUE_MS + MINUTE).state).toBe('charging')
    })
  })

  it('does not let an unchanged re-say refresh the charge state, as a rising counter does', () => {
    // The charge refresh is judged over what LANDED. A re-sent power is the same
    // power, not the car saying again that energy is flowing, so it must not
    // keep a charge state alive that would otherwise run out.
    const acc = fresh()
    acc.apply({ slots: { state: 'charging' }, observedAt: { state: 0 } }, at(0))
    acc.apply(stamped({ power: 7 }, 1_000), at(1_000))
    acc.take()
    acc.apply(stamped({ power: 7 }, 5 * HOUR), at(5 * HOUR))
    // `state` was last refreshed at 1 s, when the power landed, and a re-say at
    // 5 h did not move it: at 6 h + 1 s it is a full window old.
    expect(carried(acc, STALE_VALUE_MS + 1_000).state).toBeUndefined()
  })

  it('treats the same value after a silence longer than its window as news again', () => {
    // `power` is volatile (five minutes). What the stream last said is only
    // evidence that it is repeating itself while it keeps being heard: a value
    // that comes back after a gap is a new report, even if it equals the old.
    const acc = fresh()
    acc.apply(stamped({ power: 7 }, 0), at(0))
    acc.take()
    acc.apply({ slots: { odometer: 1 } }, at(VOLATILE_STALE_MS + MINUTE))
    expect(acc.take()?.state.power).toBeUndefined()
    expect(acc.apply(stamped({ power: 7 }, 10 * MINUTE), at(10 * MINUTE))).toBe(true)
  })

  it('never moves a value backwards for an older arrival stamp', () => {
    const acc = fresh()
    acc.apply(stamped({ power: 7 }, 10_000), at(10_000))
    acc.take()
    // A tape out of order: a stamp older than the one held is a replay, as for any observation.
    expect(acc.apply(stamped({ power: 9 }, 5_000), at(10_500))).toBe(false)
    expect(carried(acc, 10_500).power).toBe(7)
  })

  it('is inert for a profile that never sets it', () => {
    // Tesla: no `arrivalStamped`, no `observedAt`. Every defined value lands, always.
    const acc = fresh()
    expect(acc.apply({ slots: { power: 7 } }, at(1_000))).toBe(true)
    expect(acc.apply({ slots: { power: 7 } }, at(2_000))).toBe(true)
  })
})
