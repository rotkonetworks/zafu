/**
 * Ed25519 verification for the Zafu firmware-OTA wire contract.
 *
 * Verification only — the wallet NEVER signs firmware. All signatures are
 * over a fixed domain tag (including the leading 0x00, frozen by
 * docs/design/zafu-ota-wire-freeze.md) concatenated with the canonical CBOR
 * of the signed field set.
 *
 * Strictness (RFC 8032, spec §1/§3.3):
 *   - non-canonical S rejected (`{ zip215: false }` on @noble/curves)
 *   - small-order / identity public key rejected at pin time
 *   - constant-time compares
 */

import { ed25519 } from '@noble/curves/ed25519';
import { PINNED_OTA_PUBLIC_KEY } from './keys';
import { toHex, hexToBytes } from './util';

export type Bytes = Uint8Array | string;

function asBytes(v: Bytes): Uint8Array {
  return typeof v === 'string' ? hexToBytes(v) : v;
}

/** Frozen domain tags — the leading 0x00 is part of the signed bytes. */
export const DOMAINS = {
  manifest: new Uint8Array([0x00, ...new TextEncoder().encode('zafu/manifest/v1')]),
  image: new Uint8Array([0x00, ...new TextEncoder().encode('zafu/image/v1')]),
  result: new Uint8Array([0x00, ...new TextEncoder().encode('zafu/result/v1')]),
  status: new Uint8Array([0x00, ...new TextEncoder().encode('zafu/status/v1')]),
  rollback: new Uint8Array([0x00, ...new TextEncoder().encode('zafu/rollback/v1')]),
} as const;

export type DomainName = keyof typeof DOMAINS;

export class OtaVerifyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OtaVerifyError';
  }
}

/**
 * Reject a public key that is the identity or lies on the small-order
 * (torsion) subgroup, per RFC 8032 / spec §3.3. Also requires a valid
 * 32-byte point.
 *
 * @throws {OtaVerifyError} when the key is invalid / small-order.
 */
export function assertValidPinnedKey(publicKey: Uint8Array): void {
  if (publicKey.length !== 32) {
    throw new OtaVerifyError(`ed25519 public key must be 32 bytes, got ${publicKey.length}`);
  }
  let point;
  try {
    point = ed25519.ExtendedPoint.fromHex(publicKey);
  } catch (e) {
    throw new OtaVerifyError('invalid ed25519 public key (not a valid point)', { cause: e });
  }
  // A point lies on the small-order/torsion subgroup iff P*8 == identity.
  // Identity (all-zero encoding) also passes this check → rejected too.
  const cleared = point.multiply(8n).toAffine();
  if (cleared.x === 0n && cleared.y === 1n) {
    throw new OtaVerifyError('rejected small-order / identity ed25519 public key');
  }
}

/**
 * Strict RFC 8032 verification (non-canonical S and small-order pubkeys
 * fail closed via noble `zip215: false`).
 */
function verifyStrict(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== 64) {
    throw new OtaVerifyError(`ed25519 signature must be 64 bytes, got ${signature.length}`);
  }
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch (e) {
    throw new OtaVerifyError('ed25519 verification failed', { cause: e });
  }
}

function signedMessage(domain: DomainName, canonical: Uint8Array): Uint8Array {
  const tag = DOMAINS[domain];
  const out = new Uint8Array(tag.length + canonical.length);
  out.set(tag, 0);
  out.set(canonical, tag.length);
  return out;
}

function verifyDomain(
  domain: DomainName,
  canonical: Bytes,
  signature: Bytes,
  publicKey: Uint8Array,
): boolean {
  const canon = asBytes(canonical);
  const sig = asBytes(signature);
  assertValidPinnedKey(publicKey);
  return verifyStrict(signedMessage(domain, canon), sig, publicKey);
}

/** Verify the signed manifest (fields 1..7 canonical CBOR) against the pinned key. */
export function verifyManifest(
  manifestCanonical: Bytes,
  pinnedKey: Uint8Array = PINNED_OTA_PUBLIC_KEY,
  signature?: Bytes,
): boolean {
  if (signature) {
    return verifyDomain('manifest', manifestCanonical, signature, pinnedKey);
  }
  throw new OtaVerifyError('verifyManifest requires an explicit signature');
}

/** Verify the signed image header (fields 1..5 canonical CBOR) against the pinned key. */
export function verifyImage(
  imageCanonical: Bytes,
  pinnedKey: Uint8Array = PINNED_OTA_PUBLIC_KEY,
  signature?: Bytes,
): boolean {
  if (signature) {
    return verifyDomain('image', imageCanonical, signature, pinnedKey);
  }
  throw new OtaVerifyError('verifyImage requires an explicit signature');
}

/** Verify a device-signed ur:zafu-result (fields 1..5 canonical CBOR) against zid_pubkey. */
export function verifyResult(resultCanonical: Bytes, zidPubkey: Uint8Array, signature?: Bytes): boolean {
  if (signature) {
    return verifyDomain('result', resultCanonical, signature, zidPubkey);
  }
  throw new OtaVerifyError('verifyResult requires an explicit signature');
}

/** Verify a device-signed ur:zafu-status (fields 1..4 canonical CBOR) against zid_pubkey. */
export function verifyStatus(statusCanonical: Bytes, zidPubkey: Uint8Array, signature?: Bytes): boolean {
  if (signature) {
    return verifyDomain('status', statusCanonical, signature, zidPubkey);
  }
  throw new OtaVerifyError('verifyStatus requires an explicit signature');
}

/** Debug/export helper: hex of the signed message for a domain + canonical. */
export function signedMessageHex(domain: DomainName, canonical: Bytes): string {
  return toHex(signedMessage(domain, asBytes(canonical)));
}
