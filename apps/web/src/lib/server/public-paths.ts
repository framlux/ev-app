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
 * discarded rather than sanitised. `//evil.example` and `/\evil.example` are
 * both protocol-relative URLs in browsers despite starting with a slash, which
 * is the trap this exists for.
 */
export function safeNextPath(raw: string | null | undefined): string {
	if (!raw || !raw.startsWith('/')) return '/'
	if (raw.startsWith('//') || raw.startsWith('/\\')) return '/'
	return raw
}
