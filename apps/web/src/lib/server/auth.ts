import * as client from 'openid-client'
import { env } from '$env/dynamic/private'

/**
 * Everything the OIDC flow needs, read from the environment at request time.
 *
 * `$env/dynamic/private` rather than the static form on purpose: the image is
 * built once and run with the cluster's ConfigMap and Secrets injected, so
 * baking these in at build time would mean a rebuild to rotate a client secret.
 */
export interface AuthEnv {
	issuer: URL
	clientId: string
	clientSecret: string
	/** The single Pocket-ID `sub` permitted to use this application. */
	allowedSubject: string
	sessionKey: string
	redirectUri: string
}

function required(name: string): string {
	const value = env[name]
	// Missing configuration fails loudly here rather than producing a flow that
	// half works. An empty ALLOWED_SUBJECT in particular must never reach
	// authoriseClaims as "no restriction".
	if (!value) throw new Error(`${name} is not set`)
	return value
}

export function authEnv(): AuthEnv {
	const origin = required('PUBLIC_ORIGIN').replace(/\/$/, '')
	return {
		issuer: new URL(required('POCKETID_ISSUER')),
		clientId: required('POCKETID_CLIENT_ID'),
		clientSecret: required('POCKETID_CLIENT_SECRET'),
		allowedSubject: required('ALLOWED_SUBJECT'),
		sessionKey: required('SESSION_KEY'),
		// Fixed, not derived from the incoming request: the value is registered at
		// Pocket-ID and must match byte for byte, and deriving it from a header
		// would let a forged Host reroute the code.
		redirectUri: `${origin}/sso_callback`
	}
}

/**
 * Discovery result, cached for the life of the process.
 *
 * The document changes about as often as the IdP is redeployed, and fetching it
 * on every sign-in adds a round trip to a path that already has three. The
 * cache holds the *promise* so concurrent sign-ins share one request, and it is
 * dropped on failure so a transient IdP outage does not poison the process for
 * as long as it runs.
 */
let discovered: Promise<client.Configuration> | null = null

export function resetDiscoveryCache(): void {
	discovered = null
}

export async function oidcConfig(): Promise<client.Configuration> {
	if (!discovered) {
		const { issuer, clientId, clientSecret } = authEnv()
		discovered = client
			.discovery(issuer, clientId, clientSecret, client.ClientSecretPost(clientSecret))
			.catch((err: unknown) => {
				discovered = null
				throw err
			})
	}
	return discovered
}

/** Cookie carrying the in-flight authorization request's CSRF/PKCE material. */
export const FLOW_COOKIE = 'ev_oidc_flow'

/**
 * Ten minutes. The flow cookie is worthless once the callback consumes it; the
 * window only has to cover a human typing a password and a TOTP code.
 */
export const FLOW_TTL_SECONDS = 600

export interface FlowState {
	/** PKCE code_verifier. */
	v: string
	/** Expected `state`. */
	s: string
	/** Expected `nonce`. */
	n: string
	/** Where to land after sign-in; validated with safeNextPath on the way out. */
	next: string
}

export function parseFlowState(raw: string | undefined): FlowState | null {
	if (!raw) return null
	try {
		const parsed: unknown = JSON.parse(raw)
		if (typeof parsed !== 'object' || parsed === null) return null
		const { v, s, n, next } = parsed as Record<string, unknown>
		if (typeof v !== 'string' || typeof s !== 'string' || typeof n !== 'string') return null
		return { v, s, n, next: typeof next === 'string' ? next : '/' }
	} catch {
		return null
	}
}

/**
 * The URL handed to `authorizationCodeGrant`, rebuilt on the configured origin.
 *
 * Behind Traefik the request SvelteKit sees is plain HTTP on an internal name.
 * openid-client compares and validates against this URL, so it has to be the
 * public one; taking the origin from configuration rather than from the request
 * also means a spoofed Host header cannot influence the exchange.
 */
export function callbackUrl(requestUrl: URL, origin: string): URL {
	const url = new URL(origin)
	url.pathname = requestUrl.pathname
	url.search = requestUrl.search
	return url
}
