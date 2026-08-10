/**
 * ZIP-32 seed fingerprint (Zcash).
 *
 * A 32-byte BLAKE2b-256 hash of the wallet seed, personalized `Zcash_HD_Seed_FP`,
 * defined by ZIP 32 (https://zips.z.cash/zip-0032#seed-fingerprints). It identifies
 * a seed without revealing it, and is what Keystone / Zashi / vizor put in a
 * `Zip32Derivation` so a cold signer can tie an account back to its seed.
 *
 * zafu needs it for voting delegation: `build_delegation_pczt` takes the voter
 * account's `seed_fingerprint_hex` so the air-gapped signer (zigner) derives the
 * correct spending key. This TS implementation is cross-verified against the Rust
 * `zip32::fingerprint::SeedFingerprint::from_seed` used on the zigner side (see
 * the test), so both sides agree byte-for-byte.
 *
 * Invariants (from ZIP 32, all load-bearing):
 *  - hash is BLAKE2b with 32-byte digest and the exact 16-byte personalization.
 *  - the input is the single seed-LENGTH byte PREPENDED to the seed bytes.
 *  - the seed is the 64-byte BIP39 seed (`mnemonicToSeed`, empty passphrase) - the
 *    same seed used for key derivation; length must be 32..=252 or it is invalid.
 */

import { blake2b } from '@noble/hashes/blake2b';
import { mnemonicToSeedSync } from 'bip39';

const ZIP32_SEED_FP_PERSONALIZATION = new TextEncoder().encode('Zcash_HD_Seed_FP'); // 16 bytes

/** Compute the ZIP-32 seed fingerprint of an already-derived seed (>=32, <=252 bytes). */
export function seedFingerprintFromSeed(seed: Uint8Array): Uint8Array {
  if (seed.length < 32 || seed.length > 252) {
    throw new Error(`seed length ${seed.length} invalid for ZIP-32 fingerprint (must be 32..=252)`);
  }
  const input = new Uint8Array(1 + seed.length);
  input[0] = seed.length; // ZIP-32 prepends the seed length byte before hashing
  input.set(seed, 1);
  return blake2b(input, { dkLen: 32, personalization: ZIP32_SEED_FP_PERSONALIZATION });
}

/** Compute the ZIP-32 seed fingerprint from a BIP39 mnemonic (empty passphrase). */
export function seedFingerprintFromMnemonic(mnemonic: string): Uint8Array {
  return seedFingerprintFromSeed(mnemonicToSeedSync(mnemonic));
}

/** Hex form, as `build_delegation_pczt` expects for `seed_fingerprint_hex`. */
export function seedFingerprintHex(mnemonic: string): string {
  return Array.from(seedFingerprintFromMnemonic(mnemonic), b =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
