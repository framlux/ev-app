import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile, compileModule } from 'svelte/compiler'
import { transformWithEsbuild } from 'vite'
import { defineConfig, type Plugin } from 'vitest/config'

/**
 * Compiles .svelte files for SSR so test/components.test.ts can render them
 * with `render` from 'svelte/server'.
 *
 * This is a hand-rolled plugin rather than @sveltejs/vite-plugin-svelte on
 * purpose. Two reasons, both load-bearing:
 *
 * 1. Version skew. vitest 2 loads its own Vite 5, while apps/web builds on
 *    Vite 8. vite-plugin-svelte v7 targets the latter and crashes against the
 *    former inside configureServer ("Cannot convert undefined or null to
 *    object"), which is a startup error with nothing to do with our code.
 * 2. That plugin refuses to honour compilerOptions.generate, and server
 *    output is exactly what these tests need.
 *
 * Calling svelte/compiler directly sidesteps both. It is about fifteen lines
 * and has no opinion about which Vite is in the room.
 *
 * If this file is ever reverted to a plain config with no plugin, every
 * .svelte import fails vite's import analysis with "content contains invalid
 * JS syntax" pointing at `</script>` — which reads as a broken component
 * rather than a missing plugin. That has already happened once and silently
 * took the whole component suite out of the run.
 */
const LIB = fileURLToPath(new URL('./src/lib', import.meta.url))

function svelteSsrForTests(): Plugin {
	return {
		name: 'svelte-ssr-for-tests',
		enforce: 'pre',
		/**
		 * Resolves '$lib/x.js' to src/lib/x.ts.
		 *
		 * A plain alias is not enough. The codebase writes ESM-correct specifiers
		 * ending in '.js' while the files on disk are '.ts', so aliasing $lib
		 * produces a path to a file that does not exist. SvelteKit normally does
		 * both halves of this; neither happens here.
		 */
		resolveId(source) {
			if (!source.startsWith('$lib/')) return null
			const rest = source.slice('$lib/'.length)
			const base = resolve(LIB, rest)
			for (const candidate of [base.replace(/\.js$/, '.ts'), base, `${base}.ts`]) {
				if (existsSync(candidate)) return candidate
			}
			return null
		},
		/**
		 * A .svelte.ts module carries runes too, and esbuild leaves `$state` as an
		 * undefined global — a ReferenceError at import, before a single test
		 * runs. compileModule is what handles runes outside a component, and it
		 * has no TypeScript parser, so the types come off first.
		 */
		async transform(_code, id) {
			if (id.endsWith('.svelte.ts')) {
				const stripped = await transformWithEsbuild(readFileSync(id, 'utf8'), id, { loader: 'ts' })
				const { js } = compileModule(stripped.code, { filename: id, generate: 'server' })
				return { code: js.code, map: js.map }
			}
			if (!id.endsWith('.svelte')) return null
			const source = readFileSync(id, 'utf8')
			const { js } = compile(source, {
				filename: id,
				generate: 'server',
				css: 'injected'
			})
			return { code: js.code, map: js.map }
		}
	}
}

export default defineConfig({
	plugins: [svelteSsrForTests()],
	resolve: {
		conditions: ['svelte', 'import', 'default'],
		/**
		 * `$env/dynamic/private` only exists inside a SvelteKit runtime, so
		 * without this any server module that reads configuration cannot be
		 * imported by a test at all — the import fails before a single assertion
		 * runs. The stub reads process.env and applies SvelteKit's own PUBLIC_
		 * filter, so a module under test sees what it sees in the pod.
		 */
		alias: {
			'$env/dynamic/private': fileURLToPath(new URL('./test/support/env.ts', import.meta.url))
		}
	},
	test: {
		name: 'web',
		environment: 'node',
		include: ['test/**/*.test.ts']
	}
})
