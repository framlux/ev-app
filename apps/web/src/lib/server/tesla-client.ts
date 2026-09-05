import { env } from '$env/dynamic/private'
import {
	fleetStatus,
	getTelemetryConfig,
	listVehicles,
	setTelemetryConfig,
	type FleetApiOptions,
	type TelemetryConfigRequest
} from '@ev/tesla'

/**
 * The web app's single door to the Fleet API, and it opens onto ev-teslaproxy.
 *
 * The telemetry-config push must be signed with the application key, which only
 * the proxy holds, so that call cannot go direct. Reads are routed the same way
 * on purpose: one base URL, one CA, one network path to reason about, and one
 * NetworkPolicy rule that already exists (design §2).
 *
 * Routes therefore take the client from here rather than importing @ev/tesla
 * themselves. `baseUrl` is optional in that package and defaults to Tesla's
 * public host, so a route that called it directly and forgot the options would
 * silently bypass the proxy — reads would even work, and only the push would
 * fail, unsigned and confusingly.
 *
 * Trust is NOT arranged here. The proxy's certificate comes from the cluster's
 * internal CA issuer that no public trust store knows, and the answer is
 * NODE_EXTRA_CA_CERTS on the pod, which Node applies to the process trust
 * store. No CA is read by THIS module at all: it is a mount and an environment
 * variable (§3.3). An injected undici dispatcher was rejected because undici is
 * not a dependency here and "works in a test, not in the image" is the exact
 * failure that would produce.
 *
 * The other certificate in this feature is not trust and does not belong here:
 * `telemetry.ts` reads the CA the CAR pins and puts it inside the pushed
 * configuration, where it is payload. Confusing the two is the expensive
 * mistake, which is why each is read in exactly one place.
 */

/**
 * Read at call time, not at import: `$env/dynamic/private` is what makes the
 * image buildable once and configurable per deployment, and a value captured at
 * module scope would freeze the first request's environment for the life of the
 * process.
 */
function required(name: string): string {
	// Loud, by name. The tempting alternative for TESLAPROXY_URL - fall back to
	// @ev/tesla's default, which is Tesla's public host - produces a deployment
	// that looks healthy right up until the push fails for want of a signature.
	const value = env[name]
	if (!value) throw new Error(`${name} is not set`)
	return value
}

/** @ev/tesla's `baseUrl` includes the API prefix, because Tesla's default does. */
const API_PREFIX = '/api/1'

function teslaBaseUrl(): string {
	// TESLAPROXY_URL is typed into a manifest by a human, and the design shows it
	// both ways - §3.1's flow carries /api/1, §7 describes a plain service URL.
	// Accepting either (and a stray trailing slash) is cheaper than debugging the
	// 404 the proxy answers to `//vehicles`, which reads like a missing route.
	const configured = required('TESLAPROXY_URL').replace(/\/+$/, '')
	return configured.endsWith(API_PREFIX) ? configured : `${configured}${API_PREFIX}`
}

/**
 * The registered redirect URI, from configuration rather than from the incoming
 * request. Tesla matches it byte for byte against what is registered in the
 * developer portal, and deriving it from a Host header would let a forged one
 * reroute the authorization code — the same reasoning as `authEnv`'s.
 */
export function teslaRedirectUri(): string {
	return required('TESLA_REDIRECT_URI')
}

/** What the consent flow needs from the environment, in one read. */
export interface TeslaOAuthEnv {
	clientId: string
	clientSecret: string
	redirectUri: string
}

/**
 * The application credential behind the interactive consent.
 *
 * Prefixed `TESLA_` rather than mounted under the bare `CLIENT_ID` /
 * `CLIENT_SECRET` names the `ev-tesla-oauth` Secret uses: this pod already
 * holds POCKETID_CLIENT_ID and POCKETID_CLIENT_SECRET, and two unqualified
 * names for a second identity provider in the same environment is a mix-up
 * waiting to happen — one that would present Pocket-ID's credential to Tesla
 * and fail as an opaque `invalid_client`.
 *
 * All three are demanded TOGETHER, by the connect route as well as the
 * callback, even though connect needs no secret. `authorizeUrl` hard-codes
 * `prompt: 'login'`, so a consent costs a full Tesla re-authentication with
 * password and MFA (§3.4); discovering a missing CLIENT_SECRET only at the
 * callback would waste that whole ceremony on a 500.
 *
 * It is an APPLICATION credential, not a vehicle one: on its own it grants
 * nothing about any car, because vehicle access needs a user's consent token.
 * That is why §2 accepts it in this pod while refusing a refresh token.
 */
export function teslaOAuthEnv(): TeslaOAuthEnv {
	return {
		clientId: required('TESLA_CLIENT_ID'),
		clientSecret: required('TESLA_CLIENT_SECRET'),
		redirectUri: teslaRedirectUri()
	}
}

/**
 * The four calls this app is allowed to make, bound to the proxy.
 *
 * The list is exactly @ev/tesla's export surface, which is pinned by a test
 * there: no vehicle-data helper (metered, wakes the car) and no command helper.
 * With a consented token now living inside ev-web for hours at a time, that pin
 * is the thing standing between this pod and a command sent to a physical car
 * (§3.4), so this wrapper adds nothing to it.
 */
export interface TeslaClient {
	listVehicles: (token: string) => ReturnType<typeof listVehicles>
	fleetStatus: (token: string, vins: string[]) => ReturnType<typeof fleetStatus>
	getTelemetryConfig: (token: string, vin: string) => ReturnType<typeof getTelemetryConfig>
	setTelemetryConfig: (
		token: string,
		config: TelemetryConfigRequest
	) => ReturnType<typeof setTelemetryConfig>
}

export function teslaClient(): TeslaClient {
	const opts: FleetApiOptions = { baseUrl: teslaBaseUrl() }
	return {
		listVehicles: (token) => listVehicles(token, opts),
		fleetStatus: (token, vins) => fleetStatus(token, vins, opts),
		getTelemetryConfig: (token, vin) => getTelemetryConfig(token, vin, opts),
		setTelemetryConfig: (token, config) => setTelemetryConfig(token, config, opts)
	}
}
