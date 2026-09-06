import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  API_FIELD_RULES, TESLA_FIELDS, TIER_INTERVAL_SECONDS, WITHHELD_NAMES,
} from '../src/catalogue.js'
import type { AppliedTelemetryConfig, TelemetryFields } from '../src/fleet-api.js'
import {
  TELEMETRY_HOSTNAME,
  TELEMETRY_PORT,
  buildTelemetryConfig,
  buildTelemetryFields,
  compareTelemetryConfig,
} from '../src/telemetry-config.js'

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const emitterPath = path.join(repoRoot, 'scripts', 'telemetry-fields.mjs')

const VIN = '5YJYGDEE0MF000000'

/**
 * The catalogue minus the names the Fleet API refuses today. Everything that
 * asserts over "what we push" iterates THIS, not `TESLA_FIELDS`: the two were
 * the same set until the API rejected `BrickSocMinPercent`, and the difference
 * between them is now a decision the catalogue records rather than an accident.
 */
const PUSHED = TESLA_FIELDS.filter((e) => !WITHHELD_NAMES.includes(e.field))

/** The captured `fleet_telemetry_config` response §3.6's rule is pinned against. */
const captured = JSON.parse(readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures',
    'fleet-telemetry-config.json'), 'utf8')) as {
      response: { synced: boolean; config: AppliedTelemetryConfig }
    }

/**
 * A throwaway PEM, taken from the fixture so the two halves of every comparison
 * are the same certificate. The builder only checks that a certificate is
 * THERE and the rule compares on presence, so nothing here verifies against
 * anything - what matters is that it is shaped like the thing that fails, a CA
 * mounted as an empty file or as a key.
 */
const CA = captured.response.config.ca

/** A deep copy, so a test that mutates the applied config cannot leak into the next. */
const applied = (): AppliedTelemetryConfig =>
  JSON.parse(JSON.stringify(captured.response.config)) as AppliedTelemetryConfig

/**
 * What the fixture's car was asked for: the same five keys, and nothing Tesla
 * added. Built by hand rather than from `applied()` so that "identical matches"
 * is a comparison of two independently written objects, not of one with itself.
 */
const desired = (): AppliedTelemetryConfig => ({
  hostname: TELEMETRY_HOSTNAME,
  port: TELEMETRY_PORT,
  ca: CA,
  prefer_typed: true,
  fields: {
    DriveRail: { interval_seconds: 3600 },
    ChargeState: { interval_seconds: 60 },
    VehicleSpeed: { interval_seconds: 10, minimum_delta: 1 },
    Odometer: { interval_seconds: 60 },
    Soc: { interval_seconds: 60, minimum_delta: 0.5 },
    Location: { interval_seconds: 10, minimum_delta: 10 },
    InsideTemp: { interval_seconds: 300, minimum_delta: 0.5 },
  },
})

describe('buildTelemetryConfig', () => {
  /**
   * The whole reason this module exists (spec §2): two producers of the same
   * JSON is the drift the catalogue was created to prevent, and the break-glass
   * script is the producer we cannot delete. If the shim ever stops sourcing
   * the builder, this is the test that says so.
   */
  it('produces exactly what the shell script\'s shim prints', () => {
    let out: string
    try {
      out = execFileSync(process.execPath, [emitterPath], { encoding: 'utf8' })
    } catch (err) {
      throw new Error(
        `could not run ${emitterPath}: it reads dist, because the shell has no ` +
        `TypeScript - run \`pnpm --filter @ev/tesla build\`.\n${String(err)}`)
    }
    // The shim prints the catalogue's half of the envelope — the fields, and
    // the collector both pushers must agree on. The script's python assembles
    // the rest (vin, ca, prefer_typed) around it.
    const config = buildTelemetryConfig({ vin: VIN, ca: CA }).config
    expect(JSON.parse(out)).toEqual({
      hostname: config.hostname,
      port: config.port,
      fields: config.fields
    })
  })

  it('wraps the config in the vins the push body takes', () => {
    expect(buildTelemetryConfig({ vin: VIN, ca: CA }).vins).toEqual([VIN])
  })

  // hostname and port are constants HERE, not arguments: a value both callers
  // must agree on is exactly what a shared module is for.
  it('takes the collector endpoint from constants, not from its caller', () => {
    const cfg = buildTelemetryConfig({ vin: VIN, ca: CA }).config
    expect([cfg.hostname, cfg.port]).toEqual(['ev-telemetry.framlux.io', 443])
  })

  // Typed enums rather than raw ints; the normaliser's fixtures assume it.
  it('asks for typed enums', () => {
    expect(buildTelemetryConfig({ vin: VIN, ca: CA }).config.prefer_typed).toBe(true)
  })

  it('carries the CA through byte for byte', () => {
    expect(buildTelemetryConfig({ vin: VIN, ca: CA }).config.ca).toBe(CA)
  })

  it('asks for every pushable catalogued field at its tier interval, in catalogue order', () => {
    const fields = buildTelemetryConfig({ vin: VIN, ca: CA }).config.fields
    expect(Object.keys(fields)).toEqual(PUSHED.map((e) => e.field))
    for (const entry of PUSHED) {
      expect(`${entry.field}=${fields[entry.field]?.interval_seconds}`)
        .toBe(`${entry.field}=${TIER_INTERVAL_SECONDS[entry.tier]}`)
    }
  })

  it('sends minimum_delta exactly where the catalogue sets a delta', () => {
    const fields = buildTelemetryConfig({ vin: VIN, ca: CA }).config.fields
    for (const entry of PUSHED) {
      expect(`${entry.field}=${fields[entry.field]?.minimum_delta}`)
        .toBe(`${entry.field}=${entry.delta ?? undefined}`)
      expect(`${entry.field}=${'minimum_delta' in (fields[entry.field] ?? {})}`)
        .toBe(`${entry.field}=${entry.delta !== null}`)
    }
  })
})

describe('the two guards the builder took over from the script', () => {
  /**
   * The highest-consequence failure in the flow. Tesla ACCEPTS a config with no
   * fields, reports success, and the car stops streaming everything - which
   * downstream is indistinguishable from a car that is asleep. The script has
   * `[ "$COUNT" -gt 0 ] || fail`; both callers need it, so it lives here.
   */
  it('refuses an empty field set rather than silently ending ingestion', () => {
    expect(() => buildTelemetryConfig({ vin: VIN, ca: CA, catalogue: [] }))
      .toThrow(/no fields/i)
    expect(() => buildTelemetryFields([])).toThrow(/no fields/i)
  })

  /**
   * The script greps for BEGIN CERTIFICATE. A mis-projected or empty CA yields
   * a config the car accepts and then fails every connection against, which
   * again looks exactly like a car that never wakes.
   */
  it('refuses a CA that is not a certificate', () => {
    for (const bad of ['', '   ', '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----']) {
      expect(() => buildTelemetryConfig({ vin: VIN, ca: bad })).toThrow(/BEGIN CERTIFICATE/)
    }
  })
})

/**
 * Spec §3.6. Both ways of getting this wrong are silent: too strict and the
 * page re-pushes forever over a reformatted PEM, too loose and it reports
 * "already applied" over a configuration the car never got.
 */
describe('compareTelemetryConfig', () => {
  it('matches a config the car echoed back unchanged', () => {
    expect(compareTelemetryConfig(applied(), desired()).matches).toBe(true)
  })

  it('ignores everything else Tesla echoes', () => {
    const a = applied() as AppliedTelemetryConfig & Record<string, unknown>
    a['alert_types'] = ['service', 'something_new']
    a['exp'] = 0
    expect(compareTelemetryConfig(a, desired()).matches).toBe(true)
  })

  it('does not match when an interval changed', () => {
    const a = applied()
    a.fields['VehicleSpeed'] = { interval_seconds: 30, minimum_delta: 1 }
    const result = compareTelemetryConfig(a, desired())
    expect(result.matches).toBe(false)
    expect(result.differences.join('\n')).toMatch(/VehicleSpeed/)
  })

  it('does not match when a delta changed', () => {
    const a = applied()
    a.fields['Soc'] = { interval_seconds: 60, minimum_delta: 5 }
    expect(compareTelemetryConfig(a, desired()).matches).toBe(false)
  })

  // The catalogue is what changes in practice: a field added to it has to reach
  // the car, and "already applied" over a missing signal costs it silently.
  it('does not match when the field set differs', () => {
    const missing = applied()
    delete missing.fields['InsideTemp']
    expect(compareTelemetryConfig(missing, desired()).matches).toBe(false)

    const extra = applied()
    extra.fields['DetailedChargeState'] = { interval_seconds: 60 }
    expect(compareTelemetryConfig(extra, desired()).matches).toBe(false)
  })

  /**
   * The PEM survives a round trip through Tesla and back; trailing newlines and
   * line endings are not ours to control, and a mismatch on them would mean a
   * push on every check forever.
   */
  it('matches a ca that differs only in whitespace', () => {
    const a = applied()
    a.ca = `\n${a.ca.trimEnd().replace(/\n/g, '\r\n')}\n\n`
    expect(compareTelemetryConfig(a, desired()).matches).toBe(true)
  })

  // Presence only, but presence is still checked: a config the car applied with
  // no certificate in it fails every connection and MUST be re-pushed.
  it('does not match when the applied ca is absent or is not a certificate', () => {
    for (const bad of ['', 'null']) {
      const a = applied()
      a.ca = bad
      expect(compareTelemetryConfig(a, desired()).matches).toBe(false)
    }
  })

  /**
   * Tesla omits `minimum_delta` where it is the default rather than echoing a
   * zero - and the catalogue leaves it unset on 100-odd fields. Treating absent
   * and 0 as different would mean the config never matched itself.
   */
  it('treats an omitted defaulted minimum_delta as no difference', () => {
    const a = applied()
    // What the car sends back for a field the catalogue set no delta on...
    expect(a.fields['Odometer']).toEqual({ interval_seconds: 60 })
    expect(compareTelemetryConfig(a, desired()).matches).toBe(true)
    // ...and the same field with the default spelled out explicitly.
    a.fields['Odometer'] = { interval_seconds: 60, minimum_delta: 0 }
    expect(compareTelemetryConfig(a, desired()).matches).toBe(true)
  })

  it('does not match the hostname or port moving', () => {
    const host = applied()
    host.hostname = 'ev-telemetry.example.com'
    expect(compareTelemetryConfig(host, desired()).matches).toBe(false)

    const port = applied()
    port.port = 8443
    expect(compareTelemetryConfig(port, desired()).matches).toBe(false)
  })

  // Until the first push is applied the car has no config at all, and Tesla
  // omits the key. That is a difference, not a crash.
  it('reports no match when the car has no applied config', () => {
    const result = compareTelemetryConfig(undefined, desired())
    expect(result.matches).toBe(false)
    expect(result.differences).not.toEqual([])
  })

  /**
   * The comparison and the builder have to agree for the REAL catalogue, not
   * only for the fixture's seven fields: a rule that matched a trimmed config
   * and not a 204-field one would report a needed push on every check.
   */
  it('matches the full catalogue against an echo of itself', () => {
    const config = buildTelemetryConfig({ vin: VIN, ca: CA }).config
    const echoed = JSON.parse(JSON.stringify(config)) as AppliedTelemetryConfig
    echoed.ca = `${echoed.ca}\n`
    expect(compareTelemetryConfig(echoed, config).matches).toBe(true)
  })
})

describe('buildTelemetryFields', () => {
  // The script's python still assembles the envelope around what the shim
  // prints, which is what keeps push-config's text assertions untouched.
  it('is the field-map half of the builder, on its own', () => {
    const fields: TelemetryFields = buildTelemetryFields()
    expect(fields).toEqual(buildTelemetryConfig({ vin: VIN, ca: CA }).config.fields)
  })
})

/**
 * The 400 that started this: `Unknown field BrickSocMinPercent`, and with it no
 * configuration on the car at all. One name the Fleet API does not know fails
 * the WHOLE push, so this is not "one signal missing" — it is every signal.
 */
describe('fields the Fleet API does not accept yet', () => {
  it('asks for none of the 1.3.0 block', () => {
    const asked = Object.keys(buildTelemetryFields())
    expect(asked.filter((f) => WITHHELD_NAMES.includes(f))).toEqual([])
  })

  it('asks for nothing named BrickSocMinPercent', () => {
    expect(buildTelemetryFields()).not.toHaveProperty('BrickSocMinPercent')
  })

  it('still asks for everything else the catalogue captures', () => {
    const withheld = new Set<string>(WITHHELD_NAMES)
    expect(Object.keys(buildTelemetryFields()).sort())
      .toEqual(TESLA_FIELDS.map((e) => e.field).filter((f) => !withheld.has(f)).sort())
  })
})

/**
 * The SECOND 400, and the reason the rules below are data rather than a fix:
 * `SelfDrivingMilesSinceReset requires minimum delta be explicitly set and >= 1`.
 * The proto could not have told us this. Only Tesla's field reference does.
 */
describe('the API rules the proto does not carry', () => {
  it('asks for SelfDrivingMilesSinceReset with a delta the API accepts', () => {
    const rule = API_FIELD_RULES.find((r) => r.field === 'SelfDrivingMilesSinceReset')!
    const asked = buildTelemetryFields()['SelfDrivingMilesSinceReset']
    expect(asked?.minimum_delta).toBeGreaterThanOrEqual(rule.minimumDelta)
  })

  it('satisfies every MANDATORY delta rule, not just the one that bit us', () => {
    const fields = buildTelemetryFields()
    for (const rule of API_FIELD_RULES) {
      if (rule.minimumDelta === 0) continue // recorded as read, not enforced
      const asked = fields[rule.field]
      if (!asked) continue // withheld or uncatalogued: not asked for, not a violation
      const delta = asked.minimum_delta ?? 0
      expect(`${rule.field}=${delta >= rule.minimumDelta}`).toBe(`${rule.field}=true`)
    }
  })

  /**
   * A rule recorded with `minimumDelta: 0` is a note about what was READ, not a
   * constraint - the difference between "the doc does not require one" and "the
   * doc was never checked". It must never fail a build on its own.
   */
  it('never rejects a config over a rule that only recommends a delta', () => {
    const recommended = API_FIELD_RULES.filter((r) => r.minimumDelta === 0)
    expect(recommended.length).toBeGreaterThan(0)
    const stripped = TESLA_FIELDS.map((e) =>
      recommended.some((r) => r.field === e.field) ? { ...e, delta: null } : e)
    expect(() => buildTelemetryFields(stripped)).not.toThrow()
  })

  it('cites a source for every rule, so a moved doc can be re-checked', () => {
    for (const rule of API_FIELD_RULES) {
      expect(rule.source.length, rule.field).toBeGreaterThan(20)
    }
  })

  // The guard, not the fix: a catalogue that violates a rule must fail HERE,
  // where a test sees it, rather than as a 400 from a car.
  it('refuses to build a config that a rule says the API will reject', () => {
    const broken = TESLA_FIELDS.map((e) =>
      e.field === 'SelfDrivingMilesSinceReset' ? { ...e, delta: null } : e)
    expect(() => buildTelemetryFields(broken))
      .toThrow(/SelfDrivingMilesSinceReset/)
  })

  it('refuses a delta below the documented minimum, not merely a missing one', () => {
    const broken = TESLA_FIELDS.map((e) =>
      e.field === 'SelfDrivingMilesSinceReset' ? { ...e, delta: 0.5 } : e)
    expect(() => buildTelemetryFields(broken)).toThrow(/SelfDrivingMilesSinceReset/)
  })
})
