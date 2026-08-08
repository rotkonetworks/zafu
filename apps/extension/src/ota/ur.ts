/**
 * UR framing for the Zafu firmware-OTA wire contract.
 *
 *   - `ur:zafu-stream` = BC-UR fountain of `[manifest_canonical_cbor ||
 *     image_wrapper]`, type `zafu-stream`, fragmentSize 400. The manifest is
 *     at byte offset 0 of the reassembled buffer.
 *   - `ur:zafu-result` / `ur:zafu-status` = single-segment UR (tiny, fits one QR).
 *
 * Implements encode/decode on top of @ngraveio/bc-ur (a root dep) so the
 * wallet and device interop via the standard BC-UR bytewords + fountain.
 */

import { UR, UREncoder, URDecoder } from '@ngraveio/bc-ur';
import { concat } from './canonical';

export const STREAM_UR_TYPE = 'zafu-stream';
export const RESULT_UR_TYPE = 'zafu-result';
export const STATUS_UR_TYPE = 'zafu-status';

/** Default fountain fragment size (spec §10, practical ~400B/frame). */
export const DEFAULT_FRAGMENT_SIZE = 400;

/** Extra fountain frames beyond the minimum to tolerate loss (spec §10 ~10-20%). */
const REDUNDANCY_FACTOR = 1.2;

/**
 * Reassemble the stream buffer that a BC-UR fountain of a stream was built
 * from: `manifest_canonical_cbor ‖ image_wrapper`.
 */
export function buildStreamPayload(manifestCbor: Uint8Array, imageWrapper: Uint8Array): Uint8Array {
  return concat(manifestCbor, imageWrapper);
}

/**
 * Encode a stream payload into a pool of BC-UR fountain frame strings for an
 * animated QR display. Returns at least the minimum required parts (plus a
 * ~20% redundancy margin so the device can recover lost frames by rescanning).
 */
export function encodeStreamFrames(
  payload: Uint8Array,
  fragmentSize: number = DEFAULT_FRAGMENT_SIZE,
  partsToEmit?: number,
): string[] {
  const ur = new UR(Buffer.from(payload), STREAM_UR_TYPE);
  const encoder = new UREncoder(ur, fragmentSize);
  const minParts = encoder.fragmentsLength;
  const emit = partsToEmit ?? Math.max(2, Math.ceil(minParts * REDUNDANCY_FACTOR));
  const frames: string[] = [];
  for (let i = 0; i < emit; i++) {
    frames.push(encoder.nextPart());
  }
  return frames;
}

/**
 * Decode BC-UR fountain parts back into the reassembled payload bytes.
 *
 * @throws {Error} if the parts are insufficient to reconstruct the message.
 */
export function decodeStream(parts: string[]): Uint8Array {
  const decoder = new URDecoder();
  for (const part of parts) {
    decoder.receivePart(part);
  }
  if (!decoder.isComplete() || !decoder.isSuccess()) {
    throw new Error(`ur:zafu-stream decode incomplete (${parts.length} parts)`);
  }
  const result = decoder.resultUR();
  if (result.type !== STREAM_UR_TYPE) {
    throw new Error(`unexpected UR type '${result.type}', expected '${STREAM_UR_TYPE}'`);
  }
  return new Uint8Array(Buffer.from(result.cbor as Buffer));
}

/** Encode a tiny single-segment UR (used for decode tests + result/status display). */
export function encodeSinglePart(urType: string, bytes: Uint8Array): string {
  const ur = new UR(Buffer.from(bytes), urType);
  return UREncoder.encodeSinglePart(ur);
}

/** Decode a single-segment UR string. */
export function decodeSinglePart(uri: string): { type: string; bytes: Uint8Array } {
  const ur = URDecoder.decode(uri);
  return { type: ur.type, bytes: new Uint8Array(Buffer.from(ur.cbor as Buffer)) };
}

/** Decode a `ur:zafu-result` single-segment string into its raw payload bytes. */
export function decodeResult(uri: string): Uint8Array {
  const { type, bytes } = decodeSinglePart(uri);
  if (type !== RESULT_UR_TYPE) {
    throw new Error(`expected '${RESULT_UR_TYPE}', got '${type}'`);
  }
  return bytes;
}

/** Decode a `ur:zafu-status` single-segment string into its raw payload bytes. */
export function decodeStatus(uri: string): Uint8Array {
  const { type, bytes } = decodeSinglePart(uri);
  if (type !== STATUS_UR_TYPE) {
    throw new Error(`expected '${STATUS_UR_TYPE}', got '${type}'`);
  }
  return bytes;
}
