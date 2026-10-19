import { describe, expect, it } from 'vitest'
import type { RawMessage } from '@ev/core'
import { profileFor } from '../src/deps.js'
import { Pipeline } from '../src/pipeline.js'
import { RIVIAN_LEVEL_STALE_MS, rivianProfile } from '../src/profiles/rivian.js'
import { STALE_VALUE_MS, VOLATILE_STALE_MS } from '../src/timing.js'
// The synthetic envelopes Task 5's decoder tests are written from. Reaching into
// another package's test directory is deliberate: one set of hand-written
// frames, so a shape corrected there is corrected here (spec §10.1).
import { stateEnvelope, tv } from '../../../packages/rivian/test/fixtures/state.js'
import { FakeDb, openSessions } from './support/fake-db.js'

// Every frame here is SYNTHETIC, like the fixtures they build on (spec §8.4):
// what these tests pin is the wiring from a taped envelope to a sample and a
// session, not what a real R2 sends.

const OPTS = { usableCapacityKwh: 80 }
const VEHICLE = 'r2'
const VIN = 'VIN1'
const DAY = '2026-10-19'
const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN

/** Epoch ms of a UTC time of day on the test day. */
const ms = (hms: string) => Date.parse(`${DAY}T${hms}.000Z`)
const iso = (epochMs: number) => new Date(epochMs).toISOString()
const date = (epochMs: number) => new Date(epochMs)

/** A taped message, as the Rivian worker writes it: the envelope, stamped with its own `receivedAt`. */
function tape(envelope: { receivedAt: string; [key: string]: unknown }): RawMessage {
  return {
    vehicleId: VEHICLE,
    vendor: 'rivian',
    receivedAt: new Date(envelope.receivedAt),
    source: 'graphql_ws',
    payload: envelope,
  }
}

/**
 * A `vehicleState` frame arriving at `arrival`.
 *
 * `values` are stamped with the frame's own arrival, which is what a live push
 * looks like. `stamped` is for properties that already carry a `timeStamp` of
 * their own (the shape a resubscribe snapshot has), built with `tv` or by hand.
 */
function stateFrame(
  arrival: number,
  values: Record<string, unknown> = {},
  stamped: Record<string, unknown> = {},
): RawMessage {
  const props: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(values)) props[name] = tv(iso(arrival), value)
  return tape(stateEnvelope(iso(arrival), { ...props, ...stamped }))
}

/** A `gnssLocation`, which is a struct rather than a `value`. */
const location = (arrival: number, latitude: number, longitude: number) => ({
  timeStamp: iso(arrival), latitude, longitude, isAuthorized: true,
})

/** A `chargingSession` frame: its `liveData` carries no timestamps of its own. */
function chargingFrame(arrival: number, liveData: Record<string, unknown>): RawMessage {
  return tape({
    v: 1,
    stream: 'charging',
    vin: VIN,
    receivedAt: iso(arrival),
    body: { data: { chargingSession: { liveData } } },
  })
}

function otherFrame(stream: string, arrival: number, body: unknown): RawMessage {
  return tape({ v: 1, stream, vin: VIN, receivedAt: iso(arrival), body })
}

async function feed(pipeline: Pipeline, frames: readonly RawMessage[]): Promise<void> {
  for (const frame of frames) await pipeline.handle(frame)
}

/** Emit whatever is still accumulating, as the worker does at shutdown. */
const finish = (pipeline: Pipeline, at: string) => pipeline.flush(date(ms(at)), true)

function setup() {
  const db = new FakeDb()
  return { db, pipeline: new Pipeline(rivianProfile, db, OPTS) }
}

const sessionsOf = (db: FakeDb, kind: 'drive' | 'charge') =>
  db.state.sessions.filter((s) => s.kind === kind)

/** The emitted sample stamped exactly `epochMs`. */
function sampleAt(db: FakeDb, epochMs: number) {
  const sample = db.state.samples.find((s) => s.ts.getTime() === epochMs)
  if (!sample) throw new Error(`no sample at ${iso(epochMs)}`)
  return sample
}

describe('the Rivian profile', () => {
  it('is what profileFor returns for rivian', () => {
    expect(profileFor('rivian')).toBe(rivianProfile)
    expect(rivianProfile.vendor).toBe('rivian')
  })

  it('gives speed, heading and charge power the short window, the charge words six hours, and every level seven days', () => {
    for (const slot of ['speedKph', 'gpsHeading', 'chargePowerKw']) {
      expect(rivianProfile.staleWindowFor(slot)).toBe(VOLATILE_STALE_MS)
    }
    // The slots a charge's state lives in keep Tesla's six hours: an old
    // charging word must not hold a session open (spec §7.6).
    for (const slot of ['chargerState', 'chargerStatus']) {
      expect(rivianProfile.staleWindowFor(slot)).toBe(STALE_VALUE_MS)
    }
    // Everything else is a level, and Rivian streams CHANGES only, so a level
    // that has not moved is simply still true. Position and gear are among
    // them: a parked car is where it parked and in the gear it left. The Tesla
    // profile has to carve these out of its drive tier; Rivian has no such tier.
    expect(RIVIAN_LEVEL_STALE_MS).toBe(7 * 24 * HOUR)
    for (const slot of [
      'lat', 'lon', 'gear', 'socPct', 'odometerKm', 'tpmsFl', 'cloudOnline', 'powerStateRaw',
      'doorFrontLeftLocked',
    ]) {
      expect(rivianProfile.staleWindowFor(slot)).toBe(RIVIAN_LEVEL_STALE_MS)
    }
  })

  it('names the charge slots of spec §7.4', () => {
    expect([...rivianProfile.chargeStateSlots]).toEqual(['chargerState', 'chargerStatus'])
    expect([...rivianProfile.chargingPowerSlots]).toEqual(['chargePowerKw'])
    expect([...rivianProfile.chargingEnergySlots]).toEqual(['chargeEnergyAddedKwh'])
  })

  it('refuses another vendor\'s message', () => {
    const frame = stateFrame(ms('10:00:00'), { batteryLevel: 80 })
    expect(rivianProfile.decode({ ...frame, vendor: 'tesla' })).toBeNull()
  })

  it('decodes a frame to slots with the vehicle\'s own observation times', () => {
    const decoded = rivianProfile.decode(stateFrame(ms('10:00:00'), { batteryLevel: 80 }))
    expect(decoded?.slots).toEqual({ socPct: 80 })
    expect(decoded?.observedAt).toEqual({ socPct: ms('10:00:00') })
    expect(decoded?.untimed).toBe(0)
  })
})

describe('Pipeline with the Rivian profile: a drive', () => {
  /** The mileage the first frame in drive reports, in metres. */
  const FIRST_DRIVE_MILEAGE_M = 1_000_100
  /** The last frame in drive: 119 frames, 100 m apart. */
  const LAST_DRIVE_MILEAGE_M = 1_011_900

  function driveFrames(): RawMessage[] {
    const frames = [
      stateFrame(ms('10:00:00'), {
        gearStatus: 'park', gnssSpeed: 0, batteryLevel: 80, vehicleMileage: 1_000_000, powerState: 'go',
      }),
    ]
    // 10:00:10 to 10:10:00, every 5 s: 20 m/s covers the 100 m between frames.
    let i = 0
    for (let at = ms('10:00:10'); at <= ms('10:10:00'); at += 5 * SEC) {
      i++
      frames.push(stateFrame(
        at,
        {
          gearStatus: 'drive',
          gnssSpeed: 20,
          vehicleMileage: 1_000_000 + 100 * i,
          // The pack reports a change a minute: 80 down to 75.5 over the drive.
          ...(i % 12 === 1 ? { batteryLevel: 80 - ((i - 1) / 12) * 0.5 } : {}),
        },
        { gnssLocation: location(at, 47.6 + 0.0005 * i, -122.33) },
      ))
    }
    frames.push(stateFrame(ms('10:10:05'), { gearStatus: 'park', gnssSpeed: 0 }))
    for (let at = ms('10:10:35'); at <= ms('10:17:00'); at += 30 * SEC) {
      frames.push(stateFrame(at, { gearStatus: 'park', gnssSpeed: 0 }))
    }
    return frames
  }

  it('writes exactly one drive, measured from the odometer and the pack', async () => {
    const { db, pipeline } = setup()
    await feed(pipeline, driveFrames())
    await finish(pipeline, '10:30:00')

    const drives = sessionsOf(db, 'drive')
    expect(drives).toHaveLength(1)
    const drive = drives[0]!
    expect(drive.isOpen).toBe(false)
    expect(drive.startedAt).toEqual(date(ms('10:00:10')))

    const summary = drive.summary!
    // From the first moving sample's odometer to the last: the 100 m a frame
    // for 118 frames, in kilometres. The parked frame before it is not part of it.
    expect(summary.distanceKm).toBeCloseTo((LAST_DRIVE_MILEAGE_M - FIRST_DRIVE_MILEAGE_M) / 1000, 3)
    expect(summary.endSocPct).toBe(75.5)
    // The SoC delta against the usable capacity the Pipeline was given (80 kWh).
    expect(summary.energyKwh).toBeCloseTo(((80 - summary.endSocPct!) / 100) * 80, 3)
    expect(summary.energyKwh).toBeCloseTo(3.6, 3)

    expect(sessionsOf(db, 'charge')).toEqual([])
    expect(openSessions(db)).toEqual([])
  })

  it('reads speed in kilometres an hour and the gear as its letter on the way', async () => {
    const { db, pipeline } = setup()
    await feed(pipeline, driveFrames())
    await finish(pipeline, '10:30:00')

    const moving = sampleAt(db, ms('10:05:00'))
    expect(moving.speedKph).toBeCloseTo(72, 6)
    expect(moving.gear).toBe('D')
    expect(moving.powerState).toBe('online')
    // The 59th frame in drive: 100 m a frame from 1000.0 km.
    expect(moving.odometerKm).toBeCloseTo(1005.9, 6)

    const parked = sampleAt(db, ms('10:10:35'))
    expect(parked.speedKph).toBe(0)
    expect(parked.gear).toBe('P')
  })
})

describe('Pipeline with the Rivian profile: a charge', () => {
  /** 25 charging frames, 5 minutes apart, the counter climbing from 0 to 10 kWh over 2 h. */
  function chargeFrames(): RawMessage[] {
    const frames = [
      stateFrame(ms('11:00:00'), {
        chargerStatus: 'chrgr_sts_connected_charging', chargerState: 'charging_connecting',
      }),
      stateFrame(ms('11:05:00'), { chargerState: 'charging_active' }),
    ]
    for (let j = 0; j <= 24; j++) {
      frames.push(chargingFrame(ms('11:05:00') + j * 5 * MIN, {
        powerKW: 7.2, totalChargedEnergy: (10 * j) / 24,
      }))
    }
    // The last counter reading is at 13:05:00.
    frames.push(stateFrame(ms('13:05:30'), { chargerState: 'charging_complete' }))
    return frames
  }

  it('writes one charge from the charging stream\'s counter and power', async () => {
    const { db, pipeline } = setup()
    await feed(pipeline, chargeFrames())
    await finish(pipeline, '13:30:00')

    const charges = sessionsOf(db, 'charge')
    expect(charges).toHaveLength(1)
    const charge = charges[0]!
    expect(charge.isOpen).toBe(false)
    // Opened by `charging_active`, not by the `charging_connecting` before it.
    expect(charge.startedAt).toEqual(date(ms('11:05:00')))
    expect(charge.summary!.energyKwh).toBeCloseTo(10, 3)
    expect(charge.summary!.maxChargePowerKw).toBe(7.2)

    // `charging_connecting` is a handshake, and a cable in is not a charge.
    expect(sampleAt(db, ms('11:00:00')).chargeState).toBe('connected')
    expect(sampleAt(db, ms('11:05:00')).chargeState).toBe('charging')
    expect(sampleAt(db, ms('13:05:30')).chargeState).toBe('complete')
    expect(sessionsOf(db, 'drive')).toEqual([])
    expect(openSessions(db)).toEqual([])
  })

  it('is not split by GPS jitter, which the noise floor and Park read as stationary', async () => {
    const { db, pipeline } = setup()
    const jitter = [
      // Before the charge, while the cable is in but nothing flows: with no
      // charge open, 0.4 m/s read as 1.44 kph would open a phantom drive.
      stateFrame(ms('11:02:00'), { gnssSpeed: 0.4 }),
      // Below the 0.5 m/s floor, mid-charge.
      stateFrame(ms('12:00:30'), { gnssSpeed: 0.4 }),
      // Above the floor (2.16 kph), but the car is in Park.
      stateFrame(ms('12:30:30'), { gearStatus: 'park', gnssSpeed: 0.6 }),
    ]
    const frames = [...chargeFrames(), ...jitter]
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
    await feed(pipeline, frames)
    await finish(pipeline, '13:30:00')

    const charges = sessionsOf(db, 'charge')
    expect(charges).toHaveLength(1)
    expect(charges[0]!.isOpen).toBe(false)
    expect(charges[0]!.summary!.energyKwh).toBeCloseTo(10, 3)
    expect(sessionsOf(db, 'drive')).toEqual([])
    // What reached the segmenter was a stationary car, not a slow one.
    expect(sampleAt(db, ms('11:02:00')).speedKph).toBe(0)
    expect(sampleAt(db, ms('12:00:30')).speedKph).toBe(0)
    expect(sampleAt(db, ms('12:30:30')).speedKph).toBe(0)
  })
})

describe('Pipeline with the Rivian profile: a resubscribe snapshot re-sending old values', () => {
  it('never lets an older observation overwrite a newer one, and opens no drive', async () => {
    const { db, pipeline } = setup()
    await pipeline.handle(stateFrame(ms('09:00:00'), { gearStatus: 'park', gnssSpeed: 0 }))

    // A frame whose gear is OLDER than the park we already hold: the car said
    // `drive` at 08:59 and `park` at 09:00, and this is the 08:59 value turning
    // up late. Arrival order is not observation order. A battery reading rides
    // along with a live stamp, so the frame lands and a sample is written to read.
    await pipeline.handle(stateFrame(
      ms('09:01:00'), { batteryLevel: 80 }, { gearStatus: tv(iso(ms('08:59:00')), 'drive') }))

    // And a frame with nothing but that late gear lands NOTHING: it is counted
    // unmapped and schedules no sample, rather than emitting one at its own
    // arrival. (Handling it is what emits the 09:01 sample, as the burst ahead
    // of it is over.)
    const lateOnly = await pipeline.handle(
      stateFrame(ms('09:02:00'), {}, { gearStatus: tv(iso(ms('08:59:00')), 'drive') }))
    expect(lateOnly.unmapped).toBe(1)
    expect(lateOnly.fieldsApplied).toBe(0)
    expect((await pipeline.flush(date(ms('09:02:10')))).samples).toBe(0)
    expect(db.state.samples.map((x) => x.ts.getTime())).toEqual([ms('09:00:00'), ms('09:01:00')])

    const afterLateGear = sampleAt(db, ms('09:01:00'))
    expect(afterLateGear.gear).toBe('P')
    expect(afterLateGear.speedKph).toBe(0)

    // Three hours on, a resubscribe re-sends what the car last said: the park
    // from 09:00, and the last speed it read before it parked, beside a reading
    // that is current.
    await pipeline.handle(stateFrame(ms('12:00:00'), {}, {
      gearStatus: tv(iso(ms('09:00:00')), 'park'),
      gnssSpeed: tv(iso(ms('08:58:00')), 15),
      batteryLevel: tv(iso(ms('11:59:00')), 79),
    }))
    await pipeline.flush(date(ms('12:00:10')))

    expect(db.state.sessions).toEqual([])
    const resent = sampleAt(db, ms('12:00:00'))
    expect([null, 0]).toContain(resent.speedKph)
    expect(resent.gear).toBe('P')
  })

  it('opens no drive for a car with no gear on record, where the Park rule cannot help', async () => {
    const { db, pipeline } = setup()
    // Nothing here says Park, so only the observation time stands between a
    // three-hour-old 15 m/s (54 kph) and a drive.
    await pipeline.handle(stateFrame(ms('09:00:00'), { batteryLevel: 80, vehicleMileage: 1_000_000 }))
    await pipeline.handle(stateFrame(ms('12:00:00'), {}, {
      gnssSpeed: tv(iso(ms('08:58:00')), 15),
      // Real news in the same snapshot, so the frame lands and a sample is written.
      batteryLevel: tv(iso(ms('11:59:00')), 79),
    }))
    await finish(pipeline, '12:00:10')

    expect(db.state.sessions).toEqual([])
    const resent = sampleAt(db, ms('12:00:00'))
    expect(resent.speedKph).toBeNull()
    expect(resent.socPct).toBe(79)
  })

  it('opens no charge for a charging_active older than the level window', async () => {
    const { db, pipeline } = setup()
    await pipeline.handle(stateFrame(ms('09:00:00'), { batteryLevel: 80 }))
    // 7 hours old: past STALE_VALUE_MS, so the car has long since said something
    // else or gone dark, and a charge opened on it would be a charge that ended
    // hours ago.
    await pipeline.handle(stateFrame(ms('12:00:00'), {}, {
      chargerState: tv(iso(ms('05:00:00')), 'charging_active'),
      chargerStatus: tv(iso(ms('05:00:00')), 'chrgr_sts_connected_charging'),
      batteryLevel: tv(iso(ms('11:59:00')), 79),
    }))
    await finish(pipeline, '12:00:10')

    expect(db.state.sessions).toEqual([])
    const resent = sampleAt(db, ms('12:00:00'))
    expect(resent.chargeState).toBeNull()
    expect(resent.socPct).toBe(79)
  })
})

/**
 * A session whose last word was at a known time, and then a resubscribe snapshot
 * EVERY MINUTE (the connector resubscribes after each 60 s of silence) re-sending
 * the values the car said it with, stamped as they were. Run with and without
 * the replays: a replay changes nothing the car said, so the two must end alike.
 *
 * The check is a comparison and not a figure, because the figure is a
 * consequence. Each replay that is scheduled as news emits a carried-state sample
 * stamped at ITS arrival, a sample a minute, so the session's last sample keeps
 * moving: the segmenter's one-hour gap close never sees a gap, and the session
 * is held open for as long as the values stay in their window.
 */
async function withAndWithoutReplays(
  last: { frames: RawMessage[]; replay: (at: number) => RawMessage; replayFrom: string; replayTo: string },
  real: RawMessage,
  kind: 'drive' | 'charge',
) {
  const run = async (replays: boolean) => {
    const { db, pipeline } = setup()
    await feed(pipeline, last.frames)
    const replayResults = []
    if (replays) {
      for (let at = ms(last.replayFrom); at <= ms(last.replayTo); at += MIN) {
        replayResults.push(await pipeline.handle(last.replay(at)))
      }
    }
    await pipeline.handle(real)
    await finish(pipeline, '23:00:00')
    return { db, sessions: sessionsOf(db, kind), replayResults }
  }
  return { plain: await run(false), replayed: await run(true) }
}

describe('Pipeline with the Rivian profile: replays cannot hold a session open', () => {
  it('a charge ends where it would have, however often its charging_active is re-sent', async () => {
    const { plain, replayed } = await withAndWithoutReplays(
      {
        // Charging from 08:00, the last counter reading at 08:30, then silence.
        frames: [
          stateFrame(ms('08:00:00'), {
            chargerStatus: 'chrgr_sts_connected_charging', chargerState: 'charging_active',
          }),
          ...[0, 1, 2, 3, 4, 5, 6].map((j) =>
            chargingFrame(ms('08:00:00') + j * 5 * MIN, { powerKW: 7.2, totalChargedEnergy: j })),
        ],
        replayFrom: '08:31:00',
        replayTo: '15:30:00',
        // The state as it was said at 08:00, which is what a snapshot re-sends.
        replay: (at) => stateFrame(at, {}, {
          chargerState: tv(iso(ms('08:00:00')), 'charging_active'),
          chargerStatus: tv(iso(ms('08:00:00')), 'chrgr_sts_connected_charging'),
        }),
      },
      // The car speaks again, about something else, with no charger state: what
      // the sample shows of the charge is only what was carried.
      stateFrame(ms('15:40:00'), { batteryLevel: 70 }),
      'charge',
    )

    expect(plain.sessions).toHaveLength(1)
    expect(plain.sessions[0]!.isOpen).toBe(false)
    // Closed by the gap, at the last charging sample.
    expect(plain.sessions[0]!.summary!.endedAt).toEqual(date(ms('08:30:00')))

    expect(replayed.sessions).toHaveLength(1)
    expect(replayed.sessions[0]!.isOpen).toBe(false)
    expect(replayed.sessions[0]!.summary!.endedAt).toEqual(date(ms('08:30:00')))
    expect(replayed.sessions[0]!.summary!.energyKwh).toBe(plain.sessions[0]!.summary!.energyKwh)

    // Not one sample for any of the 420 replays, and every one of them taped.
    expect(replayed.replayResults).toHaveLength(420)
    expect(replayed.replayResults.every((r) => r.unmapped === 1 && r.fieldsApplied === 0)).toBe(true)
    expect(replayed.db.state.samples).toHaveLength(plain.db.state.samples.length)
    expect(replayed.db.state.raw).toHaveLength(plain.db.state.raw.length + 420)
    expect(sampleAt(replayed.db, ms('15:40:00')).chargeState).toBeNull()
  })

  it('a drive last heard of in D ends where it would have, however often that D and speed are re-sent', async () => {
    const lastWord = ms('10:02:00')
    const { plain, replayed } = await withAndWithoutReplays(
      {
        // Parked, then in D at 20 m/s from 10:00:10 to 10:02:00 (200 m a frame), then silence.
        frames: [
          stateFrame(ms('10:00:00'), {
            gearStatus: 'park', gnssSpeed: 0, batteryLevel: 80, vehicleMileage: 1_000_000,
          }),
          ...Array.from({ length: 12 }, (_, i) => stateFrame(ms('10:00:10') + i * 10 * SEC, {
            gearStatus: 'drive', gnssSpeed: 20, vehicleMileage: 1_000_200 + 200 * i,
          })),
        ],
        replayFrom: '10:03:00',
        replayTo: '11:59:00',
        // The gear and the speed as they were at the last frame. The speed is
        // inside its five minutes for the first of these and past it for the
        // rest; the gear stays inside its six hours throughout.
        replay: (at) => stateFrame(at, {}, {
          gearStatus: tv(iso(lastWord), 'drive'),
          gnssSpeed: tv(iso(lastWord), 20),
        }),
      },
      // The car parks and says so, two hours later.
      stateFrame(ms('12:00:00'), { gearStatus: 'park', gnssSpeed: 0 }),
      'drive',
    )

    expect(plain.sessions).toHaveLength(1)
    expect(plain.sessions[0]!.isOpen).toBe(false)
    expect(plain.sessions[0]!.summary!.endedAt).toEqual(date(lastWord))
    expect(plain.sessions[0]!.summary!.distanceKm).toBeCloseTo(2.2, 3)

    expect(replayed.sessions).toHaveLength(1)
    expect(replayed.sessions[0]!.isOpen).toBe(false)
    expect(replayed.sessions[0]!.summary!.endedAt).toEqual(date(lastWord))
    expect(replayed.sessions[0]!.summary!.distanceKm).toBe(plain.sessions[0]!.summary!.distanceKm)

    expect(replayed.replayResults).toHaveLength(117)
    expect(replayed.replayResults.every((r) => r.unmapped === 1 && r.fieldsApplied === 0)).toBe(true)
    expect(replayed.db.state.samples).toHaveLength(plain.db.state.samples.length)
    expect(replayed.db.state.raw).toHaveLength(plain.db.state.raw.length + 117)
  })
})

/**
 * `cloudConnection` has no `timeStamp`, and the `charging` stream has none per
 * field, so the decoder stamps them with the frame's arrival. Every snapshot's
 * arrival is strictly newer than the last, so the newer-wins guard alone cannot
 * tell an UNCHANGED one from news: each minute's resubscribe landed, scheduled a
 * carried-state sample at its own arrival, and the segmenter's gap close never
 * saw a gap. The same comparison as above, with those values in the snapshot.
 */
describe('Pipeline with the Rivian profile: arrival-stamped values re-sent unchanged', () => {
  const isOnline = (at: number) => ({ isOnline: true, lastSync: iso(at - 30 * SEC) })

  it('a drive ends where it would have, however often the cloud connection is re-sent beside it', async () => {
    const lastWord = ms('10:02:00')
    const { plain, replayed } = await withAndWithoutReplays(
      {
        frames: [
          stateFrame(ms('10:00:00'), {
            gearStatus: 'park', gnssSpeed: 0, batteryLevel: 80, vehicleMileage: 1_000_000,
          }, { cloudConnection: isOnline(ms('10:00:00')) }),
          ...Array.from({ length: 12 }, (_, i) => stateFrame(ms('10:00:10') + i * 10 * SEC, {
            gearStatus: 'drive', gnssSpeed: 20, vehicleMileage: 1_000_200 + 200 * i,
          })),
        ],
        replayFrom: '10:03:00',
        replayTo: '11:59:00',
        // What a snapshot re-sends: the timed properties as they were said, and
        // the cloud connection, which has no stamp and so arrives "now".
        replay: (at) => stateFrame(at, {}, {
          gearStatus: tv(iso(lastWord), 'drive'),
          gnssSpeed: tv(iso(lastWord), 20),
          cloudConnection: isOnline(at),
        }),
      },
      stateFrame(ms('12:00:00'), { gearStatus: 'park', gnssSpeed: 0 }),
      'drive',
    )

    expect(plain.sessions).toHaveLength(1)
    expect(plain.sessions[0]!.summary!.endedAt).toEqual(date(lastWord))

    expect(replayed.sessions).toHaveLength(1)
    expect(replayed.sessions[0]!.isOpen).toBe(false)
    expect(replayed.sessions[0]!.summary!.endedAt).toEqual(date(lastWord))
    expect(replayed.sessions[0]!.summary!.distanceKm).toBe(plain.sessions[0]!.summary!.distanceKm)

    // Not a sample for any of the 117 replays, all of them taped and unmapped.
    expect(replayed.replayResults).toHaveLength(117)
    expect(replayed.replayResults.every((r) => r.unmapped === 1 && r.fieldsApplied === 0)).toBe(true)
    expect(replayed.db.state.samples).toHaveLength(plain.db.state.samples.length)
    expect(replayed.db.state.raw).toHaveLength(plain.db.state.raw.length + 117)
  })

  it('a charge ends where it would have, however often the charging stream\'s last values are re-sent', async () => {
    const lastLive = { powerKW: 7.2, totalChargedEnergy: 6 }
    const { plain, replayed } = await withAndWithoutReplays(
      {
        frames: [
          stateFrame(ms('08:00:00'), {
            chargerStatus: 'chrgr_sts_connected_charging', chargerState: 'charging_active',
          }),
          ...[0, 1, 2, 3, 4, 5, 6].map((j) =>
            chargingFrame(ms('08:00:00') + j * 5 * MIN, { powerKW: 7.2, totalChargedEnergy: j })),
        ],
        replayFrom: '08:31:00',
        replayTo: '15:30:00',
        replay: (at) => chargingFrame(at, lastLive),
      },
      stateFrame(ms('15:40:00'), { batteryLevel: 70 }),
      'charge',
    )

    expect(plain.sessions).toHaveLength(1)
    expect(plain.sessions[0]!.summary!.endedAt).toEqual(date(ms('08:30:00')))

    expect(replayed.sessions).toHaveLength(1)
    expect(replayed.sessions[0]!.isOpen).toBe(false)
    expect(replayed.sessions[0]!.summary!.endedAt).toEqual(date(ms('08:30:00')))
    expect(replayed.sessions[0]!.summary!.energyKwh).toBe(plain.sessions[0]!.summary!.energyKwh)

    expect(replayed.replayResults).toHaveLength(420)
    expect(replayed.replayResults.every((r) => r.unmapped === 1 && r.fieldsApplied === 0)).toBe(true)
    expect(replayed.db.state.samples).toHaveLength(plain.db.state.samples.length)
    expect(replayed.db.state.raw).toHaveLength(plain.db.state.raw.length + 420)
    // The car speaks again about something else: no charge word was ever re-said.
    expect(sampleAt(replayed.db, ms('15:40:00')).chargeState).toBeNull()
  })

  it('a charge ends where it would have though the charging word is re-sent with it for seven hours', async () => {
    // The charging stream's liveData carries the charger state as well as the
    // power and the counter, stamped with arrival like them. Re-sent unchanged,
    // the word must NOT have its window renewed by it: only the car changing
    // something (power moving, the counter rising) shows energy flowing, and
    // that is what keeps a real charge's word alive. Renewed by replays, an
    // `charging_active` last changed at 08:00 would still be carried at 15:40
    // and the next real frame would open a second, phantom charge.
    const live = { powerKW: 7.2, totalChargedEnergy: 6, vehicleChargerState: 'charging_active' }
    const { plain, replayed } = await withAndWithoutReplays(
      {
        frames: [
          stateFrame(ms('08:00:00'), {
            chargerStatus: 'chrgr_sts_connected_charging', chargerState: 'charging_active',
          }),
          ...[0, 1, 2, 3, 4, 5, 6].map((j) =>
            chargingFrame(ms('08:00:00') + j * 5 * MIN, { ...live, totalChargedEnergy: j })),
        ],
        replayFrom: '08:31:00',
        replayTo: '15:30:00',
        replay: (at) => chargingFrame(at, live),
      },
      stateFrame(ms('15:40:00'), { batteryLevel: 70 }),
      'charge',
    )

    expect(plain.sessions).toHaveLength(1)
    expect(plain.sessions[0]!.summary!.endedAt).toEqual(date(ms('08:30:00')))

    // One charge, closed where the energy stopped, and no second one.
    expect(replayed.sessions).toHaveLength(1)
    expect(replayed.sessions[0]!.isOpen).toBe(false)
    expect(replayed.sessions[0]!.summary!.endedAt).toEqual(date(ms('08:30:00')))
    expect(replayed.replayResults.every((r) => r.unmapped === 1 && r.fieldsApplied === 0)).toBe(true)
    expect(replayed.db.state.samples).toHaveLength(plain.db.state.samples.length)
    expect(sampleAt(replayed.db, ms('15:40:00')).chargeState).toBeNull()
  })

  it('does not bring an expired charging word back when the stream goes on repeating it', async () => {
    // The word expires at 14:00, six hours after its last real change. A level
    // that changes at 14:30 emits a sample, and `take()` drops the word from the
    // accumulator while the minute snapshots go on re-sending it. With nothing
    // held to compare against, the next re-send used to land as new, put the
    // word back at a fresh stamp, and open a charge seven hours after the last
    // charging data. The accumulator remembers the last value the stream said,
    // whether or not it is still held, so the re-send is still not news.
    const live = { powerKW: 7.2, totalChargedEnergy: 6, vehicleChargerState: 'charging_active' }
    const { db, pipeline } = setup()
    await pipeline.handle(stateFrame(ms('08:00:00'), {
      chargerStatus: 'chrgr_sts_connected_charging', chargerState: 'charging_active',
    }))
    for (let j = 0; j <= 6; j++) {
      await pipeline.handle(chargingFrame(ms('08:00:00') + j * 5 * MIN, { ...live, totalChargedEnergy: j }))
    }
    const results = []
    for (let at = ms('08:31:00'); at <= ms('15:30:00'); at += MIN) {
      if (at === ms('14:30:00')) await pipeline.handle(stateFrame(at, { batteryLevel: 70 }))
      else results.push(await pipeline.handle(chargingFrame(at, live)))
    }
    await finish(pipeline, '15:40:00')

    const charges = sessionsOf(db, 'charge')
    expect(charges).toHaveLength(1)
    expect(charges[0]!.isOpen).toBe(false)
    expect(charges[0]!.summary!.endedAt).toEqual(date(ms('08:30:00')))
    // The level change at 14:30 is what emitted a sample (the word already run
    // out of its window), and nothing after it says charging.
    expect(sampleAt(db, ms('14:30:00')).chargeState).toBeNull()
    const after = db.state.samples.filter((x) => x.ts.getTime() > ms('14:30:00'))
    expect(after.every((x) => x.chargeState === null)).toBe(true)
    // Not one of the re-sends landed.
    expect(results.every((r) => r.unmapped === 1 && r.fieldsApplied === 0)).toBe(true)
  })

  it('still lands a charge power equal to the last session\'s, once the stream has been silent for longer than its window', async () => {
    // The memory of what the stream last said must not outlive the stream: a
    // wall charger's power is the same constant every session, and a value
    // dropped as "already said" yesterday would leave every later session with
    // no power at all.
    const { db, pipeline } = setup()
    await pipeline.handle(stateFrame(ms('08:00:00'), {
      chargerStatus: 'chrgr_sts_connected_charging', chargerState: 'charging_active',
    }))
    for (let j = 0; j <= 6; j++) {
      await pipeline.handle(chargingFrame(ms('08:00:00') + j * 5 * MIN, { powerKW: 11.5, totalChargedEnergy: j }))
    }
    await pipeline.handle(stateFrame(ms('08:35:00'), { chargerState: 'charging_complete' }))
    // The second session, hours later, at the same constant power.
    await pipeline.handle(stateFrame(ms('16:00:00'), { chargerState: 'charging_active' }))
    for (let j = 0; j <= 6; j++) {
      await pipeline.handle(chargingFrame(ms('16:00:10') + j * 5 * MIN, { powerKW: 11.5, totalChargedEnergy: j }))
    }
    await finish(pipeline, '17:00:00')

    expect(sessionsOf(db, 'charge')).toHaveLength(2)
    expect(sampleAt(db, ms('16:00:10')).chargePowerKw).toBe(11.5)
    expect(sampleAt(db, ms('16:30:10')).chargePowerKw).toBe(11.5)
  })

  it('keeps what the stream last said through a transaction that rolls back', async () => {
    // A message whose transaction fails is redelivered, and the accumulator is put
    // back to a snapshot taken before it. The memory of what the stream last said
    // is part of that snapshot: restored without it, the redelivered re-send would
    // find nothing held and nothing remembered, land as news, and bring the
    // expired charging word back as a charge.
    const live = { powerKW: 7.2, totalChargedEnergy: 6, vehicleChargerState: 'charging_active' }
    const { db, pipeline } = setup()
    await pipeline.handle(stateFrame(ms('08:00:00'), {
      chargerStatus: 'chrgr_sts_connected_charging', chargerState: 'charging_active',
    }))
    for (let j = 0; j <= 6; j++) {
      await pipeline.handle(chargingFrame(ms('08:00:00') + j * 5 * MIN, { ...live, totalChargedEnergy: j }))
    }
    for (let at = ms('08:31:00'); at <= ms('14:29:00'); at += MIN) {
      await pipeline.handle(chargingFrame(at, live))
    }
    // The word ran out at 14:00. A level change at 14:30 emits a sample at the
    // next frame, and `take()` drops the word with it.
    await pipeline.handle(stateFrame(ms('14:30:00'), { batteryLevel: 70 }))
    await pipeline.handle(chargingFrame(ms('14:31:00'), live))

    // The re-send at 14:32 commits nothing: its transaction fails.
    db.failNextCommit = new Error('commit failed')
    await expect(pipeline.handle(chargingFrame(ms('14:32:00'), live))).rejects.toThrow('commit failed')
    // And is redelivered, as the broker would.
    const redelivered = await pipeline.handle(chargingFrame(ms('14:32:00'), live))
    expect(redelivered.unmapped).toBe(1)
    expect(redelivered.fieldsApplied).toBe(0)

    for (let at = ms('14:33:00'); at <= ms('15:00:00'); at += MIN) await pipeline.handle(chargingFrame(at, live))
    await finish(pipeline, '15:10:00')

    expect(sessionsOf(db, 'charge')).toHaveLength(1)
    const after = db.state.samples.filter((x) => x.ts.getTime() >= ms('14:30:00'))
    expect(after.length).toBeGreaterThan(0)
    expect(after.every((x) => x.chargeState === null)).toBe(true)
  })

  it('a real charge stays one charge past six hours, its charging word re-sent unchanged', async () => {
    // The other half: what keeps a long charge's word alive is the car's power
    // and counter moving, through the charge refresh, with no help from the
    // re-sent word. A 12 h charge (a long Level 1 session) at 08:00 to 20:00.
    const { db, pipeline } = setup()
    await pipeline.handle(stateFrame(ms('08:00:00'), {
      chargerStatus: 'chrgr_sts_connected_charging', chargerState: 'charging_active',
    }))
    let j = 0
    for (let at = ms('08:00:10'); at <= ms('20:00:10'); at += 5 * MIN, j++) {
      await pipeline.handle(chargingFrame(at, {
        // The power wobbles and the counter rises, as a real session's do.
        powerKW: j % 2 === 0 ? 1.4 : 1.3,
        totalChargedEnergy: j * 0.1,
        vehicleChargerState: 'charging_active',
      }))
      // And the snapshot a minute later re-sends the same liveData, word included.
      await pipeline.handle(chargingFrame(at + MIN, {
        powerKW: j % 2 === 0 ? 1.4 : 1.3,
        totalChargedEnergy: j * 0.1,
        vehicleChargerState: 'charging_active',
      }))
    }
    await pipeline.handle(stateFrame(ms('20:05:00'), { chargerState: 'charging_complete' }))
    await finish(pipeline, '20:30:00')

    const charges = sessionsOf(db, 'charge')
    expect(charges).toHaveLength(1)
    expect(charges[0]!.isOpen).toBe(false)
    expect(charges[0]!.startedAt).toEqual(date(ms('08:00:00')))
    // Past the word's six hours, the samples still say charging.
    expect(sampleAt(db, ms('14:30:10')).chargeState).toBe('charging')
    expect(sampleAt(db, ms('19:55:10')).chargeState).toBe('charging')
    expect(charges[0]!.summary!.endedAt!.getTime()).toBeGreaterThan(ms('19:55:00'))
  })

  it('counts a re-sent cloud stream frame unmapped too, and applies one that says something new', async () => {
    const { db, pipeline } = setup()
    const cloud = (at: number, online: boolean) =>
      otherFrame('cloud', at, { data: { vehicleCloudConnection: { isOnline: online } } })

    expect((await pipeline.handle(cloud(ms('10:00:00'), true))).fieldsApplied).toBe(1)
    for (let at = ms('10:01:00'); at <= ms('10:30:00'); at += MIN) {
      const result = await pipeline.handle(cloud(at, true))
      expect(result.unmapped).toBe(1)
      expect(result.fieldsApplied).toBe(0)
    }
    // The car dropping off the cloud is news, and is a sample.
    expect((await pipeline.handle(cloud(ms('10:31:00'), false))).fieldsApplied).toBe(1)
    await finish(pipeline, '10:40:00')

    expect(db.state.samples.map((x) => [x.ts.getTime(), x.powerState])).toEqual([
      [ms('10:00:00'), null],
      [ms('10:31:00'), 'offline'],
    ])
  })

  it('keeps a steady charge power alive across re-sends, though they are not news', async () => {
    // 7.2 kW says nothing new after its first report, but it is what the car is
    // drawing, and a re-send is the car saying so. It must not run out of its
    // five minutes while the snapshots keep arriving, or the next real frame
    // would read a charge with no power.
    const { db, pipeline } = setup()
    await pipeline.handle(stateFrame(ms('08:00:00'), {
      chargerStatus: 'chrgr_sts_connected_charging', chargerState: 'charging_active',
    }))
    await pipeline.handle(chargingFrame(ms('08:00:10'), { powerKW: 7.2, totalChargedEnergy: 1 }))
    for (let at = ms('08:01:10'); at <= ms('08:30:10'); at += MIN) {
      await pipeline.handle(chargingFrame(at, { powerKW: 7.2, totalChargedEnergy: 1 }))
    }
    // A real frame with nothing of its own about power, a minute after the last re-send.
    await pipeline.handle(stateFrame(ms('08:31:10'), { batteryLevel: 71 }))
    await finish(pipeline, '08:40:00')

    expect(sampleAt(db, ms('08:31:10')).chargePowerKw).toBe(7.2)
  })
})

describe('Pipeline with the Rivian profile: a car parked for longer than the charge window', () => {
  // Rivian streams CHANGES only, so a level that has not moved is not re-sent as
  // news: the connector's snapshot re-sends it with its ORIGINAL stamp. Held to
  // Tesla's six hours, a car parked since 07:00 lost its SoC, odometer, position
  // and tyre pressures from every sample after 13:00, and a charge that began
  // after that could not be placed at home.
  const TYRES = { tirePressureFrontLeft: 2.9, tirePressureFrontRight: 2.9, tirePressureRearLeft: 3.0, tirePressureRearRight: 3.0 }

  it('carries position, SoC, odometer and tyres into a charge that starts eight hours later', async () => {
    const { db, pipeline } = setup()
    const parkedAt = ms('07:00:00')
    const stamped = {
      batteryLevel: tv(iso(parkedAt), 70),
      vehicleMileage: tv(iso(parkedAt), 1_000_000),
      gnssLocation: location(parkedAt, 47.6, -122.33),
      ...Object.fromEntries(Object.entries(TYRES).map(([k, v]) => [k, tv(iso(parkedAt), v)])),
    }
    await pipeline.handle(stateFrame(parkedAt, {}, stamped))
    // A snapshot every minute for eight hours, each re-sending what the car last said.
    for (let at = ms('07:01:00'); at <= ms('15:00:00'); at += MIN) {
      await pipeline.handle(stateFrame(at, {}, stamped))
    }
    // The plug goes in, and the car starts to charge.
    await pipeline.handle(stateFrame(ms('15:00:30'), {
      chargerStatus: 'chrgr_sts_connected_charging', chargerState: 'charging_active',
    }))
    await pipeline.handle(chargingFrame(ms('15:00:40'), { powerKW: 7.2, totalChargedEnergy: 0.1 }))
    await finish(pipeline, '15:10:00')

    // The re-sends were not news: nothing was sampled between the park and the plug.
    expect(db.state.samples.filter((x) => x.ts.getTime() < ms('15:00:30'))).toHaveLength(1)

    const first = sampleAt(db, ms('15:00:30'))
    expect(first.chargeState).toBe('charging')
    expect(first.lat).toBe(47.6)
    expect(first.lon).toBe(-122.33)
    expect(first.socPct).toBe(70)
    expect(first.odometerKm).toBeCloseTo(1000, 6)
    expect(first.tpms).toEqual({ fl: 2.9, fr: 2.9, rl: 3.0, rr: 3.0 })
    expect(sessionsOf(db, 'charge')).toHaveLength(1)
  })

  it('still lets a speed from eight hours ago go, and a charging word from seven', async () => {
    const { db, pipeline } = setup()
    await pipeline.handle(stateFrame(ms('07:00:00'), { batteryLevel: 70 }))
    await pipeline.handle(stateFrame(ms('15:00:00'), {}, {
      gnssSpeed: tv(iso(ms('07:00:00')), 15),
      chargerState: tv(iso(ms('08:00:00')), 'charging_active'),
      batteryLevel: tv(iso(ms('14:59:00')), 69),
    }))
    await finish(pipeline, '15:10:00')

    expect(db.state.sessions).toEqual([])
    const resent = sampleAt(db, ms('15:00:00'))
    expect(resent.speedKph).toBeNull()
    expect(resent.chargeState).toBeNull()
    expect(resent.socPct).toBe(69)
  })

  it('still drops a level once it is older than a week', async () => {
    const { db, pipeline } = setup()
    const eightDays = 8 * 24 * HOUR
    await pipeline.handle(stateFrame(ms('10:00:00') - eightDays, { batteryLevel: 70 }))
    await pipeline.handle(stateFrame(ms('10:00:00'), {}, {
      batteryLevel: tv(iso(ms('10:00:00') - eightDays), 70),
      distanceToEmpty: tv(iso(ms('09:59:00')), 300),
    }))
    await finish(pipeline, '10:10:00')

    const sample = sampleAt(db, ms('10:00:00'))
    expect(sample.socPct).toBeNull()
    expect(sample.rangeKm).toBe(300)
  })
})

describe('Pipeline with the Rivian profile: values that belong to one charge session', () => {
  // `chargeEnergyAddedKwh` counts from zero at each session, so a value carried
  // from the last one is not a stale level but somebody else's reading. Core
  // metrics take the first sample's counter as where the session started, so a
  // new session whose first sample (the plug-in word, before any liveData)
  // carried the old counter measured from there and came up short.
  /** The plug-in word, then a reading every 5 minutes: 1 kWh, 2, ... `deliveredKwh` + 1. */
  function chargeSession(start: number, deliveredKwh: number): RawMessage[] {
    const frames: RawMessage[] = [stateFrame(start, {
      chargerStatus: 'chrgr_sts_connected_charging', chargerState: 'charging_active',
    })]
    // The liveData follows the plug-in word by 5 s: past the 2 s quiet period, so
    // the word emits a sample of its own, with whatever the accumulator carries.
    for (let j = 0; j <= deliveredKwh; j++) {
      frames.push(chargingFrame(start + 5 * SEC + j * 5 * MIN, { powerKW: 7.2, totalChargedEnergy: 1 + j }))
    }
    return frames
  }

  it('does not carry the last session\'s counter into the first sample of the next', async () => {
    const { db, pipeline } = setup()
    const first = ms('08:00:00')
    const second = first + 24 * HOUR
    // Session 1 ends with its counter at 21 kWh.
    await feed(pipeline, chargeSession(first, 20))
    await pipeline.handle(stateFrame(first + 2 * HOUR, { chargerState: 'charging_complete' }))
    // Session 2, a day later, delivers 30 kWh: its counter runs 1 to 31.
    await feed(pipeline, chargeSession(second, 30))
    await pipeline.handle(stateFrame(second + 4 * HOUR, { chargerState: 'charging_complete' }))
    await pipeline.flush(date(second + 5 * HOUR), true)

    // The plug-in word's own sample, before the first reading: nothing to report.
    const plugIn = sampleAt(db, second)
    expect(plugIn.chargeState).toBe('charging')
    expect(plugIn.chargeEnergyAddedKwh).toBeNull()

    const charges = sessionsOf(db, 'charge')
    expect(charges).toHaveLength(2)
    expect(charges[0]!.summary!.energyKwh).toBeCloseTo(20, 3)
    // Measured from the session's own first reading (1 kWh) to its last (31):
    // from the 21 left over from the last session it would have come up 20 short.
    expect(charges[1]!.summary!.energyKwh).toBeCloseTo(30, 3)
  })

  it('gives the counter and the time to full the charge words\' six hours', () => {
    for (const slot of ['chargeEnergyAddedKwh', 'timeToFullChargeHours']) {
      expect(rivianProfile.staleWindowFor(slot)).toBe(STALE_VALUE_MS)
    }
  })
})

describe('Pipeline with the Rivian profile: what is not a frame of state', () => {
  it('tapes parallax, meta and ota, counts each as unmapped, and opens nothing', async () => {
    const { db, pipeline } = setup()
    const frames = [
      otherFrame('parallax', ms('10:00:00'), {
        data: { parallaxMessages: { rvm: 'charging.session.notification', payload: 'CJYB', timestamp: iso(ms('10:00:00')) } },
      }),
      otherFrame('meta', ms('10:00:01'), { kind: 'vehicle_images', data: { count: 3 } }),
      otherFrame('ota', ms('10:00:02'), { data: { vehicleOtaStatus: { currentVersion: '2026.40.0' } } }),
    ]
    for (const [n, frame] of frames.entries()) {
      const result = await pipeline.handle(frame)
      expect(result.unmapped).toBe(1)
      expect(result.fieldsApplied).toBe(0)
      expect(db.state.raw).toHaveLength(n + 1)
    }
    await finish(pipeline, '10:30:00')

    expect(db.state.raw.map((m) => m.payload)).toEqual(frames.map((f) => f.payload))
    expect(db.state.samples).toEqual([])
    expect(db.state.sessions).toEqual([])
  })

  it('counts a frame of only null and unknown properties as unmapped, not applied', async () => {
    const { db, pipeline } = setup()
    const result = await pipeline.handle(stateFrame(ms('10:00:00'), {}, {
      batteryLevel: null,
      gearStatus: null,
      gnssSpeed: { timeStamp: iso(ms('10:00:00')), value: null },
      aPropertyNobodyDecodes: tv(iso(ms('10:00:00')), 7),
    }))
    expect(result.unmapped).toBe(1)
    expect(result.fieldsApplied).toBe(0)
    expect(result.untimed).toBe(0)
    expect(db.state.raw).toHaveLength(1)

    // Nothing was accumulated, so nothing is emitted for it: counting it as
    // applied would schedule a sample of carried-only state on every resubscribe.
    await finish(pipeline, '10:30:00')
    expect(db.state.samples).toEqual([])
  })

  it('counts a frame whose only property is too old to apply as unmapped', async () => {
    const { pipeline } = setup()
    const result = await pipeline.handle(stateFrame(ms('10:00:00'), {}, {
      gnssSpeed: tv(iso(ms('09:00:00')), 15),
    }))
    expect(result.unmapped).toBe(1)
    expect(result.fieldsApplied).toBe(0)
  })

  it('counts a property with no usable timestamp as untimed, and still applies it', async () => {
    const { db, pipeline } = setup()
    const result = await pipeline.handle(stateFrame(ms('10:00:00'), {}, {
      batteryLevel: tv('garbage', 50),
    }))
    expect(result.untimed).toBe(1)
    expect(result.fieldsApplied).toBe(1)
    expect(result.unmapped).toBe(0)

    // Stamped with the frame's arrival, so it is as current as the frame.
    await finish(pipeline, '10:30:00')
    expect(sampleAt(db, ms('10:00:00')).socPct).toBe(50)

    // A timed frame beside it is not counted.
    const timed = await pipeline.handle(stateFrame(ms('10:01:00'), { batteryLevel: 49 }))
    expect(timed.untimed).toBe(0)
  })
})
