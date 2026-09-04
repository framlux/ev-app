import { defineConfig } from 'vitest/config'

// Deliberately does not load the SvelteKit plugin: the workspace-level vitest
// runs plain Node tests over route handlers, and loading the Kit plugin here
// pulls a second, incompatible Vite into the run.
export default defineConfig({
	test: {
		name: 'web',
		environment: 'node',
		include: ['test/**/*.test.ts']
	}
})
