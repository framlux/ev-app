import { describe, expect, it } from 'vitest'
import { rivianGear } from '../src/gear.js'

describe('rivianGear', () => {
  it('maps the four words the vehicle sends to the canonical letters', () => {
    expect(rivianGear('park')).toBe('P')
    expect(rivianGear('drive')).toBe('D')
    expect(rivianGear('reverse')).toBe('R')
    expect(rivianGear('neutral')).toBe('N')
  })

  it('reads them without regard to case', () => {
    expect(rivianGear('PARK')).toBe('P')
    expect(rivianGear('Drive')).toBe('D')
    expect(rivianGear('rEvErSe')).toBe('R')
    expect(rivianGear('NEUTRAL')).toBe('N')
  })

  it('says null, explicitly, for a string it cannot name', () => {
    expect(rivianGear('sport')).toBeNull()
    expect(rivianGear('')).toBeNull()
    expect(rivianGear(' park')).toBeNull()
  })

  it('treats the integration\'s placeholders as strings it cannot name, not as a gear', () => {
    for (const placeholder of ['fault', 'signal_not_available', 'undefined']) {
      expect(rivianGear(placeholder)).toBeNull()
    }
  })

  it('is not fooled by a word that is also an Object property', () => {
    for (const word of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(rivianGear(word)).toBeNull()
    }
  })

  it('says undefined, which decodes nothing, for a value that is not a string', () => {
    expect(rivianGear(42)).toBeUndefined()
    expect(rivianGear(null)).toBeUndefined()
    expect(rivianGear(undefined)).toBeUndefined()
    expect(rivianGear({})).toBeUndefined()
    expect(rivianGear(true)).toBeUndefined()
  })
})
