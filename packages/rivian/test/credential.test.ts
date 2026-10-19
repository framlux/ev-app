import { CompactEncrypt, compactDecrypt, decodeProtectedHeader, exportJWK, generateKeyPair, importJWK } from 'jose'
import type { JWK } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  CredentialUnreadable,
  generateCredentialKeys,
  parseJwk,
  sealCredential,
  unsealCredential,
  type RivianCredential,
} from '../src/credential.js'

let keys: { privateJwk: JWK; publicJwk: JWK }
let otherKeys: { privateJwk: JWK; publicJwk: JWK }

beforeAll(async () => {
  keys = await generateCredentialKeys()
  otherKeys = await generateCredentialKeys()
})

/** What a sealed string holds, decoded with the real private key. */
async function payloadOf(sealed: string): Promise<unknown> {
  const key = await importJWK(keys.privateJwk, 'ECDH-ES+A256KW')
  const { plaintext } = await compactDecrypt(sealed, key)
  return JSON.parse(new TextDecoder().decode(plaintext))
}

describe('generateCredentialKeys', () => {
  it('makes a P-256 EC pair: the private half has d, the public half does not', () => {
    expect(keys.privateJwk).toMatchObject({ kty: 'EC', crv: 'P-256' })
    expect(keys.publicJwk).toMatchObject({ kty: 'EC', crv: 'P-256' })
    expect(typeof keys.privateJwk.d).toBe('string')
    expect(keys.publicJwk.d).toBeUndefined()
    // The halves belong together.
    expect(keys.privateJwk.x).toBe(keys.publicJwk.x)
    expect(keys.privateJwk.y).toBe(keys.publicJwk.y)
  })

  it('makes a different pair each time', () => {
    expect(otherKeys.privateJwk.d).not.toBe(keys.privateJwk.d)
  })
})

describe('sealCredential and unsealCredential', () => {
  it('round-trips the credential', async () => {
    const sealed = await sealCredential(keys.publicJwk, { userSessionToken: 'S' })
    await expect(unsealCredential(keys.privateJwk, sealed)).resolves.toEqual({ userSessionToken: 'S' })
  })

  it('does not put the token in the sealed string', async () => {
    const sealed = await sealCredential(keys.publicJwk, { userSessionToken: 'a-recognisable-token' })
    expect(sealed).not.toContain('a-recognisable-token')
    // A compact JWE: five dot-separated parts.
    expect(sealed.split('.')).toHaveLength(5)
  })

  it('seals the same credential to a different string each time', async () => {
    const a = await sealCredential(keys.publicJwk, { userSessionToken: 'S' })
    const b = await sealCredential(keys.publicJwk, { userSessionToken: 'S' })
    expect(a).not.toBe(b)
  })

  it('declares ECDH-ES+A256KW and A256GCM in the protected header', async () => {
    const sealed = await sealCredential(keys.publicJwk, { userSessionToken: 'S' })
    const header = decodeProtectedHeader(sealed)
    expect(header.alg).toBe('ECDH-ES+A256KW')
    expect(header.enc).toBe('A256GCM')
  })

  it('seals exactly {userSessionToken}, even when handed more', async () => {
    // The whole sign-in result, access and refresh tokens included: nothing uses
    // them, and sealing them would only widen what a stolen key reveals.
    const wholeResult = { userSessionToken: 'S', accessToken: 'AT', refreshToken: 'RT' }
    const sealed = await sealCredential(keys.publicJwk, wholeResult as RivianCredential)
    const payload = await payloadOf(sealed)
    expect(payload).toEqual({ userSessionToken: 'S' })
    expect(Object.keys(payload as object)).toEqual(['userSessionToken'])
    await expect(unsealCredential(keys.privateJwk, sealed)).resolves.toEqual({ userSessionToken: 'S' })
  })

  it('refuses to seal a credential that has no token', async () => {
    for (const bad of [{}, { userSessionToken: '' }, { userSessionToken: 7 }]) {
      await expect(sealCredential(keys.publicJwk, bad as unknown as RivianCredential)).rejects.toThrow(
        TypeError,
      )
    }
  })

  it('throws CredentialUnreadable for a different private key', async () => {
    const sealed = await sealCredential(keys.publicJwk, { userSessionToken: 'S' })
    await expect(unsealCredential(otherKeys.privateJwk, sealed)).rejects.toBeInstanceOf(
      CredentialUnreadable,
    )
  })

  it('throws CredentialUnreadable for a corrupt string', async () => {
    const sealed = await sealCredential(keys.publicJwk, { userSessionToken: 'S' })
    const parts = sealed.split('.')
    const flipped = [...parts]
    // Alter the ciphertext's first character, which authenticated encryption must notice.
    const ciphertext = parts[3] ?? ''
    flipped[3] = (ciphertext.startsWith('A') ? 'B' : 'A') + ciphertext.slice(1)
    for (const corrupt of ['', 'not a jwe', 'a.b.c.d.e', sealed.slice(0, -4), flipped.join('.')]) {
      await expect(unsealCredential(keys.privateJwk, corrupt)).rejects.toBeInstanceOf(CredentialUnreadable)
    }
  })

  it('throws CredentialUnreadable for a JWE that decrypts to something that is not a credential', async () => {
    const key = await importJWK(keys.publicJwk, 'ECDH-ES+A256KW')
    for (const plaintext of ['not json', '[]', 'null', '{}', '{"userSessionToken":5}', '{"userSessionToken":""}']) {
      const sealed = await new CompactEncrypt(new TextEncoder().encode(plaintext))
        .setProtectedHeader({ alg: 'ECDH-ES+A256KW', enc: 'A256GCM' })
        .encrypt(key)
      await expect(unsealCredential(keys.privateJwk, sealed), plaintext).rejects.toBeInstanceOf(
        CredentialUnreadable,
      )
    }
  })

  it('refuses a JWE sealed with an algorithm other than the two it fixes', async () => {
    const plaintext = new TextEncoder().encode('{"userSessionToken":"S"}')
    // Same key, direct key agreement instead of key wrap.
    const direct = await new CompactEncrypt(plaintext)
      .setProtectedHeader({ alg: 'ECDH-ES', enc: 'A256GCM' })
      .encrypt(await importJWK(keys.publicJwk, 'ECDH-ES'))
    await expect(unsealCredential(keys.privateJwk, direct)).rejects.toBeInstanceOf(CredentialUnreadable)
    // Same key wrap, a different content encryption.
    const otherEnc = await new CompactEncrypt(plaintext)
      .setProtectedHeader({ alg: 'ECDH-ES+A256KW', enc: 'A128GCM' })
      .encrypt(await importJWK(keys.publicJwk, 'ECDH-ES+A256KW'))
    await expect(unsealCredential(keys.privateJwk, otherEnc)).rejects.toBeInstanceOf(CredentialUnreadable)
  })

  it('says nothing about the sealed string or the key in the error it throws', async () => {
    const sealed = await sealCredential(keys.publicJwk, { userSessionToken: 'S' })
    const err = await unsealCredential(otherKeys.privateJwk, sealed).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CredentialUnreadable)
    const text = [String(err), (err as Error).message, JSON.stringify(err), (err as Error).stack ?? ''].join('\n')
    expect(text).not.toContain(sealed)
    expect(text).not.toContain(String(otherKeys.privateJwk.d))
    expect((err as Error).cause).toBeUndefined()
  })

  it('does not treat a private key that will not import as an unreadable credential', async () => {
    // That is a deployment mistake, which startup catches with parseJwk; filing
    // it under credential_invalid would wait for a sign-in that cannot fix it.
    const broken: JWK = { kty: 'EC', crv: 'P-256', x: 'AA', y: 'AA', d: 'AA' }
    const sealed = await sealCredential(keys.publicJwk, { userSessionToken: 'S' })
    const err = await unsealCredential(broken, sealed).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(CredentialUnreadable)
  })
})

describe('parseJwk', () => {
  it('accepts a generated private key as private and a public key as public', () => {
    expect(parseJwk(JSON.stringify(keys.privateJwk), 'private')).toEqual({
      kty: 'EC',
      crv: 'P-256',
      x: keys.privateJwk.x,
      y: keys.privateJwk.y,
      d: keys.privateJwk.d,
    })
    expect(parseJwk(JSON.stringify(keys.publicJwk), 'public')).toEqual({
      kty: 'EC',
      crv: 'P-256',
      x: keys.publicJwk.x,
      y: keys.publicJwk.y,
    })
  })

  it('returns keys that seal and unseal', async () => {
    const pub = parseJwk(JSON.stringify(keys.publicJwk), 'public')
    const priv = parseJwk(JSON.stringify(keys.privateJwk), 'private')
    const sealed = await sealCredential(pub, { userSessionToken: 'S' })
    await expect(unsealCredential(priv, sealed)).resolves.toEqual({ userSessionToken: 'S' })
  })

  it('keeps only the key members, so extra ones cannot conflict with the fixed algorithm', async () => {
    const decorated = { ...keys.publicJwk, alg: 'ES256', use: 'sig', key_ops: ['verify'], kid: 'k', ext: true }
    expect(Object.keys(parseJwk(JSON.stringify(decorated), 'public')).sort()).toEqual(['crv', 'kty', 'x', 'y'])
  })

  it('rejects a public key passed as private', () => {
    expect(() => parseJwk(JSON.stringify(keys.publicJwk), 'private')).toThrow(/private/)
  })

  it('rejects a private key passed as public', () => {
    // The web must hold only the public half.
    expect(() => parseJwk(JSON.stringify(keys.privateJwk), 'public')).toThrow(/private part/)
  })

  it('rejects an RSA key', async () => {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true })
    const rsa = await exportJWK(privateKey)
    expect(() => parseJwk(JSON.stringify(rsa), 'private')).toThrow(/EC/)
    expect(() => parseJwk(JSON.stringify({ kty: 'RSA', n: 'x', e: 'AQAB' }), 'public')).toThrow(/EC/)
  })

  it('rejects an EC key on another curve', async () => {
    const { privateKey } = await generateKeyPair('ECDH-ES+A256KW', { crv: 'P-384', extractable: true })
    const p384 = await exportJWK(privateKey)
    expect(() => parseJwk(JSON.stringify(p384), 'private')).toThrow(/P-256/)
  })

  it('rejects a key with no public point', () => {
    expect(() => parseJwk(JSON.stringify({ kty: 'EC', crv: 'P-256', d: 'x' }), 'private')).toThrow(/x and y/)
  })

  it('rejects non-JSON and JSON that is not an object', () => {
    expect(() => parseJwk('not json', 'private')).toThrow(/not valid JSON/)
    expect(() => parseJwk('', 'public')).toThrow(/not valid JSON/)
    for (const text of ['null', '[]', '"s"', '7']) {
      expect(() => parseJwk(text, 'public'), text).toThrow(/not a JSON object/)
    }
  })

  it('never echoes the text it was given, which may be a private key', () => {
    const attempts: Array<[string, 'private' | 'public']> = [
      ['hunter2-not-json', 'private'],
      [JSON.stringify(keys.privateJwk), 'public'],
      [JSON.stringify({ ...keys.privateJwk, crv: 'P-384' }), 'private'],
      [JSON.stringify({ ...keys.privateJwk, x: 5 }), 'private'],
    ]
    for (const [text, kind] of attempts) {
      const err = (() => {
        try {
          parseJwk(text, kind)
        } catch (e) {
          return e as Error
        }
        throw new Error('expected parseJwk to throw')
      })()
      expect(err.message).not.toContain('hunter2')
      expect(err.message).not.toContain(String(keys.privateJwk.d))
      expect(err.message).not.toContain(String(keys.privateJwk.x))
    }
  })
})
