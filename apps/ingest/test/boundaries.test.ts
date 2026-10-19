import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = new URL('../src', import.meta.url).pathname
const ALLOWED = new Set(['deps.ts', 'profiles/tesla.ts', 'profiles/rivian.ts', 'parallax-dump.ts'])

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const full = join(dir, e)
    return statSync(full).isDirectory() ? files(full) : full.endsWith('.ts') ? [full] : []
  })
}

describe('vendor packages are imported only at the seam', () => {
  it('finds sources', () => expect(files(SRC).length).toBeGreaterThan(5))
  it('no other module imports @ev/tesla or @ev/rivian', () => {
    const offenders = files(SRC)
      .filter((f) => !ALLOWED.has(relative(SRC, f)))
      .filter((f) => /from\s+['"]@ev\/(tesla|rivian)(\/[^'"]*)?['"]/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f))
    expect(offenders).toEqual([])
  })
})
