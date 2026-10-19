import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		name: '@ev/rivian',
		include: ['test/**/*.test.ts']
	}
})
