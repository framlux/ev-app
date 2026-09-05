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
  })
  return `${AUTHORIZE_URL}?${q}`
}

export interface TokenSet { accessToken: string; refreshToken: string; expiresAt: Date }

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
  const j = await res.json() as { access_token: string; refresh_token: string; expires_in: number }
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: new Date(Date.now() + j.expires_in * 1000),
  }
}
