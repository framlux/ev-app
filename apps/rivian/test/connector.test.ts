import { RIVIAN_PROPERTIES, RivianApiError, SUBSCRIPTIONS_URL, type RivianStream } from '@ev/rivian'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SocketOpenError } from '../src/socket.js'
import { FakeSocket, START, TOKEN, VIN, makeHarness, settle, type Harness } from './support/connector-harness.js'
import { userInfoWith } from './support/fake-gateway.js'

/**
 * The connector, run for real against fakes of everything it touches: a clock
 * the test advances, a store that can be made to fail, a socket the test speaks
 * for, a broker that answers when told to, and a scripted Rivian gateway. Only
 * the queue, the publisher, the plan, the backoff and the connector itself are
 * the real ones.
 *
 * Real asynchronous work (a credential is genuinely sealed and unsealed with
 * jose) is waited for with `until`, in real time. Everything the connector
 * WAITS for is the fake clock's, so a test that says "an hour passes" takes
 * the time it takes to run the timers that fall in it.
 */

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const POLL = 15 * SECOND

const unauthenticated = (what = 'getUserInfo'): RivianApiError =>
  new RivianApiError(200, [{ code: 'UNAUTHENTICATED' }], what)

/** The `properties` each live `vehicleState` subscription of a socket asks for, parsed from its query. */
function liveStateProperties(socket: FakeSocket): string[] {
  const live = new Set(socket.liveIds)
  return socket.subscribes
    .filter((s) => live.has(s.id) && s.doc.operationName === 'VehicleState')
    .flatMap((s) => [...s.doc.query.matchAll(/^ {4}(\w+) \{$/gm)].map((m) => m[1]!))
}

/** How many subscriptions a fresh connection makes: ceil(catalogue / 16) groups and the seven others. */
const INITIAL_SUBSCRIPTIONS = Math.ceil(RIVIAN_PROPERTIES.length / 16) + 7

let h: Harness

afterEach(() => {
  vi.useRealTimers()
})

describe('sign-in', () => {
  it('no row means signed_out, and nothing is asked of Rivian', async () => {
    h = await makeHarness()
    h.connector.start()
    await settle()

    expect(h.connector.state).toBe('signed_out')
    expect(h.metrics.states).toEqual(['signed_out'])
    expect(h.gateway.calls.createCsrf).toBe(0)
    expect(h.fake.opens).toHaveLength(0)
  })

  it('a row appearing leads to subscribed, with userInfo taped as meta and every state announced', async () => {
    h = await makeHarness()
    h.connector.start()
    await settle()
    expect(h.connector.state).toBe('signed_out')

    await h.signIn()
    await h.clock.tick(POLL)
    await h.until(() => h.connector.state === 'subscribed', 'subscribed')
    await settle()

    expect(h.metrics.states).toEqual([
      'signed_out',
      'starting',
      'finding_vehicle',
      'connecting',
      'subscribed',
    ])
    // A `connection` meta frame for each, on the meta topic.
    expect(h.meta('connection')).toEqual([
      { state: 'signed_out', reason: null },
      { state: 'starting', reason: null },
      { state: 'finding_vehicle', reason: null },
      { state: 'connecting', reason: null },
      { state: 'subscribed', reason: null },
    ])
    expect(h.mqtt.published.every((p) => p.topic === `rivian/${VIN}/meta`)).toBe(true)

    const userInfo = h.meta('userInfo')
    expect(userInfo).toEqual([userInfoWith([{ id: 'rv-1', vin: VIN }])])

    // The socket was opened at Rivian's URL, with the session in `u-sess`, and
    // everything in the plan was subscribed.
    expect(h.fake.opens).toHaveLength(1)
    expect(h.fake.opens[0]!.url).toBe(SUBSCRIPTIONS_URL)
    expect(h.fake.opens[0]!.initPayload['u-sess']).toBe(TOKEN)
    expect(h.socket.subscribes).toHaveLength(INITIAL_SUBSCRIPTIONS)

    // And the status row says so, with Rivian's id for the car.
    const row = h.store.writes.at(-1)!
    expect(row).toMatchObject({
      state: 'subscribed',
      vin: VIN,
      rivianVehicleId: 'rv-1',
      lastError: null,
      backoffUntil: null,
      droppedProperties: [],
    })
  })

  it('the slow calls run once the car is found, each with the user session', async () => {
    h = await makeHarness()
    await h.connect()

    expect(h.gateway.calls).toMatchObject({
      createCsrf: 1,
      userInfo: 1,
      vehicle: 1,
      chargingSummaries: 1,
      introspectVehicleState: 1,
    })
    expect(new Set(h.gateway.tokens)).toEqual(new Set([TOKEN]))
    expect(h.meta('vehicle')).toHaveLength(1)
    expect(h.meta('chargingSummaries')).toHaveLength(1)
    expect(h.meta('schema')).toHaveLength(1)
  })

  it('a credential read that fails at starting is left to the next poll', async () => {
    h = await makeHarness()
    await h.signIn()
    h.store.credentialReadFails = true
    h.connector.start()
    await h.until(() => h.store.calls.credential === 1, 'the credential read')
    await settle()

    expect(h.connector.state).toBe('starting')
    expect(h.fake.opens).toHaveLength(0)

    h.store.credentialReadFails = false
    await h.clock.tick(POLL)
    await h.until(() => h.connector.state === 'subscribed', 'subscribed')
  })
})

describe('delivery', () => {
  it('a VIN that is absent leads to waiting_for_vehicle, userInfo is retried hourly, and the VIN appearing leads to subscribed', async () => {
    h = await makeHarness()
    h.gateway.script('userInfo', userInfoWith([{ id: 'other-1', vin: 'SOMEONEELSESVIN123' }]))
    await h.signIn()
    h.connector.start()
    await h.until(() => h.connector.state === 'waiting_for_vehicle', 'waiting_for_vehicle')
    await settle()

    expect(h.gateway.calls.userInfo).toBe(1)
    expect(h.fake.opens).toHaveLength(0)

    await h.clock.tick(HOUR - 1)
    expect(h.gateway.calls.userInfo).toBe(1)
    await h.clock.tick(1)
    expect(h.gateway.calls.userInfo).toBe(2)
    expect(h.connector.state).toBe('waiting_for_vehicle')
    expect(h.fake.opens).toHaveLength(0)
    // The account's vehicles did not change, so the tape holds one record of them.
    expect(h.meta('userInfo')).toHaveLength(1)
    // Retrying is not a state change: one waiting_for_vehicle, however many hours.
    expect(h.metrics.states.filter((s) => s === 'waiting_for_vehicle')).toHaveLength(1)

    h.gateway.script('userInfo', userInfoWith([{ id: 'rv-9', vin: VIN }]))
    await h.clock.tick(HOUR)
    await h.until(() => h.connector.state === 'subscribed', 'subscribed')

    expect(h.gateway.calls.userInfo).toBe(3)
    expect(h.meta('userInfo')).toHaveLength(2)
    expect(h.store.writes.at(-1)!.rivianVehicleId).toBe('rv-9')
  })

  it('an hourly retry that is refused as unauthenticated twice means unauthenticated', async () => {
    h = await makeHarness()
    h.gateway.script(
      'userInfo',
      userInfoWith([{ id: 'other-1', vin: 'SOMEONEELSESVIN123' }]),
      unauthenticated(),
    )
    await h.signIn()
    h.connector.start()
    await h.until(() => h.connector.state === 'waiting_for_vehicle', 'waiting_for_vehicle')
    await settle()
    expect(h.gateway.calls).toMatchObject({ createCsrf: 1, userInfo: 1 })

    await h.clock.tick(HOUR)

    // The retry, one fresh app session, the retry's retry: then it stops.
    expect(h.connector.state).toBe('unauthenticated')
    expect(h.gateway.calls).toMatchObject({ createCsrf: 2, userInfo: 3 })
    expect(h.store.writes.at(-1)).toMatchObject({
      state: 'unauthenticated',
      lastError: 'Rivian rejected the session',
    })
    expect(h.fake.opens).toHaveLength(0)

    await h.clock.tick(3 * HOUR)
    expect(h.gateway.calls).toMatchObject({ createCsrf: 2, userInfo: 3 })
    expect(h.connector.state).toBe('unauthenticated')
  })

  it('matches the VIN as Rivian spells it, whatever the case of the configured one', async () => {
    h = await makeHarness()
    h.gateway.script('userInfo', userInfoWith([{ id: 'rv-1', vin: VIN.toLowerCase() }]))
    await h.connect()
    expect(h.connector.state).toBe('subscribed')
  })
})

describe('credential', () => {
  it('an undecryptable credential leads to credential_invalid with no socket, and a new stamp recovers', async () => {
    h = await makeHarness()
    h.signInWithGarbage()
    h.connector.start()
    await h.until(() => h.connector.state === 'credential_invalid', 'credential_invalid')
    await settle()

    expect(h.fake.opens).toHaveLength(0)
    expect(h.gateway.calls.createCsrf).toBe(0)
    expect(h.store.writes.at(-1)).toMatchObject({
      state: 'credential_invalid',
      lastError: 'the stored credential cannot be read',
    })

    // The same row is not read again, however long it waits: only a new stamp
    // can change the answer.
    await h.clock.tick(HOUR)
    expect(h.store.calls.credential).toBe(1)
    expect(h.connector.state).toBe('credential_invalid')

    await h.signIn()
    await h.clock.tick(POLL)
    await h.until(() => h.connector.state === 'subscribed', 'subscribed')
    expect(h.fake.opens).toHaveLength(1)
    expect(h.store.writes.at(-1)!.lastError).toBeNull()
  })
})

describe('signing in again', () => {
  const SECOND_TOKEN = 'tok-SECOND-userSession-9876543210'

  it('a changed stamp while subscribed closes the live socket, and the new one carries the new token', async () => {
    h = await makeHarness()
    await h.connect()
    const first = h.socket
    const staleId = first.idFor('cloud')
    expect(h.fake.opens[0]!.initPayload['u-sess']).toBe(TOKEN)

    await h.signIn(SECOND_TOKEN)
    await h.clock.tick(POLL)
    await h.until(
      () => h.fake.opens.length === 2 && h.connector.state === 'subscribed',
      'the second connection',
    )
    await settle()

    // Exactly one more socket, the old one closed, the new one on the new session.
    expect(first.closed).toBe(true)
    expect(h.fake.sockets).toHaveLength(2)
    expect(h.socket).not.toBe(first)
    expect(h.socket.closed).toBe(false)
    expect(h.fake.opens[1]!.initPayload['u-sess']).toBe(SECOND_TOKEN)
    expect(h.socket.subscribes).toHaveLength(INITIAL_SUBSCRIPTIONS)
    // Every call made since the restart used the new token, and no call made
    // before it used the new one.
    expect(h.gateway.tokens.at(-1)).toBe(SECOND_TOKEN)
    expect(h.gateway.tokens.indexOf(SECOND_TOKEN)).toBeGreaterThan(h.gateway.tokens.lastIndexOf(TOKEN))
    // It was a restart, not a failure: no backoff, and the old socket is not heard from again.
    expect(h.metrics.reconnects).toEqual([])
    first.handlers.onNext(staleId, { data: {} })
    await settle()
    expect(h.frames('cloud')).toHaveLength(0)
  })
})

describe('postgres blips (review focus 3)', () => {
  it('a credential poll that throws three times keeps subscribed, and counts three failures', async () => {
    h = await makeHarness()
    await h.connect()

    h.store.stampFailures = 3
    await h.clock.tick(3 * POLL)

    expect(h.metrics.pollFailures).toBe(3)
    expect(h.connector.state).toBe('subscribed')
    expect(h.fake.sockets).toHaveLength(1)
    expect(h.socket.closed).toBe(false)

    // The next poll succeeds, finds the same stamp, and does nothing.
    await h.clock.tick(POLL)
    expect(h.connector.state).toBe('subscribed')
    expect(h.fake.opens).toHaveLength(1)
    // A streak of failures is one line, not one per poll, and says nothing the driver said.
    expect(h.logs.filter((l) => l.includes('credential poll failed'))).toHaveLength(1)
    expect(h.logs.join('\n')).not.toContain('db-password-xyz')
  })

  it('a successful empty poll leads to signed_out, and the socket is closed', async () => {
    h = await makeHarness()
    await h.connect()
    const socket = h.socket

    h.store.stamp = null
    await h.clock.tick(POLL)

    expect(h.connector.state).toBe('signed_out')
    expect(socket.closed).toBe(true)
    expect(h.store.writes.at(-1)).toMatchObject({ state: 'signed_out', rivianVehicleId: null })

    // And it stays out: nothing is asked of Rivian again.
    const csrfs = h.gateway.calls.createCsrf
    await h.clock.tick(HOUR)
    expect(h.fake.opens).toHaveLength(1)
    expect(h.gateway.calls.createCsrf).toBe(csrfs)
  })

  it('a poll that never answers counts as a failure after 10 s, and the next poll still runs', async () => {
    h = await makeHarness()
    await h.connect()
    const socket = h.socket
    const polls = h.store.calls.stamp

    h.store.stampHangs = true
    await h.clock.tick(POLL)
    expect(h.store.calls.stamp).toBe(polls + 1)
    expect(h.metrics.pollFailures).toBe(0)

    await h.clock.tick(10 * SECOND)
    expect(h.metrics.pollFailures).toBe(1)

    h.store.stampHangs = false
    await h.clock.tick(POLL)
    expect(h.store.calls.stamp).toBe(polls + 2)
    expect(h.connector.state).toBe('subscribed')

    // Review focus 3: through all of it the Rivian socket was never touched.
    expect(h.fake.opens).toHaveLength(1)
    expect(h.fake.sockets).toEqual([socket])
    expect(socket.closed).toBe(false)
    expect(socket.completes).toEqual([])
  })

  it('a status write that throws does not change state or close the socket', async () => {
    h = await makeHarness()
    h.store.writeFails = true
    await h.connect()

    const socket = h.socket
    expect(h.connector.state).toBe('subscribed')
    expect(h.store.calls.write).toBeGreaterThan(0)
    expect(socket.closed).toBe(false)

    // Frames are still taken and published.
    await h.next('cloud', { data: { vehicleCloudConnection: { isOnline: true } } })
    expect(h.frames('cloud')).toHaveLength(1)
    expect(h.logs.some((l) => l.includes('status write failed'))).toBe(true)
    expect(h.logs.join('\n')).not.toContain('db-password-xyz')

    // Review focus 3: failing writes, through a minute of silence and a state
    // change's worth of retries, never cost the socket or a reconnect.
    await h.clock.tick(30 * SECOND)
    expect(h.connector.state).toBe('subscribed')
    expect(h.fake.opens).toHaveLength(1)
    expect(h.fake.sockets).toEqual([socket])
    expect(socket.closed).toBe(false)
    expect(socket.completes).toEqual([])

    // The write that failed is made again with the next change.
    h.store.writeFails = false
    h.socket.handlers.onClose('rate_limited', 'websocket closed: rate limited')
    await settle()
    expect(h.store.writes.at(-1)!.state).toBe('backing_off')
  })

  it('writes last_frame_at at most once a minute', async () => {
    h = await makeHarness()
    await h.connect()
    const before = h.store.writes.length

    for (let i = 0; i < 125; i += 1) {
      await h.next('cloud')
      await h.clock.tick(SECOND)
    }

    const withFrameTime = h.store.writes.slice(before).filter((w) => w.lastFrameAt !== null)
    // A frame every second for 125 s: at the first, and about every minute after.
    expect(withFrameTime.length).toBeGreaterThanOrEqual(2)
    expect(withFrameTime.length).toBeLessThanOrEqual(3)
    expect(h.store.writes.at(-1)!.lastFrameAt).toBeInstanceOf(Date)
  })
})

describe('auth', () => {
  it('HTTP UNAUTHENTICATED on userInfo once, then OK, is fine, at the price of one more createCsrf', async () => {
    h = await makeHarness()
    h.gateway.script('userInfo', unauthenticated(), userInfoWith([{ id: 'rv-1', vin: VIN }]))
    await h.connect()

    expect(h.connector.state).toBe('subscribed')
    expect(h.gateway.calls.createCsrf).toBe(2)
    expect(h.gateway.calls.userInfo).toBe(2)
  })

  it('HTTP UNAUTHENTICATED twice means unauthenticated, with no retry until the credential changes', async () => {
    h = await makeHarness()
    h.gateway.script('userInfo', unauthenticated())
    await h.signIn()
    h.connector.start()
    await h.until(() => h.connector.state === 'unauthenticated', 'unauthenticated')
    await settle()

    expect(h.gateway.calls.createCsrf).toBe(2)
    expect(h.gateway.calls.userInfo).toBe(2)
    expect(h.fake.opens).toHaveLength(0)
    expect(h.store.writes.at(-1)).toMatchObject({
      state: 'unauthenticated',
      lastError: 'Rivian rejected the session',
    })

    await h.clock.tick(HOUR)
    expect(h.gateway.calls.userInfo).toBe(2)
    expect(h.connector.state).toBe('unauthenticated')

    h.gateway.script('userInfo', userInfoWith([{ id: 'rv-1', vin: VIN }]))
    await h.signIn()
    await h.clock.tick(POLL)
    await h.until(() => h.connector.state === 'subscribed', 'subscribed')
  })

  it('a websocket close "Unauthenticated" means unauthenticated: no reconnect in an hour, and a new stamp recovers', async () => {
    h = await makeHarness()
    await h.connect()
    const calls = { ...h.gateway.calls }

    h.socket.handlers.onClose('unauthenticated', 'websocket closed: unauthenticated')
    await settle()
    expect(h.connector.state).toBe('unauthenticated')
    expect(h.store.writes.at(-1)).toMatchObject({
      state: 'unauthenticated',
      lastError: 'websocket closed: unauthenticated',
    })

    await h.clock.tick(HOUR)
    // No socket, no HTTP of any kind, no backoff: it has stopped.
    expect(h.fake.opens).toHaveLength(1)
    expect(h.gateway.calls).toEqual(calls)
    expect(h.metrics.reconnects).toEqual([])
    expect(h.connector.state).toBe('unauthenticated')

    await h.signIn()
    await h.clock.tick(POLL)
    await h.until(() => h.connector.state === 'subscribed', 'subscribed')
    expect(h.fake.opens).toHaveLength(2)
  })

  it('a close sent in place of the ack, saying Unauthenticated, is the same verdict', async () => {
    h = await makeHarness()
    h.fake.outcomes.push(new SocketOpenError('unauthenticated', 'websocket closed: unauthenticated'))
    await h.signIn()
    h.connector.start()
    await h.until(() => h.connector.state === 'unauthenticated', 'unauthenticated')

    await h.clock.tick(HOUR)
    expect(h.fake.opens).toHaveLength(1)
    expect(h.metrics.reconnects).toEqual([])
  })

  // The refusal is the second thing to arrive after a sign-out, and an
  // `UNAUTHENTICATED` that lands once the lifecycle is over must not be answered
  // by a `CreateCSRFToken`: that is a Rivian call, made for a session that has
  // been closed on purpose, for nobody.
  it('a refusal that arrives after the lifecycle ended makes no new app session', async () => {
    h = await makeHarness()
    let refuse: (e: Error) => void = () => {}
    h.gateway.script(
      'userInfo',
      () =>
        new Promise((_resolve, reject) => {
          refuse = reject
        }),
    )
    await h.signIn()
    h.connector.start()
    await h.until(() => h.gateway.calls.userInfo === 1, 'the pending userInfo')
    expect(h.gateway.calls.createCsrf).toBe(1)

    // The user signs out while the call is in flight.
    h.store.stamp = null
    await h.clock.tick(POLL)
    expect(h.connector.state).toBe('signed_out')

    refuse(unauthenticated())
    await settle()

    expect(h.gateway.calls.createCsrf).toBe(1)
    expect(h.gateway.calls.userInfo).toBe(1)
    expect(h.connector.state).toBe('signed_out')
  })

  it('a refusal that arrives after stop() makes no new app session', async () => {
    h = await makeHarness()
    let refuse: (e: Error) => void = () => {}
    h.gateway.script(
      'userInfo',
      () =>
        new Promise((_resolve, reject) => {
          refuse = reject
        }),
    )
    await h.signIn()
    h.connector.start()
    await h.until(() => h.gateway.calls.userInfo === 1, 'the pending userInfo')

    void h.connector.stop()
    refuse(unauthenticated())
    await settle()

    expect(h.gateway.calls.createCsrf).toBe(1)
  })

  it('a refused slow call does not take a healthy stream down with it', async () => {
    h = await makeHarness()
    h.gateway.script('chargingSummaries', unauthenticated('getCompletedSessionSummaries'))
    await h.connect()

    expect(h.connector.state).toBe('subscribed')
    expect(h.logs.some((l) => l.includes('getCompletedSessionSummaries failed'))).toBe(true)
  })
})

describe('backoff', () => {
  it('a websocket close "Rate limited" gives backing_off, and the reconnect is no earlier than 30 s', async () => {
    h = await makeHarness()
    await h.connect()

    h.socket.handlers.onClose('rate_limited', 'websocket closed: rate limited')
    await settle()

    expect(h.connector.state).toBe('backing_off')
    expect(h.metrics.reconnects).toEqual(['rate_limited'])
    const row = h.store.writes.at(-1)!
    expect(row.state).toBe('backing_off')
    expect(row.lastError).toBe('websocket closed: rate limited')
    expect(row.backoffUntil).toEqual(new Date(h.clock.now() + 30 * SECOND))

    await h.clock.tick(30 * SECOND - 1)
    expect(h.fake.opens).toHaveLength(1)
    await h.clock.tick(1)
    await h.until(() => h.fake.opens.length === 2, 'the reconnect')
    await h.until(() => h.connector.state === 'subscribed', 'subscribed')

    // A reconnected socket subscribes to everything again, on a plan restarted
    // for it, and the status no longer says it is backing off.
    expect(h.socket.subscribes).toHaveLength(INITIAL_SUBSCRIPTIONS)
    expect(h.store.writes.at(-1)).toMatchObject({ state: 'subscribed', backoffUntil: null, lastError: null })
  })

  it('repeated closes follow 30 s, 60 s, 120 s, and data resets the schedule', async () => {
    h = await makeHarness()
    await h.connect()

    const closeAndWait = async (waitMs: number, expectedOpens: number): Promise<void> => {
      h.socket.handlers.onClose('closed', 'websocket closed with code 1006')
      await settle()
      expect(h.connector.state).toBe('backing_off')
      await h.clock.tick(waitMs - 1)
      expect(h.fake.opens).toHaveLength(expectedOpens - 1)
      await h.clock.tick(1)
      await h.until(() => h.fake.opens.length === expectedOpens, `open ${expectedOpens}`)
      await h.until(() => h.connector.state === 'subscribed', 'subscribed')
    }

    // The acknowledgement alone does not reset it: the server may ack and close.
    await closeAndWait(30 * SECOND, 2)
    await closeAndWait(60 * SECOND, 3)
    await closeAndWait(120 * SECOND, 4)

    // The first frame after a connect does.
    await h.next('cloud')
    await closeAndWait(30 * SECOND, 5)
  })

  it('a rejected open (no ack) backs off on the same schedule', async () => {
    h = await makeHarness()
    h.fake.outcomes.push(new SocketOpenError('no_ack', 'no connection_ack within 15000 ms'))
    await h.signIn()
    h.connector.start()
    await h.until(() => h.connector.state === 'backing_off', 'backing_off')
    await settle()

    expect(h.metrics.reconnects).toEqual(['no_ack'])
    expect(h.store.writes.at(-1)!.lastError).toBe('no connection_ack within 15000 ms')
    await h.clock.tick(30 * SECOND - 1)
    expect(h.fake.opens).toHaveLength(1)
    await h.clock.tick(1)
    await h.until(() => h.connector.state === 'subscribed', 'subscribed')
    expect(h.fake.opens).toHaveLength(2)
  })

  it('jitter is added on top of the floor', async () => {
    h = await makeHarness({ random: () => 0.5 })
    await h.connect()
    h.socket.handlers.onClose('closed', 'websocket closed with code 1006')
    await settle()

    await h.clock.tick(45 * SECOND - 1)
    expect(h.fake.opens).toHaveLength(1)
    await h.clock.tick(1)
    await h.until(() => h.fake.opens.length === 2, 'the reconnect')
  })

  it('an HTTP failure before the socket backs off too, and says what Rivian said, redacted', async () => {
    h = await makeHarness()
    h.gateway.script(
      'userInfo',
      new RivianApiError(502, [], 'getUserInfo'),
      userInfoWith([{ id: 'rv-1', vin: VIN }]),
    )
    await h.signIn()
    h.connector.start()
    await h.until(() => h.connector.state === 'backing_off', 'backing_off')
    await settle()

    expect(h.metrics.reconnects).toEqual(['http'])
    expect(h.store.writes.at(-1)!.lastError).toBe('Rivian HTTP 502')
    await h.clock.tick(30 * SECOND - 1)
    expect(h.gateway.calls.userInfo).toBe(1)
    await h.clock.tick(1)
    await h.until(() => h.connector.state === 'subscribed', 'subscribed')
    expect(h.gateway.calls.userInfo).toBe(2)
  })

  // A restart is not a reason to knock again. The status row is the only place
  // a rate-limit backoff survives a restart, and it is read at `starting`.
  it('a restart inside a saved backoff waits it out, and asks Rivian nothing before then', async () => {
    h = await makeHarness()
    const until = START + 5 * MINUTE
    h.store.statusRow = {
      state: 'backing_off',
      vin: VIN,
      rivianVehicleId: 'rv-1',
      lastFrameAt: null,
      lastError: 'websocket closed: rate limited',
      backoffUntil: new Date(until),
      droppedProperties: [],
      updatedAt: new Date(START),
    }
    await h.signIn()
    h.connector.start()
    await h.until(() => h.connector.state === 'backing_off', 'backing_off')
    await settle()

    expect(h.store.writes.at(-1)).toMatchObject({ state: 'backing_off', backoffUntil: new Date(until) })
    expect(h.gateway.calls.createCsrf).toBe(0)

    await h.clock.tick(5 * MINUTE - 1)
    expect(h.gateway.calls.createCsrf).toBe(0)
    expect(h.fake.opens).toHaveLength(0)

    await h.clock.tick(1)
    await h.until(() => h.connector.state === 'subscribed', 'subscribed')
    expect(h.gateway.calls.createCsrf).toBe(1)
  })

  it('a saved backoff that has already passed delays nothing', async () => {
    h = await makeHarness()
    h.store.statusRow = {
      state: 'backing_off',
      vin: VIN,
      rivianVehicleId: 'rv-1',
      lastFrameAt: null,
      lastError: 'websocket closed: rate limited',
      backoffUntil: new Date(START - MINUTE),
      droppedProperties: [],
      updatedAt: new Date(START - 2 * MINUTE),
    }
    await h.connect()

    expect(h.connector.state).toBe('subscribed')
    expect(h.metrics.states).not.toContain('backing_off')
  })

  it('a new credential during a backoff still waits the backoff out', async () => {
    h = await makeHarness()
    await h.connect()
    h.socket.handlers.onClose('rate_limited', 'websocket closed: rate limited')
    await settle()
    const closedAt = h.clock.now()

    await h.signIn()
    await h.clock.tick(POLL)
    // Restarted, and back to waiting: the lifecycle began inside the backoff.
    await h.until(() => h.metrics.states.filter((s) => s === 'starting').length === 2, 'the restart')
    await settle()
    expect(h.connector.state).toBe('backing_off')
    expect(h.store.writes.at(-1)!.backoffUntil).toEqual(new Date(closedAt + 30 * SECOND))
    expect(h.fake.opens).toHaveLength(1)
    // Nothing is asked of Rivian before then, HTTP included.
    expect(h.gateway.calls.createCsrf).toBe(1)

    await h.clock.tick(15 * SECOND - 1)
    expect(h.fake.opens).toHaveLength(1)
    await h.clock.tick(1)
    await h.until(() => h.connector.state === 'subscribed', 'subscribed')
    expect(h.fake.opens).toHaveLength(2)
  })
})

describe('silence', () => {
  it('61 s with no frame resubscribes every subscription under fresh ids, and does not reconnect', async () => {
    h = await makeHarness()
    await h.connect()
    const socket = h.socket
    const before = socket.liveIds

    await h.clock.tick(61 * SECOND)

    expect(socket.completes.sort()).toEqual([...before].sort())
    expect(socket.subscribes).toHaveLength(2 * INITIAL_SUBSCRIPTIONS)
    const after = socket.liveIds
    expect(after).toHaveLength(INITIAL_SUBSCRIPTIONS)
    expect(after.filter((id) => before.includes(id))).toEqual([])
    // The same subscriptions, not different ones: each key is renewed.
    const key = (id: string) => id.split('#')[0]
    expect(after.map(key).sort()).toEqual(before.map(key).sort())
    expect(h.fake.opens).toHaveLength(1)
    expect(socket.closed).toBe(false)
    expect(h.connector.state).toBe('subscribed')
    expect(h.metrics.reconnects).toEqual([])
  })

  it('a frame resets the silence clock', async () => {
    h = await makeHarness()
    await h.connect()
    const socket = h.socket

    await h.clock.tick(30 * SECOND)
    await h.next('cloud')
    await h.clock.tick(45 * SECOND)
    expect(socket.completes).toHaveLength(0)

    // 60 s after the frame, not before.
    await h.clock.tick(14 * SECOND)
    expect(socket.completes).toHaveLength(0)
    await h.clock.tick(1 * SECOND)
    expect(socket.completes).toHaveLength(INITIAL_SUBSCRIPTIONS)
  })

  it('a frame for an id that is no longer live is neither published nor a sign of life', async () => {
    h = await makeHarness()
    await h.connect()
    const socket = h.socket
    const stale = socket.idFor('cloud')

    await h.clock.tick(61 * SECOND)
    expect(socket.completes).toContain(stale)
    const published = h.frames('cloud').length

    socket.handlers.onNext(stale, { data: {} })
    await settle()
    expect(h.frames('cloud')).toHaveLength(published)
    expect(h.metrics.frames['cloud']).toBeUndefined()
  })
})

describe('a field Rivian rejects', () => {
  /** Reject, and let the 30 s pass, until the property is alone and rejected. */
  async function rejectUntilDropped(property: string): Promise<number> {
    let rejections = 0
    while (!h.store.writes.some((w) => w.droppedProperties.includes(property))) {
      const sub = h.socket.subscribeFor(property)
      if (sub === undefined || !h.socket.liveIds.includes(sub.id)) throw new Error('lost track of the property')
      h.socket.reject(sub.id)
      rejections += 1
      await h.clock.tick(30 * SECOND)
      if (rejections > 10) throw new Error('never dropped')
    }
    return rejections
  }

  it('is bisected 30 s at a time, dropped, written and taped, while its neighbours keep flowing', async () => {
    h = await makeHarness()
    await h.connect()
    const bad = RIVIAN_PROPERTIES[0]!.name
    const group0 = h.socket.subscribeFor(bad)!
    const subscribed = h.socket.subscribes.length

    h.socket.reject(group0.id)
    await settle()
    // Not at once: the halves wait.
    expect(h.socket.subscribes).toHaveLength(subscribed)
    await h.clock.tick(30 * SECOND - 1)
    expect(h.socket.subscribes).toHaveLength(subscribed)
    await h.clock.tick(1)
    expect(h.socket.subscribes).toHaveLength(subscribed + 2)
    const halves = h.socket.subscribes.slice(-2)
    expect(halves.map((s) => s.doc.operationName)).toEqual(['VehicleState', 'VehicleState'])
    expect(halves.map((s) => (s.doc.query.match(/timeStamp/g) ?? []).length)).toEqual([8, 8])

    // Sixteen properties settle in five rejections along the bad one's lineage.
    const rejections = 1 + (await rejectUntilDropped(bad))
    expect(rejections).toBe(5)

    expect(h.store.writes.at(-1)!.droppedProperties).toEqual([bad])
    expect(h.meta('droppedProperties').at(-1)).toEqual({ properties: [bad] })
    expect(h.metrics.droppedProps.at(-1)).toBe(1)

    // Everything else is still subscribed, and the dropped one is in nothing.
    const asked = liveStateProperties(h.socket)
    expect(asked).not.toContain(bad)
    expect(asked.sort()).toEqual(RIVIAN_PROPERTIES.map((p) => p.name).filter((n) => n !== bad).sort())
    expect(h.fake.opens).toHaveLength(1)
  })

  it('a dropped property stays out of a reconnect and out of the next renewal', async () => {
    h = await makeHarness()
    await h.connect()
    const bad = RIVIAN_PROPERTIES[3]!.name
    await rejectUntilDropped(bad)

    h.socket.handlers.onClose('closed', 'websocket closed with code 1006')
    await settle()
    await h.clock.tick(30 * SECOND)
    await h.until(() => h.fake.opens.length === 2, 'the reconnect')
    await h.until(() => h.connector.state === 'subscribed', 'subscribed')

    expect(liveStateProperties(h.socket)).not.toContain(bad)
  })

  it('a subscription with no properties to bisect is not resubscribed for a day', async () => {
    h = await makeHarness()
    await h.connect()
    const socket = h.socket
    const charging = socket.idFor('charging')

    socket.reject(charging)
    await h.clock.tick(HOUR)
    expect(socket.liveIds.filter((id) => id.startsWith('charging#'))).toEqual([])

    await h.clock.tick(24 * HOUR)
    expect(socket.liveIds.filter((id) => id.startsWith('charging#'))).toHaveLength(1)
  })

  it('a dropped property is tried again alone after a day, and the list shrinks when it is accepted', async () => {
    h = await makeHarness()
    const name = 'batteryLevel'
    h.store.statusRow = {
      state: 'subscribed',
      vin: VIN,
      rivianVehicleId: 'rv-1',
      lastFrameAt: null,
      lastError: null,
      backoffUntil: null,
      droppedProperties: [name],
      updatedAt: new Date(START),
    }
    await h.connect()
    expect(liveStateProperties(h.socket)).not.toContain(name)

    await h.clock.tick(25 * HOUR)

    const probe = h.socket.subscribeFor(name)!
    // Alone: one property in the selection.
    expect(probe.doc.query.match(/timeStamp/g)).toHaveLength(1)
    expect(liveStateProperties(h.socket)).toContain(name)
    // And the stored list was rewritten without it, and the tape says so.
    expect(h.store.writes.at(-1)!.droppedProperties).toEqual([])
    expect(h.meta('droppedProperties').at(-1)).toEqual({ properties: [] })
  })
})

describe('restart', () => {
  const saved = (droppedProperties: string[]) => ({
    state: 'subscribed' as const,
    vin: VIN,
    rivianVehicleId: 'rv-1',
    lastFrameAt: new Date(START - HOUR),
    lastError: null,
    backoffUntil: null,
    droppedProperties,
    updatedAt: new Date(START - HOUR),
  })

  it("with status() returning droppedProperties ['batteryLevel'], the plan leaves it out of the groups", async () => {
    h = await makeHarness()
    h.store.statusRow = saved(['batteryLevel'])
    await h.connect()

    const asked = liveStateProperties(h.socket)
    expect(asked).not.toContain('batteryLevel')
    // Its neighbour in the catalogue is still there, so this is the one name and not a group.
    expect(asked).toContain('batteryLimit')
    expect(asked).toHaveLength(RIVIAN_PROPERTIES.length - 1)
    // And the list it was started with is what the next write carries.
    expect(h.store.writes.at(-1)!.droppedProperties).toEqual(['batteryLevel'])
    expect(h.metrics.droppedProps.at(-1)).toBe(1)
  })

  it('with status() throwing, it starts with none dropped, and never writes [] over the saved list', async () => {
    h = await makeHarness()
    h.store.statusRow = saved(['batteryLevel'])
    h.store.statusReadFails = true
    await h.connect()

    expect(liveStateProperties(h.socket)).toContain('batteryLevel')
    expect(h.connector.state).toBe('subscribed')
    // Nothing could be written without overwriting a list that is not known.
    expect(h.store.writes).toEqual([])
    expect(h.logs.some((l) => l.includes('status not written'))).toBe(true)

    // The database comes back. The next change is written, with the saved list.
    h.store.statusReadFails = false
    h.socket.handlers.onClose('rate_limited', 'websocket closed: rate limited')
    await settle()
    expect(h.store.writes.length).toBeGreaterThan(0)
    for (const row of h.store.writes) expect(row.droppedProperties).toEqual(['batteryLevel'])
    expect(h.store.writes.at(-1)!.state).toBe('backing_off')
  })

  it('a property dropped before the saved list was read is written beside it, not instead of it', async () => {
    h = await makeHarness()
    h.store.statusRow = saved(['batteryLevel'])
    h.store.statusReadFails = true
    await h.connect()

    const bad = RIVIAN_PROPERTIES[0]!.name
    h.socket.reject(h.socket.subscribeFor(bad)!.id)
    let rejections = 1
    await h.clock.tick(30 * SECOND)
    h.store.statusReadFails = false
    while (!h.store.writes.some((w) => w.droppedProperties.includes(bad))) {
      h.socket.reject(h.socket.subscribeFor(bad)!.id)
      rejections += 1
      await h.clock.tick(30 * SECOND)
      if (rejections > 10) throw new Error('never dropped')
    }

    expect(h.store.writes.at(-1)!.droppedProperties).toEqual(['batteryLevel', bad])
  })
})

describe('a saved list that is read late, after the connector has learned some of its own', () => {
  it('is merged with what the connector learned before a sign-out, not substituted for it', async () => {
    h = await makeHarness()
    h.store.statusRow = {
      state: 'subscribed',
      vin: VIN,
      rivianVehicleId: 'rv-1',
      lastFrameAt: null,
      lastError: null,
      backoffUntil: null,
      droppedProperties: ['batteryLevel'],
      updatedAt: new Date(START),
    }
    h.store.statusReadFails = true
    await h.connect()

    // Rivian rejects one property, which is found while the saved list is unreadable.
    const bad = RIVIAN_PROPERTIES[0]!.name
    for (let rejection = 0; rejection < 5; rejection += 1) {
      h.socket.reject(h.socket.subscribeFor(bad)!.id)
      await h.clock.tick(30 * SECOND)
    }
    expect(liveStateProperties(h.socket)).not.toContain(bad)

    // The user signs out. The plan is gone; what it had learned is the connector's alone.
    h.store.stamp = null
    await h.clock.tick(POLL)
    expect(h.connector.state).toBe('signed_out')
    expect(h.store.writes).toEqual([])

    // The database comes back, and the user signs in again: the saved list is
    // read at last, with no plan to carry it, and joins what was learned.
    h.store.statusReadFails = false
    await h.signIn()
    await h.clock.tick(POLL)
    await h.until(() => h.connector.state === 'subscribed', 'subscribed')
    await settle()

    expect(h.store.writes.length).toBeGreaterThan(0)
    for (const row of h.store.writes) {
      expect(row.droppedProperties).toEqual(['batteryLevel', bad])
    }
    // And neither is subscribed again by the new plan.
    const asked = liveStateProperties(h.socket)
    expect(asked).not.toContain(bad)
    expect(asked).not.toContain('batteryLevel')
    expect(asked).toHaveLength(RIVIAN_PROPERTIES.length - 2)
  })
})

describe('frames', () => {
  it('stamps receivedAt with the clock at arrival, not at publish', async () => {
    h = await makeHarness()
    await h.connect()

    h.mqtt.held = true
    const first = h.clock.now()
    await h.next('cloud', { data: { n: 1 } })
    await h.clock.tick(5 * SECOND)
    const second = h.clock.now()
    await h.next('geofence', { data: { n: 2 } })
    // The broker answers half a minute later.
    await h.clock.tick(20 * SECOND)
    h.mqtt.release()
    await settle()

    const [cloud] = h.frames('cloud')
    const [geofence] = h.frames('geofence')
    expect(cloud!.receivedAt).toBe(new Date(first).toISOString())
    expect(geofence!.receivedAt).toBe(new Date(second).toISOString())
    // It was published 20 s after it arrived, and says when it arrived.
    expect(h.clock.now() - Date.parse(geofence!.receivedAt)).toBe(20 * SECOND)
  })

  it.each<[string, RivianStream]>([
    ['state:0', 'state'],
    ['parallax', 'parallax'],
    ['charging', 'charging'],
    ['cloud', 'cloud'],
    ['ota-state', 'ota'],
    ['ota-schedules', 'ota'],
    ['geofence', 'geofence'],
    ['departure', 'departure'],
  ])('publishes a frame for %s to rivian/<VIN>/%s, whole', async (key, stream) => {
    h = await makeHarness()
    await h.connect()
    const payload = { data: { thing: { n: 7 } } }

    await h.next(key, payload)

    const frames = h.frames(stream)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ v: 1, stream, vin: VIN, topic: `rivian/${VIN}/${stream}`, body: payload })
    expect(h.metrics.frames[stream]).toBe(1)
    expect(h.metrics.lastFrames.at(-1)).toBe(h.clock.now())
  })

  it('publishes a next whose payload carries errors alongside data with body.errors intact', async () => {
    h = await makeHarness()
    await h.connect()
    const payload = {
      data: { vehicleState: { batteryLevel: { timeStamp: '2026-10-19T11:00:00Z', value: 80 } } },
      errors: [{ message: 'partial', extensions: { code: 'PARTIAL_FAILURE' } }],
    }

    await h.next('state:0', payload)

    expect(h.frames('state')[0]!.body).toEqual(payload)
  })

  it('cleans the strings it publishes', async () => {
    h = await makeHarness()
    await h.connect()

    await h.next('state:0', { data: { activeDriverName: { value: 'Jo\u0000n \uD800' } } })

    expect(h.frames('state')[0]!.body).toEqual({ data: { activeDriverName: { value: 'Jon �' } } })
  })

  it('a late frame from a replaced socket is not published', async () => {
    h = await makeHarness()
    await h.connect()
    const old = h.socket
    const oldId = old.idFor('cloud')

    old.handlers.onClose('closed', 'websocket closed with code 1006')
    await settle()
    await h.clock.tick(30 * SECOND)
    await h.until(() => h.fake.opens.length === 2 && h.connector.state === 'subscribed', 'the reconnect')

    old.handlers.onNext(oldId, { data: {} })
    old.handlers.onClose('rate_limited', 'websocket closed: rate limited')
    await settle()
    expect(h.frames('cloud')).toHaveLength(0)
    // And a close from the old socket is no reason to back off the new one.
    expect(h.connector.state).toBe('subscribed')
  })

  it('closes a socket that was opened for a lifecycle that has ended', async () => {
    h = await makeHarness()
    await h.signIn()
    h.fake.hold = true
    h.connector.start()
    await h.until(() => h.fake.opens.length === 1, 'the open')

    // Signed out while the socket is still being opened.
    h.store.stamp = null
    await h.clock.tick(POLL)
    expect(h.connector.state).toBe('signed_out')

    h.fake.releaseOpens()
    await h.until(() => h.fake.sockets.length === 1, 'the socket')
    await settle()
    expect(h.fake.sockets[0]!.closed).toBe(true)
    expect(h.fake.sockets[0]!.subscribes).toEqual([])
    expect(h.connector.state).toBe('signed_out')
  })
})

describe('the publish queue overflowing', () => {
  const bulk = { data: { padding: 'x'.repeat(200) } }

  /** Frames until `n` have been dropped, with the broker held. */
  async function storm(frames: number): Promise<void> {
    h.mqtt.held = true
    for (let i = 0; i < frames; i += 1) await h.next('state:0', bulk)
  }

  it('a small cap drops frames, counts them, and resubscribes all once the queue empties', async () => {
    h = await makeHarness({ capBytes: 3_000 })
    await h.connect()
    const socket = h.socket
    const before = socket.liveIds

    await storm(40)

    expect(h.metrics.droppedTotal).toBeGreaterThan(10)
    expect(socket.completes).toEqual([])
    h.mqtt.release()
    await settle()

    expect(socket.completes.sort()).toEqual([...before].sort())
    expect(socket.liveIds).toHaveLength(INITIAL_SUBSCRIPTIONS)
    expect(h.fake.opens).toHaveLength(1)
    expect(h.connector.state).toBe('subscribed')
  })

  it('100 drops during a broker outage cause exactly one renewal, after the queue empties', async () => {
    h = await makeHarness({ capBytes: 3_000 })
    await h.connect()
    const socket = h.socket
    const subscribed = socket.subscribes.length

    await storm(200)
    expect(h.metrics.droppedTotal).toBeGreaterThanOrEqual(100)
    // Nothing is renewed while the broker is away: the snapshot would only overflow it again.
    expect(socket.completes).toEqual([])
    expect(socket.subscribes).toHaveLength(subscribed)

    h.mqtt.release()
    await settle()
    expect(socket.completes).toHaveLength(INITIAL_SUBSCRIPTIONS)
    expect(socket.subscribes).toHaveLength(subscribed + INITIAL_SUBSCRIPTIONS)

    await h.clock.tick(30 * SECOND)
    expect(socket.completes).toHaveLength(INITIAL_SUBSCRIPTIONS)
  })

  it('never renews more than once a minute', async () => {
    h = await makeHarness({ capBytes: 3_000 })
    await h.connect()
    const socket = h.socket

    await storm(200)
    h.mqtt.release()
    await settle()
    expect(socket.completes).toHaveLength(INITIAL_SUBSCRIPTIONS)
    const renewedAt = h.clock.now()

    // Another overflow ten seconds later is remembered, and acted on a minute
    // after the last renewal, not before.
    await h.clock.tick(10 * SECOND)
    await storm(200)
    h.mqtt.release()
    await settle()
    expect(socket.completes).toHaveLength(INITIAL_SUBSCRIPTIONS)

    await h.clock.tick(renewedAt + MINUTE - 1 - h.clock.now())
    expect(socket.completes).toHaveLength(INITIAL_SUBSCRIPTIONS)
    await h.clock.tick(1)
    expect(socket.completes).toHaveLength(2 * INITIAL_SUBSCRIPTIONS)
  })

  it('a drop before the socket is up asks for no renewal: the first subscribe is the snapshot', async () => {
    h = await makeHarness({ capBytes: 600 })
    // The broker is away and the socket is still opening, so the `connection`
    // and `meta` frames of the lifecycle itself overflow the queue first.
    h.mqtt.held = true
    h.fake.hold = true
    await h.signIn()
    h.connector.start()
    await h.until(() => h.fake.opens.length === 1, 'the open')
    await settle()
    expect(h.metrics.droppedTotal).toBeGreaterThan(0)

    // The broker comes back before the acknowledgement, so nothing after it overflows.
    h.mqtt.release()
    await settle()
    h.fake.releaseOpens()
    await h.until(() => h.connector.state === 'subscribed', 'subscribed')
    await settle()
    await h.clock.tick(30 * SECOND)

    expect(h.socket.completes).toEqual([])
    expect(h.socket.subscribes).toHaveLength(INITIAL_SUBSCRIPTIONS)
  })

  it('counts a frame the broker is slow for as published, not dropped', async () => {
    h = await makeHarness()
    await h.connect()

    h.mqtt.held = true
    await h.next('cloud')
    await h.next('cloud')
    h.mqtt.release()
    await settle()

    expect(h.metrics.droppedTotal).toBe(0)
    expect(h.frames('cloud')).toHaveLength(2)
    expect(h.socket.completes).toEqual([])
  })
})

describe('shutdown', () => {
  it('stop() drains, completes every id, closes the socket, and ends MQTT, in that order', async () => {
    h = await makeHarness()
    await h.connect()
    const socket = h.socket
    const ids = socket.liveIds
    const complete = vi.spyOn(socket, 'complete')
    const close = vi.spyOn(socket, 'close')
    const end = vi.spyOn(h.mqtt, 'end')

    h.mqtt.held = true
    await h.next('cloud', { data: { n: 1 } })
    const stopped = h.connector.stop()
    await settle()
    // Draining: the frame is owed to the broker, so nothing else has happened.
    expect(socket.completes).toEqual([])
    expect(close).not.toHaveBeenCalled()

    h.mqtt.release()
    await stopped

    expect(h.frames('cloud')).toHaveLength(1)
    expect([...socket.completes].sort()).toEqual([...ids].sort())
    expect(socket.closed).toBe(true)
    expect(end).toHaveBeenCalledTimes(1)
    expect(Math.max(...complete.mock.invocationCallOrder)).toBeLessThan(close.mock.invocationCallOrder[0]!)
    expect(close.mock.invocationCallOrder[0]!).toBeLessThan(end.mock.invocationCallOrder[0]!)
    expect(h.metrics.droppedTotal).toBe(0)
  })

  it('frames still owed after 5 s count as dropped', async () => {
    h = await makeHarness()
    await h.connect()
    h.mqtt.held = true
    await h.next('cloud')
    await h.next('cloud')
    await h.next('cloud')

    // Only the timers `Publisher.drain` uses; the connector's are the fake clock's.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const stopped = h.connector.stop()
    await vi.advanceTimersByTimeAsync(5_000)
    await stopped

    // One in flight and two queued behind it.
    expect(h.metrics.droppedTotal).toBe(3)
    expect(h.socket.closed).toBe(true)
    // Ended by force, since a publish was still out.
    expect(h.mqtt.ends).toEqual([true])
  })

  it('stops reading the socket and starting anything new', async () => {
    h = await makeHarness()
    await h.connect()
    const stopped = h.connector.stop()
    await stopped

    const frames = h.mqtt.published.length
    const polls = h.store.calls.stamp
    h.socket.handlers.onNext(h.socket.subscribes[0]!.id, { data: {} })
    h.socket.handlers.onClose('closed', 'websocket closed with code 1006')
    await h.clock.tick(HOUR)

    expect(h.mqtt.published).toHaveLength(frames)
    expect(h.fake.opens).toHaveLength(1)
    // Not even the credential poll: nothing runs after the stop.
    expect(h.store.calls.stamp).toBe(polls)
  })

  it('may be called more than once', async () => {
    h = await makeHarness()
    await h.connect()
    await Promise.all([h.connector.stop(), h.connector.stop()])
    expect(h.mqtt.ends).toHaveLength(1)
  })

  it('closes a socket that is still being opened', async () => {
    h = await makeHarness()
    await h.signIn()
    h.fake.hold = true
    h.connector.start()
    await h.until(() => h.fake.opens.length === 1, 'the open')

    await h.connector.stop()
    h.fake.releaseOpens()
    await h.until(() => h.fake.sockets.length === 1, 'the socket')
    await settle()

    expect(h.fake.sockets[0]!.closed).toBe(true)
    expect(h.fake.sockets[0]!.subscribes).toEqual([])
  })
})

describe('meta', () => {
  it('two identical userInfo results publish one meta frame, and a changed one publishes a second', async () => {
    h = await makeHarness()
    await h.connect()
    expect(h.meta('userInfo')).toHaveLength(1)

    await h.clock.tick(6 * HOUR)
    expect(h.gateway.calls.userInfo).toBe(2)
    expect(h.meta('userInfo')).toHaveLength(1)

    const changed = userInfoWith([{ id: 'rv-1', vin: VIN }])
    ;(changed as { currentUser: { vehicles: { name: string }[] } }).currentUser.vehicles[0]!.name = 'Renamed'
    h.gateway.script('userInfo', changed)
    await h.clock.tick(6 * HOUR)
    expect(h.gateway.calls.userInfo).toBe(3)
    expect(h.meta('userInfo')).toHaveLength(2)
    expect(h.meta('userInfo')[1]).toEqual(changed)
  })

  it('runs vehicle and the charging summaries on their cadence, change-only', async () => {
    h = await makeHarness()
    await h.connect()

    await h.clock.tick(6 * HOUR)
    expect(h.gateway.calls.chargingSummaries).toBe(2)
    expect(h.gateway.calls.vehicle).toBe(1)
    await h.clock.tick(18 * HOUR)
    expect(h.gateway.calls.chargingSummaries).toBe(5)
    expect(h.gateway.calls.vehicle).toBe(2)
    expect(h.gateway.calls.introspectVehicleState).toBe(2)
    for (const kind of ['vehicle', 'chargingSummaries', 'schema']) {
      expect(h.meta(kind), kind).toHaveLength(1)
    }
  })

  it('tries a refused introspection again in a day, and changes nothing else', async () => {
    h = await makeHarness()
    h.gateway.script('introspectVehicleState', new RivianApiError(200, [{ code: 'FORBIDDEN' }], 'introspect'), {
      __type: { fields: [] },
    })
    await h.connect()

    expect(h.gateway.calls.introspectVehicleState).toBe(1)
    expect(h.connector.state).toBe('subscribed')
    expect(h.meta('schema')).toEqual([])

    await h.clock.tick(24 * HOUR - 1)
    expect(h.gateway.calls.introspectVehicleState).toBe(1)
    await h.clock.tick(1)
    expect(h.gateway.calls.introspectVehicleState).toBe(2)
    expect(h.meta('schema')).toHaveLength(1)
  })
})

describe('discovery', () => {
  const field = (name: string, typeName: string | null, wrapped?: string) => ({
    name,
    type: wrapped === undefined ? { name: typeName, kind: 'OBJECT', ofType: null } : { name: null, kind: 'NON_NULL', ofType: { name: wrapped, kind: 'OBJECT' } },
  })

  it('a TimeStamped field the catalogue lacks is subscribed, and any other unknown field is only listed', async () => {
    h = await makeHarness()
    const introspection = {
      __type: {
        fields: [
          field('batteryLevel', 'TimeStampedFloat'),
          field('newThing', 'TimeStampedFloat'),
          field('wrappedThing', null, 'TimeStampedString'),
          field('oddThing', 'SomethingElse'),
          field('not a name', 'TimeStampedFloat'),
        ],
      },
    }
    h.gateway.script('introspectVehicleState', introspection)
    await h.connect()

    const asked = liveStateProperties(h.socket)
    expect(asked).toContain('newThing')
    expect(asked).toContain('wrappedThing')
    expect(asked).not.toContain('oddThing')
    // Known names are not asked for twice.
    expect(asked.filter((n) => n === 'batteryLevel')).toHaveLength(1)

    const [schema] = h.meta('schema') as { introspection: unknown; discovered: string[]; unselected: string[] }[]
    expect(schema!.introspection).toEqual(introspection)
    expect(schema!.discovered).toEqual(['newThing', 'wrappedThing', 'not a name'])
    expect(schema!.unselected).toEqual(['oddThing'])
  })

  it('what was discovered is part of the next connection, not only the first', async () => {
    h = await makeHarness()
    h.gateway.script('introspectVehicleState', { __type: { fields: [field('newThing', 'TimeStampedFloat')] } })
    await h.connect()

    h.socket.handlers.onClose('closed', 'websocket closed with code 1006')
    await settle()
    await h.clock.tick(30 * SECOND)
    await h.until(() => h.fake.opens.length === 2 && h.connector.state === 'subscribed', 'the reconnect')

    expect(liveStateProperties(h.socket)).toContain('newThing')
  })

  it('discovery that arrives before the acknowledgement still reaches the first subscribe', async () => {
    h = await makeHarness()
    h.gateway.script('introspectVehicleState', { __type: { fields: [field('newThing', 'TimeStampedFloat')] } })
    h.fake.hold = true
    await h.signIn()
    h.connector.start()
    await h.until(() => h.fake.opens.length === 1, 'the open')
    await h.until(() => h.meta('schema').length === 1, 'the schema')
    h.fake.releaseOpens()
    await h.until(() => h.connector.state === 'subscribed', 'subscribed')

    expect(liveStateProperties(h.socket)).toContain('newThing')
  })

  it('an answer that is not a list of fields changes nothing', async () => {
    h = await makeHarness()
    h.gateway.script('introspectVehicleState', { __type: null })
    await h.connect()

    expect(h.meta('schema')).toEqual([])
    expect(h.connector.state).toBe('subscribed')
  })
})

describe('the server ending a subscription', () => {
  it.each(['error', 'complete'] as const)(
    'a non-validation %s resubscribes that subscription after 30 s under a fresh id',
    async (kind) => {
      h = await makeHarness()
      await h.connect()
      const socket = h.socket
      const id = socket.idFor('cloud')
      const count = socket.subscribes.length

      if (kind === 'error') socket.fail(id)
      else socket.end(id)
      await settle()
      expect(socket.subscribes).toHaveLength(count)

      await h.clock.tick(30 * SECOND - 1)
      expect(socket.subscribes).toHaveLength(count)
      await h.clock.tick(1)

      expect(socket.subscribes).toHaveLength(count + 1)
      const fresh = socket.subscribes.at(-1)!
      expect(fresh.id).not.toBe(id)
      expect(fresh.id.startsWith('cloud#')).toBe(true)
      expect(fresh.doc.operationName).toBe(socket.subscribes.find((s) => s.id === id)!.doc.operationName)
      expect(h.fake.opens).toHaveLength(1)
      // And a frame under the new id is taken.
      socket.handlers.onNext(fresh.id, { data: {} })
      await settle()
      expect(h.frames('cloud')).toHaveLength(1)
    },
  )

  it('an error for an id the plan no longer holds changes nothing', async () => {
    h = await makeHarness()
    await h.connect()
    const count = h.socket.subscribes.length

    h.socket.handlers.onError('cloud#9999', [{ extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }])
    h.socket.handlers.onComplete('cloud#9999')
    // Past the 30 s a resubscribe would take, and short of the minute of silence
    // that would renew everything for its own reasons.
    await h.clock.tick(45 * SECOND)

    expect(h.socket.subscribes.length).toBe(count)
    expect(h.store.writes.at(-1)!.droppedProperties).toEqual([])
  })
})

describe('a server that keeps refusing a subscription', () => {
  /** A server that errors (or completes) every subscribe, recording when each plan key was asked for. */
  function refuseEverything(kind: 'error' | 'complete', code = 'INTERNAL_SERVER_ERROR'): Map<string, number[]> {
    const times = new Map<string, number[]>()
    h.fake.respond = (socket, id) => {
      const key = id.split('#')[0]!
      times.set(key, [...(times.get(key) ?? []), h.clock.now() - START])
      if (kind === 'error') socket.fail(id, code)
      else socket.end(id)
    }
    return times
  }

  // The flat 30 s this replaces was 120 subscribes an hour per subscription,
  // 1,920 for the sixteen, with the state still `subscribed` and nothing said.
  it.each(['error', 'complete'] as const)(
    'is retried on 30 s doubling per subscription, not every 30 s (%s)',
    async (kind) => {
      h = await makeHarness()
      const times = refuseEverything(kind)
      await h.connect()
      await h.clock.tick(HOUR)

      // Waits of 30, 60, 120, 240, 480, 900 and 900 s after the first subscribe.
      const schedule = [0, 30, 90, 210, 450, 930, 1830, 2730].map((s) => s * SECOND)
      expect(times.size).toBe(INITIAL_SUBSCRIPTIONS)
      for (const [key, at] of times) expect(at, key).toEqual(schedule)
      expect(h.socket.subscribes).toHaveLength(INITIAL_SUBSCRIPTIONS * schedule.length)
      // None of it is a reconnect, and none of it is a dead session.
      expect(h.fake.opens).toHaveLength(1)
      expect(h.connector.state).toBe('subscribed')
    },
  )

  it('adds up to 30 s of jitter to each wait', async () => {
    h = await makeHarness({ random: () => 0.5 })
    const times = refuseEverything('error')
    await h.connect()
    await h.clock.tick(255 * SECOND)

    // 30 s + 15 s, then 60 s + 15 s, then 120 s + 15 s.
    expect(times.get('cloud')).toEqual([0, 45, 120, 255].map((s) => s * SECOND))
  })

  it('caps the wait at 900 s', async () => {
    h = await makeHarness()
    const times = refuseEverything('error')
    await h.connect()
    await h.clock.tick(3 * HOUR)

    const at = times.get('cloud')!
    const gaps = at.slice(1).map((t, i) => (t - at[i]!) / SECOND)
    expect(gaps).toEqual([30, 60, 120, 240, 480, ...Array<number>(10).fill(900)])
  })

  it('keeps one subscription’s failures out of another’s schedule', async () => {
    h = await makeHarness()
    const times = new Map<string, number[]>()
    h.fake.respond = (socket, id) => {
      const key = id.split('#')[0]!
      if (key !== 'cloud') return
      times.set(key, [...(times.get(key) ?? []), h.clock.now() - START])
      socket.fail(id)
    }
    await h.connect()
    // The geofence stream is refused once, much later, and starts from the floor.
    await h.clock.tick(HOUR)
    expect(times.get('cloud')!.length).toBeGreaterThan(5)
    // (Silence has renewed the live ones all the while, so count from here.)
    const geofences = () => h.socket.subscribes.filter((s) => s.id.startsWith('geofence#')).length
    const before = geofences()
    h.socket.fail(h.socket.idFor('geofence'))
    await settle()
    await h.clock.tick(30 * SECOND - 1)
    expect(geofences()).toBe(before)
    await h.clock.tick(1)
    expect(geofences()).toBe(before + 1)
  })

  it('goes back to 30 s once that subscription has been heard from', async () => {
    h = await makeHarness()
    const times = new Map<string, number[]>()
    let refusing = true
    h.fake.respond = (socket, id) => {
      const key = id.split('#')[0]!
      if (key !== 'cloud' || !refusing) return
      times.set(key, [...(times.get(key) ?? []), h.clock.now() - START])
      socket.fail(id)
    }
    await h.connect()
    // Refused at 0, 30 s and 90 s: the next wait would be 120 s.
    await h.clock.tick(90 * SECOND)
    expect(times.get('cloud')).toEqual([0, 30 * SECOND, 90 * SECOND])

    // The 120 s wait ends with an accepted subscribe, and a frame.
    refusing = false
    await h.clock.tick(120 * SECOND)
    await h.next('cloud')

    // Refused again: the schedule starts over at 30 s, not at 240 s.
    refusing = true
    const refusedAt = h.clock.now()
    h.socket.fail(h.socket.idFor('cloud'))
    await settle()
    await h.clock.tick(90 * SECOND)
    expect(times.get('cloud')!.slice(3).map((at) => at - (refusedAt - START))).toEqual([
      30 * SECOND,
      90 * SECOND,
    ])
  })

  it('a frame from another subscription does not reset this one', async () => {
    h = await makeHarness()
    const times = new Map<string, number[]>()
    h.fake.respond = (socket, id) => {
      if (id.split('#')[0] !== 'cloud') return
      times.set('cloud', [...(times.get('cloud') ?? []), h.clock.now() - START])
      socket.fail(id)
    }
    await h.connect()
    await h.next('charging')
    await h.next('geofence')
    await h.clock.tick(90 * SECOND)
    await h.next('charging')
    await h.clock.tick(120 * SECOND)

    expect(times.get('cloud')).toEqual([0, 30, 90, 210].map((s) => s * SECOND))
  })

  it('drops the waits with the socket: a reconnect starts every subscription from the floor', async () => {
    h = await makeHarness()
    const times = refuseEverything('error')
    await h.connect()
    await h.clock.tick(10 * MINUTE)
    const before = times.get('cloud')!.length

    h.socket.handlers.onClose('closed', 'websocket closed with code 1006')
    await settle()
    // The old socket's retry timers are gone with it: nothing fires into the new one.
    await h.clock.tick(30 * SECOND)
    await h.until(() => h.fake.opens.length === 2, 'the reconnect')
    await h.until(() => h.connector.state === 'subscribed', 'subscribed')
    await settle()
    expect(h.fake.sockets).toHaveLength(2)
    expect(h.fake.sockets[0]!.subscribes.length).toBeGreaterThan(0)
    const first = h.fake.sockets[0]!.subscribes.length
    await h.clock.tick(10 * MINUTE)
    expect(h.fake.sockets[0]!.subscribes).toHaveLength(first)
    expect(times.get('cloud')!.length).toBeGreaterThan(before)
  })

  describe('says so in last_error', () => {
    it('names the stream and the code while it is refused, and clears when it is heard from', async () => {
      h = await makeHarness()
      await h.connect()
      expect(h.store.writes.at(-1)!.lastError).toBeNull()

      h.socket.fail(h.socket.idFor('cloud'), 'INTERNAL_SERVER_ERROR')
      await settle()
      expect(h.connector.state).toBe('subscribed')
      expect(h.store.writes.at(-1)).toMatchObject({
        state: 'subscribed',
        lastError: 'subscription cloud refused: INTERNAL_SERVER_ERROR',
      })

      await h.clock.tick(30 * SECOND)
      await h.next('cloud')
      expect(h.store.writes.at(-1)!.lastError).toBeNull()
    })

    it('keeps saying it while any subscription is still refused, and the latest one is the one named', async () => {
      h = await makeHarness()
      await h.connect()

      h.socket.fail(h.socket.idFor('cloud'), 'INTERNAL_SERVER_ERROR')
      await settle()
      h.socket.fail(h.socket.idFor('geofence'), 'SERVICE_UNAVAILABLE')
      await settle()
      expect(h.store.writes.at(-1)!.lastError).toBe('subscription geofence refused: SERVICE_UNAVAILABLE')

      await h.clock.tick(30 * SECOND)
      await h.next('geofence')
      // The cloud subscription has not been heard from yet.
      expect(h.store.writes.at(-1)!.lastError).toBe('subscription cloud refused: INTERNAL_SERVER_ERROR')

      await h.next('cloud')
      expect(h.store.writes.at(-1)!.lastError).toBeNull()
    })

    it('says it with the first code Rivian gave, and nothing else of what Rivian said', async () => {
      h = await makeHarness()
      await h.connect()

      const id = h.socket.idFor('ota-state')
      h.socket.ended.add(id)
      h.socket.handlers.onError(id, [
        { message: `nope ${TOKEN}`, extensions: { code: 'FORBIDDEN', reason: TOKEN } },
        { message: 'second', extensions: { code: 'OTHER_CODE' } },
      ])
      await settle()

      // The stream, not the subscription's own name, and a code that passed the filter.
      expect(h.store.writes.at(-1)!.lastError).toBe('subscription ota refused: FORBIDDEN')
      expect(JSON.stringify([h.logs, h.store.writes])).not.toContain('SECRET')
    })

    it('leaves the code out when none of Rivian’s survived the filter', async () => {
      h = await makeHarness()
      await h.connect()

      // A "code" shaped like a token is refused by the error type, so nothing is left to say.
      h.socket.fail(h.socket.idFor('cloud'), TOKEN)
      await settle()

      expect(h.store.writes.at(-1)!.lastError).toBe('subscription cloud refused')
      expect(JSON.stringify([h.logs, h.store.writes])).not.toContain('SECRET')
    })

    it('does not outlive the socket: a close replaces it, and a new connection starts clean', async () => {
      h = await makeHarness()
      await h.connect()
      h.socket.fail(h.socket.idFor('cloud'))
      await settle()
      expect(h.store.writes.at(-1)!.lastError).toMatch(/^subscription cloud refused/)

      h.socket.handlers.onClose('rate_limited', 'websocket closed: rate limited')
      await settle()
      expect(h.store.writes.at(-1)).toMatchObject({
        state: 'backing_off',
        lastError: 'websocket closed: rate limited',
      })

      await h.clock.tick(30 * SECOND)
      await h.until(() => h.connector.state === 'subscribed', 'subscribed')
      await settle()
      expect(h.store.writes.at(-1)!.lastError).toBeNull()
    })

    it('is not set by a server that merely completes a subscription', async () => {
      h = await makeHarness()
      await h.connect()
      h.socket.end(h.socket.idFor('cloud'))
      await settle()

      expect(h.store.writes.at(-1)!.lastError).toBeNull()
    })
  })

  describe('UNAUTHENTICATED on a subscription', () => {
    it('is a dead session: stop, no retry of anything, and a new credential starts again', async () => {
      h = await makeHarness()
      await h.connect()
      const socket = h.socket
      const calls = { ...h.gateway.calls }
      const subscribed = socket.subscribes.length

      socket.fail(socket.idFor('cloud'), 'UNAUTHENTICATED')
      await settle()
      expect(h.connector.state).toBe('unauthenticated')
      expect(socket.closed).toBe(true)
      expect(h.store.writes.at(-1)).toMatchObject({
        state: 'unauthenticated',
        lastError: 'subscription cloud refused: UNAUTHENTICATED',
      })

      await h.clock.tick(HOUR)
      // No subscribe, no socket, no HTTP, no backoff: it has stopped.
      expect(socket.subscribes).toHaveLength(subscribed)
      expect(h.fake.opens).toHaveLength(1)
      expect(h.gateway.calls).toEqual(calls)
      expect(h.metrics.reconnects).toEqual([])
      expect(h.connector.state).toBe('unauthenticated')

      await h.signIn()
      await h.clock.tick(POLL)
      await h.until(() => h.connector.state === 'subscribed', 'subscribed')
      expect(h.fake.opens).toHaveLength(2)
    })

    it('wins over a validation failure in the same error', async () => {
      h = await makeHarness()
      await h.connect()
      const bad = RIVIAN_PROPERTIES[0]!.name
      const group = h.socket.subscribeFor(bad)!

      h.socket.handlers.onError(group.id, [
        { extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } },
        { extensions: { code: 'UNAUTHENTICATED' } },
      ])
      await settle()
      await h.clock.tick(HOUR)

      expect(h.connector.state).toBe('unauthenticated')
      expect(h.store.writes.at(-1)!.droppedProperties).toEqual([])
      expect(h.socket.subscribes).toHaveLength(INITIAL_SUBSCRIPTIONS)
    })

    it('is a dead session whichever id carries it, and stops a retry already waiting', async () => {
      h = await makeHarness()
      await h.connect()
      const socket = h.socket
      // An ended subscription is waiting out its 30 s when the verdict arrives.
      socket.fail(socket.idFor('geofence'))
      await settle()

      socket.handlers.onError('cloud#9999', [{ extensions: { code: 'UNAUTHENTICATED' } }])
      await settle()
      expect(h.connector.state).toBe('unauthenticated')
      const subscribed = socket.subscribes.length

      await h.clock.tick(HOUR)
      expect(socket.subscribes).toHaveLength(subscribed)
    })
  })
})

describe('redaction (review focus 5)', () => {
  it('no session token appears in any log line, status row or published frame across the run', async () => {
    h = await makeHarness()
    // Everything that can fail with a secret nearby, in one run: an error that
    // is not one of ours and carries the token in its message, a Rivian error
    // that does the same in a field it should not, a database error, a broker
    // password in the config, and a server error on a live subscription.
    h.gateway.script(
      'userInfo',
      new Error(`boom ${TOKEN}`),
      new RivianApiError(500, [{ code: 'INTERNAL_SERVER_ERROR', reason: TOKEN }], 'getUserInfo'),
      userInfoWith([{ id: 'rv-1', vin: VIN }]),
    )
    h.gateway.script('vehicle', new RivianApiError(200, [{ code: 'UNAUTHENTICATED', reason: TOKEN }], 'getVehicle'))
    h.gateway.script('chargingSummaries', new Error(`charging ${TOKEN}`))
    await h.signIn()
    h.connector.start()
    await h.until(() => h.connector.state === 'backing_off', 'the first failure')
    await h.clock.tick(30 * SECOND)
    await h.until(() => h.metrics.reconnects.length === 2, 'the second failure')
    await h.clock.tick(60 * SECOND)
    await h.until(() => h.connector.state === 'subscribed', 'subscribed')

    h.store.stampFailures = 2
    await h.clock.tick(2 * POLL)
    h.socket.fail(h.socket.idFor('cloud'))
    h.socket.handlers.onClose('rate_limited', 'websocket closed: rate limited')
    await settle()
    await h.clock.tick(HOUR)
    await h.until(() => h.connector.state === 'subscribed', 'subscribed again')

    // The run was not vacuous: the token went where it belongs.
    expect(new Set(h.gateway.tokens)).toEqual(new Set([TOKEN]))
    expect(h.fake.opens.every((o) => o.initPayload['u-sess'] === TOKEN)).toBe(true)
    expect(h.logs.length).toBeGreaterThan(5)
    expect(h.store.writes.some((w) => w.lastError !== null)).toBe(true)

    const everything = JSON.stringify([h.logs, h.store.writes, h.mqtt.published.map((p) => p.body)])
    expect(everything).not.toContain(TOKEN)
    expect(everything).not.toContain('SECRET')
    expect(everything).not.toContain('db-password-xyz')
    expect(everything).not.toContain('mqtt-pw')
    for (const row of h.store.writes) {
      if (row.lastError !== null) {
        expect(row.lastError).toMatch(/^(Rivian |websocket |unexpected |the |waiting )/)
      }
    }
  })
})
