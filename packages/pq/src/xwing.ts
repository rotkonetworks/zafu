/**
 * X-Wing: the hybrid KEM (X25519 + ML-KEM-768) zafu uses for post-quantum
 * confidentiality of key agreement.
 *
 * WHY hybrid, WHY now: an adversary recording ciphertext today can decrypt it
 * once a cryptographically-relevant quantum computer exists (harvest-now,
 * decrypt-later). Mixing ML-KEM-768 into the key agreement keeps that recorded
 * traffic confidential against a future quantum attacker; keeping X25519 in the
 * mix means a break or flaw in the (still young) ML-KEM never LOWERS today's
 * classical security. Neither half alone is trusted - both must break.
 *
 * This wraps @noble/post-quantum's `ml_kem768_x25519`, whose sizes match the
 * X-Wing draft exactly (pk 1216 = ml-kem-768 ek 1184 + x25519 32; ct 1120 =
 * ml-kem-768 ct 1088 + x25519 32; ss 32; sk a 32-byte SEED). The 32-byte-seed
 * secret key is the key property: the secret is recoverable from the mnemonic
 * (derive 32 bytes and that IS the decapsulation key) - losing it would lose
 * every hybrid secret, so it must never be a fresh random blob.
 *
 * X-Wing is a KEM (encapsulate/decapsulate), NOT a NIKE like static-static
 * X25519: one side encapsulates against the other's public key and the RESULT
 * carries a ciphertext the peer must receive to decapsulate. That ciphertext is
 * 1120 bytes - it does not fit a 512-byte Zcash memo or a 64-byte presence blob,
 * so a surface adopting X-Wing must have somewhere to carry 1120 bytes.
 *
 * Scope: this is for KEY AGREEMENT / CONFIDENTIALITY only. Signatures and the
 * ed25519 ZID identity stay classical - a quantum computer cannot retroactively
 * forge a signature that was already verified, so authentication has no
 * harvest-now-decrypt-later exposure.
 */

import { ml_kem768_x25519 } from '@noble/post-quantum/hybrid.js';

/**
 * Suite id carried in a contact card / key advertisement so a peer knows how to
 * establish the secret. `x25519-v1` (classical NIKE) is the current default;
 * `xwing-v1` is this hybrid KEM.
 */
export const XWING_SUITE = 'xwing-v1';

/** byte lengths of each X-Wing artifact (see module doc for the breakdown). */
export const XWING_LENGTHS = {
  seed: 32,
  publicKey: 1216,
  cipherText: 1120,
  sharedSecret: 32,
} as const;

export interface XWingKeypair {
  /** the decapsulation key. Store only the 32-byte seed and re-derive this. */
  secretKey: Uint8Array;
  /** the 1216-byte encapsulation key - goes in the contact card / advertisement. */
  publicKey: Uint8Array;
}

export interface XWingEncapsulation {
  /** the 32-byte shared secret (feed to a KDF before use as an AEAD key). */
  sharedSecret: Uint8Array;
  /** the 1120-byte ciphertext the recipient decapsulates. */
  cipherText: Uint8Array;
}

const assertLen = (b: Uint8Array, n: number, what: string): void => {
  if (b.length !== n) {
    throw new Error(`xwing: ${what} must be ${n} bytes, got ${b.length}`);
  }
};

/**
 * Derive an X-Wing keypair deterministically from a 32-byte seed. Feed a seed
 * derived from the mnemonic (via the wallet's contact-KA derivation tag) so the
 * decapsulation key is recoverable from backup. Same seed -> same keypair.
 */
export function xwingKeypairFromSeed(seed32: Uint8Array): XWingKeypair {
  assertLen(seed32, XWING_LENGTHS.seed, 'seed');
  const kp = ml_kem768_x25519.keygen(seed32);
  return { secretKey: kp.secretKey, publicKey: kp.publicKey };
}

/** the public (encapsulation) key for a seed, without materialising the secret. */
export function xwingPublicKeyFromSeed(seed32: Uint8Array): Uint8Array {
  return xwingKeypairFromSeed(seed32).publicKey;
}

/**
 * Encapsulate to a peer's public key. Returns a fresh shared secret and the
 * ciphertext the peer needs to recover it. The shared secret is single-use;
 * derive an AEAD key from it with a KDF (do not use raw).
 */
export function xwingEncapsulate(publicKey: Uint8Array): XWingEncapsulation {
  assertLen(publicKey, XWING_LENGTHS.publicKey, 'publicKey');
  const { sharedSecret, cipherText } = ml_kem768_x25519.encapsulate(publicKey);
  return { sharedSecret, cipherText };
}

/**
 * Decapsulate a ciphertext with the secret key to recover the shared secret.
 *
 * SECURITY: ML-KEM uses IMPLICIT REJECTION - a tampered or wrong ciphertext does
 * NOT throw here; it returns a pseudo-random shared secret that differs from the
 * sender's. The mismatch MUST be caught downstream by AEAD decryption failing.
 * Never treat "decapsulate returned bytes" as "ciphertext was authentic".
 */
export function xwingDecapsulate(cipherText: Uint8Array, secretKey: Uint8Array): Uint8Array {
  assertLen(cipherText, XWING_LENGTHS.cipherText, 'cipherText');
  return ml_kem768_x25519.decapsulate(cipherText, secretKey);
}
