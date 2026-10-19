#!/usr/bin/env node
/**
 * Generates the keypair the Rivian credential is sealed with (design §4.2).
 *
 *   pnpm --filter "@ev/rivian..." build
 *   node scripts/rivian-keygen.mjs
 *
 * Build @ev/rivian first: this imports the BUILT package, as every script here
 * does, so on a fresh checkout it fails with "cannot find module" until you do.
 * The trailing `...` is not decoration: @ev/rivian imports @ev/core, and
 * `--filter @ev/rivian` alone builds only the one package, so on a fresh
 * checkout its compile fails for want of @ev/core's built types. `...` builds
 * what it depends on first (`pnpm -r build` does the same, for everything).
 *
 * It prints two lines, each ready to paste as an environment variable:
 *
 *   RIVIAN_CREDENTIAL_PRIVATE_KEY=<private JWK, one line of JSON>
 *   RIVIAN_CREDENTIAL_PUBLIC_KEY=<public JWK, one line of JSON>
 *
 * WHERE EACH LINE GOES, AND WHERE IT MUST NOT. The private line goes ONLY into
 * the connector's SealedSecret. The web gets the public line and nothing else:
 * a web pod that held the private key could read back every credential it
 * writes, which is exactly what sealing exists to prevent, and `parseJwk`
 * refuses a private key where a public one is expected for the same reason.
 * Anyone with the private line can read the stored Rivian session, so do not
 * paste it into a chat, a ticket or a shared terminal, and do not run this
 * somewhere whose output is logged. The script writes no file, on purpose: the
 * only copy of the private key is the one you put in the SealedSecret.
 *
 * Run it once. Running it again makes a NEW pair, and a credential sealed to
 * the old public key will not open with the new private one: the connector
 * would report `credential_invalid` until someone signs in again on
 * /settings/rivian. That is the rotation procedure, not an accident, but it is
 * a sign-in's worth of disruption, so rotate on purpose.
 */

import { generateCredentialKeys } from '../packages/rivian/dist/index.js'

const { privateJwk, publicJwk } = await generateCredentialKeys()

console.log(`RIVIAN_CREDENTIAL_PRIVATE_KEY=${JSON.stringify(privateJwk)}`)
console.log(`RIVIAN_CREDENTIAL_PUBLIC_KEY=${JSON.stringify(publicJwk)}`)
