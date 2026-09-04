import { expect, it } from 'vitest'
import * as fleet from '../src/fleet-api.js'

it('exposes no vehicle-data helper, because polling it is metered', () => {
  expect(Object.keys(fleet).sort()).toEqual(
    ['fleetStatus', 'getTelemetryConfig', 'listVehicles'])
})
