/**
 * webauthn authenticator - builds credential responses from ZID-derived P-256 keys.
 *
 * Every function takes the identity node (identityKey), never the phrase. A
 * passkey made with a user id is per relying party AND account (v3): its
 * credential id is that user id sealed (AES-GCM) under a per-RP key, so `get`
 * recovers the userHandle and two accounts at one site are unlinkable. Passkeys
 * made before v3 (one per rpId) are still recognised and keep their keys.
 *
 * supports:
 * - credential creation (navigator.credentials.create), honouring excludeCredentials
 * - assertion signing (navigator.credentials.get)
 * - PRF extension (hmac-secret for E2E encryption keys)
 */

import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { hexToBytes } from '@noble/hashes/utils';
import {
  derivePasskeyCredentialId,
  derivePasskeyWrapKey,
  derivePrf,
  passkeyPublicKey,
  signPasskey,
} from './identity';

const enc = new TextEncoder();

/** AAGUID for zafu authenticator */
const ZAFU_AAGUID = new Uint8Array([
  0x7a, 0x61, 0x66, 0x75, 0x2d, 0x70, 0x61, 0x73, 0x73, 0x6b, 0x65, 0x79, 0x2d, 0x76, 0x31, 0x00,
]);

const FLAGS = {
  UP: 0x01, // user present
  UV: 0x04, // user verified
  AT: 0x40, // attested credential data
  ED: 0x80, // extension data
};

/** first byte of a v3 (per-account) credential id */
const V3 = 0x03;
const NONCE = 12;
const TAG = 16;

/** a passkey this wallet holds: its credential id, and the account it is for (v3 only) */
export interface Credential {
  id: Uint8Array;
  userId?: Uint8Array;
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The credential id passkeys made before v2: "zafu:" + SHA-256(rpId)[:8], the
 * same for every zafu user at a relying party. Only recognised, never issued:
 * a relying party that stored one still gets it back (the key is unchanged).
 */
export function legacyCredentialId(rpId: string): Uint8Array {
  const hash = sha256(enc.encode(rpId)).slice(0, 8);
  const prefix = enc.encode('zafu:');
  const id = new Uint8Array(prefix.length + hash.length);
  id.set(prefix, 0);
  id.set(hash, prefix.length);
  return id;
}

/** run `fn` with the relying party's AES-GCM key and zeroize the raw bytes */
const withWrapKey = async <T>(
  identity: Uint8Array,
  rpId: string,
  fn: (raw: Uint8Array, key: CryptoKey) => Promise<T>,
): Promise<T> => {
  const raw = derivePasskeyWrapKey(identity, rpId);
  try {
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(raw), 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
    return await fn(raw, key);
  } finally {
    raw.fill(0);
  }
};

/**
 * A v3 credential id: 0x03 || nonce || AES-GCM(userId), with the rpId as
 * associated data. The nonce is HMAC(key, userId), so one account always gets
 * the same id and it restores from the phrase alone.
 */
export const accountCredentialId = (
  identity: Uint8Array,
  rpId: string,
  userId: Uint8Array,
): Promise<Uint8Array> =>
  withWrapKey(identity, rpId, async (raw, key) => {
    const iv = hmac(sha256, raw, userId).slice(0, NONCE);
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(rpId) },
      key,
      Uint8Array.from(userId),
    );
    return new Uint8Array([V3, ...iv, ...new Uint8Array(sealed)]);
  });

/** the account a v3 id was sealed for, or undefined when it is not this wallet's */
const openCredentialId = (
  identity: Uint8Array,
  rpId: string,
  id: Uint8Array,
): Promise<Uint8Array | undefined> =>
  id[0] !== V3 || id.length < 1 + NONCE + TAG
    ? Promise.resolve(undefined)
    : withWrapKey(identity, rpId, (_raw, key) =>
        crypto.subtle
          .decrypt(
            { name: 'AES-GCM', iv: id.slice(1, 1 + NONCE), additionalData: enc.encode(rpId) },
            key,
            id.slice(1 + NONCE),
          )
          .then(
            plain => new Uint8Array(plain),
            () => undefined,
          ),
      );

/**
 * Which of the ids a relying party listed is a passkey this wallet holds: a
 * v3 id it sealed, the per-rpId (v2) id or the pre-v2 one. Undefined when
 * every id belongs to some other authenticator.
 */
export async function findCredential(
  identity: Uint8Array,
  rpId: string,
  idsHex: readonly string[],
): Promise<Credential | undefined> {
  const perRp = derivePasskeyCredentialId(identity, rpId);
  const legacy = legacyCredentialId(rpId);
  for (const hex of idsHex) {
    const id = hexToBytes(hex.toLowerCase());
    if (equal(id, perRp) || equal(id, legacy)) {
      return { id };
    }
    const userId = await openCredentialId(identity, rpId, id);
    if (userId) {
      return { id, userId };
    }
  }
  return undefined;
}

/**
 * The passkey a sign-in with no credential list answers with: the account
 * this wallet last used here, else the per-rpId passkey.
 */
export const discoverableCredential = async (
  identity: Uint8Array,
  rpId: string,
  userId?: Uint8Array,
): Promise<Credential> =>
  userId?.length
    ? { id: await accountCredentialId(identity, rpId, userId), userId }
    : { id: derivePasskeyCredentialId(identity, rpId) };

/** CBOR-encode a P-256 COSE public key */
function coseP256Key(publicKey: Uint8Array): Uint8Array {
  const x = publicKey.slice(1, 33);
  const y = publicKey.slice(33, 65);
  const buf = new Uint8Array(77); // exact size for map(5) with 2x bstr(32)
  let o = 0;
  buf[o++] = 0xa5; // map(5)
  buf[o++] = 0x01;
  buf[o++] = 0x02; // 1: 2 (kty: EC2)
  buf[o++] = 0x03;
  buf[o++] = 0x26; // 3: -7 (alg: ES256)
  buf[o++] = 0x20;
  buf[o++] = 0x01; // -1: 1 (crv: P-256)
  buf[o++] = 0x21;
  buf[o++] = 0x58;
  buf[o++] = 0x20; // -2: bstr(32)
  buf.set(x, o);
  o += 32;
  buf[o++] = 0x22;
  buf[o++] = 0x58;
  buf[o++] = 0x20; // -3: bstr(32)
  buf.set(y, o);
  return buf;
}

/** build authenticator data bytes */
function authData(
  rpIdHash: Uint8Array,
  flags: number,
  signCount: number,
  attestedCredData?: Uint8Array,
): Uint8Array {
  const base = 32 + 1 + 4;
  const size = base + (attestedCredData?.length ?? 0);
  const buf = new Uint8Array(size);
  let o = 0;
  buf.set(rpIdHash, o);
  o += 32;
  buf[o++] = flags;
  buf[o++] = (signCount >> 24) & 0xff;
  buf[o++] = (signCount >> 16) & 0xff;
  buf[o++] = (signCount >> 8) & 0xff;
  buf[o++] = signCount & 0xff;
  if (attestedCredData) {
    buf.set(attestedCredData, o);
  }
  return buf;
}

/** build attested credential data (AAGUID + credId + COSE key) */
function attestedCredentialData(credentialId: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const cose = coseP256Key(publicKey);
  const buf = new Uint8Array(16 + 2 + credentialId.length + cose.length);
  let o = 0;
  buf.set(ZAFU_AAGUID, o);
  o += 16;
  buf[o++] = (credentialId.length >> 8) & 0xff;
  buf[o++] = credentialId.length & 0xff;
  buf.set(credentialId, o);
  o += credentialId.length;
  buf.set(cose, o);
  return buf;
}

/**
 * create a WebAuthn credential: per account when the relying party names a
 * user, else the per-rpId passkey.
 */
export async function createCredential(
  identity: Uint8Array,
  rpId: string,
  userId: Uint8Array,
  /** the person entered their password for this request (sets UV) */
  verified: boolean,
): Promise<{
  credentialId: Uint8Array;
  authenticatorData: Uint8Array;
  publicKey: Uint8Array;
}> {
  const { id: credentialId, userId: user } = await discoverableCredential(identity, rpId, userId);
  const publicKey = passkeyPublicKey(identity, rpId, user);
  const rpIdHash = sha256(enc.encode(rpId));
  const acd = attestedCredentialData(credentialId, publicKey);
  const ad = authData(rpIdHash, FLAGS.UP | (verified ? FLAGS.UV : 0) | FLAGS.AT, 0, acd);

  return { credentialId, authenticatorData: ad, publicKey };
}

/**
 * sign a WebAuthn assertion: ES256 over authData || clientDataHash, i.e.
 * ECDSA P-256 over SHA-256(authData || clientDataHash), as the spec has it.
 * Called only after the person's tap, which is the presence UP claims. The
 * caller checks clientDataHash against the challenge and the sender's origin
 * first.
 */
export function signAssertion(
  identity: Uint8Array,
  rpId: string,
  credential: Credential,
  clientDataHash: Uint8Array,
  prfSalts: { first: string; second?: string } | undefined,
  /** the person entered their password for this request (sets UV) */
  verified: boolean,
): {
  authenticatorData: Uint8Array;
  signature: Uint8Array;
  prfResults?: { first: Uint8Array; second?: Uint8Array };
} {
  const rpIdHash = sha256(enc.encode(rpId));
  const ad = authData(rpIdHash, FLAGS.UP | (verified ? FLAGS.UV : 0), 0);

  // message to sign: authData || clientDataHash (signPasskey hashes it)
  const message = new Uint8Array(ad.length + clientDataHash.length);
  message.set(ad, 0);
  message.set(clientDataHash, ad.length);

  const user = credential.userId;
  const signature = signPasskey(identity, rpId, message, user);
  const prfResults = prfSalts && {
    first: derivePrf(identity, rpId, prfSalts.first, user),
    second: prfSalts.second ? derivePrf(identity, rpId, prfSalts.second, user) : undefined,
  };

  return { authenticatorData: ad, signature, prfResults };
}
