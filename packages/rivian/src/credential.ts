/**
 * THE CREDENTIAL, SEALED TO THE CONNECTOR (design §4.2).
 *
 * Nothing arrives from Rivian unless a session is held open around the clock,
 * so unlike the Tesla design the system must keep a standing credential: the
 * user session token that the sign-in produced. This file is how it is kept
 * without the party that stores it being able to read it. The web pod performs
 * the sign-in and SEALS the token to the connector's public key; the database
 * holds only the sealed string; only the connector holds the private key. A
 * database dump yields nothing, and the web pod can write the credential and can
 * never read it back (it has no private key to read it with).
 *
 * THE FORMAT is a compact JWE: `ECDH-ES+A256KW` key management with `A256GCM`
 * content encryption, on a P-256 key as a JWK. Both algorithms are fixed on the
 * way in AND on the way out. Sealing writes them into the protected header, and
 * unsealing names them as the only ones it will accept, so a sealed string
 * crafted with another algorithm (`dir`, say, or an `alg` that downgrades the
 * encryption) is refused rather than honoured.
 *
 * THE PAYLOAD is exactly `{userSessionToken}` and nothing else, by
 * construction: `sealCredential` copies that one field into the plaintext, so a
 * caller that hands it the whole sign-in result (with the access and refresh
 * tokens beside it, which nothing uses and which would only widen the exposure)
 * seals one field of it. The unsealer returns the same single field, so a sealed
 * string that does carry more yields no more.
 */

import { CompactEncrypt, compactDecrypt, exportJWK, generateKeyPair, importJWK } from 'jose'
import type { JWK } from 'jose'

const ALG = 'ECDH-ES+A256KW'
const ENC = 'A256GCM'
const CURVE = 'P-256'

export interface RivianCredential {
  userSessionToken: string
}

/**
 * A sealed credential that cannot be read: it is not a JWE, it was sealed to a
 * different key (a rotated SealedSecret, a wrong key pasted in), it was
 * altered, or its payload is not a credential.
 *
 * The connector treats this as the state `credential_invalid` and waits for a
 * new row, instead of crashing into a restart loop (design §4.2). The message
 * is fixed on purpose: the underlying error comes from a cipher, and what a
 * cipher says about a failed decryption is nothing a log needs, while the
 * sealed string and the key are never anything a log may hold.
 */
export class CredentialUnreadable extends Error {
  constructor() {
    super('the sealed Rivian credential cannot be read')
    this.name = 'CredentialUnreadable'
  }
}

/** Seal `{userSessionToken}` to a public key, as a compact JWE. */
export async function sealCredential(publicJwk: JWK, c: RivianCredential): Promise<string> {
  // A token that is not text would seal as `{}` (JSON drops `undefined`), and
  // the connector would later report a credential nobody can use as merely
  // unreadable. Refuse it where the mistake is made. The message names no value.
  if (typeof c.userSessionToken !== 'string' || c.userSessionToken === '') {
    throw new TypeError('a Rivian credential needs a non-empty userSessionToken')
  }
  const key = await importJWK(publicJwk, ALG)
  // Only this field, whatever else the argument carries (see the file comment).
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ userSessionToken: c.userSessionToken }),
  )
  return new CompactEncrypt(plaintext).setProtectedHeader({ alg: ALG, enc: ENC }).encrypt(key)
}

/**
 * Open a sealed credential with the private key. Throws `CredentialUnreadable`
 * for any string that does not open to a credential, and nothing else for it.
 *
 * The private key is imported OUTSIDE the `try`: a key that will not import is
 * a deployment mistake (startup validates it with `parseJwk`), not a bad row,
 * and putting it in the same bucket would send the connector into
 * `credential_invalid` and wait for a new sign-in that cannot fix it.
 */
export async function unsealCredential(privateJwk: JWK, sealed: string): Promise<RivianCredential> {
  const key = await importJWK(privateJwk, ALG)
  try {
    const { plaintext } = await compactDecrypt(sealed, key, {
      keyManagementAlgorithms: [ALG],
      contentEncryptionAlgorithms: [ENC],
    })
    const payload: unknown = JSON.parse(new TextDecoder().decode(plaintext))
    if (typeof payload !== 'object' || payload === null) throw new CredentialUnreadable()
    const { userSessionToken } = payload as { userSessionToken?: unknown }
    if (typeof userSessionToken !== 'string' || userSessionToken === '') {
      throw new CredentialUnreadable()
    }
    return { userSessionToken }
  } catch {
    // Every failure, the jose ones included, becomes the one error. The caught
    // value is dropped without being read: `JSON.parse` errors quote the text
    // they choked on, and this text is a credential.
    throw new CredentialUnreadable()
  }
}

/** A new keypair for `rivian-keygen.mjs`: the private half for the connector, the public for the web. */
export async function generateCredentialKeys(): Promise<{ privateJwk: JWK; publicJwk: JWK }> {
  const { publicKey, privateKey } = await generateKeyPair(ALG, { crv: CURVE, extractable: true })
  return { privateJwk: await exportJWK(privateKey), publicJwk: await exportJWK(publicKey) }
}

/**
 * Read a key out of an environment variable's text, and refuse anything that is
 * not the kind of key that was asked for. `kind` says which half: a private key
 * has `d`, a public key must not, and passing one for the other is the mistake
 * this exists to catch (the web must hold only the public half; a private key
 * in its environment would let it read every credential it writes).
 *
 * It returns just the members of the key (`kty`, `crv`, `x`, `y`, and `d` for a
 * private one), so a JWK that arrived with `key_ops`, `ext` or an `alg` of its
 * own cannot pull `importJWK` into a conflict with the algorithm fixed here.
 *
 * The messages are fixed text. The input is a key, possibly the private one,
 * and `JSON.parse` quotes the text it fails on, so its error is never passed on.
 */
export function parseJwk(text: string, kind: 'private' | 'public'): JWK {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`the ${kind} key is not valid JSON`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`the ${kind} key is not a JSON object`)
  }
  const { kty, crv, x, y, d } = parsed as Record<string, unknown>
  if (kty !== 'EC') throw new Error(`the ${kind} key is not an EC key`)
  if (crv !== CURVE) throw new Error(`the ${kind} key is not on curve ${CURVE}`)
  if (typeof x !== 'string' || typeof y !== 'string') {
    throw new Error(`the ${kind} key has no public point (x and y)`)
  }
  if (kind === 'private') {
    if (typeof d !== 'string') throw new Error('the private key has no private part (d)')
    return { kty, crv, x, y, d }
  }
  if (d !== undefined) throw new Error('the public key carries a private part (d)')
  return { kty, crv, x, y }
}
