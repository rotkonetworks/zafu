/**
 * @zafu/pq - hybrid post-quantum key agreement for zafu.
 *
 * Confidentiality only: these are KEMs for KEY AGREEMENT (X-Wing for one-shot
 * surfaces, raw ML-KEM-768 for the Noise channel mix). Signatures and the
 * ed25519 ZID identity stay classical - authentication has no
 * harvest-now-decrypt-later exposure.
 *
 * ```typescript
 * import { xwingKeypairFromSeed, xwingEncapsulate, xwingDecapsulate } from '@zafu/pq';
 * const bob = xwingKeypairFromSeed(seed32);          // recoverable from mnemonic
 * const { sharedSecret, cipherText } = xwingEncapsulate(bob.publicKey);
 * const same = xwingDecapsulate(cipherText, bob.secretKey); // === sharedSecret
 * ```
 */

export {
  XWING_SUITE,
  XWING_LENGTHS,
  xwingKeypairFromSeed,
  xwingPublicKeyFromSeed,
  xwingEncapsulate,
  xwingDecapsulate,
  type XWingKeypair,
  type XWingEncapsulation,
} from './xwing';

export {
  MLKEM768_LENGTHS,
  mlkem768KeygenEphemeral,
  mlkem768KeypairFromSeed,
  mlkem768Encapsulate,
  mlkem768Decapsulate,
  type MlKem768Keypair,
  type MlKem768Encapsulation,
} from './mlkem';

export { SEAL_SUITE_XWING, sealXWing, openXWing } from './sealed';

export { PQ_KEY_AUTH_DOMAIN, pqKeyAuthMessage } from './pq-key-auth';
