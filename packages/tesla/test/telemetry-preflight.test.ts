import { describe, expect, it } from 'vitest'
import {
  MIN_FIRMWARE,
  checkTelemetryPreconditions,
  firmwareAtLeast,
} from '../src/telemetry-preflight.js'

describe('firmwareAtLeast', () => {
  // The bug this exists to catch: "2024.9" > "2024.26" under a string compare.
  // If firmwareAtLeast ever regresses to lexical comparison, this is the case
  // that fails while every "obviously old" and "obviously new" case still passes.
  it('compares the week numerically, not lexically', () => {
    expect(firmwareAtLeast('2024.9.2')).toBe(false)
    expect(firmwareAtLeast('2024.26')).toBe(true)
  })

  it('is inclusive at the floor and rejects one week below it', () => {
    expect(firmwareAtLeast(`${MIN_FIRMWARE[0]}.${MIN_FIRMWARE[1]}`)).toBe(true)
    expect(firmwareAtLeast(`${MIN_FIRMWARE[0]}.${MIN_FIRMWARE[1] - 1}.9.9`)).toBe(false)
  })

  it('lets a later year pass on a week below the floor', () => {
    // 2025.2 is newer than 2024.26 despite the smaller week. A comparator that
    // checked the week first would wrongly reject every early-year build.
    expect(firmwareAtLeast('2025.2')).toBe(true)
  })

  it('rejects an earlier year even on a large week', () => {
    expect(firmwareAtLeast('2023.44.30')).toBe(false)
  })

  it('treats unparseable firmware as failing, never as passing', () => {
    for (const v of ['', 'unknown', '2024', 'v2024.26']) {
      expect(firmwareAtLeast(v)).toBe(false)
    }
  })
})

describe('checkTelemetryPreconditions', () => {
  const VIN = '5YJYGDEE0MF000000'
  const ok = { firmware_version: '2025.14.9' }

  it('passes a paired car on current firmware', () => {
    const r = checkTelemetryPreconditions(VIN, ok, true)
    expect(r).toEqual({ ok: true, blockers: [], warnings: [] })
  })

  it('blocks an unpaired key and names the domain trap in the pairing URL', () => {
    const r = checkTelemetryPreconditions(VIN, ok, false)
    expect(r.ok).toBe(false)
    expect(r.blockers.join(' ')).toMatch(/_ak\/<developer-domain>/)
    expect(r.blockers.join(' ')).toMatch(/DOMAIN/)
  })

  it('blocks firmware below the floor and reports the actual version', () => {
    const r = checkTelemetryPreconditions(VIN, { firmware_version: '2024.20.1' }, true)
    expect(r.ok).toBe(false)
    expect(r.blockers.join(' ')).toContain('2024.20.1')
  })

  it('blocks rather than assumes when the car is missing from vehicle_info', () => {
    const r = checkTelemetryPreconditions(VIN, undefined, true)
    expect(r.ok).toBe(false)
  })

  it('blocks rather than assumes when firmware_version is absent', () => {
    const r = checkTelemetryPreconditions(VIN, {}, true)
    expect(r.ok).toBe(false)
  })

  it('reports every blocker at once, not just the first', () => {
    // A preflight that stops at the first problem turns one round trip to the
    // car into several, each an hour apart if the car is asleep.
    const r = checkTelemetryPreconditions(VIN, { firmware_version: '2023.1' }, false)
    expect(r.blockers).toHaveLength(2)
  })

  it('warns but does not block on the Safety-screen toggle being off', () => {
    const r = checkTelemetryPreconditions(
      VIN, { ...ok, safety_screen_streaming_toggle_enabled: false }, true)
    expect(r.ok).toBe(true)
    expect(r.warnings).toHaveLength(1)
  })

  it('stays silent when the toggle is null or absent, which means not applicable', () => {
    expect(checkTelemetryPreconditions(
      VIN, { ...ok, safety_screen_streaming_toggle_enabled: null }, true).warnings).toEqual([])
    expect(checkTelemetryPreconditions(VIN, ok, true).warnings).toEqual([])
  })
})
