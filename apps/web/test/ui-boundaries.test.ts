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
