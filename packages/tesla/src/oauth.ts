const TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token'

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
