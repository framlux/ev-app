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
