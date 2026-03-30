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

/** derive stable zpro license seed (never rotates). */
const deriveSeedForLicense = (identity: Uint8Array): Uint8Array =>
  deriveSeed(identity, enc.encode('zpro-license-v1'));

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
 * derive the stable zpro license key for an identity.
 *
 * this key NEVER rotates - it's the permanent license identity.
 * used for: payment memo, license lookup, ring VRF derivation.
 * independent of ZID rotation so subscriptions survive key rotation.
 */
export const deriveZproKey = (mnemonic: string, identity = DEFAULT_IDENTITY): { publicKey: string; seed: Uint8Array } =>
  withIdentity(mnemonic, identity, (id) => {
    const seed = deriveSeedForLicense(id);
    const { publicKey } = keypairFromSeed(seed.slice());
    return { publicKey: bytesToHex(publicKey), seed: seed.slice(0, 32) };
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

// -- passkey (non-rotating, long-lived WebAuthn credential) --

/**
 * derive a passkey seed for a relying party. NOT affected by ZID rotation.
 * passkeys are long-lived credentials — rotating would lock the user out.
 * re-registration is an explicit action (delete + create new passkey).
 */
const deriveSeedForPasskey = (identity: Uint8Array, rpId: string): Uint8Array =>
  deriveSeed(identity, enc.encode('passkey:' + rpId));

/**
 * derive a P-256 keypair for a passkey (non-rotating).
 */
export const derivePasskeyForSite = (mnemonic: string, identity: string, rpId: string): { publicKey: string } =>
  withIdentity(mnemonic, identity, (id) => {
    const { publicKey } = p256KeypairFromSeed(deriveSeedForPasskey(id, rpId));
    return { publicKey: bytesToHex(publicKey) };
  });

/**
 * sign with the passkey P-256 key (non-rotating).
 * message is NOT pre-hashed — p256.sign handles SHA-256 internally.
 */
export const signPasskey = (
  mnemonic: string,
  rpId: string,
  message: Uint8Array,
  identity = DEFAULT_IDENTITY,
): { signature: Uint8Array; publicKey: string } =>
  withIdentity(mnemonic, identity, (id) => {
    const seed = deriveSeedForPasskey(id, rpId);
    const { privateKey, publicKey } = p256KeypairFromSeed(seed);
    const sig = p256.sign(message, privateKey, { lowS: true });
    privateKey.fill(0);
    return {
      signature: sig.toDERRawBytes(),
      publicKey: bytesToHex(publicKey),
    };
  });

// -- PRF (WebAuthn pseudo-random function) --

/**
 * derive a PRF output for a site — the WebAuthn hmac-secret / prf extension.
 *
 * sites like Confer.to use PRF to derive encryption keys from passkeys.
 * our implementation: HMAC(identity, "prf:" + origin + "\0" + salt_hex)
 *
 * the output is deterministic: same seed + same site + same salt = same key.
 * this is exactly what the PRF extension spec requires.
 */
export const derivePrf = (
  mnemonic: string,
  identity: string,
  rpId: string,
  saltHex: string,
): Uint8Array =>
  withIdentity(mnemonic, identity, (id) => {
    // PRF is bound to the passkey (non-rotating), not the ZID rotation
    const passkeySeed = deriveSeedForPasskey(id, rpId);
    const prfTag = enc.encode('prf:' + saltHex);
    const result = hmac(sha256, passkeySeed.slice(0, 32), prfTag);
    passkeySeed.fill(0);
    return result;
  });

// -- deterministic passwords --

/** base85 alphabet (RFC 1924 — URL-safe, no quotes) */
const B85 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~';

/**
 * derive a deterministic password for a site + username.
 * same seed → same password, always. nothing stored.
 *
 * derivation: HMAC-SHA512(identity, "password:" + origin + "\0" + username)
 * output: first 32 bytes → base85 → 40-char string, truncated to len.
 */
/** normalize origin for password derivation — strip protocol, www/common subdomains, trailing slash */
export const normalizeOrigin = (raw: string): string => {
  let s = raw.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '');
  s = s.replace(/\/.*$/, '');
  s = s.replace(/:\d+$/, '');
  // strip common subdomains that share the same account
  s = s.replace(/^(www|api|app|login|auth|sso|accounts|mail|my|portal|secure|id)\./i, '');
  return s;
};

export const derivePassword = (
  mnemonic: string,
  identity: string,
  origin: string,
  username: string,
  length = 32,
  /** rotation index — increment when site requires password change */
  index = 0,
): string =>
  withIdentity(mnemonic, identity, (id) => {
    const normalized = normalizeOrigin(origin);
    const suffix = index > 0 ? '\0' + index : '';
    const tag = enc.encode('password:' + normalized + '\0' + username + suffix);
    const seed = deriveSeed(id, tag);
    const bytes = seed.slice(0, 32);
    seed.fill(0);

    // base85 encode for high entropy density + printable chars
    let result = '';
    for (let i = 0; i < bytes.length && result.length < length; i += 4) {
      let val = 0;
      for (let j = 0; j < 4 && i + j < bytes.length; j++) {
        val = (val << 8) | bytes[i + j]!;
      }
      for (let j = 0; j < 5 && result.length < length; j++) {
        result += B85[val % 85]!;
        val = Math.floor(val / 85);
      }
    }
    bytes.fill(0);
    return result.slice(0, length);
  });

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
