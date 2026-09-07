import { describe, expect, it } from 'vitest'
import { makeSample, type SessionSummary, type VehicleSample } from '@ev/core'
import {
  classifyCharge,
  priceCharge,
  type EnergyPrice,
  type HomeLocation,
} from '../src/pricing.js'

/** The driveway. Seattle, so the longitude is negative — see config.test.ts. */
const HOME: HomeLocation = { lat: 47.6062, lon: -122.3321, radiusKm: 0.1 }

const t = (iso: string) => new Date(iso)

function sample(at: string, over: Partial<VehicleSample> = {}): VehicleSample {
  return makeSample({ vehicleId: 'veh-1', ts: t(at), ...over })
}

/**
 * Only the four fields classification and pricing read. The rest of a summary
 * is spelled out as null rather than cast, so a field added to SessionSummary
 * shows up here as a compile error rather than as `undefined` at runtime.
 */
function summaryOf(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    startedAt: t('2026-09-04T20:00:00.000Z'),
    endedAt: t('2026-09-04T21:00:00.000Z'),
    distanceKm: null, energyKwh: 10, efficiencyWhPerKm: null,
    avgSpeedKph: null, maxChargePowerKw: null,
    startSocPct: null, endSocPct: null,
    startOdometerKm: null, endOdometerKm: null,
    startLat: null, startLon: null, endLat: null, endLon: null,
    ...over,
  }
}

const URDB: EnergyPrice = { pricePerKwh: 0.11256, currency: 'USD', source: 'urdb' }

describe('classifyCharge: home', () => {
  it('is home when any one sample says so, however many say nothing', () => {
    // LocatedAtHome is catalogued at tier `static` — an hour between pushes —
    // so a charge that starts before the first one arrives has the signal null
    // across its opening samples and true thereafter. Requiring it on every
    // sample, or reading only the first, would call the driveway unknown.
    const points = [
      sample('2026-09-04T20:00:00.000Z'),
      sample('2026-09-04T20:30:00.000Z', { locatedAtHome: true }),
      sample('2026-09-04T21:00:00.000Z'),
    ]
    expect(classifyCharge(points, summaryOf(), HOME).basis).toBe('home')
  })

  it('is not home when the car says it is somewhere else', () => {
    const points = [sample('2026-09-04T20:00:00.000Z', { locatedAtHome: false })]
    expect(classifyCharge(points, summaryOf(), HOME).basis).toBe('unknown')
  })

  it('falls back to the start coordinate when the signal never arrives', () => {
    // ~50 m north of the configured point: the same driveway as far as a
    // 100 m radius is concerned.
    const summary = summaryOf({ startLat: 47.60665, startLon: -122.3321 })
    expect(classifyCharge([sample('2026-09-04T20:00:00.000Z')], summary, HOME).basis)
      .toBe('home')
  })

  it('does not stretch the radius to the far side of the neighbourhood', () => {
    // ~1.1 km away. Sitting a whole kilometre from the house is the shape of a
    // public charger, and pricing it at the domestic rate would be a quiet lie
    // in the owner's favour.
    const summary = summaryOf({ startLat: 47.6162, startLon: -122.3321 })
    expect(classifyCharge([sample('2026-09-04T20:00:00.000Z')], summary, HOME).basis)
      .toBe('unknown')
  })

  it('cannot place a charge at home with no signal and no configured home', () => {
    // EV_HOME_LAT/LON absent disables the fallback entirely (spec §3.8). The
    // answer is "we cannot say", never 0,0 — which is a real point in the Gulf
    // of Guinea and would make every charge on earth non-home by a wide margin.
    const summary = summaryOf({ startLat: 47.6062, startLon: -122.3321 })
    expect(classifyCharge([sample('2026-09-04T20:00:00.000Z')], summary, null).basis)
      .toBe('unknown')
  })

  it('carries the energy and the start time the price needs', () => {
    const summary = summaryOf({ energyKwh: 41.2 })
    const c = classifyCharge(
      [sample('2026-09-04T20:00:00.000Z', { locatedAtHome: true })], summary, HOME)
    // The rate is looked up at the session's OWN start, not at now, which is
    // what makes re-pricing a recovered session produce the same figure.
    expect(c).toEqual({
      basis: 'home', energyKwh: 41.2, at: t('2026-09-04T20:00:00.000Z'),
    })
  })
})

describe('classifyCharge: awaiting a Tesla invoice', () => {
  it('is pending on the presence flag alone, with no type ever reported', () => {
    // FastChargerPresent is tier `charge` (60s) and FastChargerType is tier
    // `static` (3600s), so a twenty-minute Supercharger stop routinely carries
    // the flag on every sample and the type on none. Requiring both would
    // leave the sessions that cost the most sitting at `unknown`, and §3.5's
    // reconciliation would never see them.
    const points = [
      sample('2026-09-04T20:00:00.000Z', { fastChargerPresent: true }),
      sample('2026-09-04T20:20:00.000Z', { fastChargerPresent: true }),
    ]
    expect(classifyCharge(points, summaryOf(), HOME).basis).toBe('pending')
  })

  it('reads the enum with its proto prefix intact', () => {
    // Enums arrive on MQTT as their `.String()` name and are stored untouched,
    // so the column holds 'FastChargerSupercharger'. The unprefixed spelling
    // appears in the web tier's fixtures and is not a value the car ever sends;
    // matching it and not the real one would classify nothing.
    const at = (type: string): string => classifyCharge([
      sample('2026-09-04T20:00:00.000Z', { fastChargerPresent: true, fastChargerType: type }),
    ], summaryOf(), HOME).basis

    expect(at('FastChargerSupercharger')).toBe('pending')
    expect(at('Supercharger')).toBe('unknown')
  })

  it.each([
    ['FastChargerSupercharger', 'pending'],
    ['FastChargerCombo', 'pending'],
    ['FastChargerCHAdeMO', 'unknown'],
    ['FastChargerGB', 'unknown'],
    ['FastChargerACSingleWireCAN', 'unknown'],
    ['FastChargerMCSingleWireCAN', 'unknown'],
    ['FastChargerOther', 'unknown'],
    ['FastChargerUnknown', 'unknown'],
    ['FastChargerSNA', 'unknown'],
  ])('%s classifies as %s', (type, basis) => {
    // Every member of the proto's FastCharger enum, so a member that changes
    // sides is a deliberate edit rather than a silent one. The two that count
    // as Tesla-billed are the two Tesla bills for.
    const points = [
      sample('2026-09-04T20:00:00.000Z', { fastChargerPresent: true, fastChargerType: type }),
    ]
    expect(classifyCharge(points, summaryOf(), HOME).basis).toBe(basis)
  })

  it('does not treat a type seen without the presence flag as fast charging', () => {
    // The type is a level carried forward for an hour, so the last DC stop's
    // value can still be in the accumulator when the car plugs in at home.
    // Presence is the fact about now.
    const points = [
      sample('2026-09-04T20:00:00.000Z', { fastChargerType: 'FastChargerSupercharger' }),
    ]
    expect(classifyCharge(points, summaryOf(), HOME).basis).toBe('unknown')
  })

  it('prefers home over pending when the car is in the driveway', () => {
    // A Wall Connector can report a fast-charger type of its own, and home is
    // the stronger fact: we know what that energy cost, so there is nothing for
    // Tesla to invoice.
    const points = [
      sample('2026-09-04T20:00:00.000Z', {
        locatedAtHome: true, fastChargerPresent: true, fastChargerType: null,
      }),
    ]
    expect(classifyCharge(points, summaryOf(), HOME).basis).toBe('home')
  })

  it('is unknown when nothing identifies the charger at all', () => {
    // A destination charger, or a friend's garage. Honest ignorance, and
    // §3.7's UI says so rather than rendering a blank that reads as free.
    expect(classifyCharge([sample('2026-09-04T20:00:00.000Z')], summaryOf(), HOME).basis)
      .toBe('unknown')
  })
})

describe('priceCharge', () => {
  it('multiplies energy by the rate and rounds to cents', () => {
    // 41.2 × 0.11256 = 4.637472. Storing the unrounded product would put a
    // figure in a NUMERIC(10,2) column that the database rounds anyway, so the
    // stored cost and the arithmetic the charge page prints would disagree.
    const c = classifyCharge(
      [sample('2026-09-04T20:00:00.000Z', { locatedAtHome: true })],
      summaryOf({ energyKwh: 41.2 }), HOME)
    expect(priceCharge(c, URDB)).toEqual({
      cost: 4.64,
      costCurrency: 'USD',
      costRatePerKwh: 0.11256,
      costBasis: 'home',
      costSource: 'urdb',
    })
  })

  it('keeps the home basis when the energy was never measured', () => {
    // We know exactly why this is unpriced — no counter reading — and the UI
    // needs the basis to say so. Dropping to `unknown` would claim we could not
    // tell where the car was, which is not what happened.
    const c = classifyCharge(
      [sample('2026-09-04T20:00:00.000Z', { locatedAtHome: true })],
      summaryOf({ energyKwh: null }), HOME)
    expect(priceCharge(c, URDB)).toEqual({
      cost: null, costCurrency: null, costRatePerKwh: null,
      costBasis: 'home', costSource: null,
    })
  })

  it('keeps the home basis when no rate covers the date', () => {
    // A charge older than the first row in `energy_rate`. Reaching for the
    // oldest rate instead would invent history and label it a measurement;
    // §5's backfill does that on purpose and marks it as an estimate.
    const c = classifyCharge(
      [sample('2026-09-04T20:00:00.000Z', { locatedAtHome: true })], summaryOf(), HOME)
    expect(priceCharge(c, null)).toEqual({
      cost: null, costCurrency: null, costRatePerKwh: null,
      costBasis: 'home', costSource: null,
    })
  })

  it.each(['pending', 'unknown'] as const)('leaves a %s charge with no figure', (basis) => {
    // The invariant the read API enforces: no currency, no source and no rate
    // without an amount. Only the basis survives.
    expect(priceCharge({ basis }, URDB)).toEqual({
      cost: null, costCurrency: null, costRatePerKwh: null,
      costBasis: basis, costSource: null,
    })
  })

  it('prices at whatever the manual override said', () => {
    // A manual row is a row like any other by the time it gets here; the only
    // trace is `cost_source`, which is what tells a later reader the number
    // came from a person rather than from URDB.
    const c = classifyCharge(
      [sample('2026-09-04T20:00:00.000Z', { locatedAtHome: true })],
      summaryOf({ energyKwh: 20 }), HOME)
    expect(priceCharge(c, { pricePerKwh: 0.199, currency: 'USD', source: 'manual' }))
      .toMatchObject({ cost: 3.98, costSource: 'manual', costRatePerKwh: 0.199 })
  })
})
