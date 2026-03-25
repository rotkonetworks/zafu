/**
 * zid  - seed-derived ed25519 signing identity
 *
 * a zid is a cross-network identity: not penumbra, not zcash  - it's the
 * person behind the wallet. one seed → one identity root → derived keypairs.
 *
 * derivation hierarchy:
 *   root     = HMAC-SHA512("zid-v1", mnemonic)
 *   global   = HMAC-SHA512(root, 0x00000000)              ← public identity
 *   per-site = HMAC-SHA512(root, "site:" + origin)         ← unlinkable per origin
 *   rotated  = HMAC-SHA512(root, "site:" + origin + ":N")  ← rotation N for origin
 *   key      = ed25519.fromSeed(seed[0:32])
 *
 * all deterministic from seed. no extra key storage  - just store the
 * per-origin preference (which mode + rotation counter).
 */

import { ed25519 } from '@noble/curves/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { hmac } from '@noble/hashes/hmac';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

const ZID_DOMAIN = 'zid-v1';
const enc = new TextEncoder();

export interface Zid {
  publicKey: string;  // hex-encoded 32 bytes
  address: string;    // display: "zid" + first 16 hex chars of pubkey
}

/** per-origin identity preference */
export interface ZidSitePreference {
  /** 'global' = share your public zid. 'site' = origin-specific. */
  mode: 'global' | 'site';
  /** rotation counter for site mode (0 = first identity for this origin) */
  rotation: number;
}

/** format a public key as a zid address */
const formatZid = (pubkeyHex: string): string => 'zid' + pubkeyHex.slice(0, 16);

/** derive the identity root from the mnemonic. caller must zeroize. */
const deriveRoot = (mnemonic: string): Uint8Array =>
  hmac(sha512, ZID_DOMAIN, enc.encode(mnemonic));

/** derive seed from root + arbitrary tag bytes. caller must zeroize. */
const deriveSeedFromTag = (root: Uint8Array, tag: Uint8Array): Uint8Array =>
  hmac(sha512, root, tag);

/** derive seed at numeric index (for global zid). */
const deriveSeedByIndex = (root: Uint8Array, index: number): Uint8Array => {
  const idx = new Uint8Array(4);
  new DataView(idx.buffer).setUint32(0, index, false);
  return deriveSeedFromTag(root, idx);
};

/** derive seed for a specific origin + rotation. */
const deriveSeedForSite = (root: Uint8Array, origin: string, rotation: number): Uint8Array => {
  const tag = rotation === 0
    ? enc.encode('site:' + origin)
    : enc.encode('site:' + origin + ':' + rotation);
  return deriveSeedFromTag(root, tag);
};

/** extract ed25519 keypair from a seed. zeroizes the seed. */
const keypairFromSeed = (seed: Uint8Array): { privateKey: Uint8Array; publicKey: Uint8Array } => {
  const privateKey = seed.slice(0, 32);
  const publicKey = ed25519.getPublicKey(privateKey);
  seed.fill(0);
  return { privateKey, publicKey };
};

/** derive seed for a specific contact (by their zid pubkey or contact id). */
const deriveSeedForContact = (root: Uint8Array, contactId: string): Uint8Array =>
  deriveSeedFromTag(root, enc.encode('contact:' + contactId));

// ── public API ──

/**
 * derive the global zid (index 0). this is the user's "public" identity.
 */
export const deriveZid = (mnemonic: string, index = 0): Zid => {
  const root = deriveRoot(mnemonic);
  const { publicKey } = keypairFromSeed(deriveSeedByIndex(root, index));
  root.fill(0);
  const hex = bytesToHex(publicKey);
  return { publicKey: hex, address: formatZid(hex) };
};

/**
 * derive a site-specific zid for an origin.
 */
export const deriveZidForSite = (mnemonic: string, origin: string, rotation = 0): Zid => {
  const root = deriveRoot(mnemonic);
  const { publicKey } = keypairFromSeed(deriveSeedForSite(root, origin, rotation));
  root.fill(0);
  const hex = bytesToHex(publicKey);
  return { publicKey: hex, address: formatZid(hex) };
};

/**
 * derive a per-contact zid. when you share your contact card with someone,
 * use this instead of your global zid. if they forward your card, the
 * recipient will present this zid  - you'll know who shared it.
 *
 * contactId: their zid pubkey, or any stable unique identifier for the contact.
 */
export const deriveZidForContact = (mnemonic: string, contactId: string): Zid => {
  const root = deriveRoot(mnemonic);
  const { publicKey } = keypairFromSeed(deriveSeedForContact(root, contactId));
  root.fill(0);
  const hex = bytesToHex(publicKey);
  return { publicKey: hex, address: formatZid(hex) };
};

/**
 * resolve which zid to use for a given origin based on preference.
 */
export const resolveZid = (mnemonic: string, origin: string, pref?: ZidSitePreference): Zid => {
  if (!pref || pref.mode === 'global') return deriveZid(mnemonic);
  return deriveZidForSite(mnemonic, origin, pref.rotation);
};

/**
 * sign a challenge with the appropriate zid for an origin.
 */
export const signZid = (
  mnemonic: string,
  origin: string,
  challenge: Uint8Array,
  pref?: ZidSitePreference,
): { signature: string; publicKey: string } => {
  const root = deriveRoot(mnemonic);
  const seed = (!pref || pref.mode === 'global')
    ? deriveSeedByIndex(root, 0)
    : deriveSeedForSite(root, origin, pref.rotation);
  const { privateKey, publicKey } = keypairFromSeed(seed);
  const signature = ed25519.sign(challenge, privateKey);

  privateKey.fill(0);
  root.fill(0);

  return {
    signature: bytesToHex(signature),
    publicKey: bytesToHex(publicKey),
  };
};

/** verify a zid signature */
export const verifyZid = (
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
