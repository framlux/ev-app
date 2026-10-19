import { defineConfig } from 'vitest/config'
import { isolatedDatabase } from '../../packages/db/test/support/isolated-database.js'

/**
 * This project's own database, so its tests cannot race the other projects'
 * writes to the same tables. See packages/db/test/support/isolated-database.ts.
 */
const db = isolatedDatabase('ingest')

export default defineConfig({
	test: {
		name: '@ev/ingest',
		include: ['test/**/*.test.ts'],
		env: db.env,
		globalSetup: db.globalSetup
	}
})
