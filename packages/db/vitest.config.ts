import { defineConfig } from 'vitest/config'
import { isolatedDatabase } from './test/support/isolated-database.js'

/**
 * This project's own database, so its tests cannot race the other projects'
 * writes to the same tables. See test/support/isolated-database.ts.
 */
const db = isolatedDatabase('db')

export default defineConfig({
	test: {
		name: '@ev/db',
		include: ['test/**/*.test.ts'],
		env: db.env,
		globalSetup: db.globalSetup
	}
})
