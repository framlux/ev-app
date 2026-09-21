import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		name: '@ev/tesla',
		include: ['test/**/*.test.ts'],
		/**
		 * `TELEMETRY_HOSTNAME` is read from the environment at import, because it
		 * is deployment-specific — see `src/telemetry-config.ts`. The tests that
		 * build a configuration need a value, and the one they pin is this.
		 */
		env: { EV_TELEMETRY_HOSTNAME: 'ev-telemetry.example.com' }
	}
})
