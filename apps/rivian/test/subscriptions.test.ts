import {
  RIVIAN_PROPERTIES,
  chargingSessionDocument,
  parallaxDocument,
  vehicleStateDocument,
} from '@ev/rivian'
import { describe, expect, it } from 'vitest'
import { SubscriptionPlan, type PlannedSubscription } from '../src/subscriptions.js'

const VEHICLE = 'veh-1'
const NOW = Date.UTC(2026, 9, 19, 12)
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const OTHER_KEYS = ['parallax', 'charging', 'cloud', 'ota-state', 'ota-schedules', 'geofence', 'departure']

/** `n` distinct, valid property names. */
function props(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `prop${String(i).padStart(3, '0')}`)
}

function planOf(
  properties: readonly string[],
  over: { dropped?: readonly string[]; parallaxRvms?: string[] | null; now?: number } = {},
): SubscriptionPlan {
  return new SubscriptionPlan(VEHICLE, {
    properties,
    dropped: over.dropped ?? [],
    parallaxRvms: over.parallaxRvms === undefined ? null : over.parallaxRvms,
    now: over.now ?? NOW,
  })
}

/** What `rejected` answers when there is nothing to do. */
const NOTHING = { probes: [], newlyDropped: [], unavailable: null, fault: null }

const stateSubs = (subs: { sub: PlannedSubscription }[]): PlannedSubscription[] =>
  subs.map((s) => s.sub).filter((s) => s.stream === 'state')

describe('SubscriptionPlan.initial', () => {
  it('has ceil(n/16) state groups plus the seven other subscriptions, under unique ids', () => {
    for (const n of [1, 15, 16, 17, 40, 135]) {
      const initial = planOf(props(n)).initial()
      const groups = stateSubs(initial)
      expect(groups, `n=${n}`).toHaveLength(Math.ceil(n / 16))
      expect(initial, `n=${n}`).toHaveLength(Math.ceil(n / 16) + 7)
      expect(new Set(initial.map((s) => s.id)).size, `n=${n}`).toBe(initial.length)
    }
  })

  it('puts every property in exactly one group of at most 16, in order', () => {
    const names = props(40)
    const groups = stateSubs(planOf(names).initial()).map((s) => s.properties)
    expect(groups.map((g) => g?.length)).toEqual([16, 16, 8])
    expect(groups.flat()).toEqual(names)
  })

  it('names the subscriptions state:<n>, parallax, charging, cloud, ota-state, ota-schedules, geofence and departure', () => {
    const keys = planOf(props(20)).initial().map((s) => s.sub.key)
    expect(keys).toEqual(['state:0', 'state:1', ...OTHER_KEYS])
  })

  it('gives each subscription an id of the form key#counter', () => {
    for (const { id, sub } of planOf(props(20)).initial()) {
      expect(id.startsWith(`${sub.key}#`), id).toBe(true)
      expect(id.slice(sub.key.length + 1)).toMatch(/^\d+$/)
    }
  })

  it('maps each id to its stream, ota-state and ota-schedules both being ota', () => {
    const plan = planOf(props(20))
    const streams = new Map(plan.initial().map(({ id, sub }) => [sub.key, plan.streamOf(id)]))
    expect(Object.fromEntries(streams)).toEqual({
      'state:0': 'state',
      'state:1': 'state',
      parallax: 'parallax',
      charging: 'charging',
      cloud: 'cloud',
      'ota-state': 'ota',
      'ota-schedules': 'ota',
      geofence: 'geofence',
      departure: 'departure',
    })
  })

  it('builds each state group\'s document from the catalogue, for the vehicle', () => {
    const [first] = stateSubs(planOf(props(20)).initial())
    expect(first?.doc).toEqual(vehicleStateDocument(VEHICLE, props(16)))
    expect(first?.doc.variables).toEqual({ vehicleId: VEHICLE })
  })

  it('asks Parallax for the topics it was given, or for all of them with null', () => {
    const all = planOf(props(1), { parallaxRvms: null }).initial().find((s) => s.sub.key === 'parallax')
    expect(all?.sub.doc).toEqual(parallaxDocument(VEHICLE, null))
    const some = planOf(props(1), { parallaxRvms: ['rvm'] }).initial().find((s) => s.sub.key === 'parallax')
    expect(some?.sub.doc).toEqual(parallaxDocument(VEHICLE, ['rvm']))
  })

  it('subscribes the charging session for the vehicle', () => {
    const charging = planOf(props(1)).initial().find((s) => s.sub.key === 'charging')
    expect(charging?.sub.doc).toEqual(chargingSessionDocument(VEHICLE))
  })

  it('splits the real catalogue into groups of at most 16', () => {
    const names = RIVIAN_PROPERTIES.map((p) => p.name)
    const groups = stateSubs(planOf(names).initial())
    expect(groups).toHaveLength(Math.ceil(names.length / 16))
    for (const g of groups) expect(g.properties!.length).toBeLessThanOrEqual(16)
  })

  it('returns null for an id it never handed out', () => {
    expect(planOf(props(3)).streamOf('state:0#999')).toBeNull()
    expect(planOf(props(3)).subOf('state:0#999')).toBeNull()
  })

  it('names the subscription behind an id, and the key stays the same under the fresh id of a retry', () => {
    const plan = planOf(props(3))
    const cloud = plan.initial().find((s) => s.sub.key === 'cloud')!
    expect(plan.subOf(cloud.id)).toBe(cloud.sub)

    const ended = plan.ended(cloud.id)!
    expect(plan.subOf(cloud.id)).toBeNull()
    const again = plan.activate(ended)
    expect(again).not.toBe(cloud.id)
    expect(plan.subOf(again)?.key).toBe('cloud')
  })

  it('does not build a document from an empty group when there are no properties', () => {
    const initial = planOf([]).initial()
    expect(initial.map((s) => s.sub.key)).toEqual(OTHER_KEYS)
  })

  it('leaves out, and never queries, a name that is not a GraphQL name', () => {
    // Property names can come from discovery, which reads them out of Rivian's
    // introspection response. One that is not an identifier must not reach
    // query text, and must not take the group it would have joined down with it.
    const groups = stateSubs(planOf(['ok', 'not a name', '9bad', 'x{y}', '', 'alsoOk']).initial())
    expect(groups.map((g) => g.properties)).toEqual([['ok', 'alsoOk']])
  })

  it('lists a repeated name once', () => {
    const groups = stateSubs(planOf(['a', 'b', 'a', 'b', 'c']).initial())
    expect(groups.map((g) => g.properties)).toEqual([['a', 'b', 'c']])
  })

  it('starts over when called again: new ids for everything, and the old ones are stale', () => {
    const plan = planOf(props(20))
    const first = plan.initial()
    const second = plan.initial()
    expect(second.map((s) => s.sub.key)).toEqual(first.map((s) => s.sub.key))
    const old = new Set(first.map((s) => s.id))
    for (const { id } of second) expect(old.has(id)).toBe(false)
    for (const { id } of first) expect(plan.streamOf(id)).toBeNull()
    for (const { id } of second) expect(plan.streamOf(id)).not.toBeNull()
  })
})

describe('SubscriptionPlan.renewAll', () => {
  it('gives every active subscription a new id, and the old ids stop mapping to a stream', () => {
    const plan = planOf(props(20))
    const initial = plan.initial()
    const renewed = plan.renewAll()
    expect(renewed).toHaveLength(initial.length)
    const oldIds = initial.map((s) => s.id)
    expect(renewed.map((r) => r.oldId)).toEqual(oldIds)
    for (const r of renewed) {
      expect(r.id).not.toBe(r.oldId)
      expect(plan.streamOf(r.oldId)).toBeNull()
      expect(plan.streamOf(r.id)).toBe(r.sub.stream)
    }
    const everyId = [...oldIds, ...renewed.map((r) => r.id)]
    expect(new Set(everyId).size).toBe(everyId.length)
  })

  it('hands back the same subscriptions it had', () => {
    const plan = planOf(props(20))
    const before = plan.initial().map((s) => s.sub)
    expect(plan.renewAll().map((r) => r.sub)).toEqual(before)
  })

  it('never reuses an id across repeated renewals', () => {
    // graphql-transport-ws forbids reusing an id on a socket (design §5.2).
    const plan = planOf(props(20))
    const seen = new Set(plan.initial().map((s) => s.id))
    for (let i = 0; i < 5; i++) {
      for (const { id } of plan.renewAll()) {
        expect(seen.has(id), id).toBe(false)
        seen.add(id)
      }
    }
  })

  it('leaves out a subscription Rivian rejected, which is retried on its own schedule', () => {
    const plan = planOf(props(3))
    const charging = plan.initial().find((s) => s.sub.key === 'charging')!
    plan.rejected(charging.id, NOW)
    expect(plan.renewAll().map((r) => r.sub.key)).not.toContain('charging')
  })
})

/**
 * The server for the bisection tests: it rejects, with GRAPHQL_VALIDATION_FAILED,
 * any live `vehicleState` subscription whose properties include a bad one, and
 * accepts everything else. Rivian's errors do not say which field is at fault
 * (design §2.3), so the plan sees only "this id was rejected" and the test
 * plays the connector: it asks the plan, subscribes the probes it returns (the
 * 30 s wait is the connector's, so it is skipped), and repeats until the server
 * has nothing left to reject.
 */
function bisect(
  plan: SubscriptionPlan,
  initial: { id: string; sub: PlannedSubscription }[],
  bad: ReadonlySet<string>,
  now = NOW,
) {
  const live = new Map<string, PlannedSubscription>()
  for (const { id, sub } of initial) live.set(id, sub)
  const newlyDropped: string[] = []
  let rejections = 0
  for (;;) {
    const rejectedId = [...live].find(
      ([, sub]) => sub.stream === 'state' && sub.properties!.some((p) => bad.has(p)),
    )?.[0]
    if (rejectedId === undefined) break
    live.delete(rejectedId)
    rejections += 1
    const result = plan.rejected(rejectedId, now)
    expect(result.unavailable).toBeNull()
    newlyDropped.push(...result.newlyDropped)
    for (const probe of result.probes) live.set(plan.activate(probe), probe)
  }
  return { live, newlyDropped, rejections }
}

describe('SubscriptionPlan.rejected: bisection (design §5.4)', () => {
  it('finds one bad property among 16 within 8 rejections, and keeps the other 15 flowing', () => {
    const names = props(15)
    names.splice(7, 0, 'badOne')
    expect(names).toHaveLength(16)
    const plan = planOf(names)
    const { live, newlyDropped, rejections } = bisect(plan, plan.initial(), new Set(['badOne']))
    expect(newlyDropped).toEqual(['badOne'])
    expect(rejections).toBeLessThanOrEqual(8)
    expect(plan.dropped).toEqual(['badOne'])
    // Accepted halves stay active: every live state group still maps to a
    // stream, none holds the bad one, and together they hold the other 15, each once.
    const held = [...live].filter(([, sub]) => sub.stream === 'state')
    for (const [id] of held) expect(plan.streamOf(id)).toBe('state')
    const properties = held.flatMap(([, sub]) => sub.properties!)
    expect(properties).not.toContain('badOne')
    expect([...properties].sort()).toEqual(names.filter((n) => n !== 'badOne').sort())
  })

  it('splits a rejected group into halves, the first taking the odd one', () => {
    const plan = planOf(['a', 'b', 'c', 'd', 'e'])
    const id = plan.initial().find((s) => s.sub.stream === 'state')!.id
    const { probes, newlyDropped, unavailable } = plan.rejected(id, NOW)
    expect(probes.map((p) => p.properties)).toEqual([['a', 'b', 'c'], ['d', 'e']])
    expect(newlyDropped).toEqual([])
    expect(unavailable).toBeNull()
    // Each probe is its own subscription, with a key of its own, and a document
    // built for just its properties.
    expect(new Set(probes.map((p) => p.key)).size).toBe(2)
    for (const p of probes) {
      expect(p.key).toMatch(/^state:\d+$/)
      expect(p.stream).toBe('state')
      expect(p.doc).toEqual(vehicleStateDocument(VEHICLE, p.properties!))
    }
  })

  it('gives probes keys that no other subscription has', () => {
    const plan = planOf(props(32))
    const initial = plan.initial()
    const id = initial.find((s) => s.sub.key === 'state:0')!.id
    const { probes } = plan.rejected(id, NOW)
    const keys = [...initial.map((s) => s.sub.key), ...probes.map((p) => p.key)]
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('does not subscribe the probes itself: they have no id until activated', () => {
    const plan = planOf(props(16))
    const id = plan.initial().find((s) => s.sub.stream === 'state')!.id
    const { probes } = plan.rejected(id, NOW)
    expect(plan.streamOf(id)).toBeNull()
    const probeId = plan.activate(probes[0]!)
    expect(probeId.startsWith(`${probes[0]!.key}#`)).toBe(true)
    expect(plan.streamOf(probeId)).toBe('state')
  })

  it('drops a property that is rejected on its own, with no probes', () => {
    // 17 properties: the second group is a single one.
    const names = props(17)
    const plan = planOf(names)
    const lone = plan.initial().find((s) => s.sub.key === 'state:1')!
    expect(lone.sub.properties).toEqual([names[16]])
    expect(plan.rejected(lone.id, NOW)).toEqual({ ...NOTHING, newlyDropped: [names[16]] })
    expect(plan.dropped).toEqual([names[16]])
    expect(plan.streamOf(lone.id)).toBeNull()
  })

  it('finds several bad properties, each dropped once, and keeps every good one', () => {
    const names = props(16)
    const bad = new Set([names[0]!, names[9]!, names[15]!])
    const plan = planOf(names)
    const { live, newlyDropped } = bisect(plan, plan.initial(), bad)
    expect([...newlyDropped].sort()).toEqual([...bad].sort())
    expect([...plan.dropped].sort()).toEqual([...bad].sort())
    const held = [...live.values()].flatMap((s) => s.properties ?? [])
    expect([...held].sort()).toEqual(names.filter((n) => !bad.has(n)).sort())
  })

  it('reports nothing for an id it does not hold, and changes nothing', () => {
    const plan = planOf(props(16))
    const before = plan.initial()
    expect(plan.rejected('state:0#999', NOW)).toEqual(NOTHING)
    expect(plan.dropped).toEqual([])
    expect(before.every((s) => plan.streamOf(s.id) !== null)).toBe(true)
  })

  it('treats a rejected id as ended: asking again about it reports nothing', () => {
    const plan = planOf(props(16))
    const id = plan.initial().find((s) => s.sub.stream === 'state')!.id
    expect(plan.rejected(id, NOW).probes).toHaveLength(2)
    expect(plan.rejected(id, NOW)).toEqual(NOTHING)
  })

  it('keeps a dropped property out of every later initial() and renewal', () => {
    const names = props(16)
    const plan = planOf(names)
    bisect(plan, plan.initial(), new Set([names[3]!]))

    // A renewal (silence, or a queue overflow) on the same socket.
    const renewed = plan.renewAll()
    const renewedProperties = stateSubs(renewed).flatMap((s) => s.properties!)
    expect(renewedProperties).not.toContain(names[3])
    expect(renewedProperties).toHaveLength(15)

    // And a replaced socket.
    const again = plan.initial()
    expect(stateSubs(again).flatMap((s) => s.properties!)).not.toContain(names[3])
    expect(stateSubs(again).flatMap((s) => s.properties!)).toHaveLength(15)
  })
})

describe('SubscriptionPlan.rejected: a subscription with no properties to bisect', () => {
  it('marks charging unavailable and returns no probes', () => {
    const plan = planOf(props(3))
    const charging = plan.initial().find((s) => s.sub.key === 'charging')!
    expect(plan.rejected(charging.id, NOW)).toEqual({ ...NOTHING, unavailable: 'charging' })
    expect(plan.streamOf(charging.id)).toBeNull()
    expect(plan.dropped).toEqual([])
  })

  it('does the same for each of the other six', () => {
    for (const key of OTHER_KEYS) {
      const plan = planOf(props(3))
      const sub = plan.initial().find((s) => s.sub.key === key)!
      expect(plan.rejected(sub.id, NOW), key).toEqual({ ...NOTHING, unavailable: key })
    }
  })

  it('leaves an unavailable subscription out of a later initial(), until it is due', () => {
    const plan = planOf(props(3))
    const charging = plan.initial().find((s) => s.sub.key === 'charging')!
    plan.rejected(charging.id, NOW)
    expect(plan.initial().map((s) => s.sub.key)).not.toContain('charging')
  })
})

describe('SubscriptionPlan.ended', () => {
  it('returns the subscription to resubscribe, and the old id stops mapping', () => {
    const plan = planOf(props(20))
    const initial = plan.initial()
    const state = initial.find((s) => s.sub.key === 'state:1')!
    const ended = plan.ended(state.id)
    expect(ended).toEqual(state.sub)
    expect(plan.streamOf(state.id)).toBeNull()
  })

  it('lets the same subscription come back under a fresh id', () => {
    const plan = planOf(props(3))
    const parallax = plan.initial().find((s) => s.sub.key === 'parallax')!
    const sub = plan.ended(parallax.id)!
    const id = plan.activate(sub)
    expect(id).not.toBe(parallax.id)
    expect(id.startsWith('parallax#')).toBe(true)
    expect(plan.streamOf(id)).toBe('parallax')
    expect(plan.streamOf(parallax.id)).toBeNull()
  })

  it('keeps a probe\'s properties when it ends', () => {
    const plan = planOf(props(16))
    const id = plan.initial().find((s) => s.sub.stream === 'state')!.id
    const probe = plan.rejected(id, NOW).probes[0]!
    const probeId = plan.activate(probe)
    expect(plan.ended(probeId)?.properties).toEqual(probe.properties)
  })

  it('returns null for an id it does not hold, including one already ended', () => {
    const plan = planOf(props(3))
    const id = plan.initial()[0]!.id
    expect(plan.ended('nope#1')).toBeNull()
    expect(plan.ended(id)).not.toBeNull()
    expect(plan.ended(id)).toBeNull()
  })

  it('does not count as a rejection: nothing is dropped and nothing is marked unavailable', () => {
    const plan = planOf(props(3))
    const charging = plan.initial().find((s) => s.sub.key === 'charging')!
    plan.ended(charging.id)
    expect(plan.dropped).toEqual([])
    expect(plan.dueForReprobe(NOW + 10 * DAY)).toEqual([])
  })
})

describe('SubscriptionPlan.dropped', () => {
  it('leaves a property it is constructed with out of initial()', () => {
    const names = props(15)
    names.push('badOne')
    const plan = planOf(names, { dropped: ['badOne'] })
    const properties = stateSubs(plan.initial()).flatMap((s) => s.properties!)
    expect(properties).not.toContain('badOne')
    expect(properties).toHaveLength(15)
    expect(plan.dropped).toEqual(['badOne'])
  })

  it('leaves out a dropped name even when the property list does not mention it', () => {
    const plan = planOf(props(2), { dropped: ['gone'] })
    expect(stateSubs(plan.initial()).flatMap((s) => s.properties!)).toEqual(props(2))
    expect(plan.dropped).toEqual(['gone'])
  })

  it('holds no state subscription when every property is dropped', () => {
    const plan = planOf(['a', 'b'], { dropped: ['a', 'b'] })
    expect(plan.initial().map((s) => s.sub.key)).toEqual(OTHER_KEYS)
  })

  it('ignores a persisted name that is not a GraphQL name', () => {
    // The list is read back from a database row. A name that could never have
    // been queried cannot have been dropped, and could not be probed again.
    const plan = planOf(props(2), { dropped: ['badOne', 'not a name', 'badOne'] })
    expect(plan.dropped).toEqual(['badOne'])
  })
})

describe('SubscriptionPlan.dueForReprobe', () => {
  /** badOne dropped and charging unavailable, both at NOW, through the plan's own paths. */
  function withBothDown(): SubscriptionPlan {
    const names = props(15)
    names.push('badOne')
    const plan = planOf(names)
    const initial = plan.initial()
    bisect(plan, initial, new Set(['badOne']))
    plan.rejected(initial.find((s) => s.sub.key === 'charging')!.id, NOW)
    return plan
  }

  it('returns the dropped property alone, and the unavailable subscription, 24 h on', () => {
    const plan = withBothDown()
    expect(plan.dueForReprobe(NOW + DAY - 1)).toEqual([])
    const due = plan.dueForReprobe(NOW + DAY)
    expect(due).toHaveLength(2)
    const alone = due.find((s) => s.stream === 'state')!
    expect(alone.properties).toEqual(['badOne'])
    expect(alone.doc).toEqual(vehicleStateDocument(VEHICLE, ['badOne']))
    const charging = due.find((s) => s.key === 'charging')!
    expect(charging.doc).toEqual(chargingSessionDocument(VEHICLE))
  })

  it('returns nothing again until another 24 h pass, if the server still refuses them', () => {
    const plan = withBothDown()
    const due = plan.dueForReprobe(NOW + DAY)
    expect(plan.dueForReprobe(NOW + DAY)).toEqual([])
    // The connector subscribes them, and the server rejects them again.
    const at = NOW + DAY
    const results = due.map((sub) => plan.rejected(plan.activate(sub), at))
    expect(results.flatMap((r) => r.newlyDropped)).toEqual(['badOne'])
    expect(results.map((r) => r.unavailable).filter(Boolean)).toEqual(['charging'])
    expect(plan.dropped).toEqual(['badOne'])
    expect(plan.dueForReprobe(at + DAY - 1)).toEqual([])
    expect(plan.dueForReprobe(at + DAY)).toHaveLength(2)
  })

  it('counts a constructor-supplied dropped property\'s first hour from the time given, not its first day', () => {
    const plan = planOf(props(2), { dropped: ['badOne'], now: NOW })
    expect(plan.dueForReprobe(NOW)).toEqual([])
    expect(plan.dueForReprobe(NOW + HOUR - 1)).toEqual([])
    const due = plan.dueForReprobe(NOW + HOUR)
    expect(due.map((s) => s.properties)).toEqual([['badOne']])
  })

  it('probes each dropped property alone', () => {
    const plan = planOf(props(2), { dropped: ['x', 'y', 'z'] })
    const due = plan.dueForReprobe(NOW + DAY)
    expect(due.map((s) => s.properties)).toEqual([['x'], ['y'], ['z']])
    expect(new Set(due.map((s) => s.key)).size).toBe(3)
  })

  it('treats a reprobe the server accepts as recovered: it leaves the dropped list for good', () => {
    // Nothing in the plan's interface says "accepted": a probe that is not
    // rejected is accepted. So taking a property out for a reprobe takes it off
    // the dropped list, and only a rejection puts it back.
    const plan = planOf(props(2), { dropped: ['badOne'] })
    const [probe] = plan.dueForReprobe(NOW + DAY)
    const id = plan.activate(probe!)
    expect(plan.streamOf(id)).toBe('state')
    expect(plan.dropped).toEqual([])
    expect(plan.dueForReprobe(NOW + 30 * DAY)).toEqual([])
    expect(stateSubs(plan.initial()).flatMap((s) => s.properties!)).toContain('badOne')
  })

  it('returns an unavailable subscription for subscribing again with its original document', () => {
    const plan = planOf(props(2))
    const sub = plan.initial().find((s) => s.sub.key === 'departure')!
    plan.rejected(sub.id, NOW)
    const [again] = plan.dueForReprobe(NOW + DAY)
    expect(again).toEqual(sub.sub)
    const id = plan.activate(again!)
    expect(plan.streamOf(id)).toBe('departure')
    expect(plan.initial().map((s) => s.sub.key)).toContain('departure')
  })
})

describe('SubscriptionPlan.addProperties', () => {
  it('returns one new group holding a newly discovered property', () => {
    const plan = planOf(props(3))
    const groups = plan.addProperties(['newThing'])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ stream: 'state', properties: ['newThing'] })
    expect(groups[0]!.doc).toEqual(vehicleStateDocument(VEHICLE, ['newThing']))
  })

  it('groups many new properties 16 at a time', () => {
    const plan = planOf(props(3))
    const groups = plan.addProperties(props(40).map((n) => `new_${n}`))
    expect(groups.map((g) => g.properties!.length)).toEqual([16, 16, 8])
  })

  it('has the caller subscribe each group, under a key that is not already taken', () => {
    const plan = planOf(props(20))
    const taken = plan.initial().map((s) => s.sub.key)
    const [group] = plan.addProperties(['newThing'])
    expect(taken).not.toContain(group!.key)
    expect(group!.key).toMatch(/^state:\d+$/)
    const id = plan.activate(group!)
    expect(plan.streamOf(id)).toBe('state')
  })

  it('ignores names the plan already has, including dropped ones, and repeats', () => {
    const plan = planOf(props(3), { dropped: ['badOne'] })
    expect(plan.addProperties([...props(3), 'badOne'])).toEqual([])
    expect(plan.addProperties(['a', 'a', 'a'])[0]!.properties).toEqual(['a'])
    expect(plan.addProperties(['a'])).toEqual([])
  })

  it('ignores a name that is not a GraphQL name, without refusing the rest', () => {
    const plan = planOf(props(3))
    const groups = plan.addProperties(['fine', 'not a name', 'also{bad}', 'alsoFine'])
    expect(groups.map((g) => g.properties)).toEqual([['fine', 'alsoFine']])
  })

  it('returns no group when there is nothing new', () => {
    expect(planOf(props(3)).addProperties([])).toEqual([])
  })

  it('has the discovered property in a later initial()', () => {
    const plan = planOf(props(3))
    plan.addProperties(['newThing'])
    expect(stateSubs(plan.initial()).flatMap((s) => s.properties!)).toContain('newThing')
  })
})

// ---------------------------------------------------------------------------
// A fault in the documents is not a fault in a field (design §5.4)
// ---------------------------------------------------------------------------

/** Reject every id in `ids`, each `gapMs` after the last, and return what each rejection answered. */
function rejectAll(plan: SubscriptionPlan, ids: string[], at = NOW, gapMs = 100) {
  return ids.map((id, i) => plan.rejected(id, at + i * gapMs))
}

describe('SubscriptionPlan.rejected: when every state group of the first wave is rejected', () => {
  /** 40 properties: groups of 16, 16 and 8. */
  function threeGroups() {
    const plan = planOf(props(40))
    const initial = plan.initial()
    const groups = initial.filter((s) => s.sub.stream === 'state')
    return { plan, initial, groups }
  }

  it('bisects the early rejections as ever, and calls it a document fault on the last', () => {
    const { plan, groups } = threeGroups()
    const [first, second, last] = rejectAll(plan, groups.map((g) => g.id))

    expect(first!.probes).toHaveLength(2)
    expect(first!.fault).toBeNull()
    expect(second!.probes).toHaveLength(2)
    expect(second!.fault).toBeNull()

    // The last rejection completes the wave: nothing is bisected for it, and
    // every probe already handed out for the others is withdrawn.
    expect(last!.probes).toEqual([])
    expect(last!.newlyDropped).toEqual([])
    expect(last!.fault).toMatchObject({ kind: 'documents' })
    expect(last!.fault!.retry.map((s) => s.key)).toEqual(groups.map((g) => g.sub.key))
    expect(last!.fault!.retry).toEqual(groups.map((g) => g.sub))
    expect([...last!.fault!.withdrawn].sort()).toEqual(
      [...first!.probes, ...second!.probes].map((p) => p.key).sort(),
    )
    expect(last!.fault!.restored).toEqual([])
  })

  it('drops nothing, however long it goes on', () => {
    const { plan, groups } = threeGroups()
    rejectAll(plan, groups.map((g) => g.id))
    expect(plan.dropped).toEqual([])
  })

  it('does not search the group again when a retry of it is rejected again', () => {
    const { plan, groups } = threeGroups()
    const results = rejectAll(plan, groups.map((g) => g.id))
    const retried = results.at(-1)!.fault!.retry[0]!

    const again = plan.rejected(plan.activate(retried), NOW + HOUR)
    expect(again.probes).toEqual([])
    expect(again.newlyDropped).toEqual([])
    expect(again.fault).toMatchObject({ kind: 'documents', retry: [retried], withdrawn: [], restored: [] })
    expect(plan.dropped).toEqual([])
  })

  it('goes back to searching once a state frame shows the documents are fine', () => {
    const { plan, groups } = threeGroups()
    const retry = rejectAll(plan, groups.map((g) => g.id)).at(-1)!.fault!.retry
    // One group's retry is accepted and a frame arrives; another is still refused.
    plan.activate(retry[0]!)
    plan.documentAccepted()

    const genuine = plan.rejected(plan.activate(retry[1]!), NOW + HOUR)
    expect(genuine.fault).toBeNull()
    expect(genuine.probes).toHaveLength(2)
  })

  it('is not a document fault when a state frame has arrived in the meantime: some group is accepted', () => {
    const { plan, groups } = threeGroups()
    const first = plan.rejected(groups[0]!.id, NOW)
    expect(first.probes).toHaveLength(2)
    plan.documentAccepted()

    const second = plan.rejected(groups[1]!.id, NOW + 100)
    const third = plan.rejected(groups[2]!.id, NOW + 200)
    expect(second.fault).toBeNull()
    expect(third.fault).toBeNull()
    expect(third.probes).toHaveLength(2)
  })

  it('is not a document fault when one group is not rejected: that one bad field is bisected', () => {
    const { plan, groups } = threeGroups()
    const results = rejectAll(plan, groups.slice(0, 2).map((g) => g.id))
    expect(results.every((r) => r.fault === null)).toBe(true)
    expect(results.every((r) => r.probes.length === 2)).toBe(true)
  })

  it('is not one wave if the rejections are more than 20 s apart', () => {
    const { plan, groups } = threeGroups()
    const results = rejectAll(plan, groups.map((g) => g.id), NOW, 21_000)
    expect(results.map((r) => r.fault)).toEqual([null, null, null])
    expect(results.map((r) => r.probes.length)).toEqual([2, 2, 2])
  })

  it('needs at least two groups: a lone group that is rejected is bisected', () => {
    const plan = planOf(props(16))
    const id = plan.initial().find((s) => s.sub.stream === 'state')!.id
    const result = plan.rejected(id, NOW)
    expect(result.fault).toBeNull()
    expect(result.probes).toHaveLength(2)
  })

  it('takes a property back that a one-property group lost before the wave was complete', () => {
    // 17 properties: a group of 16 and a group of one. The lone one is dropped
    // at once, as a lone rejected property is; the wave then completes, and the
    // drop is undone because it was a document fault, not that property.
    const names = props(17)
    const plan = planOf(names)
    const [big, lone] = plan.initial().filter((s) => s.sub.stream === 'state')

    const dropped = plan.rejected(lone!.id, NOW)
    expect(dropped.newlyDropped).toEqual([names[16]])
    expect(plan.dropped).toEqual([names[16]])

    const last = plan.rejected(big!.id, NOW + 100)
    expect(last.fault).toMatchObject({ kind: 'documents', restored: [names[16]] })
    expect(last.fault!.retry.map((s) => s.key)).toEqual(['state:0', 'state:1'])
    expect(plan.dropped).toEqual([])
    expect(stateSubs(plan.initial()).flatMap((s) => s.properties!)).toContain(names[16])
  })

  it('starts again with a new wave when initial() does', () => {
    const { plan, groups } = threeGroups()
    rejectAll(plan, groups.map((g) => g.id))

    const again = plan.initial().filter((s) => s.sub.stream === 'state')
    const first = plan.rejected(again[0]!.id, NOW + DAY)
    // No leftover verdict: it is a rejection, and it is searched.
    expect(first.fault).toBeNull()
    expect(first.probes).toHaveLength(2)
  })
})

describe('SubscriptionPlan.rejected: when every property of a group is rejected', () => {
  /** Reject whatever is live and made only of `bad` properties, and keep going. Returns the faults seen. */
  function exhaust(plan: SubscriptionPlan, initial: { id: string; sub: PlannedSubscription }[], bad: ReadonlySet<string>) {
    const live = new Map<string, PlannedSubscription>()
    for (const { id, sub } of initial) live.set(id, sub)
    const faults: NonNullable<ReturnType<SubscriptionPlan['rejected']>['fault']>[] = []
    let rejections = 0
    let at = NOW
    for (;;) {
      const next = [...live].find(
        ([, sub]) => sub.stream === 'state' && sub.properties!.some((p) => bad.has(p)),
      )
      if (next === undefined) break
      live.delete(next[0])
      rejections += 1
      const result = plan.rejected(next[0], at)
      at += 30_000
      if (result.fault !== null) faults.push(result.fault)
      for (const probe of result.probes) live.set(plan.activate(probe), probe)
    }
    return { live, faults, rejections }
  }

  it('restores the original group, drops nothing, and hands it back to retry', () => {
    const names = props(16)
    const plan = planOf(names)
    const initial = plan.initial()
    const original = stateSubs(initial)[0]!

    const { faults, rejections } = exhaust(plan, initial, new Set(names))

    // 16 bad leaves means 1 + 2 + 4 + 8 + 16 rejections, and then it stops.
    expect(rejections).toBe(31)
    expect(faults).toHaveLength(1)
    expect(faults[0]).toMatchObject({ kind: 'group', withdrawn: [] })
    expect(faults[0]!.retry).toEqual([original])
    // The 15 leaves rejected before the last were dropped as they were found;
    // finding the last takes them back.
    expect(new Set(faults[0]!.restored).size).toBe(15)
    for (const name of faults[0]!.restored) expect(names).toContain(name)
    expect(plan.dropped).toEqual([])
  })

  it('has the restored group in the next initial(), whole', () => {
    const names = props(16)
    const plan = planOf(names)
    exhaust(plan, plan.initial(), new Set(names))
    const [group] = stateSubs(plan.initial())
    expect(group!.properties).toEqual(names)
  })

  it('does not search the restored group again when a retry of it is rejected', () => {
    const names = props(16)
    const plan = planOf(names)
    const initial = plan.initial()
    const { faults } = exhaust(plan, initial, new Set(names))

    const retried = faults[0]!.retry[0]!
    const id = plan.activate(retried)
    const again = plan.rejected(id, NOW + HOUR)
    expect(again.probes).toEqual([])
    expect(again.newlyDropped).toEqual([])
    expect(again.fault).toMatchObject({ kind: 'group', retry: [retried], withdrawn: [], restored: [] })

    // Not even after a state frame: that is about the documents, and this group
    // has shown that its own properties are the trouble.
    plan.documentAccepted()
    const third = plan.rejected(plan.activate(retried), NOW + 2 * HOUR)
    expect(third.fault).toMatchObject({ kind: 'group' })
    expect(third.probes).toEqual([])
  })

  it('does not apply when even one property of the group is accepted: the rest are dropped', () => {
    const names = props(16)
    const plan = planOf(names)
    const bad = new Set(names.slice(1))
    const { faults, live } = exhaust(plan, plan.initial(), bad)

    expect(faults).toEqual([])
    expect([...plan.dropped].sort()).toEqual([...bad].sort())
    expect([...live.values()].flatMap((s) => s.properties ?? [])).toEqual([names[0]])
  })

  it('does not apply to a group of one: a lone property that is rejected is the bad field', () => {
    const plan = planOf(['onlyOne'])
    const id = plan.initial().find((s) => s.sub.stream === 'state')!.id
    expect(plan.rejected(id, NOW)).toEqual({ ...NOTHING, newlyDropped: ['onlyOne'] })
  })

  it('counts only rejections of one search: leaves rejected long apart are not one group', () => {
    // [a b c d] splits into [a b] and [c d]. a and b are found at once. [c d]
    // is accepted, and a day later it is rejected: that is a new group, not the
    // rest of the old search, so a and b are not taken back.
    const plan = planOf(['a', 'b', 'c', 'd'])
    const root = plan.initial().find((s) => s.sub.stream === 'state')!
    const [ab, cd] = plan.rejected(root.id, NOW).probes
    const abId = plan.activate(ab!)
    const cdId = plan.activate(cd!)
    const [a, b] = plan.rejected(abId, NOW).probes
    expect(plan.rejected(plan.activate(a!), NOW).newlyDropped).toEqual(['a'])
    expect(plan.rejected(plan.activate(b!), NOW).newlyDropped).toEqual(['b'])
    expect(plan.dropped).toEqual(['a', 'b'])

    const later = NOW + DAY
    const [c, d] = plan.rejected(cdId, later).probes
    expect(plan.rejected(plan.activate(c!), later).newlyDropped).toEqual(['c'])
    const last = plan.rejected(plan.activate(d!), later)

    // [c d] itself was wholly rejected, and is restored; a and b are not.
    expect(last.fault).toMatchObject({ kind: 'group', restored: ['c'] })
    expect(last.fault!.retry[0]!.properties).toEqual(['c', 'd'])
    expect(plan.dropped).toEqual(['a', 'b'])
  })

  it('starts again with initial()', () => {
    const names = props(16)
    const plan = planOf(names)
    exhaust(plan, plan.initial(), new Set(names))

    const id = plan.initial().find((s) => s.sub.stream === 'state')!.id
    const result = plan.rejected(id, NOW + DAY)
    expect(result.fault).toBeNull()
    expect(result.probes).toHaveLength(2)
  })
})

describe('SubscriptionPlan: reprobing what a restart read back as dropped (design §5.4)', () => {
  const saved = (n: number) => Array.from({ length: n }, (_, i) => `saved${String(i).padStart(3, '0')}`)

  it('waits an hour, not a day, and is not due at any moment before it', () => {
    const plan = planOf(props(2), { dropped: saved(60) })
    for (const at of [0, 1, MINUTE, 30 * MINUTE, HOUR - 1]) {
      expect(plan.dueForReprobe(NOW + at), String(at)).toEqual([])
    }
    expect(plan.dueForReprobe(NOW + HOUR)).toHaveLength(1)
  })

  it('spreads them across the hour after that, and everything is out by two hours', () => {
    const names = saved(60)
    const plan = planOf(props(2), { dropped: names })
    const probed: string[] = []
    const perMinute: number[] = []
    for (let minute = 0; minute <= 120; minute += 1) {
      const due = plan.dueForReprobe(NOW + minute * MINUTE)
      if (minute < 60) expect(due, `minute ${minute}`).toEqual([])
      perMinute.push(due.length)
      probed.push(...due.flatMap((s) => s.properties!))
    }
    expect([...probed].sort()).toEqual([...names].sort())
    // Not all in one tick: 60 over an hour is one a minute.
    expect(Math.max(...perMinute)).toBeLessThanOrEqual(1)
    expect(perMinute.slice(60, 120).filter((n) => n > 0).length).toBeGreaterThanOrEqual(59)
  })

  it('spreads a long list at least as fine as one every thirty seconds', () => {
    const names = saved(135)
    const plan = planOf(props(2), { dropped: names })
    let total = 0
    for (let minute = 60; minute <= 120; minute += 1) {
      const due = plan.dueForReprobe(NOW + minute * MINUTE)
      expect(due.length, `minute ${minute}`).toBeLessThanOrEqual(3)
      total += due.length
    }
    expect(total).toBe(135)
  })

  it('keeps a lone name\'s hour, whatever else is in the list', () => {
    const plan = planOf(props(2), { dropped: ['lone'] })
    expect(plan.dueForReprobe(NOW + HOUR - 1)).toEqual([])
    expect(plan.dueForReprobe(NOW + HOUR).map((s) => s.properties)).toEqual([['lone']])
  })

  it('counts each name once: a repeat and a name that is not a GraphQL name take no slot', () => {
    const plan = planOf(props(2), { dropped: ['x', 'x', 'not a name', 'y'] })
    const due = plan.dueForReprobe(NOW + 2 * HOUR)
    expect(due.map((s) => s.properties)).toEqual([['x'], ['y']])
  })

  it('goes back to a day for a name that is rejected again', () => {
    const plan = planOf(props(2), { dropped: ['x'] })
    const [probe] = plan.dueForReprobe(NOW + HOUR)
    const at = NOW + HOUR
    expect(plan.rejected(plan.activate(probe!), at).newlyDropped).toEqual(['x'])
    expect(plan.dueForReprobe(at + DAY - 1)).toEqual([])
    expect(plan.dueForReprobe(at + DAY)).toHaveLength(1)
  })

  it('keeps properties found bad together from all coming due in the same tick', () => {
    // Eight of sixteen found bad in one search drop at the same moment; a day
    // later they must not be eight probes at once.
    const names = props(16)
    const plan = planOf(names)
    const bad = new Set(names.filter((_, i) => i % 2 === 0))
    const initial = plan.initial()
    bisect(plan, initial, bad)
    expect(plan.dropped).toHaveLength(8)

    const due = [NOW + DAY - 1, NOW + DAY, NOW + DAY + MINUTE].map((at) => plan.dueForReprobe(at).length)
    expect(due).toEqual([0, 1, 1])
    expect(plan.dueForReprobe(NOW + DAY + 8 * MINUTE)).toHaveLength(6)
  })
})
