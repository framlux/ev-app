#!/usr/bin/env node
/**
 * Prints the scopes a sealed REFRESH_TOKEN actually carries.
 *
 * The scopes granted at consent are fixed for the life of the token and cannot
 * be widened afterwards - correcting them means redoing the browser flow and
 * re-sealing. The token response reports them once, at exchange time, and then
 * never again, so a missed scope is normally discovered months later by a
 * feature that mysteriously 403s.
 *
 * Tesla issues access tokens as JWTs carrying an `scp` claim, so the grant is
 * recoverable from the refresh token alone. This reads it back.
 *
 * Read-only: it mints an access token and decodes it. It calls no vehicle
 * endpoint, so it neither wakes the car nor costs a metered request.
 *
 *   CLIENT_ID=... REFRESH_TOKEN=... node packages/tesla/scripts/check-token-scopes.mjs
 */
const { CLIENT_ID, REFRESH_TOKEN } = process.env
if (!CLIENT_ID || !REFRESH_TOKEN) {
  console.error('set CLIENT_ID and REFRESH_TOKEN in the environment')
  process.exit(2)
}

// Refresh needs no client_secret; it is the same call the app makes at runtime,
// so a failure here is also a genuine signal that the sealed token is unusable.
const res = await fetch('https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: REFRESH_TOKEN,
  }),
})
if (!res.ok) {
  console.error(`refresh failed: ${res.status} ${await res.text()}`)
  process.exit(1)
}
const tok = await res.json()

if (!tok.refresh_token) {
  console.error('WARNING: response carried no refresh_token - offline_access was not granted.')
}

const claims = JSON.parse(Buffer.from(tok.access_token.split('.')[1], 'base64url').toString())
const granted = new Set((claims.scp ?? []))

const EXPECTED = [
  'openid', 'offline_access',
  'vehicle_device_data', 'vehicle_location',
  'vehicle_cmds', 'vehicle_charging_cmds',
]

console.log('granted scopes:', [...granted].sort().join(' ') || '(none)')
console.log('expires:', new Date(claims.exp * 1000).toISOString())
console.log('audience:', Array.isArray(claims.aud) ? claims.aud.join(', ') : claims.aud)

// offline_access is frequently absent from scp even when it was granted - the
// proof that it worked is that a refresh_token came back at all, which is
// checked above. Do not report it as missing on the strength of the claim.
const missing = EXPECTED.filter((s) => s !== 'offline_access' && !granted.has(s))
if (missing.length) {
  console.error(`\nMISSING: ${missing.join(' ')}`)
  console.error('These cannot be added to this token. Redo consent and re-seal.')
  process.exit(1)
}
console.log('\nAll expected scopes present.')
