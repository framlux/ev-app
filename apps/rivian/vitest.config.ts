import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		name: '@ev/rivian-connector',
		include: ['test/**/*.test.ts']
	}
})
