import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Two rules about the UI that a typechecker cannot see and a test run against
 * an empty database would never hit.
 */

function files(dir: string, match: RegExp): string[] {
	const out: string[] = []
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry)
		if (statSync(full).isDirectory()) out.push(...files(full, match))
		else if (match.test(entry)) out.push(full)
	}
	return out
}

const SRC = new URL('../src', import.meta.url).pathname
const svelteFiles = files(SRC, /\.svelte$/)
const sourceFiles = files(SRC, /\.(svelte|ts)$/)

describe('maplibre-gl stays out of the server bundle', () => {
	it('finds .svelte files to check, so a passing run means something', () => {
		expect(svelteFiles.length).toBeGreaterThan(0)
	})

	/**
	 * maplibre-gl touches `window` at module scope. A static import puts it in
	 * the SSR graph, and every page that mounts a map then 500s on the server —
	 * including the garage, which is the first page anyone loads. The failure is
	 * total and immediate in production, and completely invisible in a unit test
	 * that never renders the component, so it is pinned here instead.
	 */
	it('is only ever reached through a dynamic import', () => {
		const offenders: string[] = []
		for (const f of sourceFiles) {
			for (const line of readFileSync(f, 'utf8').split('\n')) {
				// `import(...)` inside an onMount is fine; `import x from` is not.
				if (/^\s*import\s[^(]*['"]maplibre-gl/.test(line)) offenders.push(`${f}: ${line.trim()}`)
			}
		}
		expect(offenders).toEqual([])
	})
})

describe('Svelte 5 runes, not Svelte 4 idioms', () => {
	// Mixing the two in one component is a compile error in runes mode, and the
	// project forces runes on in vite.config.ts — but a store or an `export let`
	// in a file nothing imports yet compiles fine right up until it is used.
	it('declares props with $props(), never `export let`', () => {
		const offenders = svelteFiles.filter((f) => /^\s*export\s+let\s/m.test(readFileSync(f, 'utf8')))
		expect(offenders).toEqual([])
	})

	it('never reaches for svelte/store', () => {
		const offenders = sourceFiles.filter((f) =>
			/from\s+['"]svelte\/store['"]/.test(readFileSync(f, 'utf8'))
		)
		expect(offenders).toEqual([])
	})
})

describe('EventSource is constructed in exactly one place', () => {
	/**
	 * Reconnect, backoff and the signed-out probe all live in the live store. A
	 * second EventSource built anywhere else would be a second connection with
	 * none of that behaviour — and it would look like it worked, right up until
	 * the first pod restart.
	 */
	it('appears only in lib/live.svelte.ts', () => {
		const offenders = sourceFiles.filter(
			(f) => /new EventSource\(/.test(readFileSync(f, 'utf8')) && !f.endsWith('live.svelte.ts')
		)
		expect(offenders).toEqual([])
	})
})

/**
 * Getting to the telemetry settings without hunting for them.
 *
 * The header has carried a `Telemetry` link since the page existed, but it is
 * 0.86rem of muted text beside the theme toggle, and it is not called
 * "settings" — so the way to the one operational page in the app was to know it
 * was there. The vehicle tab bar is where attention already is.
 */
describe('the settings link is reachable from a vehicle', () => {
	const layout = readFileSync(
		join(SRC, 'routes/vehicles/[id]/+layout.svelte'), 'utf8')

	it('offers Settings in the vehicle tab bar', () => {
		expect(layout).toMatch(/label: 'Settings'/)
	})

	/**
	 * It must point AT the page that exists. A tab that 404s is worse than no
	 * tab, and there is no per-vehicle settings route — this is a second door to
	 * the global one, which is deliberate: the page is about this install's
	 * plumbing (spec §3.8), not about the car.
	 */
	it('points at the telemetry settings page itself', () => {
		expect(layout).toMatch(/href: '\/settings\/telemetry'/)
	})

	/**
	 * Order is the request: after Charges and Battery. Pinned because a tab bar
	 * is muscle memory, and a reordering is the kind of change nobody notices
	 * they have made.
	 */
	it('puts it last, after Battery', () => {
		const labels = [...layout.matchAll(/label: '([^']+)'/g)].map((m) => m[1])
		expect(labels).toEqual(['Overview', 'Drives', 'Charges', 'Battery', 'Settings'])
	})
})
