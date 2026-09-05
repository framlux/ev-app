import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { SAMPLE_COLUMNS } from '@ev/core'
import { LIVE_STATE_FIELDS } from '../src/lib/api-types.js'

/**
 * The projection is the whole reason the live stream survived `VehicleState`
 * growing from 17 columns to two hundred (spec §3.8).
 *
 * The stream serialises one state object per notification AND one per vehicle
 * in every snapshot, on every open tab. Sending the full row would make an idle
 * tab receive a few kilobytes every couple of seconds to render a dozen numbers
 * — and nothing about that failure is visible in a test that only checks the
 * numbers are right. So it is pinned here: the constant is smaller than the
 * full state, it carries what the live pages read, and it carries nothing the
 * database does not have a column for.
 */

/** Every property a `VehicleState` has, derived the same way the type is. */
const STATE_KEYS = new Set<string>(['vehicleId', 'ts', ...SAMPLE_COLUMNS.map((c) => c.key)])

const src = (path: string): string =>
	readFileSync(new URL(`../src/${path}`, import.meta.url).pathname, 'utf8')

describe('LIVE_STATE_FIELDS', () => {
	it('names only fields a VehicleState actually has', () => {
		expect(LIVE_STATE_FIELDS.filter((f) => !STATE_KEYS.has(f))).toEqual([])
	})

	it('names each field once', () => {
		expect(new Set(LIVE_STATE_FIELDS).size).toBe(LIVE_STATE_FIELDS.length)
	})

	it('is strictly smaller than the full state, which is the point of it', () => {
		expect(LIVE_STATE_FIELDS.length).toBeLessThan(STATE_KEYS.size)
		// Not a token saving: a projection that dropped a handful of columns
		// would still ship a multi-kilobyte frame per notification.
		expect(LIVE_STATE_FIELDS.length * 4).toBeLessThan(STATE_KEYS.size)
	})

	it('carries the identity and timestamp every consumer keys on', () => {
		// The client store dedupes by vehicle id and drops frames older than what
		// it holds; without these two it can do neither.
		expect(LIVE_STATE_FIELDS).toContain('vehicleId')
		expect(LIVE_STATE_FIELDS).toContain('ts')
	})

	it('carries what the activity pill is derived from', () => {
		// deriveActivity reads these on the server, but the pill is re-rendered
		// from a streamed entry and the fields have to survive the trip.
		expect(LIVE_STATE_FIELDS).toContain('powerState')
		expect(LIVE_STATE_FIELDS).toContain('chargeState')
	})

	/**
	 * The drift this file exists to catch: a tile that reads a field the stream
	 * does not send renders on first paint (from the page load) and then blanks
	 * the moment the car reports. Both files below render a LIVE entry.
	 */
	it('carries every state field the live pages read', () => {
		const files = ['routes/vehicles/[id]/+page.svelte', 'lib/components/VehicleCard.svelte']
		const missing: string[] = []
		for (const f of files) {
			for (const m of src(f).matchAll(/\bs[?]?\.([a-zA-Z0-9_]+)/g)) {
				const key = m[1]!
				if (STATE_KEYS.has(key) && !LIVE_STATE_FIELDS.includes(key as never)) {
					missing.push(`${f} -> ${key}`)
				}
			}
		}
		expect(missing).toEqual([])
	})

	it('is what feeds the hub, so the stream cannot be wired to the full query', () => {
		// The projection only saves anything if the STREAM uses it. The hub's two
		// dependencies are the seam where a well-meaning edit would reinstate the
		// full row without changing a single test about the payload's contents.
		// Checked on the IMPORT rather than the whole file: the hub's dependency
		// properties are named getVehicle/listVehicles, and the hub can only call
		// what this module imports.
		const imported = src('lib/server/notify-listener.ts').match(
			/import \{([^}]*)\} from '\.\/queries\.js'/
		)
		expect(imported).not.toBeNull()
		const names = imported![1]!
		expect(names).toContain('getVehicleLive')
		expect(names).toContain('listVehiclesLive')
		expect(names).not.toMatch(/\bgetVehicle\b(?!Live)/)
		expect(names).not.toMatch(/\blistVehicles\b(?!Live)/)
	})

	it('finds the live pages it claims to check, so a pass means something', () => {
		// A renamed route would otherwise turn the test above into a no-op.
		expect(src('routes/vehicles/[id]/+page.svelte')).toContain('live.get')
		expect(src('lib/components/VehicleCard.svelte')).toContain('entry.state')
	})
})
