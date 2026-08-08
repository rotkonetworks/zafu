/**
 * DEV-ONLY producer for the Zafu OTA wire contract.
 *
 * This is the +1 side of the OTA "1-3 MB module over QR" that was missing
 * from zafu: the wallet can now *generate* a genuine signed `ur:zafu-stream`
 * payload from a module/wasm file, exactly as the update server would, so the
 * wallet's own verify→approve→QR path can be exercised end-to-end without a
 * remote HSM.
 *
 * Production: the stream is produced by Zafu engineering on an HSM and served
 * from a real update URL (spec §12). This module exists so the flow actually
 * runs in dev and so tests can prove a real multi-MB stream verifies and
 * round-trips. NEVER ship the dev signing key below in a release build.
 */

import { ed25519 } from '@noble/curves/ed25519';
import { encodeMap, concat } from './canonical';
import { DOMAINS } from './signature';
import { sha256, toHex, u32le } from './util';
import { BOARD, KEY_ID_BLACKLIST } from './keys';
import type { FwClass } from './types';

/** Deterministic dev-only signing key. Public half == PINNED_OTA_PUBLIC_KEY. */
const DEV_SECRET_SEED = 'zafu-ota-dev-key-v1::dev-only-placeholder';

async function devSecretKey(): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(DEV_SECRET_SEED));
  return new Uint8Array(digest); // 32-byte scalar seed
}

async function ed25519Sign(message: Uint8Array, secret: Uint8Array): Promise<Uint8Array> {
  return ed25519.sign(message, secret);
}

export interface ProduceOptions {
  version?: string;
  board?: string;
  minVersion?: string;
  keyId?: number;
  class?: FwClass;
  /** 8-byte session correlation id (random if omitted). */
  reqId?: Uint8Array;
}

export interface ProducedStream {
  /** The assembled `ur:zafu-stream` payload: manifest_cbor ‖ image_wrapper. */
  payload: Uint8Array;
  /** JSON body a dev endpoint returns to `checkForUpdate`. */
  json: { payloadHex: string };
  manifestSig: Uint8Array;
  imageSig: Uint8Array;
}

/**
 * Produce a fully-signed `ur:zafu-stream` payload for `moduleBytes`.
 * Throws if a blacklisted key_id is requested or the class is not whitelisted.
 */
export async function produceStream(
  moduleBytes: Uint8Array,
  opts: ProduceOptions = {},
): Promise<ProducedStream> {
  const version = opts.version ?? '0.9.0';
  const board = opts.board ?? BOARD;
  const minVersion = opts.minVersion ?? '0.8.0';
  const keyId = opts.keyId ?? 1;
  const fwClass = opts.class ?? 'release';
  const reqId = opts.reqId ?? crypto.getRandomValues(new Uint8Array(8));

  if (KEY_ID_BLACKLIST.includes(keyId)) {
    throw new Error(`refusing to produce stream with blacklisted key_id ${keyId}`);
  }
  if (fwClass !== 'release' && fwClass !== 'rollback') {
    throw new Error(`refusing to produce stream with non-whitelisted class '${fwClass}'`);
  }

  const payloadSha256 = await sha256(moduleBytes);
  const payloadSize = moduleBytes.length;
  const secret = await devSecretKey();

  // Signed image header (fields 1..5) -> image_sig
  const imageCanonical = encodeMap([
    [1, keyId],
    [2, board],
    [3, version],
    [4, payloadSha256],
    [5, payloadSize],
  ]);
  const imageMsg = concat(DOMAINS.image, imageCanonical);
  const imageSig = await ed25519Sign(imageMsg, secret);

  // Signed manifest (fields 1..7) -> manifest_sig
  const manifestSigned = encodeMap([
    [1, version],
    [2, board],
    [3, payloadSha256],
    [4, payloadSize],
    [5, minVersion],
    [6, keyId],
    [7, fwClass],
  ]);
  const manifestSig = await ed25519Sign(concat(DOMAINS.manifest, manifestSigned), secret);

  // Frame[0] manifest (fields 1..9)
  const manifestFrame0 = encodeMap([
    [1, version],
    [2, board],
    [3, payloadSha256],
    [4, payloadSize],
    [5, minVersion],
    [6, keyId],
    [7, fwClass],
    [8, imageSig],
    [9, reqId],
  ]);

  // image wrapper (u32le key_id || u32le payload_len || sha256 || payload), NOT CBOR
  const wrapper = concat(u32le(keyId), u32le(payloadSize), payloadSha256, moduleBytes);

  const payload = concat(manifestFrame0, wrapper);
  return {
    payload,
    json: { payloadHex: toHex(payload) },
    manifestSig,
    imageSig,
  };
}
