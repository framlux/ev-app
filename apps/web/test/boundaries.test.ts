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
 * redirect URI, and the one registered is https://ev.framlux.io/tesla_login.
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

  it('never issues an app session from a Tesla credential', () => {
    const offenders: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      // A session cookie or sealSession call in the same file as Tesla OAuth
      // handling is the shape this forbids.
      const touchesTesla = /tesla/i.test(src)
      const issuesSession = /sealSession|ev_session|cookies\.set\(/.test(src)
      if (touchesTesla && issuesSession) offenders.push(f)
    }
    expect(offenders).toEqual([])
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
