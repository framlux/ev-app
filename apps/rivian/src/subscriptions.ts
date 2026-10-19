import {
  MAX_GROUP_SIZE,
  chargingSessionDocument,
  cloudConnectionDocument,
  departureSchedulesDocument,
  geofencesDocument,
  groupProperties,
  otaInstallSchedulesDocument,
  otaInstallStateDocument,
  parallaxDocument,
  vehicleStateDocument,
  type RivianStream,
  type SubscriptionDocument,
} from '@ev/rivian'

/**
 * WHAT THE CONNECTOR IS SUBSCRIBED TO, AND WHAT IT DOES WHEN RIVIAN SAYS NO
 * (design §5.3, §5.4).
 *
 * This is pure bookkeeping: no socket, no timer, no clock of its own. The
 * connector owns the wire and the waiting; the plan owns the answers to "which
 * subscription is this frame from", "what do I subscribe now", and "that one
 * was refused, now what". It takes `now` wherever time matters, so a test
 * drives it without sleeping.
 *
 * TWO FACTS SHAPE EVERYTHING HERE.
 *
 * 1. Rivian's validation errors do not name the offending field (§2.3). A
 *    `vehicleState` subscription with one retired property in a selection of
 *    135 is rejected whole, with `GRAPHQL_VALIDATION_FAILED` and no hint. So
 *    the properties are subscribed in groups of at most 16, which caps how many
 *    healthy fields one bad field can silence, and a rejected group is bisected
 *    (halved, each half subscribed again) until the single field at fault is
 *    alone and rejected, at which point it is dropped. 16 settle in at most 5
 *    rejections; healthy halves keep flowing the whole time.
 *
 * 2. `graphql-transport-ws` forbids reusing a subscription id on a socket
 *    (§5.2). Renewing a subscription, which the connector does after every 60 s
 *    of silence, is a `complete` for the old id and a `subscribe` under a NEW
 *    one. So every id is minted fresh from a counter that never goes back, and
 *    the id (not the subscription) is what a frame is matched on: a late frame
 *    for an id that has been renewed, rejected or ended finds nothing here, and
 *    is a stale frame to be ignored, not data for the new subscription.
 */

/** One thing to subscribe to. `properties` is present for `vehicleState` only. */
export interface PlannedSubscription {
  /** `state:<n>`, `parallax`, `charging`, `cloud`, `ota-state`, `ota-schedules`, `geofence` or `departure`. */
  key: string
  stream: RivianStream
  doc: SubscriptionDocument
  properties?: string[]
}

/**
 * How long a rejected property, or a rejected subscription with no properties
 * to bisect, is left alone before it is tried once more (§5.4). A field that
 * Rivian removed can come back for another model, but not by the minute: a day
 * is slow enough not to nag, and fast enough to notice by the next morning.
 */
const REPROBE_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * Whether `name` may become part of a `vehicleState` query.
 *
 * The catalogue's own document builder is the authority, since it is the code
 * that would refuse the name later: it throws `RangeError` for anything that is
 * not a GraphQL name. Asking it here, rather than keeping a second copy of its
 * pattern, means the two cannot drift apart. Names reach the plan from
 * discovery (read out of Rivian's introspection response) and from the
 * database (the persisted dropped list), and neither is trusted to be an
 * identifier. One bad name must cost that name only, not the group it would
 * have joined, so it is filtered out before any group is built.
 */
function isQueryable(name: unknown): name is string {
  if (typeof name !== 'string') return false
  try {
    vehicleStateDocument('', [name])
    return true
  } catch (e) {
    if (e instanceof RangeError) return false
    throw e
  }
}

export class SubscriptionPlan {
  readonly #vehicleId: string
  readonly #parallaxRvms: string[] | null

  /** Every `vehicleState` property we know to ask for, dropped ones included. */
  readonly #properties: string[] = []

  /** Dropped properties, each with the time it may next be tried. */
  readonly #dropped = new Map<string, number>()

  /** Subscriptions with no properties to bisect that Rivian refused, with their retry time. */
  readonly #unavailable = new Map<string, { sub: PlannedSubscription; dueAt: number }>()

  /** The ids that are subscribed right now, and what each one is. */
  #live = new Map<string, PlannedSubscription>()

  /** Never reset, so an id is never handed out twice (the protocol forbids it). */
  #nextId = 0

  /** The next `state:<n>`. Reset by `initial()`. */
  #nextGroup = 0

  /**
   * `properties` is the list to subscribe (the catalogue, widened by discovery
   * in an earlier run). `dropped` is what a previous run found Rivian rejects,
   * read back from the database: those names are left out of `initial()`, and
   * first tried again `now` + 24 h, so a restart neither repeats the search nor
   * retries at once what it already knows fails.
   */
  constructor(
    vehicleId: string,
    opts: {
      properties: readonly string[]
      dropped: readonly string[]
      parallaxRvms: string[] | null
      now: number
    },
  ) {
    this.#vehicleId = vehicleId
    this.#parallaxRvms = opts.parallaxRvms === null ? null : [...opts.parallaxRvms]
    for (const name of opts.dropped) {
      if (isQueryable(name) && !this.#dropped.has(name)) {
        this.#dropped.set(name, opts.now + REPROBE_INTERVAL_MS)
      }
    }
    // A dropped name is a known name even if the list no longer mentions it,
    // so that it joins a group again if a later probe finds it accepted.
    const seen = new Set<string>()
    for (const name of [...opts.properties, ...this.#dropped.keys()]) {
      if (isQueryable(name) && !seen.has(name)) {
        seen.add(name)
        this.#properties.push(name)
      }
    }
  }

  /** The properties Rivian is known to reject, in the order they were dropped. */
  get dropped(): readonly string[] {
    return [...this.#dropped.keys()]
  }

  /**
   * Everything to subscribe to now, each under a fresh id: the live properties
   * in groups of at most 16, then the seven subscriptions that have no
   * properties to group.
   *
   * It starts over. Calling it again (the socket was replaced) forgets every
   * id handed out so far, so a straggler frame from the old socket is stale,
   * and numbers the groups from 0 again. Groups already bisected come back as
   * a plain regrouping of what is not dropped: if a bad field is still being
   * hunted, the hunt starts again, which costs a few probes and nothing more.
   * A subscription Rivian refused and that is not yet due stays out, so a
   * reconnect does not nag the endpoint it was just told no by.
   *
   * The connector must discard any probe it is holding for a delayed
   * `activate`. Those belong to the numbering that has just been reset.
   */
  initial(): { id: string; sub: PlannedSubscription }[] {
    this.#live.clear()
    this.#nextGroup = 0
    const live = this.#properties.filter((name) => !this.#dropped.has(name))
    const subs = [
      ...groupProperties(live, MAX_GROUP_SIZE).map((names) => this.#stateGroup(names)),
      ...this.#fixedSubscriptions().filter((sub) => !this.#unavailable.has(sub.key)),
    ]
    return subs.map((sub) => ({ id: this.activate(sub), sub }))
  }

  /** Which stream a frame with this id belongs to; null for an id that is not live. */
  streamOf(id: string): RivianStream | null {
    return this.#live.get(id)?.stream ?? null
  }

  /**
   * A fresh id for every subscription that is live, for the connector to
   * `complete` the old and `subscribe` the new (silence, or a drop in the
   * publish queue). The old ids stop mapping to anything at once.
   *
   * Only live subscriptions are renewed. A probe waiting out its 30 s, an
   * ended subscription waiting to come back, and an unavailable one waiting
   * for its day are all someone else's timer, and renewing them here would
   * subscribe them early.
   */
  renewAll(): { oldId: string; id: string; sub: PlannedSubscription }[] {
    const renewed: { oldId: string; id: string; sub: PlannedSubscription }[] = []
    const next = new Map<string, PlannedSubscription>()
    for (const [oldId, sub] of this.#live) {
      const id = this.#mint(sub.key)
      next.set(id, sub)
      renewed.push({ oldId, id, sub })
    }
    this.#live = next
    return renewed
  }

  /**
   * Rivian rejected this id with `GRAPHQL_VALIDATION_FAILED` (§5.4). The id is
   * finished either way: an `error` message ends an operation.
   *
   * - A `vehicleState` group of several properties is split in two (the first
   *   half takes the odd one) and the halves are returned as `probes`. The
   *   connector subscribes each after 30 s, through `activate`. A half that is
   *   accepted simply stays; a half that is rejected comes back here and is
   *   split again.
   * - A group of one that is rejected has found the bad field: it is dropped
   *   and reported in `newlyDropped`, for the connector to persist and publish.
   * - Anything else has no properties to bisect. It is marked unavailable, named
   *   in `unavailable`, and tried again once a day by `dueForReprobe`.
   *
   * An id the plan does not hold (already renewed, ended or rejected) answers
   * nothing and changes nothing: it is a stale error for a subscription that
   * has already been dealt with.
   */
  rejected(
    id: string,
    now: number,
  ): { probes: PlannedSubscription[]; newlyDropped: string[]; unavailable: string | null } {
    const sub = this.#live.get(id)
    if (sub === undefined) return { probes: [], newlyDropped: [], unavailable: null }
    this.#live.delete(id)

    const properties = sub.properties
    if (properties === undefined) {
      this.#unavailable.set(sub.key, { sub, dueAt: now + REPROBE_INTERVAL_MS })
      return { probes: [], newlyDropped: [], unavailable: sub.key }
    }
    if (properties.length === 1) {
      const name = properties[0]!
      this.#dropped.set(name, now + REPROBE_INTERVAL_MS)
      return { probes: [], newlyDropped: [name], unavailable: null }
    }
    const middle = Math.ceil(properties.length / 2)
    return {
      probes: [
        this.#stateGroup(properties.slice(0, middle)),
        this.#stateGroup(properties.slice(middle)),
      ],
      newlyDropped: [],
      unavailable: null,
    }
  }

  /**
   * Subscribe something the plan handed back (a probe, an ended subscription
   * coming back, a reprobe, or a discovered group): it is given a fresh id and
   * becomes live under it.
   */
  activate(sub: PlannedSubscription): string {
    const id = this.#mint(sub.key)
    this.#live.set(id, sub)
    return id
  }

  /**
   * The server completed this id, or errored it in a way that is not a
   * validation failure. Returns the subscription to subscribe again after 30 s
   * (through `activate`, which gives it a fresh id: the old one is spent), or
   * null for an id the plan does not hold.
   */
  ended(id: string): PlannedSubscription | null {
    const sub = this.#live.get(id)
    if (sub === undefined) return null
    this.#live.delete(id)
    return sub
  }

  /**
   * Discovery found properties Rivian's schema has and the plan does not (§5.6).
   * Returns the groups to subscribe, for the connector to `activate`; the names
   * are also kept, so a later `initial()` includes them.
   *
   * A name the plan already knows (dropped ones included: a dropped property
   * comes back through `dueForReprobe`, not through discovery) is ignored, and
   * so is one that is not a GraphQL name (see `isQueryable`).
   */
  addProperties(names: readonly string[]): PlannedSubscription[] {
    const known = new Set(this.#properties)
    const fresh: string[] = []
    for (const name of names) {
      if (!known.has(name) && isQueryable(name)) {
        known.add(name)
        fresh.push(name)
      }
    }
    this.#properties.push(...fresh)
    return groupProperties(fresh, MAX_GROUP_SIZE).map((group) => this.#stateGroup(group))
  }

  /**
   * What to try again, once per 24 h: each dropped property ALONE (§5.4, in
   * case a field has come back, say for the R2) and each unavailable
   * subscription as it was.
   *
   * Nothing in this interface says "accepted", only "rejected", so what is
   * handed out here is assumed to be accepted unless `rejected` says
   * otherwise. A property taken out for a reprobe therefore leaves `dropped`
   * at once, and a rejection puts it back, with another 24 h to wait; the same
   * goes for an unavailable subscription. The alternative, leaving it listed
   * until proven, has no way to learn that it was proven, and a recovered
   * field would be reported missing for ever. The price is a short window in
   * which a property being reprobed is not in `dropped`; a restart inside it
   * finds the property in a normal group and bisects again.
   */
  dueForReprobe(now: number): PlannedSubscription[] {
    const due: PlannedSubscription[] = []
    for (const [name, dueAt] of [...this.#dropped]) {
      if (now >= dueAt) {
        this.#dropped.delete(name)
        due.push(this.#stateGroup([name]))
      }
    }
    for (const [key, { sub, dueAt }] of [...this.#unavailable]) {
      if (now >= dueAt) {
        this.#unavailable.delete(key)
        due.push(sub)
      }
    }
    return due
  }

  /** `${key}#${counter}`: the counter is shared, so no two ids are ever alike. */
  #mint(key: string): string {
    const id = `${key}#${this.#nextId}`
    this.#nextId += 1
    return id
  }

  /**
   * A `vehicleState` subscription for these properties. They are never empty
   * (the document builder would throw): every caller passes a slice that has
   * at least one name in it.
   */
  #stateGroup(names: readonly string[]): PlannedSubscription {
    const key = `state:${this.#nextGroup}`
    this.#nextGroup += 1
    return {
      key,
      stream: 'state',
      doc: vehicleStateDocument(this.#vehicleId, names),
      properties: [...names],
    }
  }

  /** The seven subscriptions that have no properties to group. */
  #fixedSubscriptions(): PlannedSubscription[] {
    const id = this.#vehicleId
    return [
      { key: 'parallax', stream: 'parallax', doc: parallaxDocument(id, this.#parallaxRvms) },
      { key: 'charging', stream: 'charging', doc: chargingSessionDocument(id) },
      { key: 'cloud', stream: 'cloud', doc: cloudConnectionDocument(id) },
      { key: 'ota-state', stream: 'ota', doc: otaInstallStateDocument(id) },
      { key: 'ota-schedules', stream: 'ota', doc: otaInstallSchedulesDocument(id) },
      { key: 'geofence', stream: 'geofence', doc: geofencesDocument(id) },
      { key: 'departure', stream: 'departure', doc: departureSchedulesDocument(id) },
    ]
  }
}
