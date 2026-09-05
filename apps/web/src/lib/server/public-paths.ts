/**
 * The unauthenticated surface of this application, enumerated.
 *
 * Everything not listed here needs a session. The list is short on purpose and
 * each entry has to justify itself:
 *
 * - the two health endpoints, because kubelet probes carry no cookie;
 * - the SSO start and callback, because you cannot sign in from behind a gate
 *   that requires you to be signed in;
 * - `/.well-known/**`, because the vehicle vendor's Fleet API fetches the
 *   application's public key from `static/.well-known/appspecific/` with no
 *   credentials of any kind. Gating that path returns 302 to the IdP, the
 *   vendor reads an HTML redirect instead of a PEM, and the vehicle silently
 *   un-pairs. It is the least obvious entry here and the most costly to break.
 *
 * Note what is NOT here: sign-out is authenticated (clearing a session you do
 * not have is not a thing anyone needs to do anonymously), and no vendor OAuth
 * callback belongs here either — vendor tokens grant vehicle access, never
 * application access.
 */
export type PublicPathRule =
	| { readonly kind: 'exact'; readonly path: string }
	| { readonly kind: 'prefix'; readonly path: string }

// Declared as `PUBLIC_PATHS = [` rather than with a type annotation before the
// `=`: test/boundaries.test.ts greps for exactly that shape to prove no vendor
// OAuth path ever lands in the allowlist, and an annotation there would make the
// grep silently match nothing.
export const PUBLIC_PATHS = [
	{ kind: 'exact', path: '/healthz/live' },
	{ kind: 'exact', path: '/healthz/ready' },
	{ kind: 'exact', path: '/auth/login' },
	{ kind: 'exact', path: '/sso_callback' },
	{ kind: 'prefix', path: '/.well-known/' }
] as const satisfies readonly PublicPathRule[]

/**
 * Exact by default, prefix only where a subtree genuinely has to be open.
 *
 * The distinction is the whole point: `startsWith('/auth/login')` would also
 * admit `/auth/loginbackdoor`, and a prefix rule for `/healthz` would open
 * anything a future route drops under it. `url.pathname` is already normalised
 * by the URL parser, so `/.well-known/../api/x` never reaches here as a
 * `/.well-known/` string.
 */
export function isPublicPath(pathname: string): boolean {
	return PUBLIC_PATHS.some((rule) =>
		rule.kind === 'exact' ? pathname === rule.path : pathname.startsWith(rule.path)
	)
}

/**
 * Where to send the browser after a successful sign-in.
 *
 * The value round-trips through a cookie the user's own browser holds, so it is
 * attacker-influenced input: anything that is not a path on this origin is
 * discarded rather than sanitised.
 *
 * Two independent checks, because string prefix tests alone have already failed
 * here once:
 *
 * 1. Reject C0 controls and DEL. Browsers *strip* tab, LF and CR from a URL
 *    before parsing it, so `/\t/evil.example` reaches the parser as
 *    `//evil.example` — a protocol-relative URL — while any `startsWith('//')`
 *    check upstream sees a plain path beginning `/\t`. The value survives the
 *    JSON round trip through the flow cookie and is emitted verbatim in the
 *    Location header, so the browser, not the server, does the redirecting
 *    off-origin. NUL and the other C0 codes are rejected with them: none of
 *    them belong in a path and each is handled differently by different
 *    parsers, which is the whole failure mode.
 * 2. Resolve what is left against a sentinel origin with the WHATWG URL parser
 *    and require the result to still be on that origin. The parser is exactly
 *    what the browser will apply to the Location header, so agreeing with it is
 *    the point: it is what catches `//evil.example`, `/\evil.example` (a
 *    backslash is a path separator for special schemes, so this is
 *    protocol-relative too) and anything else that smuggles an authority past a
 *    leading slash.
 *
 * Only pathname+search+hash is returned, so even a candidate that parses to
 * this origin cannot carry an origin back out.
 */

/** C0 controls plus DEL. See check 1 above — tab/LF/CR are the live exploit. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

/**
 * An origin no real deployment can be. `.invalid` is reserved by RFC 2606, so a
 * candidate that resolves to it did so by being a relative path, never by
 * naming the host itself.
 */
const SENTINEL_ORIGIN = 'https://safe-next-path.invalid'

export function safeNextPath(raw: string | null | undefined): string {
	if (!raw || !raw.startsWith('/')) return '/'
	if (CONTROL_CHARACTERS.test(raw)) return '/'
	let resolved: URL
	try {
		resolved = new URL(raw, SENTINEL_ORIGIN)
	} catch {
		return '/'
	}
	if (resolved.origin !== SENTINEL_ORIGIN) return '/'

	const path = `${resolved.pathname}${resolved.search}${resolved.hash}`

	// The OUTPUT is re-checked, not just the input, and this is not
	// belt-and-braces - it closes a live hole.
	//
	// WHATWG dot-segment collapse can turn a path that resolves safely into one
	// that is itself protocol-relative: '/x/..//evil.example' resolves on the
	// sentinel origin, so the check above passes, and yields the PATHNAME
	// '//evil.example'. Emitted as a Location header, a browser resolves that
	// against the real origin as https://evil.example/ - the open redirect,
	// carried by a value this function had just certified as safe. A fuzz over
	// four path segments found 775 such inputs, including '/..//evil.example',
	// '/.//evil.example' and the percent-encoded '/x/%2e%2e//evil.example'.
	//
	// Checking the input alone cannot catch these: the input is not
	// protocol-relative, the collapse creates that property. So the invariant
	// this function claims - never returns a value carrying an origin - has to
	// be asserted against what it actually returns.
	if (path.startsWith('//')) return '/'

	return path
}
