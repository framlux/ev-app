import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { errorMessageFrom } from '../src/lib/api-error.js'

/**
 * WHY THIS EXISTS, and it is not a hypothetical.
 *
 * The telemetry page read a failed response with `await res.json()` because
 * SvelteKit's error body is documented as `{ message }`. These endpoints answer
 * with `content-type: text/plain` and the bare sentence — verified against
 * production, where an unauthenticated POST returns exactly `unauthorized` as
 * text. So `res.json()` threw, the page fell back to `the request failed (502)`,
 * and EVERY message these endpoints have ever produced was discarded: the
 * consent prompts, the preflight refusals, and finally Tesla's own explanation
 * of why it rejected the configuration.
 *
 * The status was never the useful part. The sentence was.
 */
describe('the message shown when an action fails', () => {
	it('uses a text/plain body, which is what these endpoints actually send', () => {
		expect(errorMessageFrom(502, 'text/plain',
			'Tesla refused the request: Unknown field BrickSocMinPercent [Tesla txid c9bd]'))
			.toBe('Tesla refused the request: Unknown field BrickSocMinPercent [Tesla txid c9bd]')
	})

	it('still reads a JSON { message } body, in case that ever comes back', () => {
		expect(errorMessageFrom(409, 'application/json', '{"message":"connect to Tesla first"}'))
			.toBe('connect to Tesla first')
	})

	// A JSON body without the key is not a message; falling through to the raw
	// JSON would put braces on the screen.
	it('falls back when JSON carries no message', () => {
		expect(errorMessageFrom(500, 'application/json', '{"error":"nope"}'))
			.toBe('the request failed (500)')
	})

	/**
	 * The failure that started this: Traefik and Cloudflare both sit in front of
	 * this app and answer with their own HTML when the app is unreachable. That
	 * is a real and different problem from a refusal — but pasting a gateway's
	 * error page into the UI tells the operator nothing and looks like a bug in
	 * the app.
	 */
	it('never puts a gateway HTML page on the screen', () => {
		const html = '<html><head><title>502 Bad Gateway</title></head><body>...</body></html>'
		expect(errorMessageFrom(502, 'text/html', html)).toBe('the request failed (502)')
		expect(errorMessageFrom(502, 'text/plain', '<!DOCTYPE html><html>x</html>'))
			.toBe('the request failed (502)')
	})

	it('falls back on an empty or whitespace body', () => {
		expect(errorMessageFrom(502, 'text/plain', '')).toBe('the request failed (502)')
		expect(errorMessageFrom(502, 'text/plain', '   \n ')).toBe('the request failed (502)')
		expect(errorMessageFrom(502, null, '')).toBe('the request failed (502)')
	})

	/**
	 * An upstream that answers a 500 with its entire stack trace should not push
	 * the page's own layout off the screen. Truncation keeps the first, most
	 * useful line rather than the last.
	 */
	it('truncates a body too long to be a sentence', () => {
		const long = `${'x'.repeat(400)} tail`
		const shown = errorMessageFrom(500, 'text/plain', long)
		expect(shown.length).toBeLessThanOrEqual(301)
		expect(shown.startsWith('xxx')).toBe(true)
		expect(shown.endsWith('…')).toBe(true)
	})

	it('keeps a real refusal well inside the limit', () => {
		const refusal =
			'Tesla refused the request: SelfDrivingMilesSinceReset requires minimum delta ' +
			'be explicitly set and >= 1 [Tesla txid cbe224814cdef1d182bb6622da5dd0fc]'
		expect(errorMessageFrom(502, 'text/plain', refusal)).toBe(refusal)
	})
})

/**
 * Both callers, pinned. The helper is only worth having if the places that had
 * the bug actually use it — and "load more" had the same one in milder form,
 * showing `request failed (500)` where the endpoint had sent a sentence.
 */
describe('every failed-request path goes through it', () => {
	const files = [
		'src/routes/settings/telemetry/+page.svelte',
		'src/lib/components/PaginatedSessions.svelte',
		// The energy-rate form posts a rate and shows the refusal verbatim — a
		// 400 saying which field is wrong is the entire value of that endpoint's
		// messages, and reading it as JSON would replace all of them with
		// "request failed (400)".
		'src/routes/settings/energy/+page.svelte'
	]

	it('reads failed responses as text, never as JSON', () => {
		for (const f of files) {
			const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
			expect(src, f).toContain('errorMessageFrom(')
			// `res.json()` on the SUCCESS path is correct and stays; what must not
			// come back is parsing a failure as JSON.
			expect(src, f).not.toMatch(/res\.json\(\)\.catch/)
		}
	})
})
