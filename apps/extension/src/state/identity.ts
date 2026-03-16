/**
 * identity — seed-derived ed25519 signing identity
 *
 * derives a stable ed25519 keypair from the wallet mnemonic at a dedicated
 * derivation path separate from any network. used for "sign in with wallet"
 * and message signing. upgradeable to falconed (ed25519 + falcon-512) later.
 *
 * derivation: HMAC-SHA512("zafu-identity" || mnemonic) → ed25519 seed
 * the identity is wallet-level, not network-level.
 */

import { ed25519 } from '@noble/curves/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { hmac } from '@noble/hashes/hmac';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

const IDENTITY_DOMAIN = 'zafu-identity';

export interface IdentityKeypair {
  publicKey: string;    // hex-encoded 32 bytes
  address: string;      // truncated display: "zid1..." (first 20 bytes, bech32-like but simple hex for now)
}

/**
 * derive ed25519 identity keypair from mnemonic at a given index.
 * deterministic: same mnemonic + index = same key, always.
 */
export const deriveIdentityKeypair = (mnemonic: string, index = 0): IdentityKeypair => {
  // HMAC-SHA512 with domain separation, then take first 32 bytes as ed25519 seed
  const indexBytes = new Uint8Array(4);
  new DataView(indexBytes.buffer).setUint32(0, index, false);

  const seed = hmac(sha512, IDENTITY_DOMAIN, new TextEncoder().encode(mnemonic + '\0' + index));
  const privateKey = seed.slice(0, 32);
  const publicKey = ed25519.getPublicKey(privateKey);

  return {
    publicKey: bytesToHex(publicKey),
    address: 'zid' + bytesToHex(publicKey).slice(0, 16),
  };
};

/**
 * sign a challenge with the identity key.
 * challenge is typically: domain + nonce + timestamp from the requesting site.
 */
export const signWithIdentity = (mnemonic: string, index: number, challenge: Uint8Array): {
  signature: string;   // hex-encoded 64 bytes
  publicKey: string;   // hex-encoded 32 bytes
} => {
  const indexBytes = new Uint8Array(4);
  new DataView(indexBytes.buffer).setUint32(0, index, false);

  const seed = hmac(sha512, IDENTITY_DOMAIN, new TextEncoder().encode(mnemonic + '\0' + index));
  const privateKey = seed.slice(0, 32);
  const publicKey = ed25519.getPublicKey(privateKey);
  const signature = ed25519.sign(challenge, privateKey);

  // zeroize private key
  privateKey.fill(0);
  seed.fill(0);

  return {
    signature: bytesToHex(signature),
    publicKey: bytesToHex(publicKey),
  };
};

/**
 * verify an identity signature (for testing / other extensions).
 */
export const verifyIdentitySignature = (
  publicKeyHex: string,
  signatureHex: string,
  challenge: Uint8Array,
): boolean => {
  try {
    return ed25519.verify(hexToBytes(signatureHex), challenge, hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
};
