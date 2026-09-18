/**
 * Hybrid post-quantum sealed box: encrypt to a recipient's X-Wing public key
 * with no interaction and no sender key (anonymous sender, like NaCl
 * crypto_box_seal / age). This is the one-shot confidentiality surface - the
 * wallet's zafu_encrypt uses it so dapp messages a recorder captures today stay
 * confidential against a future quantum attacker (harvest-now-decrypt-later).
 *
 * Construction: X-Wing encapsulate -> HKDF-SHA256 -> AES-256-GCM. X-Wing already
 * bundles the ephemeral X25519 and the ML-KEM-768 ciphertext, so the wire needs
 * no separate ephemeral public key. A suite byte prefixes the wire so a future
 * suite can be told apart, and a classical (X25519-only) ciphertext - which
 * carries its ephemeral pubkey in a separate field - is never confused with this.
 *
 * wire: [0x01 suite][xwing_ct 1120][nonce 12][aes-256-gcm ciphertext+tag]
 */

import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import {
  xwingEncapsulate,
  xwingDecapsulate,
  xwingKeypairFromSeed,
  XWING_LENGTHS,
} from './xwing';

/** suite byte identifying an X-Wing hybrid sealed box on the wire. */
export const SEAL_SUITE_XWING = 0x01;

const NONCE_LEN = 12;
const KEY_LEN = 32;
const INFO = new TextEncoder().encode('zafu-seal-pq-v1');

/** the fixed prefix length before the AEAD blob: suite(1) + xwing_ct + nonce. */
const HEADER_LEN = 1 + XWING_LENGTHS.cipherText + NONCE_LEN;

const deriveKey = (sharedSecret: Uint8Array): Uint8Array =>
  hkdf(sha256, sharedSecret, undefined, INFO, KEY_LEN);

/**
 * Seal `plaintext` to a recipient's X-Wing public key (1216 bytes). Returns the
 * self-contained wire bytes; the recipient needs only their secret to open it.
 */
export function sealXWing(recipientPublicKey: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const { sharedSecret, cipherText } = xwingEncapsulate(recipientPublicKey);
  const key = deriveKey(sharedSecret);
  sharedSecret.fill(0);
  const nonce = randomBytes(NONCE_LEN);
  const sealed = gcm(key, nonce).encrypt(plaintext);
  key.fill(0);

  const out = new Uint8Array(HEADER_LEN + sealed.length);
  out[0] = SEAL_SUITE_XWING;
  out.set(cipherText, 1);
  out.set(nonce, 1 + cipherText.length);
  out.set(sealed, HEADER_LEN);
  return out;
}

/**
 * Open a sealed box with the recipient's 32-byte X-Wing SEED (derive it from the
 * mnemonic; the seed is the secret key). Throws on a wrong suite, a truncated
 * wire, or an authentication failure (a tampered ciphertext, or the wrong key -
 * ML-KEM implicit rejection surfaces here at the AEAD, exactly as intended).
 */
export function openXWing(recipientSeed: Uint8Array, wire: Uint8Array): Uint8Array {
  if (wire.length < HEADER_LEN) {
    throw new Error('sealed box: wire too short');
  }
  if (wire[0] !== SEAL_SUITE_XWING) {
    throw new Error(`sealed box: unknown suite byte 0x${(wire[0] ?? 0).toString(16)}`);
  }
  const cipherText = wire.slice(1, 1 + XWING_LENGTHS.cipherText);
  const nonce = wire.slice(1 + XWING_LENGTHS.cipherText, HEADER_LEN);
  const sealed = wire.slice(HEADER_LEN);

  const kp = xwingKeypairFromSeed(recipientSeed);
  const sharedSecret = xwingDecapsulate(cipherText, kp.secretKey);
  kp.secretKey.fill(0); // no longer needed after decapsulation
  const key = deriveKey(sharedSecret);
  sharedSecret.fill(0);
  try {
    return gcm(key, nonce).decrypt(sealed);
  } finally {
    key.fill(0);
  }
}
