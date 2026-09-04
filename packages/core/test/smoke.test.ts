import { describe, expect, it } from 'vitest'
import { CORE_VERSION } from '../src/index.js'

describe('core package', () => {
  it('is importable from the workspace root', () => {
    expect(CORE_VERSION).toBe('0.0.0')
  })
})
