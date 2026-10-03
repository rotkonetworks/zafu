/**
 * webauthn authenticator - builds credential responses from ZID-derived P-256 keys.
 *
 * uses the non-rotating passkey derivation path (not ZID rotation).
 * passkeys are long-lived - rotation would lock users out.
 *
 * supports:
 * - credential creation (navigator.credentials.create)
 * - assertion signing (navigator.credentials.get)
 * - PRF extension (hmac-secret for E2E encryption keys)
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  derivePasskeyCredentialId,
  derivePasskeyForSite,
  signPasskey,
  derivePrf,
  DEFAULT_IDENTITY,
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

/**
 * Which of this user's credential ids to answer `get` with: the one the
 * relying party asked for (new or legacy), the new one when it asked for none
 * (a discoverable sign-in), or undefined when every id it listed belongs to
 * some other authenticator.
 */
export function pickCredentialId(
  mnemonic: string,
  rpId: string,
  allowHex: readonly string[] | undefined,
  identity = DEFAULT_IDENTITY,
): Uint8Array | undefined {
  const current = derivePasskeyCredentialId(mnemonic, identity, rpId);
  if (!allowHex?.length) {
    return current;
  }
  const allow = new Set(allowHex.map(h => h.toLowerCase()));
  const legacy = legacyCredentialId(rpId);
  return [current, legacy].find(id => allow.has(bytesToHex(id)));
}

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
 * create a WebAuthn credential.
 */
export function createCredential(
  mnemonic: string,
  rpId: string,
  /** the person entered their password for this request (sets UV) */
  verified: boolean,
  identity = DEFAULT_IDENTITY,
): {
  credentialId: Uint8Array;
  authenticatorData: Uint8Array;
  publicKey: Uint8Array;
} {
  const { publicKey: pubHex } = derivePasskeyForSite(mnemonic, identity, rpId);
  const publicKey = hexToBytes(pubHex);
  const credentialId = derivePasskeyCredentialId(mnemonic, identity, rpId);
  const rpIdHash = sha256(enc.encode(rpId));
  const acd = attestedCredentialData(credentialId, publicKey);
  const ad = authData(rpIdHash, FLAGS.UP | (verified ? FLAGS.UV : 0) | FLAGS.AT, 0, acd);

  return { credentialId, authenticatorData: ad, publicKey };
}

/**
 * sign a WebAuthn assertion: ES256 over authData || clientDataHash, i.e.
 * ECDSA P-256 over SHA-256(authData || clientDataHash), as the spec has it.
 * The caller checks clientDataHash against the challenge and the sender's
 * origin first.
 */
export function signAssertion(
  mnemonic: string,
  rpId: string,
  clientDataHash: Uint8Array,
  prfSalts: { first: string; second?: string } | undefined,
  /** the person entered their password for this request (sets UV) */
  verified: boolean,
  identity = DEFAULT_IDENTITY,
): {
  authenticatorData: Uint8Array;
  signature: Uint8Array;
  prfResults?: { first: Uint8Array; second?: Uint8Array };
} {
  const rpIdHash = sha256(enc.encode(rpId));
  const flags = FLAGS.UP | (verified ? FLAGS.UV : 0);
  const ad = authData(rpIdHash, flags, 0);

  // message to sign: authData || clientDataHash (signPasskey hashes it)
  const message = new Uint8Array(ad.length + clientDataHash.length);
  message.set(ad, 0);
  message.set(clientDataHash, ad.length);

  const { signature } = signPasskey(mnemonic, rpId, message, identity);

  // PRF outputs
  let prfResults: { first: Uint8Array; second?: Uint8Array } | undefined;
  if (prfSalts) {
    const first = derivePrf(mnemonic, identity, rpId, prfSalts.first);
    const second = prfSalts.second
      ? derivePrf(mnemonic, identity, rpId, prfSalts.second)
      : undefined;
    prfResults = { first, second };
  }

  return { authenticatorData: ad, signature: hexToBytes(bytesToHex(signature)), prfResults };
}
