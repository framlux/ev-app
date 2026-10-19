import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The Rivian settings page's `load`: what it reads, and, as much to the point,
 * what it refuses to pass on.
 *
 * `components.test.ts` renders the `.svelte` against hand-written `data`, so
 * whether the load really drops the sealed credential on its way to the browser
 * is decided here or nowhere. The database is mocked at the module this app
 * already owns (`$lib/server/db.js`); the pending-code map is real, because
 * "is there an attempt in progress" is a fact about that map and a fake of it
 * would only restate the test.
 */
const readRivianCredential = vi.fn()
const readRivianStatus = vi.fn()

vi.mock('../src/lib/server/db.js', () => ({
	getPool: () => ({}) as never,
	withTransaction: (_pool: unknown, fn: (c: unknown) => unknown) => fn({}),
	readRivianCredential: (...args: unknown[]) => readRivianCredential(...args),
	readRivianStatus: (...args: unknown[]) => readRivianStatus(...args)
}))

const { load } = await import('../src/routes/settings/rivian/+page.server.js')
const { clearPendingOtp, setPendingOtp } = await import('../src/lib/server/rivian-pending.js')

const SUBJECT = 'operator'
const SEALED = 'eyJhbGciOiJFQ0RILUVTK0EyNTZLVyIsImVuYyI6IkEyNTZHQ00ifQ.SEALED-VALUE.iv.ct.tag'

const event = (sub: string | null = SUBJECT) =>
	({ locals: { user: sub ? { sub } : null } }) as never

interface Loaded {
	credential: { account: string; updatedAt: string } | null
	status: {
		state: string
		vin: string | null
		lastFrameAt: string | null
		lastError: string | null
		backoffUntil: string | null
		droppedProperties: string[]
		updatedAt: string
	} | null
	pendingOtp: boolean
	now: string
}

/**
 * `PageServerLoad` is typed as possibly returning void, which it never does
 * here. Narrowing once keeps each assertion reading as the fact it checks.
 */
const loaded = async (sub: string | null = SUBJECT) => {
	const data = await load(event(sub))
	if (!data) throw new Error('the load returned nothing')
	return data as unknown as Loaded
}

const CREDENTIAL_ROW = {
	sealed: SEALED,
	account: 'owner@example.com',
	createdAt: new Date('2026-10-01T08:00:00.000Z'),
	updatedAt: new Date('2026-10-18T09:30:00.000Z')
}

const STATUS_ROW = {
	state: 'subscribed',
	vin: '7FCTGAAA0PN000000',
	rivianVehicleId: '01-internal-vehicle-id',
	lastFrameAt: new Date('2026-10-19T11:59:30.000Z'),
	lastError: 'Rivian HTTP 400: UNAUTHENTICATED/expired',
	backoffUntil: new Date('2026-10-19T12:15:00.000Z'),
	droppedProperties: ['batteryHvThermalEventPropagation', 'gnssLocation'],
	updatedAt: new Date('2026-10-19T11:59:45.000Z')
}

/** Every key and every string anywhere in a value, for the "nowhere" assertions. */
function everything(value: unknown, out: string[] = []): string[] {
	if (typeof value === 'string') out.push(value)
	else if (Array.isArray(value)) for (const v of value) everything(v, out)
	else if (value && typeof value === 'object') {
		for (const [k, v] of Object.entries(value)) {
			out.push(k)
			everything(v, out)
		}
	}
	return out
}

afterEach(() => {
	clearPendingOtp(SUBJECT)
	clearPendingOtp('someone-else')
	vi.clearAllMocks()
})

describe('the Rivian page load', () => {
	it('with no rows, says so: no credential and no status, both null', async () => {
		readRivianCredential.mockResolvedValue(null)
		readRivianStatus.mockResolvedValue(null)

		const data = await loaded()
		expect(data.credential).toBeNull()
		expect(data.status).toBeNull()
		expect(data.pendingOtp).toBe(false)
		expect(Number.isNaN(Date.parse(data.now))).toBe(false)
	})

	it('with rows, passes on the account and its stamp, and the status as the connector wrote it', async () => {
		readRivianCredential.mockResolvedValue(CREDENTIAL_ROW)
		readRivianStatus.mockResolvedValue(STATUS_ROW)

		const data = await loaded()
		expect(data.credential).toEqual({
			account: 'owner@example.com',
			updatedAt: '2026-10-18T09:30:00.000Z'
		})
		expect(data.status).toEqual({
			state: 'subscribed',
			vin: '7FCTGAAA0PN000000',
			lastFrameAt: '2026-10-19T11:59:30.000Z',
			lastError: 'Rivian HTTP 400: UNAUTHENTICATED/expired',
			backoffUntil: '2026-10-19T12:15:00.000Z',
			droppedProperties: ['batteryHvThermalEventPropagation', 'gnssLocation'],
			updatedAt: '2026-10-19T11:59:45.000Z'
		})
	})

	it('never passes the sealed credential on, under any name, anywhere in the object', async () => {
		readRivianCredential.mockResolvedValue(CREDENTIAL_ROW)
		readRivianStatus.mockResolvedValue(STATUS_ROW)

		const data = await loaded()
		const seen = everything(data)
		expect(seen).not.toContain('sealed')
		for (const text of seen) {
			expect(text).not.toContain('SEALED-VALUE')
			expect(text.toLowerCase()).not.toContain('sealed')
		}
		// Nor the connector's internal vehicle id, which nothing on the page shows.
		expect(seen).not.toContain('rivianVehicleId')
		expect(JSON.stringify(data)).not.toContain('01-internal-vehicle-id')
	})

	it('keeps an empty dropped list empty and a missing field null, never turning either into a claim', async () => {
		readRivianCredential.mockResolvedValue(null)
		readRivianStatus.mockResolvedValue({
			...STATUS_ROW,
			state: 'signed_out',
			vin: null,
			lastFrameAt: null,
			lastError: null,
			backoffUntil: null,
			droppedProperties: []
		})

		const { status } = await loaded()
		expect(status).toMatchObject({
			state: 'signed_out',
			vin: null,
			lastFrameAt: null,
			lastError: null,
			backoffUntil: null,
			droppedProperties: []
		})
	})

	it('reads both rows, and only those', async () => {
		readRivianCredential.mockResolvedValue(null)
		readRivianStatus.mockResolvedValue(null)
		await loaded()
		expect(readRivianCredential).toHaveBeenCalledTimes(1)
		expect(readRivianStatus).toHaveBeenCalledTimes(1)
	})

	describe('the pending-code flag', () => {
		const attempt = (expiresAt: Date) => ({
			email: 'owner@example.com',
			app: { csrfToken: 'csrf', appSessionToken: 'app' },
			otpToken: 'otp',
			expiresAt
		})

		it('reflects an attempt in progress for THIS subject', async () => {
			readRivianCredential.mockResolvedValue(null)
			readRivianStatus.mockResolvedValue(null)

			setPendingOtp(SUBJECT, attempt(new Date(Date.now() + 5 * 60_000)))
			expect((await loaded()).pendingOtp).toBe(true)
			expect((await loaded('someone-else')).pendingOtp).toBe(false)
			expect((await loaded(null)).pendingOtp).toBe(false)
		})

		it('is false once the attempt has expired, and the read evicts it', async () => {
			readRivianCredential.mockResolvedValue(null)
			readRivianStatus.mockResolvedValue(null)

			setPendingOtp(SUBJECT, attempt(new Date(Date.now() - 1)), new Date(0))
			expect((await loaded()).pendingOtp).toBe(false)
		})

		it('does not put the attempt itself in the data, only whether there is one', async () => {
			readRivianCredential.mockResolvedValue(null)
			readRivianStatus.mockResolvedValue(null)
			setPendingOtp(SUBJECT, attempt(new Date(Date.now() + 60_000)))

			const seen = everything(await loaded())
			for (const secret of ['csrf', 'app', 'otp']) expect(seen).not.toContain(secret)
		})
	})
})
