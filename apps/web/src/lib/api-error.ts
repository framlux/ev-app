/**
 * What to show when an action's request fails.
 *
 * The telemetry page used to read a failed response with `await res.json()`,
 * because SvelteKit documents its error body as `{ message }`. These endpoints
 * answer with `content-type: text/plain` and the bare sentence — an
 * unauthenticated POST to `/api/v1/telemetry/push` in production returns
 * `unauthorized` as text, not JSON. So the parse threw, the page fell back to
 * "the request failed (502)", and every message these endpoints have ever
 * produced was discarded on the way to the screen: the consent prompts, the
 * preflight refusals, and Tesla's own explanation of what was wrong with the
 * configuration.
 *
 * A status code is almost never the useful part. `502` says "something
 * upstream"; the sentence says `Unknown field BrickSocMinPercent`, which is the
 * difference between an operator who can act and one who has to read pod logs.
 *
 * Both shapes are accepted rather than one, because there are three things that
 * can answer this request and only one of them is the app: Traefik and
 * Cloudflare both sit in front of it and answer with their own pages when it is
 * unreachable. Their HTML is deliberately NOT shown — it is a real problem, but
 * a different one, and a gateway's error page pasted into the UI reads as a bug
 * in this app while saying nothing about what to do.
 */

/** Long enough for Tesla's longest refusal, short enough not to take the page. */
const MAX_LENGTH = 300

const looksLikeHtml = (body: string): boolean => /^\s*<(?:!doctype|html|head|body)\b/i.test(body)

export function errorMessageFrom(
	status: number,
	contentType: string | null,
	body: string
): string {
	const fallback = `the request failed (${status})`
	const trimmed = body.trim()
	if (trimmed === '') return fallback

	if (contentType?.includes('application/json') || trimmed.startsWith('{')) {
		try {
			const parsed: unknown = JSON.parse(trimmed)
			const message = (parsed as { message?: unknown } | null)?.message
			// A JSON body without the key is not a message; showing the raw
			// document instead would put braces and quotes on the screen.
			return typeof message === 'string' && message.trim() !== ''
				? truncate(message.trim())
				: fallback
		} catch {
			return fallback
		}
	}

	if (contentType?.includes('text/html') || looksLikeHtml(trimmed)) return fallback

	return truncate(trimmed)
}

/**
 * Keeps the FIRST characters, not the last: an upstream that answers with a
 * stack trace puts the useful line first and the frames after it.
 */
function truncate(message: string): string {
	return message.length <= MAX_LENGTH ? message : `${message.slice(0, MAX_LENGTH)}…`
}
