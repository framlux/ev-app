import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The Rivian settings page's `load`: what it reads, and, as much to the point,
 * what it refuses to pass on.
 *
 * `components.test.ts` renders the `.svelte` against hand-written `data`, so
 * what the load actually reads and forwards (which reader, which fields, which
 * dates as strings) is decided here or nowhere. The sealed credential is kept
 * out by never SELECTing it: the load reads `readRivianCredentialSummary`, and
 * the last block of this file fails if any web source names the full reader.
 * The database is mocked at the module this app
 * already owns (`$lib/server/db.js`); the pending-code map is real, because
 * "is there an attempt in progress" is a fact about that map and a fake of it
 * would only restate the test.
 */
const readRivianCredentialSummary = vi.fn()
const readRivianStatus = vi.fn()

vi.mock('../src/lib/server/db.js', () => ({
	getPool: () => ({}) as never,
	withTransaction: (_pool: unknown, fn: (c: unknown) => unknown) => fn({}),
	readRivianCredentialSummary: (...args: unknown[]) => readRivianCredentialSummary(...args),
	// `readRivianCredential` is deliberately NOT provided. The web must never
	// SELECT the sealed column, and a mocked module that lacks the full reader
	// makes any call to it throw here rather than quietly succeed.
	readRivianStatus: (...args: unknown[]) => readRivianStatus(...args)
}))

const { load } = await import('../src/routes/settings/rivian/+page.server.js')
const { clearPendingOtp, setPendingOtp } = await import('../src/lib/server/rivian-pending.js')

const SUBJECT = 'operator'
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

/**
 * What `readRivianCredentialSummary` returns: the account and both stamps. There
 * is no `sealed` here because the reader's query does not select it
 * (packages/db/test/rivian-repo.test.ts pins that), so a load that tried to
 * pass it on would have nothing to pass.
 */
const CREDENTIAL_ROW = {
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
		readRivianCredentialSummary.mockResolvedValue(null)
		readRivianStatus.mockResolvedValue(null)

		const data = await loaded()
		expect(data.credential).toBeNull()
		expect(data.status).toBeNull()
		expect(data.pendingOtp).toBe(false)
		expect(Number.isNaN(Date.parse(data.now))).toBe(false)
	})

	it('with rows, passes on the account and its stamp, and the status as the connector wrote it', async () => {
		readRivianCredentialSummary.mockResolvedValue(CREDENTIAL_ROW)
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

	it('passes on nothing but the account and the stamp, and nothing about a sealed value', async () => {
		readRivianCredentialSummary.mockResolvedValue(CREDENTIAL_ROW)
		readRivianStatus.mockResolvedValue(STATUS_ROW)

		const data = await loaded()
		const seen = everything(data)
		for (const text of seen) expect(text.toLowerCase()).not.toContain('sealed')
		expect(Object.keys(data.credential!).sort()).toEqual(['account', 'updatedAt'])
		// Nor the connector's internal vehicle id, which nothing on the page shows.
		expect(seen).not.toContain('rivianVehicleId')
		expect(JSON.stringify(data)).not.toContain('01-internal-vehicle-id')
	})

	it('reads the credential only through the summary reader, which the module mock enforces', async () => {
		readRivianCredentialSummary.mockResolvedValue(null)
		readRivianStatus.mockResolvedValue(null)
		await loaded()
		// The mocked db module has no `readRivianCredential` at all, so reaching
		// the full reader would have thrown above; this pins the positive side.
		expect(readRivianCredentialSummary).toHaveBeenCalledTimes(1)
	})

	it('keeps an empty dropped list empty and a missing field null, never turning either into a claim', async () => {
		readRivianCredentialSummary.mockResolvedValue(null)
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
		readRivianCredentialSummary.mockResolvedValue(null)
		readRivianStatus.mockResolvedValue(null)
		await loaded()
		expect(readRivianCredentialSummary).toHaveBeenCalledTimes(1)
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
			readRivianCredentialSummary.mockResolvedValue(null)
			readRivianStatus.mockResolvedValue(null)

			setPendingOtp(SUBJECT, attempt(new Date(Date.now() + 5 * 60_000)))
			expect((await loaded()).pendingOtp).toBe(true)
			expect((await loaded('someone-else')).pendingOtp).toBe(false)
			expect((await loaded(null)).pendingOtp).toBe(false)
		})

		it('is false once the attempt has expired, and the read evicts it', async () => {
			readRivianCredentialSummary.mockResolvedValue(null)
			readRivianStatus.mockResolvedValue(null)

			setPendingOtp(SUBJECT, attempt(new Date(Date.now() - 1)), new Date(0))
			expect((await loaded()).pendingOtp).toBe(false)
		})

		it('does not put the attempt itself in the data, only whether there is one', async () => {
			readRivianCredentialSummary.mockResolvedValue(null)
			readRivianStatus.mockResolvedValue(null)
			setPendingOtp(SUBJECT, attempt(new Date(Date.now() + 60_000)))

			const seen = everything(await loaded())
			for (const secret of ['csrf', 'app', 'otp']) expect(seen).not.toContain(secret)
		})
	})
})

/**
 * The web must never SELECT the sealed column (§4.2): it writes the JWE and
 * does not read it back. `readRivianCredential` is the reader that selects it,
 * so nothing under `src` may name it, and `$lib/server/db.ts` must not
 * re-export it. A name that cannot be imported cannot be called by a later
 * edit that did not know why it was left out.
 *
 * Comments are stripped first, because db.ts and the page load explain the
 * rule by naming the function it forbids.
 */
describe('the web never names the reader that selects the sealed credential', () => {
	function sourceFiles(dir: string): string[] {
		const out: string[] = []
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry)
			if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
			else if (/\.(ts|svelte|js)$/.test(entry)) out.push(full)
		}
		return out
	}
	const stripComments = (src: string) =>
		src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

	const files = sourceFiles(new URL('../src', import.meta.url).pathname)

	it('finds source files, so a pass means something', () => {
		expect(files.length).toBeGreaterThan(0)
	})

	it('has no reference to readRivianCredential in any source file', () => {
		// `\b` after the name: `readRivianCredentialSummary` is a different word.
		const offenders = files.filter((f) =>
			/\breadRivianCredential\b/.test(stripComments(readFileSync(f, 'utf8'))))
		expect(offenders).toEqual([])
	})

	it('still catches a re-export of it, which is the shape this forbids', () => {
		const reexport = `export { readRivianCredential, readRivianStatus } from '@ev/db'`
		expect(/\breadRivianCredential\b/.test(stripComments(reexport))).toBe(true)
		// And does not mistake the summary reader, or a comment, for it.
		expect(/\breadRivianCredential\b/.test(stripComments(`import { readRivianCredentialSummary } from 'x'`))).toBe(false)
		expect(/\breadRivianCredential\b/.test(stripComments(`// readRivianCredential\n/* readRivianCredential */`))).toBe(false)
	})
})
