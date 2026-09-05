import { afterEach, expect, it, vi } from 'vitest'
import { SCOPES, WEB_SCOPES, authorizeUrl, exchangeCode } from '../src/oauth.js'

it('always requests offline_access, or there is no refresh token at all', () => {
  // This omission has already happened once. Its symptom is not a failed
  // consent - the exchange succeeds and returns an access token - it is the
  // integration silently dying when that token expires overnight.
  expect(SCOPES).toContain('offline_access')
})

it('requests the command scopes, so enabling commands needs no reconsent', () => {
  expect(SCOPES).toContain('vehicle_cmds')
  expect(SCOPES).toContain('vehicle_charging_cmds')
})

it('requests the read scopes the app actually runs on', () => {
  expect(SCOPES).toContain('vehicle_device_data')
  expect(SCOPES).toContain('vehicle_location')
})

it('authorizes against auth.tesla.com, not the fleet-auth token host', () => {
  const u = new URL(authorizeUrl('cid', 'https://ev.framlux.io/tesla_login', 's'))
  expect(u.host).toBe('auth.tesla.com')
})

it('space-delimits scopes and carries every one of them', () => {
  const u = new URL(authorizeUrl('cid', 'https://ev.framlux.io/tesla_login', 's'))
  expect(u.searchParams.get('scope')?.split(' ')).toEqual([...SCOPES])
})

it('passes client_id, redirect_uri and state through unmangled', () => {
  const u = new URL(authorizeUrl('cid', 'https://ev.framlux.io/tesla_login', 'nonce123'))
  expect(u.searchParams.get('client_id')).toBe('cid')
  expect(u.searchParams.get('redirect_uri')).toBe('https://ev.framlux.io/tesla_login')
  expect(u.searchParams.get('state')).toBe('nonce123')
  expect(u.searchParams.get('response_type')).toBe('code')
})

it('asks Tesla to prompt for scopes an existing grant does not already carry', () => {
  // Without this, Tesla reuses the scopes of the existing (account, app) grant
  // and ignores the scope parameter entirely. Consent and exchange both
  // succeed, and the token silently carries the OLD scope set.
  const u = new URL(authorizeUrl('cid', 'https://ev.framlux.io/tesla_login', 's'))
  expect(u.searchParams.get('prompt_missing_scopes')).toBe('true')
})

it('requires the full requested scope set, so a partial grant fails loudly', () => {
  const u = new URL(authorizeUrl('cid', 'https://ev.framlux.io/tesla_login', 's'))
  expect(u.searchParams.get('require_requested_scopes')).toBe('true')
})

/**
 * WEB_SCOPES is pinned exactly the way the export surface of fleet-api.ts is,
 * and for the same reason: the failure of quietly using the default SCOPES is
 * silent. The exchange would succeed, the app would work, and Tesla would have
 * minted a refresh token - a standing, vehicle-capable credential living in a
 * pod, which is the single thing the web consent flow exists to avoid.
 */
it('the web flow requests exactly openid and vehicle_device_data', () => {
  expect([...WEB_SCOPES]).toEqual(['openid', 'vehicle_device_data'])
})

it('the web flow never requests offline_access, so no refresh token can exist', () => {
  // Without offline_access Tesla returns NO refresh token at all. That is the
  // mechanism, not a policy: the flow cannot create a long-lived credential
  // even by mistake.
  expect(WEB_SCOPES).not.toContain('offline_access')
})

it('the web flow requests no command scope', () => {
  expect(WEB_SCOPES).not.toContain('vehicle_cmds')
  expect(WEB_SCOPES).not.toContain('vehicle_charging_cmds')
})

function stubToken(body: Record<string, unknown>): void {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  }))
}

afterEach(() => { vi.unstubAllGlobals() })

it('returns a token set with no refreshToken when Tesla issues none', async () => {
  // The web flow asks for no offline_access, so this is its NORMAL response.
  // The field must be genuinely absent rather than `undefined` behind a type
  // that promises a string: the callback asserts on its absence, and that
  // assertion is the executable form of "this flow holds no standing
  // credential".
  stubToken({ access_token: 'at', expires_in: 28800 })
  const t = await exchangeCode('code', 'cid', 'secret', 'https://ev.framlux.io/cb')
  expect(t.accessToken).toBe('at')
  expect('refreshToken' in t).toBe(false)
  expect(t.expiresAt.getTime()).toBeGreaterThan(Date.now())
})

it('still carries the refreshToken through when Tesla issues one', async () => {
  // The scripts' flow does request offline_access, and it must keep working.
  stubToken({ access_token: 'at', refresh_token: 'rt', expires_in: 28800 })
  const t = await exchangeCode('code', 'cid', 'secret', 'https://ev.framlux.io/cb')
  expect(t.refreshToken).toBe('rt')
})
