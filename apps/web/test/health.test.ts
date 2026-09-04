import { describe, expect, it } from 'vitest'
import { GET as live } from '../src/routes/healthz/live/+server.js'

describe('healthz', () => {
	it('live returns 200 with a plain ok body', async () => {
		const res = await live()
		expect(res.status).toBe(200)
		expect(await res.text()).toBe('ok')
	})
})
