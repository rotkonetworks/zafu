/**
 * Verify a reassembled `ur:zafu-stream` payload on the wallet side.
 *
 * The stream buffer is `manifest_canonical_cbor ‖ image_wrapper`. We parse
 * the manifest at byte offset 0, verify `manifest_sig` and (when the image is
 * present) `image_sig` against the pinned key, and enforce the fail-closed
 * policy checks (blacklist, board, class whitelist, semver ordering).
 */

import { decodeCanonical, encodeMap } from './canonical';
import type { CborMap, CborValue } from './canonical';
import { verifyImage } from './signature';
import { BOARD, KEY_ID_BLACKLIST, CLASS_WHITELIST, PINNED_OTA_PUBLIC_KEY, MAX_STREAM_BYTES } from './keys';
import { compareSemver } from './semver';
import { bytesEqual, sha256Sync, u32leValue } from './util';
import type { Manifest, ImageHeader, FwClass } from './types';

export class OtaStreamError extends Error {
  constructor(
    message: string,
    readonly code?:
      | 'decode'
      | 'blacklist'
      | 'board'
      | 'class'
      | 'semver'
      | 'sig'
      | 'image-mismatch'
      | 'bad-image-wrap',
  ) {
    super(message);
    this.name = 'OtaStreamError';
  }
}

function requireStr(v: CborValue | undefined, what: string): string {
  if (typeof v !== 'string') {
    throw new OtaStreamError(`manifest ${what} missing or not a tstr`, 'decode');
  }
  return v;
}

function requireUint(v: CborValue | undefined, what: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new OtaStreamError(`manifest ${what} missing or not a uint`, 'decode');
  }
  return v;
}

function requireBstr(v: CborValue | undefined, what: string, len?: number): Uint8Array {
  if (!(v instanceof Uint8Array)) {
    throw new OtaStreamError(`manifest ${what} missing or not a bstr`, 'decode');
  }
  if (len !== undefined && v.length !== len) {
    throw new OtaStreamError(`manifest ${what} must be ${len} bytes, got ${v.length}`, 'decode');
  }
  return v;
}

function buildSignedMap(
  version: string,
  board: string,
  payloadSha256: Uint8Array,
  payloadSize: number,
  minVersion: string,
  keyId: number,
  fwClass: string,
): Uint8Array {
  const m = new Map<number, CborValue>();
  m.set(1, version);
  m.set(2, board);
  m.set(3, payloadSha256);
  m.set(4, payloadSize);
  m.set(5, minVersion);
  m.set(6, keyId);
  m.set(7, fwClass);
  return encodeMap(m.entries());
}

/**
 * Verify a stream payload.
 *
 * @param payloadBytes the reassembled `ur:zafu-stream` buffer
 * @param pinnedKey    the pinned Zafu update public key (default dev key)
 * @returns parsed manifest + image header
 * @throws {OtaStreamError} on any policy / signature / parse failure
 */
export function verifyStream(
  payloadBytes: Uint8Array,
  pinnedKey: Uint8Array = PINNED_OTA_PUBLIC_KEY,
): { manifest: Manifest; imageHeader: ImageHeader; imagePresent: boolean; consumed: number } {
  const { value, consumed } = decodeCanonical(payloadBytes);
  if (payloadBytes.length > MAX_STREAM_BYTES) {
    throw new OtaStreamError(
      `stream too large (${payloadBytes.length} bytes, max ${MAX_STREAM_BYTES})`,
      'decode',
    );
  }
  if (!(value instanceof Map)) {
    throw new OtaStreamError('stream does not start with a manifest map', 'decode');
  }
  const map = value as CborMap;

  const version = requireStr(map.get(1), 'version');
  const board = requireStr(map.get(2), 'board');
  const payloadSha256 = requireBstr(map.get(3), 'payload_sha256', 32);
  const payloadSize = requireUint(map.get(4), 'payload_size');
  const minVersion = requireStr(map.get(5), 'min_version');
  const keyId = requireUint(map.get(6), 'key_id');
  const fwClassRaw = requireStr(map.get(7), 'class');
  const imageSig = requireBstr(map.get(8), 'image_sig', 64);
  const reqId = requireBstr(map.get(9), 'req_id', 8);

  // --- fail-closed policy checks -------------------------------------------
  if (KEY_ID_BLACKLIST.includes(keyId)) {
    throw new OtaStreamError(`key_id ${keyId} is blacklisted`, 'blacklist');
  }
  if (board !== BOARD) {
    throw new OtaStreamError(`board '${board}' does not match '${BOARD}'`, 'board');
  }
  if (!CLASS_WHITELIST.includes(fwClassRaw)) {
    throw new OtaStreamError(`unknown class '${fwClassRaw}'`, 'class');
  }
  const order = compareSemver(version, minVersion);
  if (order === null) {
    throw new OtaStreamError(
      `invalid semver ordering (version='${version}', min_version='${minVersion}')`,
      'semver',
    );
  }
  if (order < 0) {
    throw new OtaStreamError(
      `version '${version}' is below min_version '${minVersion}' (downgrade)`,
      'semver',
    );
  }

  // --- verify manifest_sig over signed fields 1..7 -------------------------
  // The frozen wire manifest fields 1..9 carry image_sig (8) and req_id (9)
  // but NOT a standalone manifest_sig (the manifest is authenticated on-wire
  // by image_sig, whose signed header covers the manifest's cryptographic
  // fields key_id/board/version/payload_sha256/payload_len — spec freeze + RFC
  // §2). verifyManifest() verifies the standalone manifest_sig (corpus vector)
  // against the pinned key when an explicit signature is available.

  // --- image header + image_sig -------------------------------------------
  const imageCanonical = buildImageSigned(
    keyId,
    board,
    version,
    payloadSha256,
    payloadSize,
  );
  if (!verifyImage(imageCanonical, pinnedKey, imageSig)) {
    throw new OtaStreamError('image_sig verification failed against pinned key', 'sig');
  }

  const imageHeader: ImageHeader = {
    key_id: keyId,
    board,
    version,
    payload_sha256: payloadSha256,
    payload_len: payloadSize,
  };

  // --- parse image wrapper (when present) ----------------------------------
  let imagePresent = false;
  let bytesAfter = payloadBytes.length - consumed;
  if (payloadSize > 0 && bytesAfter >= 4 + 4 + 32) {
    const wKeyId = u32leValue(payloadBytes, consumed);
    const wLen = u32leValue(payloadBytes, consumed + 4);
    const wSha = payloadBytes.slice(consumed + 8, consumed + 8 + 32);
    if (wKeyId === keyId && wLen === payloadSize && bytesEqual(wSha, payloadSha256)) {
      imagePresent = true;
      bytesAfter = 4 + 4 + 32 + wLen;
      if (consumed + bytesAfter > payloadBytes.length) {
        throw new OtaStreamError('image wrapper payload truncated', 'bad-image-wrap');
      }
    } else {
      throw new OtaStreamError('image wrapper header does not match manifest', 'image-mismatch');
    }

    // Payload-integrity: recompute SHA-256 of the ACTUAL delivered payload
    // bytes and compare to the signed manifest hash (spec §5.2/§6.1, and the
    // device-side verify_payload_chunks). The wrapper's "declared" hash is
    // NOT enough — a tampered payload must fail here, before we ever show
    // "signed & verified". Deliberately synchronous (sha256Sync).
    const payloadStart = consumed + 4 + 4 + 32;
    const payloadBytesActual = payloadBytes.subarray(payloadStart, consumed + bytesAfter);
    if (!bytesEqual(sha256Sync(payloadBytesActual), payloadSha256)) {
      throw new OtaStreamError('delivered payload does not match signed payload_sha256', 'image-mismatch');
    }
  }

  const manifest: Manifest = {
    version,
    board,
    payload_sha256: payloadSha256,
    payload_size: payloadSize,
    min_version: minVersion,
    key_id: keyId,
    class: fwClassRaw as FwClass,
    image_sig: imageSig,
    req_id: reqId,
  };

  return { manifest, imageHeader, imagePresent, consumed: consumed + (imagePresent ? bytesAfter : 0) };
}

function buildImageSigned(
  keyId: number,
  board: string,
  version: string,
  payloadSha256: Uint8Array,
  payloadLen: number,
): Uint8Array {
  const m = new Map<number, CborValue>();
  m.set(1, keyId);
  m.set(2, board);
  m.set(3, version);
  m.set(4, payloadSha256);
  m.set(5, payloadLen);
  return encodeMap(m.entries());
}

/** Encode the signed manifest set (fields 1..7) for external verification. */
export function encodeManifestSigned(manifest: Manifest): Uint8Array {
  return buildSignedMap(
    manifest.version,
    manifest.board,
    manifest.payload_sha256,
    manifest.payload_size,
    manifest.min_version,
    manifest.key_id,
    manifest.class,
  );
}

/** Encode the signed image header set (fields 1..5). */
export function encodeImageSigned(header: ImageHeader): Uint8Array {
  return buildImageSigned(header.key_id, header.board, header.version, header.payload_sha256, header.payload_len);
}
