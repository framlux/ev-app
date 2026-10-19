import { error } from '@sveltejs/kit'

/**
 * The text fields of a JSON POST body, or a 400.
 *
 * Both sign-in routes take a body that is mostly a secret (a password, a
 * one-time code), so this is written around what it must not do: it never puts
 * any part of the body into the refusal. The message is fixed text naming the
 * FIELDS that are expected, which is the one piece of the request that is not
 * the user's, and a body that fails to parse is refused without the parser's
 * error, because `JSON.parse` quotes the text it choked on.
 *
 * Values come back exactly as sent. Trimming is the caller's decision, because
 * it differs by field: an email or a code is trimmed, and a password with a
 * space at its end is a password with a space at its end.
 *
 * `T extends string` so the result is typed by the names asked for and a typo
 * in a route is a compile error rather than a field that is always undefined.
 */
export async function readStringFields<T extends string>(
	request: Request,
	names: readonly T[]
): Promise<Record<T, string>> {
	const refusal = `the request body must be a JSON object with the text fields ${names.join(', ')}`

	let parsed: unknown
	try {
		parsed = await request.json()
	} catch {
		error(400, refusal)
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) error(400, refusal)

	const out = {} as Record<T, string>
	for (const name of names) {
		const value = (parsed as Record<string, unknown>)[name]
		if (typeof value !== 'string') error(400, refusal)
		out[name] = value
	}
	return out
}
