import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * No server-side configuration may be named with SvelteKit's PUBLIC_ prefix.
 *
 * SvelteKit reserves `PUBLIC_` for values it exposes to the browser, and
 * `$env/dynamic/private` FILTERS THOSE OUT. A server variable named PUBLIC_x is
 * therefore unreadable no matter how correctly the deployment sets it.
 *
 * This shipped once as PUBLIC_ORIGIN. It could not be caught by any unit test,
 * because the tests inject their own environment rather than going through
 * `$env`, and it could not be caught by a build, because the name is only
 * resolved at runtime. It was found by running the actual container, where
 * process.env.PUBLIC_ORIGIN was set correctly and the request still failed with
 * "PUBLIC_ORIGIN is not set" - so every sign-in returned 500 while the
 * ConfigMap looked right.
 *
 * A grep is a blunt instrument, but the failure it prevents is invisible in
 * every other layer.
 */
function serverFiles(dir: string): string[] {
	const out: string[] = []
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry)
		if (statSync(full).isDirectory()) out.push(...serverFiles(full))
		else if (/\.(ts|svelte)$/.test(entry)) out.push(full)
	}
	return out
}

describe('environment variable naming', () => {
	const files = serverFiles(new URL('../src', import.meta.url).pathname)

	it('finds source files, so a pass means something', () => {
		expect(files.length).toBeGreaterThan(0)
	})

	it('never reads a PUBLIC_-prefixed name from the private environment', () => {
		const offenders: string[] = []
		for (const f of files) {
			const src = readFileSync(f, 'utf8')
			// Only files that read the private env can have this bug.
			if (!src.includes("$env/dynamic/private") && !src.includes("$env/static/private")) continue
			for (const m of src.matchAll(/['"`](PUBLIC_[A-Z0-9_]+)['"`]/g)) {
				offenders.push(`${f} -> ${m[1]}`)
			}
		}
		expect(offenders).toEqual([])
	})
})
