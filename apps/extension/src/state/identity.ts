/**
 * zid  - seed-derived ed25519 signing identity
 *
 * a zid is a cross-network identity: not penumbra, not zcash — it's the
 * person behind the wallet. one seed -> named identities -> derived keypairs.
 *
 * derivation hierarchy:
 *   root              = HMAC-SHA512("zid-v1", mnemonic)
 *   identity["poker"] = HMAC-SHA512(root, "identity:poker")     <- named persona
 *   per-site          = HMAC-SHA512(identity, "site:" + origin)  <- default, unlinkable
 *   rotated           = HMAC-SHA512(identity, "site:" + origin + ":" + N)
 *   per-contact       = HMAC-SHA512(identity, "contact:" + contactId)
 *   cross-site        = HMAC-SHA512(identity, "cross-site")     <- opt-in, dangerous
 *   key               = ed25519.fromSeed(seed[0:32])
 *
 * identities are named, not numbered. "poker" and "personal" derive
 * different subtrees. the name is a derivation path component, not a
 * secret — the mnemonic provides all entropy.
 *
 * identities are unlinkable — no one can tell identity["poker"] and
 * identity["personal"] came from the same seed.
 *
 * contacts are scoped to the identity — poker identity's contacts are
 * completely separate from personal identity's contacts.
 *
 * cross-site key: links your activity across origins WITHIN one identity.
 * opt-in only, requires explicit confirmation. never displayed by default.
 * it does NOT link across identities — "poker" cross-site key cannot be
 * correlated with "personal" cross-site key.
 *
 * limitations:
 *   - no forward secrecy. compromised seed decrypts all past e2ee messages.
 *     for poker game channels, consider ephemeral DH with ratcheting (future).
 *   - no revocation. compromised identity has no signal mechanism. a revocation
 *     certificate protocol (sign "revoked, trust new key" with old key) is
 *     planned but requires a distribution channel (future).
 *
 * separation of concerns:
 *   diversified address  -> payment routing + referral tracking
 *   per-site zid         -> website authentication
 *   per-contact zid      -> sender auth + e2ee (X25519 DH)
 */

import { ed25519 } from '@noble/curves/ed25519';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { hmac } from '@noble/hashes/hmac';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

const ZID_DOMAIN = 'zid-v1';
const enc = new TextEncoder();

export interface Zid {
  publicKey: string;  // hex-encoded 32 bytes
  address: string;    // display: "zid" + first 16 hex chars of pubkey
}

/** a named identity persona */
export interface ZidIdentity {
  /** derivation name ("personal", "poker", "anon") — stable, part of key path */
  name: string;
  /** user-facing label (can be renamed without changing keys) */
  label: string;
}

/** per-origin identity preference */
export interface ZidSitePreference {
  /** 'cross-site' = same key across origins (dangerous). 'site' = origin-specific (default). */
  mode: 'cross-site' | 'site';
  /** rotation counter for site mode (0 = first key for this origin) */
  rotation: number;
  /** which identity name to use for this origin */
  identity: string;
}

/** format a public key as a zid address */
const formatZid = (pubkeyHex: string): string => 'zid' + pubkeyHex.slice(0, 16);

// -- derivation primitives --

/** derive the identity root from the mnemonic. caller must zeroize. */
const deriveRoot = (mnemonic: string): Uint8Array =>
  hmac(sha512, ZID_DOMAIN, enc.encode(mnemonic));

/** derive a named identity subtree root. caller must zeroize. */
const deriveIdentity = (root: Uint8Array, name: string): Uint8Array =>
  hmac(sha512, root, enc.encode('identity:' + name));

/** derive seed from identity + tag. caller must zeroize. */
const deriveSeed = (identity: Uint8Array, tag: Uint8Array): Uint8Array =>
  hmac(sha512, identity, tag);

/** derive per-site seed. */
const deriveSeedForSite = (identity: Uint8Array, origin: string, rotation: number): Uint8Array => {
  const tag = rotation === 0
    ? enc.encode('site:' + origin)
    : enc.encode('site:' + origin + ':' + rotation);
  return deriveSeed(identity, tag);
};

/** derive cross-site seed. opt-in only. */
const deriveSeedCrossSite = (identity: Uint8Array): Uint8Array =>
  deriveSeed(identity, enc.encode('cross-site'));

/** derive per-contact seed. */
const deriveSeedForContact = (identity: Uint8Array, contactId: string): Uint8Array =>
  deriveSeed(identity, enc.encode('contact:' + contactId));

/** extract ed25519 keypair from seed. zeroizes the seed. */
const keypairFromSeed = (seed: Uint8Array): { privateKey: Uint8Array; publicKey: Uint8Array } => {
  const privateKey = seed.slice(0, 32);
  const publicKey = ed25519.getPublicKey(privateKey);
  seed.fill(0);
  return { privateKey, publicKey };
};

/** extract P-256 keypair from seed (for WebAuthn/passkey compat). zeroizes the seed. */
const p256KeypairFromSeed = (seed: Uint8Array): { privateKey: Uint8Array; publicKey: Uint8Array } => {
  // domain-separate from ed25519: HMAC to get a valid P-256 scalar
  const derived = hmac(sha256, enc.encode('zid-p256'), seed.slice(0, 32));
  seed.fill(0);
  const privateKey = derived.slice(0, 32);
  const publicKey = p256.getPublicKey(privateKey, false); // uncompressed (0x04 || x || y)
  return { privateKey, publicKey };
};

/** helper: derive named identity, run fn, zeroize. */
const withIdentity = <T>(mnemonic: string, identityName: string, fn: (identity: Uint8Array) => T): T => {
  const root = deriveRoot(mnemonic);
  const identity = deriveIdentity(root, identityName);
  root.fill(0);
  const result = fn(identity);
  identity.fill(0);
  return result;
};

// -- public API --

/** default identity name for new wallets */
export const DEFAULT_IDENTITY = 'default';

/**
 * derive a site-specific zid for an origin under a named identity.
 * this is the DEFAULT mode — each site sees a unique key.
 */
export const deriveZidForSite = (mnemonic: string, identity: string, origin: string, rotation = 0): Zid =>
  withIdentity(mnemonic, identity, (id) => {
    const { publicKey } = keypairFromSeed(deriveSeedForSite(id, origin, rotation));
    const hex = bytesToHex(publicKey);
    return { publicKey: hex, address: formatZid(hex) };
  });

/**
 * derive the cross-site zid for an identity. OPT-IN ONLY.
 *
 * this key is the same across all origins for this identity.
 * sharing it lets sites collude to link your sessions.
 * it does NOT link across different identities.
 *
 * never display by default. buried in settings > identity > advanced.
 */
export const deriveZidCrossSite = (mnemonic: string, identity: string): Zid =>
  withIdentity(mnemonic, identity, (id) => {
    const { publicKey } = keypairFromSeed(deriveSeedCrossSite(id));
    const hex = bytesToHex(publicKey);
    return { publicKey: hex, address: formatZid(hex) };
  });

/**
 * derive a per-contact zid under a named identity.
 *
 * contacts are scoped to the identity — "poker" contacts are separate
 * from "personal" contacts. the same contactId under different identities
 * produces different keypairs.
 *
 * contactId must be STABLE for the lifetime of the relationship.
 */
export const deriveZidForContact = (mnemonic: string, identity: string, contactId: string): Zid =>
  withIdentity(mnemonic, identity, (id) => {
    const { publicKey } = keypairFromSeed(deriveSeedForContact(id, contactId));
    const hex = bytesToHex(publicKey);
    return { publicKey: hex, address: formatZid(hex) };
  });

/**
 * resolve which zid to use for a given origin based on preference.
 * default: site-specific for the "default" identity.
 */
export const resolveZid = (mnemonic: string, origin: string, pref?: ZidSitePreference): Zid => {
  const identity = pref?.identity ?? DEFAULT_IDENTITY;
  if (pref?.mode === 'cross-site') return deriveZidCrossSite(mnemonic, identity);
  return deriveZidForSite(mnemonic, identity, origin, pref?.rotation ?? 0);
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
  const identityName = pref?.identity ?? DEFAULT_IDENTITY;
  const root = deriveRoot(mnemonic);
  const identity = deriveIdentity(root, identityName);
  root.fill(0);

  const seed = (pref?.mode === 'cross-site')
    ? deriveSeedCrossSite(identity)
    : deriveSeedForSite(identity, origin, pref?.rotation ?? 0);
  identity.fill(0);

  const { privateKey, publicKey } = keypairFromSeed(seed);
  const signature = ed25519.sign(challenge, privateKey);

  privateKey.fill(0);

  return {
    signature: bytesToHex(signature),
    publicKey: bytesToHex(publicKey),
  };
};

// -- P-256 / WebAuthn / passkey --

/**
 * derive a site-specific P-256 public key (for WebAuthn/passkey registration).
 * same origin scoping as ed25519 ZID — same rotation, same identity.
 * returns uncompressed public key (65 bytes: 0x04 || x || y).
 */
export const deriveP256ForSite = (mnemonic: string, identity: string, origin: string, rotation = 0): { publicKey: string } =>
  withIdentity(mnemonic, identity, (id) => {
    const { publicKey } = p256KeypairFromSeed(deriveSeedForSite(id, origin, rotation));
    return { publicKey: bytesToHex(publicKey) };
  });

/**
 * sign a WebAuthn challenge with the P-256 key for an origin.
 * produces an ECDSA signature (DER-encoded) compatible with ES256.
 * used for sites that only support WebAuthn/passkeys.
 */
export const signP256 = (
  mnemonic: string,
  origin: string,
  challenge: Uint8Array,
  pref?: ZidSitePreference,
): { signature: string; publicKey: string } => {
  const identityName = pref?.identity ?? DEFAULT_IDENTITY;
  const root = deriveRoot(mnemonic);
  const identity = deriveIdentity(root, identityName);
  root.fill(0);

  const seed = (pref?.mode === 'cross-site')
    ? deriveSeedCrossSite(identity)
    : deriveSeedForSite(identity, origin, pref?.rotation ?? 0);
  identity.fill(0);

  const { privateKey, publicKey } = p256KeypairFromSeed(seed);
  const signature = p256.sign(challenge, privateKey);

  privateKey.fill(0);

  return {
    signature: bytesToHex(signature.toDERRawBytes()),
    publicKey: bytesToHex(publicKey),
  };
};

/**
 * verify a P-256 signature.
 */
export const verifyP256 = (
  publicKeyHex: string,
  signatureHex: string,
  challenge: Uint8Array,
): boolean => {
  try {
    return p256.verify(hexToBytes(signatureHex), challenge, hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
};

// -- backwards compatibility --

/**
 * derive the display zid (default identity, cross-site key).
 * @deprecated use deriveZidForSite with explicit identity name.
 */
export const deriveZid = (mnemonic: string): Zid =>
  deriveZidCrossSite(mnemonic, DEFAULT_IDENTITY);

// -- share log --

/** a record of a zid shared with a site during authentication */
export interface ZidShareRecord {
  /** the zid pubkey we signed with (hex) */
  publicKey: string;
  /** the origin we authenticated to */
  sharedWith: string;
  /** when we signed */
  sharedAt: number;
  /** which identity name was used */
  identity: string;
}

/** look up the most recent zid shared with a site */
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
