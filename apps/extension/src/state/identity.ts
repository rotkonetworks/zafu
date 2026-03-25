/**
 * zid  - seed-derived ed25519 signing identity
 *
 * a zid is a cross-network identity: not penumbra, not zcash  - it's the
 * person behind the wallet. one seed -> one identity root -> derived keypairs.
 *
 * derivation hierarchy:
 *   root        = HMAC-SHA512("zid-v1", mnemonic)
 *   global      = HMAC-SHA512(root, 0x00000000)              <- opt-in only
 *   per-site    = HMAC-SHA512(root, "site:" + origin)         <- default, unlinkable
 *   rotated     = HMAC-SHA512(root, "site:" + origin + ":N")  <- rotation N for origin
 *   per-contact = HMAC-SHA512(root, "contact:" + contactId)   <- DH keypair for e2ee
 *   key         = ed25519.fromSeed(seed[0:32])
 *
 * default is per-site. global identity is opt-in because sharing the same
 * zid across origins lets sites collude to link your activity.
 *
 * per-contact zids provide DH keypairs for authenticated encrypted messaging.
 * they are NOT for referral tracking - that's handled by diversified zcash
 * addresses at the transport layer.
 *
 * separation of concerns:
 *   diversified address  -> payment routing + referral tracking
 *   per-site zid         -> website authentication
 *   per-contact zid      -> sender auth + e2ee (X25519 DH)
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

// -- public API --

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
 * derive a per-contact zid for authenticated encrypted communication.
 *
 * each contact gets a unique ed25519 keypair. the public key is shared in
 * the contact card (TLV tag 0x01). the recipient can use it for:
 *   - verifying message authenticity (signature)
 *   - X25519 DH key exchange for e2ee
 *
 * referral tracking ("via alice") is handled by diversified zcash addresses,
 * not by per-contact zids.
 *
 * contactId must be STABLE for the lifetime of the relationship. use the
 * contact's internal database ID (not their zid pubkey, which may rotate).
 * changing contactId changes the derived keypair, breaking e2ee continuity.
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
 * default is site-specific (not global) to prevent cross-origin linking.
 */
export const resolveZid = (mnemonic: string, origin: string, pref?: ZidSitePreference): Zid => {
  if (pref?.mode === 'global') return deriveZid(mnemonic);
  // default to site-specific identity
  return deriveZidForSite(mnemonic, origin, pref?.rotation ?? 0);
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
  const seed = (pref?.mode === 'global')
    ? deriveSeedByIndex(root, 0)
    : deriveSeedForSite(root, origin, pref?.rotation ?? 0);
  const { privateKey, publicKey } = keypairFromSeed(seed);
  const signature = ed25519.sign(challenge, privateKey);

  privateKey.fill(0);
  root.fill(0);

  return {
    signature: bytesToHex(signature),
    publicKey: bytesToHex(publicKey),
  };
};

// -- zid share log (site authentication tracking) --

/** a record of a zid we shared with a site during authentication */
export interface ZidShareRecord {
  /** the zid pubkey we signed with (hex) */
  publicKey: string;
  /** the origin we authenticated to */
  sharedWith: string;
  /** when we signed */
  sharedAt: number;
}

/**
 * look up which site we used a zid pubkey with.
 * used by the connections page to show which zid each site knows.
 */
export const lookupSharedZid = (
  log: ZidShareRecord[],
  origin: string,
): ZidShareRecord | undefined =>
  log.filter(r => r.sharedWith === origin).pop();

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
