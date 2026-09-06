import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TESLA_FIELDS, TIER_INTERVAL_SECONDS, WITHHELD_FIELDS } from '../src/catalogue.js'
import { TELEMETRY_HOSTNAME, TELEMETRY_PORT } from '../src/telemetry-config.js'

/**
 * The third drift test (spec §5): what we ASK THE CAR FOR equals what we
 * catalogue.
 *
 * The other two — the migration and the insert — are in packages/db, and
 * together the three close the loop that this design exists to close. A field
 * asked for and not stored is a signal we are billed for and discard; a column
 * stored and never asked for is a column that stays null forever. Both are
 * silent at runtime, because the car ignores a config entry whose name it does
 * not know and the normaliser ignores a field it cannot place.
 *
 * The push script itself is NOT run here. It mints a token, starts a pod and
 * POSTs a configuration to a real vehicle; only the field list it would build
 * is under test, which is exactly why that list was moved out into a script of
 * its own that does nothing but print JSON.
 */

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const emitterPath = path.join(repoRoot, 'scripts', 'telemetry-fields.mjs')
const pushScript = readFileSync(
  path.join(repoRoot, 'scripts', 'push-telemetry-config.sh'), 'utf8')

/** One `interval_seconds`/`minimum_delta` pair, as the Tesla API takes it. */
interface EmittedField {
  readonly interval_seconds?: unknown
  readonly minimum_delta?: unknown
}

/**
 * What the push script would send, obtained by running the emitter it runs.
 *
 * Read once, at the first test that needs it, so that a stale `dist` fails the
 * drift tests with a message that says so rather than failing the whole file
 * before the shell-script checks below get to run.
 */
let cached: Record<string, EmittedField> | undefined
const emitted = (): Record<string, EmittedField> => {
  if (cached) return cached
  let out: string
  try {
    out = execFileSync(process.execPath, [emitterPath], { encoding: 'utf8' })
  } catch (err) {
    throw new Error(
      `could not run ${emitterPath}: if it failed to import the catalogue, run ` +
      `\`pnpm --filter @ev/tesla build\` - it reads dist, because the shell has ` +
      `no TypeScript.\n${String(err)}`)
  }
  const parsed = JSON.parse(out) as {
    hostname: string; port: number; fields: Record<string, EmittedField>
  }
  cachedEnvelope = { hostname: parsed.hostname, port: parsed.port }
  return (cached = parsed.fields)
}

/**
 * The shim prints the collector's hostname and port alongside the fields, and
 * the shell script reads them from there rather than declaring its own.
 *
 * That is the drift this whole module exists to close, and it was open in
 * exactly this dimension: the constants lived in telemetry-config.ts for the
 * web app AND in the shell script for the operator, so changing the collector
 * would have had the two pushers sending different configurations, with every
 * later check reporting a hostname difference nobody could account for.
 */
let cachedEnvelope: { hostname: string; port: number } | undefined
const envelope = (): { hostname: string; port: number } => {
  emitted()
  return cachedEnvelope!
}

describe('the collector the push script sends the car to', () => {
  it('comes from the catalogue module, not from the shell script', () => {
    expect(envelope()).toEqual({ hostname: TELEMETRY_HOSTNAME, port: TELEMETRY_PORT })
  })

  it('is not also declared in the shell script, where it could drift', () => {
    // A LITERAL assignment is the drift; reading it back out of the emitted
    // JSON is the fix, and both lines start with the same token.
    expect(pushScript).not.toMatch(/^HOSTNAME_=[\w.-]+$/m)
    expect(pushScript).not.toMatch(/^PORT=\d+$/m)
    // Read from the emitted JSON instead.
    expect(pushScript).toMatch(/HOSTNAME_=\$\(python3 .*\["hostname"\]/)
    expect(pushScript).toMatch(/PORT=\$\(python3 .*\["port"\]/)
  })
})

/**
 * The shim and the web app are ONE producer, so the script stops asking for a
 * withheld field at the same moment the app does - that is the property worth
 * pinning here, not the catalogue count. `PUSHED` is the catalogue minus the
 * names the Fleet API refuses today; see `WITHHELD_FIELDS`.
 */
const PUSHED = TESLA_FIELDS.filter((e) => !WITHHELD_FIELDS.fields.includes(e.field))

describe('the field list the push script emits', () => {
  it('is exactly the pushable catalogue, in catalogue order', () => {
    expect(Object.keys(emitted())).toEqual(PUSHED.map((e) => e.field))
  })

  it('emits none of the fields the Fleet API refuses', () => {
    const emittedNames = new Set(Object.keys(emitted()))
    expect(WITHHELD_FIELDS.fields.filter((f) => emittedNames.has(f))).toEqual([])
  })

  // The tier is the whole point of tiering: a field silently pushed at the
  // wrong interval is either a cost we did not model (§3.5's budget) or a
  // resolution we think we have and do not.
  it('asks for each field at its tier interval', () => {
    for (const entry of PUSHED) {
      expect(`${entry.field}=${emitted()[entry.field]?.interval_seconds}`)
        .toBe(`${entry.field}=${TIER_INTERVAL_SECONDS[entry.tier]}`)
    }
  })

  // `minimum_delta` is what bounds the bill on a car that is awake all day
  // (§3.5), so an omitted one is a cost, and one on a field the catalogue left
  // null is suppression nobody decided on.
  it('sends minimum_delta exactly where the catalogue sets a delta', () => {
    for (const entry of PUSHED) {
      const has = 'minimum_delta' in (emitted()[entry.field] ?? {})
      expect(`${entry.field}=${has}`).toBe(`${entry.field}=${entry.delta !== null}`)
    }
  })

  it('sends the catalogue delta unchanged, in wire units', () => {
    for (const entry of PUSHED.filter((e) => e.delta !== null)) {
      expect(`${entry.field}=${emitted()[entry.field]?.minimum_delta}`)
        .toBe(`${entry.field}=${entry.delta}`)
    }
  })

  // Tesla accepts unknown keys by ignoring them, so a stray one would never be
  // reported; keep the emitted object to what the API actually reads.
  it('sends no key the Tesla API does not define', () => {
    for (const [field, cfg] of Object.entries(emitted())) {
      expect(`${field}: ${Object.keys(cfg).sort().join(',')}`).toMatch(
        /: (interval_seconds|interval_seconds,minimum_delta)$/)
    }
  })

  it('emits intervals as positive integers', () => {
    for (const [field, cfg] of Object.entries(emitted())) {
      expect(`${field}=${cfg.interval_seconds}`)
        .toBe(`${field}=${Math.trunc(Number(cfg.interval_seconds))}`)
      expect(Number(cfg.interval_seconds)).toBeGreaterThan(0)
    }
  })
})

describe('push-telemetry-config.sh', () => {
  /**
   * The reason the check above is a drift test and not a coincidence: if the
   * shell could still name a field itself, the catalogue and the pushed config
   * could disagree with every test above passing.
   */
  it('names no proto field of its own', () => {
    const named = TESLA_FIELDS.map((e) => e.field)
      .filter((f) => new RegExp(`\\b${f}\\b`).test(pushScript))
    expect(named).toEqual([])
  })

  it('builds the config it pushes out of the emitted list', () => {
    expect(pushScript).toMatch(/node "\$ROOT\/scripts\/telemetry-fields\.mjs" > "\$TMP\/fields\.json"/)
    expect(pushScript).toMatch(/"fields": fields,/)
  })

  // An empty `fields` map is accepted by Tesla and stops the car streaming
  // anything at all - indistinguishable, downstream, from a car that is asleep.
  it('refuses to push a configuration with no fields', () => {
    expect(pushScript).toMatch(/\[ "\$COUNT" -gt 0 \] \|\| fail/)
  })

  // Safety properties of the script that predate this change and must survive
  // it: it aborts on the first failure and on an unset variable, it never
  // guesses a VIN, and every command it depends on is checked BEFORE it mints a
  // token or starts a pod - a missing `node` discovered at step 5 would leave a
  // pod running and a token minted for nothing.
  it('keeps its shell safety flags', () => {
    expect(pushScript).toMatch(/^set -euo pipefail$/m)
  })

  it('checks for every command it runs, up front', () => {
    const checked = /^for bin in ([^;]*); do$/m.exec(pushScript)?.[1]?.split(/\s+/) ?? []
    expect(checked).toContain('node')
    expect(checked).toContain('python3')
    expect(checked).toContain('kubectl')
  })

  it('still refuses to guess between two vehicles', () => {
    expect(pushScript).toMatch(/more than one vehicle - pass the VIN as an argument/)
  })

  it('still pushes the private CA the car pins, and the typed-enum preference', () => {
    expect(pushScript).toMatch(/ev-telemetry-ca/)
    expect(pushScript).toMatch(/"prefer_typed": True/)
  })
})
