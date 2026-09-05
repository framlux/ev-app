import { expect, it } from 'vitest'
import { SCOPES, authorizeUrl } from '../src/oauth.js'

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
