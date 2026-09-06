const TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token'

// Authorization happens on auth.tesla.com; the token exchange happens on
// fleet-auth. They are different hosts and swapping them fails confusingly.
const AUTHORIZE_URL = 'https://auth.tesla.com/oauth2/v3/authorize'

/**
 * The scopes the refresh token is minted with.
 *
 * This is a constant rather than something typed into a browser because the
 * scope set is only decided ONCE. Tesla issues the refresh token against the
 * scopes granted at consent, and widening them later means redoing the browser
 * flow and re-sealing the secret. `offline_access` has already been missed here
 * once: without it the exchange returns an access token and no refresh token,
 * and the integration appears to work until it dies overnight.
 *
 * The command scopes are granted deliberately, so that adding command support
 * later needs no Tesla-side reconsent. They make the TOKEN command-capable;
 * they do not make the APP command-capable. That second guarantee is held by
 * the export surface of fleet-api.ts, which its test pins - adding a command
 * helper has to break that test first, which is the point.
 */
export const SCOPES = [
  'openid',
  'offline_access',
  'vehicle_device_data',
  'vehicle_location',
  'vehicle_cmds',
  'vehicle_charging_cmds',
] as const

/**
 * The scopes the WEB app's interactive consent asks for, and nothing else.
 *
 * It is a separate constant rather than a subset computed from SCOPES because
 * the two are decided for opposite reasons. SCOPES mints a standing refresh
 * token deliberately; this flow exists so that no standing credential is
 * created at all. Omitting `offline_access` is the mechanism, not the policy:
 * without it Tesla issues NO refresh token, so the flow cannot mint one even by
 * accident. The command scopes are not asked for either.
 *
 * Passing the default SCOPES here would fail silently - the consent and the
 * exchange would both succeed, and the app would have created exactly the
 * credential this design removes - so `oauth.test.ts` pins this list the way
 * `fleet-api.test.ts` pins the export surface.
 *
 * Read the comment in `authorizeUrl` before trusting this to be a REDUCTION:
 * Tesla records a grant per (account, application) and this account's grant
 * already carries the command scopes, so a fresh authorize may hand back a
 * token with them regardless of what was requested. What actually holds that
 * line is that no function in this repo sends a command.
 *
 * `vehicle_location` IS REQUIRED, and was missing here until a push finally
 * said so:
 *
 *   400 Unauthorized missing scopes vehicle_location for vehicle data access
 *
 * Tesla will not apply a telemetry configuration that names `Location` unless
 * the token carries that scope, and this catalogue names it - a driving history
 * without position is not the product. The scope is about what the token may
 * READ, which is data this app already stores from the stream; it mints no
 * standing credential, so it takes nothing away from the design above. Note
 * `require_requested_scopes=true` in `authorizeUrl`: a consent where the
 * operator unticks location fails loudly here rather than producing a token
 * that cannot push.
 *
 * `scripts/push-telemetry-config.sh` never hit this, which is why it went
 * unnoticed for so long - it mints from SCOPES, which has always had it.
 */
export const WEB_SCOPES = ['openid', 'vehicle_device_data', 'vehicle_location'] as const

export function authorizeUrl(
  clientId: string, redirectUri: string, state: string,
  scopes: readonly string[] = SCOPES,
): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    state,
    // Force the account chooser. Without it a browser already signed in to
    // Tesla silently reuses that session, which is how you consent as the
    // wrong account and get an empty vehicle list with no error.
    prompt: 'login',
    // BOTH of these are required to widen the scopes of an app a Tesla account
    // has already authorized, and their absence is silent.
    //
    // Tesla records a grant per (account, application). Once one exists, a
    // fresh authorize call reuses ITS scopes and ignores what you asked for -
    // consent succeeds, the exchange succeeds, and the token comes back with
    // the original scope set. `prompt: 'login'` does not help: it forces
    // re-authentication, not re-consent, so it produces a convincing login
    // screen and the same old grant. That is precisely how this app spent a
    // round of consent believing it had vehicle_cmds when it had four scopes.
    //
    // prompt_missing_scopes asks the user to approve scopes not already
    // granted. require_requested_scopes then makes a partial grant an outright
    // failure instead of a quiet downgrade - the failure mode being fixed here
    // is not that a scope was refused, it is that nothing said so.
    prompt_missing_scopes: 'true',
    require_requested_scopes: 'true',
  })
  return `${AUTHORIZE_URL}?${q}`
}

/**
 * `refreshToken` is optional because it genuinely is: Tesla returns one only
 * when `offline_access` was requested, and the web consent flow deliberately
 * does not ask (see WEB_SCOPES). Typing it `string` would put an `undefined`
 * behind a type promising otherwise - the same silent-shape trap this file's
 * SCOPES comment documents in the other direction - and the web callback
 * asserts on its ABSENCE, which is the executable form of "this flow holds no
 * standing credential".
 */
export interface TokenSet { accessToken: string; refreshToken?: string; expiresAt: Date }

export async function exchangeCode(
  code: string, clientId: string, clientSecret: string, redirectUri: string,
): Promise<TokenSet> {
  return post({ grant_type: 'authorization_code', client_id: clientId,
                client_secret: clientSecret, code, redirect_uri: redirectUri, audience: FLEET_AUDIENCE })
}

export async function refresh(
  refreshToken: string, clientId: string,
): Promise<TokenSet> {
  return post({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken })
}

const FLEET_AUDIENCE = 'https://fleet-api.prd.na.vn.cloud.tesla.com'

async function post(body: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  })
  if (!res.ok) throw new Error(`token request failed: ${res.status} ${await res.text()}`)
  const j = await res.json() as {
    access_token: string; refresh_token?: string; expires_in: number
  }
  return {
    accessToken: j.access_token,
    // Spread rather than assigned: under exactOptionalPropertyTypes an
    // explicit `undefined` is not the same as an absent key, and the web
    // callback distinguishes them on purpose - it refuses a token set that
    // CARRIES a refresh token, so the key must not exist when there is none.
    ...(j.refresh_token !== undefined && { refreshToken: j.refresh_token }),
    expiresAt: new Date(Date.now() + j.expires_in * 1000),
  }
}
