import { describe, expect, it } from 'vitest'
import { createChangeListener, type ListenerClient } from '../src/listen.js'

/**
 * A stand-in for pg.Client that reproduces the two behaviours this module
 * exists to survive: a client cannot be reconnected once used, and one dropped
 * connection emits 'error' twice and then 'end'.
 */
class FakeClient implements ListenerClient {
  static made: FakeClient[] = []
  connects = 0
  queries: string[] = []
  ended = false
  private handlers = new Map<string, Array<(err?: unknown) => void>>()

  constructor() {
    FakeClient.made.push(this)
  }

  async connect(): Promise<void> {
    this.connects++
    if (this.connects > 1) throw new Error('Client has already been connected. You cannot reuse a client.')
  }

  async query(sql: string): Promise<unknown> {
    this.queries.push(sql)
    return { rows: [] }
  }

  async end(): Promise<void> {
    this.ended = true
  }

  on(event: 'error' | 'end', fn: (err?: unknown) => void): void {
    const list = this.handlers.get(event) ?? []
    list.push(fn)
    this.handlers.set(event, list)
  }

  /** What one real dropped connection emits, in order. */
  drop(): void {
    this.emit('error', new Error('connection terminated unexpectedly'))
    this.emit('error', new Error('connection terminated unexpectedly'))
    this.emit('end')
  }

  emit(event: string, err?: unknown): void {
    for (const fn of this.handlers.get(event) ?? []) fn(err)
  }

  hasHandler(event: string): boolean {
    return (this.handlers.get(event) ?? []).length > 0
  }
}

function harness() {
  FakeClient.made = []
  const scheduled: Array<() => void> = []
  const connected: number[] = []
  const payloads: string[] = []
  const errors: unknown[] = []
  const listener = createChangeListener(
    'vehicle_changed',
    {
      onPayload: (raw) => payloads.push(raw),
      onConnected: () => connected.push(1),
      onError: (err) => errors.push(err),
    },
    {
      createClient: () => new FakeClient(),
      backoffMs: () => 1000,
      schedule: (fn) => scheduled.push(fn),
    }
  )
  return { listener, scheduled, connected, payloads, errors }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('createChangeListener', () => {
  it('LISTENs on the channel once connected and reports it', async () => {
    const h = harness()
    h.listener.start()
    await settle()
    expect(FakeClient.made).toHaveLength(1)
    expect(FakeClient.made[0]!.queries).toEqual(['LISTEN vehicle_changed'])
    expect(h.connected).toEqual([1])
  })

  it('attaches error and end handlers BEFORE connecting', async () => {
    // An 'error' with no listener throws out of the EventEmitter and takes the
    // process down, so the window between construction and connect() must not
    // exist.
    const h = harness()
    h.listener.start()
    await settle()
    expect(FakeClient.made[0]!.hasHandler('error')).toBe(true)
    expect(FakeClient.made[0]!.hasHandler('end')).toBe(true)
  })

  it('builds a NEW client on reconnect, because a used one cannot be reconnected', async () => {
    const h = harness()
    h.listener.start()
    await settle()
    FakeClient.made[0]!.drop()
    await settle()
    h.scheduled.forEach((fn) => fn())
    await settle()
    expect(FakeClient.made).toHaveLength(2)
    expect(FakeClient.made[1]!.queries).toEqual(['LISTEN vehicle_changed'])
    expect(h.connected).toEqual([1, 1])
  })

  it('schedules exactly one reconnect for one drop, despite error+error+end', async () => {
    const h = harness()
    h.listener.start()
    await settle()
    FakeClient.made[0]!.drop()
    await settle()
    expect(h.scheduled).toHaveLength(1)
  })

  it('ignores events from a superseded client', async () => {
    const h = harness()
    h.listener.start()
    await settle()
    const first = FakeClient.made[0]!
    first.drop()
    await settle()
    h.scheduled.forEach((fn) => fn())
    await settle()
    // The dead client emits again — a real socket does this — and it must not
    // schedule a second reconnect loop on top of the live client.
    const before = h.scheduled.length
    first.drop()
    await settle()
    expect(h.scheduled).toHaveLength(before)
  })

  it('forwards notification payloads for this channel only', async () => {
    const h = harness()
    h.listener.start()
    await settle()
    FakeClient.made[0]!.emit('notification', { channel: 'vehicle_changed', payload: 'a' })
    FakeClient.made[0]!.emit('notification', { channel: 'something_else', payload: 'b' })
    expect(h.payloads).toEqual(['a'])
  })

  it('stops cleanly and does not reconnect after stop', async () => {
    const h = harness()
    h.listener.start()
    await settle()
    await h.listener.stop()
    expect(FakeClient.made[0]!.ended).toBe(true)
    FakeClient.made[0]!.drop()
    await settle()
    expect(h.scheduled).toHaveLength(0)
  })
})
