/**
 * Zigner's answer to one PCZT sign request, read back into a signed PCZT.
 *
 * The scanner hands over the CBOR `{1: bytes}` wrap of whatever the device
 * returned. Three shapes ride it:
 *   - `ur:zcash-pczt`: the wrap directly encloses the raw signed PCZT;
 *   - `ur:zigner-module` full: a prelude response `[0x53][0x04][0x03] ||
 *     digest:32 || len:u32(LE) || signed_pczt`;
 *   - `ur:zigner-module` compact: `[0x53][0x04][0x07|0x08]` with spend-auth
 *     signatures only, merged into the PCZT zafu kept.
 *
 * The accepted shape is bound to the request: a compact answer only to a
 * compact request, and a full one only to a full request.
 */

import {
  mergeContributions,
  parseCompactResponse,
  SUPPORTED_COMPACT_RESPONSE_VERSION,
} from '../state/keyring/compact-signing';
import {
  parsePreludeBatchResponse,
  parsePreludeSinglePcztResponse,
  unwrapCborSinglePczt,
} from '../routes/popup/send/zcash-send-cbor-helpers';

export interface ZignerAsked {
  /** the request went out compact (tx_type 0x05) */
  readonly compact: boolean;
  /** the PCZT zafu kept: a compact answer's signatures are merged into it */
  readonly pcztHex: string;
  /** apply signature contributions (JSON) to a PCZT, verifying each; the worker's merge */
  readonly merge: (pcztHex: string, contributionsJson: string) => Promise<string>;
}

const toHex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

const isPrelude = (b: Uint8Array, ...types: number[]) =>
  b.length >= 3 && b[0] === 0x53 && b[1] === 0x04 && types.includes(b[2]!);

/** the full prelude response, or the raw PCZT the legacy wrap holds */
export const signedPcztBytes = (unwrapped: Uint8Array): Uint8Array =>
  isPrelude(unwrapped, 0x03) ? parsePreludeSinglePcztResponse(unwrapped).signedPczt : unwrapped;

/** the signed PCZT (hex) in the device's scanned answer */
export const signedPcztOfAnswer = async (
  scanned: Uint8Array,
  asked: ZignerAsked,
): Promise<string> => {
  const unwrapped = unwrapCborSinglePczt(scanned);

  if (!isPrelude(unwrapped, 0x07, 0x08)) {
    if (asked.compact) {
      throw new Error('zigner answered in an older format · please scan again');
    }
    return toHex(signedPcztBytes(unwrapped));
  }

  if (!asked.compact) {
    throw new Error(
      'received a compact (signatures-only) response but this request was not sent as compact',
    );
  }
  if (!asked.pcztHex) {
    throw new Error('no unsigned PCZT in context for compact merge');
  }
  const { version, messages } = parseCompactResponse(unwrapped);
  if (version !== SUPPORTED_COMPACT_RESPONSE_VERSION) {
    throw new Error(
      `zigner answered in a newer format (${version}, zafu reads ${SUPPORTED_COMPACT_RESPONSE_VERSION}) · please update zafu or zigner`,
    );
  }
  // exactly one PCZT went out, so exactly one message must come back;
  // mergeContributions refuses anything else rather than pass an unsigned PCZT on
  const [merged] = await mergeContributions([asked.pcztHex], messages, asked.merge);
  return merged!;
};

/** the signed PCZTs (hex, request order) in the device's answer to a full batch of `count` */
export const signedPcztsOfBatchAnswer = (scanned: Uint8Array, count: number): string[] =>
  parsePreludeBatchResponse(unwrapCborSinglePczt(scanned), count).map(toHex);
