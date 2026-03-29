/**
 * webauthn authenticator — builds credential responses from ZID-derived P-256 keys.
 *
 * supports:
 * - credential creation (navigator.credentials.create)
 * - assertion signing (navigator.credentials.get)
 * - PRF extension (hmac-secret for encryption key derivation)
 *
 * no credential storage — everything is derived from the seed.
 * the credential ID encodes the origin + rotation, so we can re-derive on assertion.
 */

import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { deriveP256ForSite, signP256, derivePrf, DEFAULT_IDENTITY } from './identity';
import type { ZidSitePreference } from './identity';

const enc = new TextEncoder();

/** AAGUID for zafu authenticator (random, identifies us as the authenticator) */
const ZAFU_AAGUID = new Uint8Array([
  0x7a, 0x61, 0x66, 0x75, // "zafu"
  0x2d, 0x70, 0x61, 0x73, // "-pas"
  0x73, 0x6b, 0x65, 0x79, // "skey"
  0x2d, 0x76, 0x31, 0x00, // "-v1\0"
]);

/** flags byte for authenticator data */
const FLAGS = {
  UP: 0x01,    // user present
  UV: 0x04,    // user verified
  AT: 0x40,    // attestation data included
  ED: 0x80,    // extension data included
};

/**
 * build a credential ID that encodes the derivation parameters.
 * format: "zafu:" + origin_hash(8) + ":" + rotation(1)
 * this lets us re-derive the key on assertion without storing anything.
 */
export function buildCredentialId(origin: string, rotation = 0): Uint8Array {
  const originHash = sha256(enc.encode(origin)).slice(0, 8);
  const id = new Uint8Array(14); // "zafu:" (5) + hash (8) + rotation (1)
  id.set(enc.encode('zafu:'), 0);
  id.set(originHash, 5);
  id[13] = rotation;
  return id;
}

/**
 * build authenticator data for a creation response.
 */
function buildAuthData(
  rpIdHash: Uint8Array,
  credentialId: Uint8Array,
  publicKeyBytes: Uint8Array, // uncompressed P-256 (65 bytes: 04 || x || y)
  flags: number,
  signCount = 0,
  extensions?: Uint8Array,
): Uint8Array {
  // COSE key for P-256: { 1: 2, 3: -7, -1: 1, -2: x, -3: y }
  const x = publicKeyBytes.slice(1, 33);
  const y = publicKeyBytes.slice(33, 65);
  const coseKey = buildCoseP256Key(x, y);

  const hasAttestation = (flags & FLAGS.AT) !== 0;
  const hasExtensions = (flags & FLAGS.ED) !== 0;

  let size = 32 + 1 + 4; // rpIdHash + flags + signCount
  if (hasAttestation) {
    size += 16 + 2 + credentialId.length + coseKey.length; // aaguid + credIdLen + credId + coseKey
  }
  if (hasExtensions && extensions) {
    size += extensions.length;
  }

  const authData = new Uint8Array(size);
  let offset = 0;

  authData.set(rpIdHash, offset); offset += 32;
  authData[offset++] = flags;
  // sign count (big-endian u32)
  authData[offset++] = (signCount >> 24) & 0xff;
  authData[offset++] = (signCount >> 16) & 0xff;
  authData[offset++] = (signCount >> 8) & 0xff;
  authData[offset++] = signCount & 0xff;

  if (hasAttestation) {
    authData.set(ZAFU_AAGUID, offset); offset += 16;
    authData[offset++] = (credentialId.length >> 8) & 0xff;
    authData[offset++] = credentialId.length & 0xff;
    authData.set(credentialId, offset); offset += credentialId.length;
    authData.set(coseKey, offset); offset += coseKey.length;
  }

  if (hasExtensions && extensions) {
    authData.set(extensions, offset);
  }

  return authData;
}

/**
 * build a COSE P-256 public key (CBOR-encoded).
 * { 1: 2, 3: -7, -1: 1, -2: x(32), -3: y(32) }
 */
function buildCoseP256Key(x: Uint8Array, y: Uint8Array): Uint8Array {
  // hand-rolled CBOR — map(5)
  const buf = new Uint8Array(2 + 3 + 3 + 3 + 35 + 35); // conservative
  let o = 0;

  buf[o++] = 0xa5; // map(5)

  // 1: 2 (kty: EC2)
  buf[o++] = 0x01; buf[o++] = 0x02;

  // 3: -7 (alg: ES256)
  buf[o++] = 0x03; buf[o++] = 0x26; // -7 = 0x26 in CBOR negint

  // -1: 1 (crv: P-256)
  buf[o++] = 0x20; buf[o++] = 0x01; // -1 = 0x20

  // -2: x (bstr 32)
  buf[o++] = 0x21; // -2
  buf[o++] = 0x58; buf[o++] = 0x20; // bstr(32)
  buf.set(x, o); o += 32;

  // -3: y (bstr 32)
  buf[o++] = 0x22; // -3
  buf[o++] = 0x58; buf[o++] = 0x20; // bstr(32)
  buf.set(y, o); o += 32;

  return buf.slice(0, o);
}

/**
 * create a WebAuthn credential (for navigator.credentials.create).
 */
export function createCredential(
  mnemonic: string,
  rpId: string,
  origin: string,
  challenge: Uint8Array,
  pref?: ZidSitePreference,
): {
  credentialId: Uint8Array;
  authData: Uint8Array;
  publicKey: Uint8Array;
  publicKeyHex: string;
} {
  const rotation = pref?.rotation ?? 0;
  const identity = pref?.identity ?? DEFAULT_IDENTITY;
  const { publicKey: publicKeyHex } = deriveP256ForSite(mnemonic, identity, origin, rotation);
  const publicKey = hexToBytes(publicKeyHex);
  const credentialId = buildCredentialId(origin, rotation);
  const rpIdHash = sha256(enc.encode(rpId));

  const authData = buildAuthData(
    rpIdHash,
    credentialId,
    publicKey,
    FLAGS.UP | FLAGS.UV | FLAGS.AT,
  );

  return { credentialId, authData, publicKey, publicKeyHex };
}

/**
 * sign a WebAuthn assertion (for navigator.credentials.get).
 */
export function signAssertion(
  mnemonic: string,
  rpId: string,
  origin: string,
  clientDataHash: Uint8Array,
  prfSalts?: { first: string; second?: string },
  pref?: ZidSitePreference,
): {
  authData: Uint8Array;
  signature: Uint8Array;
  prfResults?: { first: Uint8Array; second?: Uint8Array };
} {
  const rotation = pref?.rotation ?? 0;
  const identity = pref?.identity ?? DEFAULT_IDENTITY;
  const rpIdHash = sha256(enc.encode(rpId));

  // PRF extension data (if requested)
  let extensionsCbor: Uint8Array | undefined;
  let prfResults: { first: Uint8Array; second?: Uint8Array } | undefined;

  if (prfSalts) {
    const first = derivePrf(mnemonic, identity, origin, prfSalts.first, rotation);
    const second = prfSalts.second
      ? derivePrf(mnemonic, identity, origin, prfSalts.second, rotation)
      : undefined;
    prfResults = { first, second };

    // CBOR encode: { "hmac-secret": { first: bstr, second?: bstr } }
    // simplified — just include the raw bytes for the content script to format
  }

  const flags = FLAGS.UP | FLAGS.UV | (prfResults ? FLAGS.ED : 0);
  const authData = buildAuthData(
    rpIdHash,
    new Uint8Array(0),
    new Uint8Array(65), // not needed for assertion
    flags,
    0,
    extensionsCbor,
  );

  // sign: SHA-256(authData || clientDataHash)
  const signedData = new Uint8Array(authData.length + clientDataHash.length);
  signedData.set(authData, 0);
  signedData.set(clientDataHash, authData.length);
  const hash = sha256(signedData);

  const { signature: sigHex } = signP256(mnemonic, origin, hash, pref);
  const signature = hexToBytes(sigHex);

  return { authData, signature, prfResults };
}
