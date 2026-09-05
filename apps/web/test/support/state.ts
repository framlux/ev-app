import { SAMPLE_COLUMNS } from '@ev/core'
import type { VehicleState } from '../../src/lib/api-types.js'

/**
 * A `VehicleState` in which the car reported nothing but the timestamp — the
 * normal shape of a row on the day the columns were added.
 *
 * Built from the column catalogue rather than written out. There are two
 * hundred columns; a fixture listing them by hand would need editing every
 * time one is added, which turns a test fixture into the thing that decides
 * whether a column exists.
 */
export function nullState(overrides: Partial<VehicleState> = {}): VehicleState {
	const columns = Object.fromEntries(SAMPLE_COLUMNS.map((c) => [c.key, null]))
	return {
		...columns,
		vehicleId: 'v1',
		ts: '2026-09-04T00:00:00.000Z',
		...overrides
	} as VehicleState
}
