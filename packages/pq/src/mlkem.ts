/**
 * Raw ML-KEM-768 (FIPS 203), for the Noise channel hybrid.
 *
 * The Noise handshake already performs X25519 DHs; wrapping X-Wing there would
 * do X25519 twice. So the channel mixes the RAW ML-KEM-768 shared secret into
 * the Noise chaining key alongside the existing DHs (see the channel's mixKey).
 * X-Wing (./xwing) is for the one-shot surfaces (sealed box, contact root) that
 * have no X25519 of their own.
 *
 * Sizes: ek 1184, ct 1088, dk 2400, ss 32, seed 64 (d || z). Both ek and ct
 * exceed a 512-byte memo, so ML-KEM material rides the relay path, not the memo.
 *
 * IMPLICIT REJECTION (same as X-Wing): a bad ciphertext yields a pseudo-random
 * ss, it does not throw. The Noise transcript hash + AEAD tag are what catch a
 * mismatch.
 */

import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

export const MLKEM768_LENGTHS = {
  seed: 64,
  publicKey: 1184,
  secretKey: 2400,
  cipherText: 1088,
  sharedSecret: 32,
} as const;

export interface MlKem768Keypair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface MlKem768Encapsulation {
  sharedSecret: Uint8Array;
  cipherText: Uint8Array;
}

/**
 * A fresh EPHEMERAL ML-KEM-768 keypair (random). Use for the per-handshake
 * ephemeral that gives the channel post-quantum forward secrecy - never stored,
 * never reused.
 */
export function mlkem768KeygenEphemeral(): MlKem768Keypair {
  const kp = ml_kem768.keygen();
  return { secretKey: kp.secretKey, publicKey: kp.publicKey };
}

/**
 * A deterministic ML-KEM-768 keypair from a 64-byte seed (d || z), for any
 * STATIC ML-KEM key that must be mnemonic-recoverable.
 */
export function mlkem768KeypairFromSeed(seed64: Uint8Array): MlKem768Keypair {
  if (seed64.length !== MLKEM768_LENGTHS.seed) {
    throw new Error(
      `ml-kem-768: seed must be ${MLKEM768_LENGTHS.seed} bytes, got ${seed64.length}`,
    );
  }
  const kp = ml_kem768.keygen(seed64);
  return { secretKey: kp.secretKey, publicKey: kp.publicKey };
}

export function mlkem768Encapsulate(publicKey: Uint8Array): MlKem768Encapsulation {
  if (publicKey.length !== MLKEM768_LENGTHS.publicKey) {
    throw new Error(
      `ml-kem-768: publicKey must be ${MLKEM768_LENGTHS.publicKey} bytes, got ${publicKey.length}`,
    );
  }
  const { sharedSecret, cipherText } = ml_kem768.encapsulate(publicKey);
  return { sharedSecret, cipherText };
}

export function mlkem768Decapsulate(cipherText: Uint8Array, secretKey: Uint8Array): Uint8Array {
  if (cipherText.length !== MLKEM768_LENGTHS.cipherText) {
    throw new Error(
      `ml-kem-768: cipherText must be ${MLKEM768_LENGTHS.cipherText} bytes, got ${cipherText.length}`,
    );
  }
  return ml_kem768.decapsulate(cipherText, secretKey);
}
