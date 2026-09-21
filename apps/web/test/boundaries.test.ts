import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Architectural boundary, enforced rather than documented.
 *
 * apps/web legitimately depends on @ev/core for its TYPES — VehicleSample,
 * Session and friends are what the API serialises and the pages render. What it
 * must never do is reach into the engine: spec §3.3 says the web reads derived
 * tables, and the sessionisation logic belongs to the ingest worker alone.
 *
 * The trap is that packages/core's barrel re-exports the engine, so
 * `import { summariseSession } from '@ev/core'` resolves, typechecks and builds
 * with no complaint. Two copies of the segmentation rules — one computing on
 * write, one recomputing on read — would disagree silently and the UI would
 * quietly contradict the database. This test is the thing that stops it.
 */

const ENGINE_SYMBOLS = [
  'summariseSession',
  'deriveIdles',
  'estimateCapacity',
  'initialState',
  'DEFAULT_SEGMENTER_OPTIONS',
]

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full))
    } else if (/\.(ts|svelte|js)$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

describe('apps/web architectural boundaries', () => {
  const files = sourceFiles(new URL('../src', import.meta.url).pathname)

  it('finds source files to check, so a passing run means something', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('never imports the engine subpath from @ev/core', () => {
    const offenders = files.filter((f) =>
      /from\s+['"]@ev\/core\/engine/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('never references an engine symbol re-exported through the core barrel', () => {
    const offenders: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      for (const sym of ENGINE_SYMBOLS) {
        if (new RegExp(`\\b${sym}\\b`).test(src)) offenders.push(`${f} -> ${sym}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('never imports the segmenter, metrics or battery modules by any path', () => {
    const offenders = files.filter((f) =>
      /from\s+['"][^'"]*\/engine\/(segmenter|metrics|battery)/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})

/**
 * Authentication boundary: Pocket-ID is the ONLY way into this app.
 *
 * The trap this guards is a naming accident. Tesla's application form demands a
 * redirect URI, and the one registered is https://ev.example.com/tesla_login.
 * That path is not a login: it is a one-time OAuth callback the operator uses to
 * mint a Fleet API refresh token, and it authenticates nobody. Its name reads
 * like a sign-in option, which is exactly how a future change ends up adding
 * "Sign in with Tesla" and quietly turning a Tesla account into a second way
 * into a single-user app whose whole authorisation model is one Pocket-ID `sub`.
 *
 * Tesla tokens grant vehicle access. They must never grant app access.
 */
describe('apps/web authentication boundaries', () => {
  const files = sourceFiles(new URL('../src', import.meta.url).pathname)

  it('never places a Tesla path in the public/unauthenticated allowlist', () => {
    const offenders: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      const m = src.match(/PUBLIC_PATHS\s*=\s*\[([\s\S]*?)\]/)
      if (m && /tesla/i.test(m[1] ?? '')) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })

  /**
   * What "issues an app session" means, in one place so the guard and the test
   * that proves the guard still works cannot drift apart.
   *
   * `cookies.set(` used to be part of this pattern, as a proxy for "mints a
   * credential". It stopped being a usable proxy the moment a Tesla flow
   * legitimately needed a cookie of its own: the consent flow's `state` nonce
   * is a CSRF token for an OUTBOUND authorization request, not a credential for
   * this app, and it has to be set in a file that says the word Tesla. Left as
   * it was, a correct connect route turned this test red, and the only ways out
   * were deleting the guard or hiding the flow from it - both worse.
   *
   * Narrowing a guard is exactly the move that should be suspicious, so the
   * invariant is restated rather than assumed: no Tesla credential may ever
   * mint an APP session. This app mints one in exactly one way - `sealSession`,
   * written to the cookie `SESSION_COOKIE` names - and those are what this
   * matches now. The test below proves it, against fixture strings rather than
   * by reading the regex.
   */
  const issuesAppSession = (src: string) => /sealSession|SESSION_COOKIE\b|ev_session/.test(src)
  const touchesTesla = (src: string) => /tesla/i.test(src)

  it('never issues an app session from a Tesla credential', () => {
    const offenders: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      // Sealing a session, or writing the session cookie by name, in the same
      // file as Tesla OAuth handling is the shape this forbids.
      if (touchesTesla(src) && issuesAppSession(src)) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })

  it('still catches a Tesla credential that mints an app session', () => {
    // The narrowing above is only defensible if what it defends is still
    // caught, and that has to be demonstrated rather than argued.
    const sealsIt = `
      import { exchangeCode } from '@ev/tesla'
      const tokens = await exchangeCode(code, clientId, clientSecret, redirectUri)
      cookies.set(SESSION_COOKIE, await sealSession({ sub }, key), SESSION_COOKIE_OPTIONS)
    `
    expect(touchesTesla(sealsIt) && issuesAppSession(sealsIt)).toBe(true)

    // And by the cookie's literal name, which is how it would be written by
    // something reaching around $lib/server/session.js.
    const writesTheCookieByName = `
      const token = await teslaAccessToken(code)
      response.headers.set('set-cookie', \`ev_session=\${token}; Path=/\`)
    `
    expect(touchesTesla(writesTheCookieByName) && issuesAppSession(writesTheCookieByName)).toBe(true)

    // What the narrowing deliberately admits, pinned so re-widening this guard
    // breaks a test that explains why it was narrowed: a consent flow setting
    // its own CSRF nonce grants nothing about this app.
    const setsAStateNonce = `
      import { teslaRedirectUri } from '$lib/server/tesla-client.js'
      cookies.set(TESLA_FLOW_COOKIE, JSON.stringify({ s: state }), { sameSite: 'lax' })
    `
    expect(touchesTesla(setsAStateNonce)).toBe(true)
    expect(issuesAppSession(setsAStateNonce)).toBe(false)
  })

  it('offers no Tesla sign-in affordance in the UI', () => {
    const offenders: string[] = []
    for (const f of files.filter((f) => f.endsWith('.svelte'))) {
      const src = readFileSync(f, 'utf8')
      if (/sign\s*in\s*with\s*tesla|log\s*in\s*with\s*tesla|tesla\s*login/i.test(src)) {
        offenders.push(f)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('the live stream is gated like every other API route', () => {
  it('is not in the public allowlist', () => {
    const src = readFileSync(
      new URL('../src/lib/server/public-paths.ts', import.meta.url).pathname,
      'utf8'
    )
    // The ALLOWLIST, not the file: the file's comments contain the word
    // "upstream", so a bare /stream/ over the whole source is red before
    // anything has gone wrong.
    const allowlist = src.match(/PUBLIC_PATHS\s*=\s*\[([\s\S]*?)\]/)
    expect(allowlist).not.toBeNull()
    expect(allowlist![1]).not.toMatch(/stream/)
  })
})
