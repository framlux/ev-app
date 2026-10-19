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
const DAY = 24 * 60 * 60 * 1000

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
    expect(plan.rejected(lone.id, NOW)).toEqual({ probes: [], newlyDropped: [names[16]], unavailable: null })
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

  it('drops all 16 when every one is bad, and then holds no state subscription', () => {
    const names = props(16)
    const plan = planOf(names)
    const { live, newlyDropped } = bisect(plan, plan.initial(), new Set(names))
    expect([...newlyDropped].sort()).toEqual([...names].sort())
    expect([...live.values()].filter((s) => s.stream === 'state')).toEqual([])
  })

  it('reports nothing for an id it does not hold, and changes nothing', () => {
    const plan = planOf(props(16))
    const before = plan.initial()
    expect(plan.rejected('state:0#999', NOW)).toEqual({ probes: [], newlyDropped: [], unavailable: null })
    expect(plan.dropped).toEqual([])
    expect(before.every((s) => plan.streamOf(s.id) !== null)).toBe(true)
  })

  it('treats a rejected id as ended: asking again about it reports nothing', () => {
    const plan = planOf(props(16))
    const id = plan.initial().find((s) => s.sub.stream === 'state')!.id
    expect(plan.rejected(id, NOW).probes).toHaveLength(2)
    expect(plan.rejected(id, NOW)).toEqual({ probes: [], newlyDropped: [], unavailable: null })
  })

  it('keeps a dropped property out of every later initial() and renewal', () => {
    const names = props(16)
    const plan = planOf(names)
    bisect(plan, plan.initial(), new Set([names[3]!]))
    const again = plan.initial()
    expect(stateSubs(again).flatMap((s) => s.properties!)).not.toContain(names[3])
    expect(stateSubs(again).flatMap((s) => s.properties!)).toHaveLength(15)
  })
})

describe('SubscriptionPlan.rejected: a subscription with no properties to bisect', () => {
  it('marks charging unavailable and returns no probes', () => {
    const plan = planOf(props(3))
    const charging = plan.initial().find((s) => s.sub.key === 'charging')!
    expect(plan.rejected(charging.id, NOW)).toEqual({ probes: [], newlyDropped: [], unavailable: 'charging' })
    expect(plan.streamOf(charging.id)).toBeNull()
    expect(plan.dropped).toEqual([])
  })

  it('does the same for each of the other six', () => {
    for (const key of OTHER_KEYS) {
      const plan = planOf(props(3))
      const sub = plan.initial().find((s) => s.sub.key === key)!
      expect(plan.rejected(sub.id, NOW), key).toEqual({ probes: [], newlyDropped: [], unavailable: key })
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

  it('counts the first 24 h of a constructor-supplied dropped property from the time given', () => {
    const plan = planOf(props(2), { dropped: ['badOne'], now: NOW })
    expect(plan.dueForReprobe(NOW)).toEqual([])
    expect(plan.dueForReprobe(NOW + DAY - 1)).toEqual([])
    const due = plan.dueForReprobe(NOW + DAY)
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
