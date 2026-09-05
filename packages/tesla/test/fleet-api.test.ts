import { expect, it } from 'vitest'
import * as fleet from '../src/fleet-api.js'

/**
 * This pin does two jobs, and the second one got heavier when the OAuth scopes
 * were widened to include `vehicle_cmds` and `vehicle_charging_cmds`.
 *
 * 1. No vehicle-data helper: polling `/vehicle_data` is metered per request and
 *    wakes a sleeping car. Telemetry streams the same information for free, so
 *    a convenience helper here is a standing invitation to run up a bill.
 *
 * 2. No command helper: the refresh token can now command the vehicle. That was
 *    a deliberate choice - it means adding commands later needs no reconsent -
 *    but it removes the credential as a safety boundary. Nothing outside this
 *    file stops the app from unlocking the car; this list does.
 *
 * Adding either is fine, once it is a decision. Breaking this test first is
 * what makes it one.
 */
it('exposes no vehicle-data or command helper, so neither happens by accident', () => {
  expect(Object.keys(fleet).sort()).toEqual(
    ['fleetStatus', 'getTelemetryConfig', 'listVehicles'])
})
