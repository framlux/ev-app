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
 *    A SECOND KIND OF FAULT LOOKS LIKE THE FIRST AND MUST NOT BE SEARCHED. If
 *    every `vehicleState` group of a fresh subscribe is rejected, or a group's
 *    search ends with every one of its properties rejected, the likelier fault
 *    is the DOCUMENT (the wrong type, the wrong variable) and not a hundred
 *    fields retiring at once. Bisecting it would take the whole catalogue down
 *    to single properties in a couple of minutes (261 subscribes), drop all 135
 *    and persist that, so a restart would then subscribe no state at all. The
 *    plan reports such a rejection as a `fault`: nothing is dropped, what was
 *    dropped on the way is taken back, and the groups are handed back to retry
 *    on a backoff. A `vehicleState` frame is what shows the documents are fine
 *    (`documentAccepted`).
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
 * What `rejected` found to be the matter when it was not a field.
 *
 * - `documents`: every `vehicleState` group of the subscribe wave was rejected
 *   (or one of them is rejected again after that, with the documents still
 *   unproven). The document is wrong, not a field.
 * - `group`: a group was searched down to its single properties and every one
 *   of them was rejected. Nothing in the group is known to be good.
 */
export interface Fault {
  kind: 'documents' | 'group'
  /** The groups to subscribe again on a backoff, whole and as they were first subscribed. */
  retry: PlannedSubscription[]
  /**
   * Keys of probes this plan handed out for those groups, earlier, that are no
   * longer wanted: the connector must cancel any it is still holding.
   */
  withdrawn: string[]
  /**
   * Properties this search had dropped that are taken back: they were dropped
   * on the way to finding out that it was not them. The dropped list has
   * shrunk, and the connector writes it again.
   */
  restored: string[]
}

/** What `rejected` answers. */
export interface Rejection {
  probes: PlannedSubscription[]
  newlyDropped: string[]
  unavailable: string | null
  fault: Fault | null
}

/** A group's search for its bad field: the group first rejected, and the properties found rejected alone since. */
interface Lineage {
  group: PlannedSubscription
  rejected: Set<string>
  lastAt: number
}

/** The first subscribe wave's state groups, and what each rejection of them handed out or dropped. */
interface Wave {
  groups: Map<string, PlannedSubscription>
  firstAt: number | null
  rejected: Map<string, { probes: string[]; dropped: string[] }>
}

/**
 * How long a rejected property, or a rejected subscription with no properties
 * to bisect, is left alone before it is tried once more (§5.4). A field that
 * Rivian removed can come back for another model, but not by the minute: a day
 * is slow enough not to nag, and fast enough to notice by the next morning.
 */
const REPROBE_INTERVAL_MS = 24 * 60 * 60 * 1000

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS

/**
 * A property that a previous run found rejected, read back at start, is first
 * tried again an hour later and not a day: the list was learned by a connector
 * that may have been wrong (a document fault is not meant to reach it, but one
 * did once), and a day is a long time to leave 135 fields out on the strength
 * of a search that nobody can check. The retries are spread over the hour after
 * that (see the constructor), so a restart does not turn the whole list into
 * one burst of subscribes.
 */
const FIRST_REPROBE_MS = HOUR_MS

/**
 * The least gap between two reprobes that are handed out for a rejection (and
 * between the last of those read back at start and the next). Eight properties
 * that one search found bad at the same moment would otherwise all fall due at
 * the same moment a day later; this keeps each reprobe a probe of its own.
 */
const REPROBE_SPACING_MS = MINUTE_MS

/**
 * How far apart in time the first and last rejection of a subscribe wave can be
 * and still be one document fault. A server that rejects the documents
 * rejects them all within moments of the subscribe; this is under the 30 s a
 * bisection probe waits, so that when the last rejection completes the wave
 * the probes already planned for the others have not yet been subscribed and
 * can still be withdrawn.
 */
const WAVE_WINDOW_MS = 20_000

/**
 * How long a bisection stays one search. Its rejections come one probe (30 s)
 * after another, so a leaf rejected minutes after the last is not part of the
 * same search: it is a probe that was accepted at the time and is rejected now
 * (after a renewal, say), and counting it would "complete" an old search and
 * take back properties that really were found bad.
 */
const LINEAGE_WINDOW_MS = 5 * MINUTE_MS

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

  /** When the latest reprobe time that was handed to a dropped property falls (see `#dueAfterDrop`). */
  #lastDueAt = Number.NEGATIVE_INFINITY

  /** The first subscribe wave, while it can still turn out to be one document fault. Null when it cannot. */
  #wave: Wave | null = null

  /** Bisection searches in progress or lately finished, by the key of each probe in them. */
  readonly #lineages = new Map<string, Lineage>()

  /**
   * Groups to retry, not search, because every group of a wave was rejected.
   * Emptied by a `vehicleState` frame (`documentAccepted`) and by `initial()`.
   */
  readonly #faulted = new Set<string>()

  /**
   * Groups to retry, not search, because every property of them was rejected.
   * Emptied only by `initial()`: another group's frame says nothing about
   * this group's own properties.
   */
  readonly #exhausted = new Set<string>()

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
   * first tried again from `now` + 1 h, spread evenly across the hour after
   * that, so a restart neither repeats the search nor retries at once what it
   * already knows fails, and does not retry all of it in one burst either.
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
    const saved = [...new Set(opts.dropped)].filter(isQueryable)
    saved.forEach((name, i) => {
      const dueAt = opts.now + FIRST_REPROBE_MS + Math.floor((i * HOUR_MS) / saved.length)
      this.#dropped.set(name, dueAt)
      this.#lastDueAt = Math.max(this.#lastDueAt, dueAt)
    })
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
   *
   * ONLY FOR A REPLACED SOCKET. Forgetting the ids is right when the old
   * connection is gone and took its server-side subscriptions with it. On a
   * socket that is still open, use `renewAll`: `initial()` discards the old ids
   * without handing them back, so the connector could never `complete` them,
   * and the server would keep delivering under subscriptions nobody can name.
   */
  initial(): { id: string; sub: PlannedSubscription }[] {
    this.#live.clear()
    this.#nextGroup = 0
    // The keys are numbered afresh, so everything that remembered one is
    // about subscriptions that no longer exist.
    this.#lineages.clear()
    this.#faulted.clear()
    this.#exhausted.clear()
    const live = this.#properties.filter((name) => !this.#dropped.has(name))
    const groups = groupProperties(live, MAX_GROUP_SIZE).map((names) => this.#stateGroup(names))
    // A wave needs at least two groups: with one, "every group was rejected"
    // says no more than "that group was rejected".
    this.#wave =
      groups.length >= 2
        ? { groups: new Map(groups.map((g) => [g.key, g])), firstAt: null, rejected: new Map() }
        : null
    const subs = [
      ...groups,
      ...this.#fixedSubscriptions().filter((sub) => !this.#unavailable.has(sub.key)),
    ]
    return subs.map((sub) => ({ id: this.activate(sub), sub }))
  }

  /** Which stream a frame with this id belongs to; null for an id that is not live. */
  streamOf(id: string): RivianStream | null {
    return this.#live.get(id)?.stream ?? null
  }

  /**
   * The subscription this id is, for the connector to key its per-subscription
   * state on (`key` is stable across the fresh ids a retry gives it); null for
   * an id that is not live.
   */
  subOf(id: string): PlannedSubscription | null {
    return this.#live.get(id) ?? null
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
   * - But a rejection that is more likely the DOCUMENT than a field comes back
   *   as a `fault` instead, with nothing dropped and nothing bisected: the
   *   rejection that completes a wave (every state group of `initial()`
   *   rejected), a search in which every property of the group was rejected, and
   *   a retry of a group that has already been so judged. The connector retries
   *   the `fault.retry` groups on a backoff, cancels the `fault.withdrawn`
   *   probes it was holding, and writes the dropped list again if
   *   `fault.restored` is not empty.
   *
   * An id the plan does not hold (already renewed, ended or rejected) answers
   * nothing and changes nothing: it is a stale error for a subscription that
   * has already been dealt with.
   */
  rejected(id: string, now: number): Rejection {
    const sub = this.#live.get(id)
    if (sub === undefined) return { probes: [], newlyDropped: [], unavailable: null, fault: null }
    this.#live.delete(id)

    const properties = sub.properties
    if (properties === undefined) {
      this.#unavailable.set(sub.key, { sub, dueAt: now + REPROBE_INTERVAL_MS })
      return { probes: [], newlyDropped: [], unavailable: sub.key, fault: null }
    }

    // Already judged: it was a fault when it was last rejected and nothing since
    // has said otherwise, so it is retried and not searched.
    if (this.#faulted.has(sub.key)) return this.#retryOnly('documents', sub)
    if (this.#exhausted.has(sub.key)) return this.#retryOnly('group', sub)

    const wave = this.#waveFor(sub, now)
    if (wave !== null && wave.rejected.size + (wave.rejected.has(sub.key) ? 0 : 1) === wave.groups.size) {
      return this.#documentFault(wave)
    }
    const result = this.#search(sub, properties, now)
    if (wave !== null && result.fault === null) {
      wave.rejected.set(sub.key, {
        probes: result.probes.map((p) => p.key),
        dropped: result.newlyDropped,
      })
    }
    return result
  }

  /**
   * A `vehicleState` frame arrived: the documents are valid, so a rejection
   * from now on is about a field. A wave still open cannot be all-rejected, and
   * groups waiting to be retried as document faults are searched when they are
   * rejected again.
   */
  documentAccepted(): void {
    this.#wave = null
    this.#faulted.clear()
  }

  /** The wave `sub` belongs to, while it is still one wave; null if it belongs to none, or took too long. */
  #waveFor(sub: PlannedSubscription, now: number): Wave | null {
    const wave = this.#wave
    if (wave === null || !wave.groups.has(sub.key)) return null
    if (wave.firstAt === null) wave.firstAt = now
    else if (now - wave.firstAt > WAVE_WINDOW_MS) {
      this.#wave = null
      return null
    }
    return wave
  }

  /** The last group of a wave was rejected: it was the documents. Take back what the others did. */
  #documentFault(wave: Wave): Rejection {
    const withdrawn: string[] = []
    const restored: string[] = []
    for (const entry of wave.rejected.values()) {
      withdrawn.push(...entry.probes)
      restored.push(...entry.dropped)
    }
    for (const key of withdrawn) this.#lineages.delete(key)
    for (const name of restored) this.#dropped.delete(name)
    for (const key of wave.groups.keys()) this.#faulted.add(key)
    this.#wave = null
    return {
      probes: [],
      newlyDropped: [],
      unavailable: null,
      fault: { kind: 'documents', retry: [...wave.groups.values()], withdrawn, restored },
    }
  }

  #retryOnly(kind: Fault['kind'], sub: PlannedSubscription): Rejection {
    return {
      probes: [],
      newlyDropped: [],
      unavailable: null,
      fault: { kind, retry: [sub], withdrawn: [], restored: [] },
    }
  }

  /**
   * The search proper: split a group, or drop a property that is rejected
   * alone, unless that completes a group whose every property was rejected.
   */
  #search(sub: PlannedSubscription, properties: readonly string[], now: number): Rejection {
    const lineage = this.#lineageOf(sub.key, now)

    if (properties.length === 1) {
      const name = properties[0]!
      if (lineage !== undefined) {
        lineage.rejected.add(name)
        lineage.lastAt = now
        if (lineage.rejected.size === lineage.group.properties!.length) {
          // Every property the group was made of has been rejected alone. That
          // is not sixteen retired fields, it is something the group's query
          // gets wrong; the ones already dropped on the way were not at fault.
          const restored = [...lineage.rejected].filter((n) => n !== name)
          for (const n of restored) this.#dropped.delete(n)
          for (const [key, l] of [...this.#lineages]) if (l === lineage) this.#lineages.delete(key)
          this.#exhausted.add(lineage.group.key)
          return {
            probes: [],
            newlyDropped: [],
            unavailable: null,
            fault: { kind: 'group', retry: [lineage.group], withdrawn: [], restored },
          }
        }
      }
      this.#dropped.set(name, this.#dueAfterDrop(now))
      return { probes: [], newlyDropped: [name], unavailable: null, fault: null }
    }

    const middle = Math.ceil(properties.length / 2)
    const probes = [
      this.#stateGroup(properties.slice(0, middle)),
      this.#stateGroup(properties.slice(middle)),
    ]
    const search = lineage ?? { group: sub, rejected: new Set<string>(), lastAt: now }
    search.lastAt = now
    for (const probe of probes) this.#lineages.set(probe.key, search)
    return { probes, newlyDropped: [], unavailable: null, fault: null }
  }

  /** The search this probe belongs to, unless it is old enough to be a different matter (see `LINEAGE_WINDOW_MS`). */
  #lineageOf(key: string, now: number): Lineage | undefined {
    const lineage = this.#lineages.get(key)
    if (lineage === undefined) return undefined
    if (now - lineage.lastAt > LINEAGE_WINDOW_MS) {
      this.#lineages.delete(key)
      return undefined
    }
    return lineage
  }

  /**
   * When a property just found rejected is next tried: a day on, but never
   * within a minute of the last one handed a time, so that properties found bad
   * together are probed one by one over the following minutes and not in one
   * burst a day later.
   */
  #dueAfterDrop(now: number): number {
    const at = Math.max(now + REPROBE_INTERVAL_MS, this.#lastDueAt + REPROBE_SPACING_MS)
    this.#lastDueAt = at
    return at
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
   * validation failure. Returns the subscription to subscribe again, when the
   * connector's per-subscription backoff says (through `activate`, which gives
   * it a fresh id: the old one is spent), or null for an id the plan does not
   * hold.
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
   * What to try again, once per 24 h (a property read back at start: once, an
   * hour after it, and then daily): each dropped property ALONE (§5.4, in case
   * a field has come back, say for the R2) and each unavailable subscription as
   * it was. The properties' times are spread, so a call returns one or two of
   * them and not the list.
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
   *
   * HOW TO CALL IT. Only while the socket is acknowledged, and `activate` every
   * probe it returns at once: a probe handed out and not subscribed is
   * forgotten (it has left `dropped` or the unavailable set, and nothing will
   * bring it back for a day, or for ever if it was a dropped property). Then
   * persist `dropped` again, because it shrinks as the probes are handed out;
   * the stored list is otherwise stale until the next rejection.
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
