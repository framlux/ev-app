import type { SessionSummary, VehicleSample } from './deps.js'

/**
 * Deciding what a closed charge cost, as arithmetic over facts already in hand.
 *
 * Nothing here touches the database, the clock, or the network. That is the
 * point of the file rather than a coding preference: the rules below are the
 * ones that decide whether a year of home charging is priced or blank, and the
 * only way to exercise every branch cheaply is for the whole decision to be a
 * function of its arguments. `pipeline.ts` supplies the one input it cannot —
 * the rate in force at the session's start — and writes the answer.
 */

/** Where the car lives, from EV_HOME_LAT/EV_HOME_LON/EV_HOME_RADIUS_KM. */
export interface HomeLocation {
  lat: number
  lon: number
  radiusKm: number
}

/**
 * A price in force, structurally the part of `EnergyRate` that pricing reads.
 *
 * Declared here rather than imported from `@ev/db` so this file, and the
 * pipeline that calls it, stay free of the repo layer — the same reason `Store`
 * describes persistence in the pipeline's own vocabulary. A real `EnergyRate`
 * satisfies it, so `store.ts` hands one over without a conversion.
 */
export interface EnergyPrice {
  pricePerKwh: number
  currency: string
  source: 'urdb' | 'manual'
}

/**
 * Why a charge is priced the way it is (spec §3.4).
 *
 * `home` carries the two inputs the price needs, so the caller does not have to
 * re-derive from the summary what classification already looked at — and, more
 * usefully, so `at` is visibly the session's own start rather than the wall
 * clock. That is what makes re-pricing a crash-recovered session produce the
 * same number the live worker would have.
 *
 * `tesla` is absent: nothing at close time can know what Tesla billed. A
 * session reaches that basis only through §3.5's reconciliation.
 */
export type ChargeClassification =
  | { basis: 'home'; energyKwh: number | null; at: Date | null }
  | { basis: 'pending' }
  | { basis: 'unknown' }

/** A price as it is written to `session`, whether or not there is a figure. */
export interface ChargeCost {
  cost: number | null
  costCurrency: string | null
  costRatePerKwh: number | null
  costBasis: 'home' | 'tesla' | 'pending' | 'unknown'
  costSource: 'urdb' | 'manual' | 'tesla-invoice' | 'backfill-estimate' | null
}

/**
 * The values of the proto's `FastCharger` enum that mean "Tesla will bill us".
 *
 * Two facts about the wire format decide the spelling. Enums arrive as their
 * `.String()` name and are stored untouched, so the value is
 * `FastChargerSupercharger` and never `Supercharger`; the unprefixed form
 * appears only in the web tier's fixtures, where it has never been checked
 * against a real message.
 *
 * The membership is a judgement over nine values, and getting it wrong is not
 * symmetric. Too narrow leaves a real Supercharger stop at `unknown`, which
 * §3.5 never revisits. Too wide leaves a home or third-party charge sitting at
 * `pending` for the full 45 days before the give-up flips it.
 *
 *  - `Supercharger` is unambiguous: Tesla's own network, Tesla's own invoice.
 *  - `Combo` is CCS. On a CCS-native Tesla that is what a Magic Dock stall and
 *    a Supercharger both report, so excluding it would lose the newer cars.
 *    An Electrify America stop also lands here and will pend for 45 days —
 *    accepted, because the alternative loses real invoices.
 *  - `ACSingleWireCAN` and `MCSingleWireCAN` are deliberately NOT here: a home
 *    Wall Connector reports them, and `home` only wins first when the location
 *    is known. A charge at an unlocatable Wall Connector must read `unknown`,
 *    not spend six weeks awaiting an invoice nobody will ever send.
 *  - `CHAdeMO`, `GB`, `Other`, `SNA` and `Unknown` are not Tesla's to bill.
 */
const TESLA_BILLED_CONNECTORS = new Set([
  'FastChargerSupercharger',
  'FastChargerCombo',
])

/**
 * Mean Earth radius in kilometres (IUGG), the value that makes a haversine
 * distance accurate to a few metres at any latitude.
 *
 * The choice is invisible at the scale this is used: over the ~100 m the home
 * radius spans, swapping it for the equatorial 6378.137 moves the answer by
 * about a tenth of a metre. It is named rather than inlined so the next reader
 * does not have to work that out before trusting the number.
 */
const EARTH_RADIUS_KM = 6371.0088

/**
 * Classify a closed charge (spec §3.4), in the order the questions actually
 * answer each other.
 *
 * Home first, because it is the only branch that yields a figure now and
 * because it is the stronger fact: energy from our own meter is not energy
 * Tesla can invoice, whatever connector the car saw. Then Tesla-billed, which
 * claims nothing except that asking later is worth the call. Then honest
 * ignorance, which the UI renders as ignorance rather than as free.
 */
export function classifyCharge(
  points: VehicleSample[], summary: SessionSummary, home: HomeLocation | null,
): ChargeClassification {
  if (isAtHome(points, summary, home)) {
    return { basis: 'home', energyKwh: summary.energyKwh, at: summary.startedAt }
  }
  if (isTeslaBilled(points)) return { basis: 'pending' }
  return { basis: 'unknown' }
}

/**
 * Turn a classification and the rate that covered it into the row.
 *
 * The five fields are null together whenever there is no figure, and the basis
 * survives alone — that asymmetry is what §3.7 renders. A `home` charge with no
 * energy reading and a `home` charge with no covering rate are both unpriced
 * and both still `home`: we know where the electrons came from, we just have no
 * number, and demoting either to `unknown` would throw away the one thing we do
 * know.
 */
export function priceCharge(
  c: ChargeClassification, rate: EnergyPrice | null,
): ChargeCost {
  const unpriced: ChargeCost = {
    cost: null, costCurrency: null, costRatePerKwh: null,
    costBasis: c.basis, costSource: null,
  }
  if (c.basis !== 'home' || rate === null || c.energyKwh === null) return unpriced
  return {
    // Rounded here rather than left to NUMERIC(10,2), so the number we store is
    // the number we computed. Otherwise the charge page's `41.2 kWh × $0.11256`
    // and the total beside it would disagree in the last cent with no way for a
    // reader to tell which one lied.
    cost: Math.round(c.energyKwh * rate.pricePerKwh * 100) / 100,
    costCurrency: rate.currency,
    // The rate is copied onto the session on purpose: this is a fact about the
    // charge, not about today's tariff, so history never re-prices when PSE
    // raises its rate.
    costRatePerKwh: rate.pricePerKwh,
    costBasis: 'home',
    costSource: rate.source,
  }
}

/**
 * The car's own answer first, the map only as a fallback.
 *
 * `locatedAtHome` is tier `static`, pushed roughly hourly, so it is null across
 * the opening of a charge that began between pushes — hence `some`, over the
 * whole session, rather than reading the first sample. An explicit `false`
 * anywhere does not veto: the value is a level carried forward, and a stale
 * `false` from the drive home would otherwise beat a fresh `true`.
 *
 * The coordinate fallback exists because the signal predates nothing — old
 * sessions were recorded before the field was catalogued, and §5's backfill
 * has only coordinates to work from. With neither, we cannot say, and saying so
 * is the correct answer.
 */
function isAtHome(
  points: VehicleSample[], summary: SessionSummary, home: HomeLocation | null,
): boolean {
  if (points.some((p) => p.locatedAtHome === true)) return true
  if (home === null || summary.startLat === null || summary.startLon === null) return false
  return distanceKm(summary.startLat, summary.startLon, home.lat, home.lon) <= home.radiusKm
}

/**
 * Might Tesla have billed this?
 *
 * Presence is the fact about now and is required; the type is corroboration
 * that may never arrive. `FastChargerPresent` is tier `charge` at 60s while
 * `FastChargerType` is tier `static` at 3600s, so a twenty-minute Supercharger
 * stop can carry the flag on twenty samples and the type on none. A null type
 * therefore has to qualify, or the sessions that cost the most would sit at
 * `unknown` and §3.5 would never look for their invoices.
 *
 * When a type IS reported, every reported value must be one Tesla bills for —
 * `every`, not `some`. A session shows one connector; two distinct values means
 * the accumulator is still carrying the last stop's, and guessing which is
 * current is worse than declining to guess.
 */
function isTeslaBilled(points: VehicleSample[]): boolean {
  if (!points.some((p) => p.fastChargerPresent === true)) return false
  const types = new Set(
    points.map((p) => p.fastChargerType).filter((x): x is string => x !== null))
  return [...types].every((x) => TESLA_BILLED_CONNECTORS.has(x))
}

/** Great-circle distance in kilometres. */
function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = (d: number): number => (d * Math.PI) / 180
  const dLat = rad(bLat - aLat)
  const dLon = rad(bLon - aLon)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}
