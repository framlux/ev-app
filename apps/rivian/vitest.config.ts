import { defineConfig } from 'vitest/config'
import { isolatedDatabase } from '../../packages/db/test/support/isolated-database.js'

/**
 * This project's own database, so its tests cannot race the other projects'
 * writes to the same tables (`store.test.ts` empties `rivian_credential` and
 * `rivian_status` wholesale). See packages/db/test/support/isolated-database.ts.
 */
const db = isolatedDatabase('rivian')

export default defineConfig({
	test: {
		name: '@ev/rivian-connector',
		include: ['test/**/*.test.ts'],
		env: db.env,
		globalSetup: db.globalSetup
	}
})
