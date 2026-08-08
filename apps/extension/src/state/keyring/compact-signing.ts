/**
 * Compact PCZT signing module for zafu.
 *
 * Implements the compact signatures-only flow for Zcash PCZT signing via zigner.
 *
 * Zigner's prelude envelope:
 *   0x53 = prelude marker
 *   0x04 = crypto type (zcash)
 *   0x05 = single compact request
 *   0x06 = batch compact request (max 40)
 *   0x07 = single compact response
 *   0x08 = batch compact response
 *
 * Request format (body layout identical to non-compact 0x03/0x04):
 *   single:  [0x53][0x04][0x05] || pczt_bytes
 *   batch:   [0x53][0x04][0x06] || count:u8 ||
 *            count * (id_len:u8 || id || pczt_len:u32(LE) || pczt_bytes)
 *
 * Response format (compact signatures-only):
 *   single:  [0x53][0x04][0x07] || ver_len:u8 || version ||
 *            sig_count:u16(LE) || sig_count * (pool:u8 || action_index:u32(LE) || signature:64)
 *   batch:   [0x53][0x04][0x08] || ver_len:u8 || version || count:u8 ||
 *            count * (id_len:u8 || id || sig_count:u16(LE) ||
 *                     sig_count * (pool:u8 || action_index:u32(LE) || signature:64))
 *
 * Pool enum (matches pczt::orchard::ValuePool):
 *   0 = Orchard
 *   1 = Ironwood
 */

const PRELUDE_MARKER = 0x53;
const CRYPTO_TYPE_ZCASH = 0x04;
const TX_TYPE_SINGLE_COMPACT = 0x05;
const TX_TYPE_BATCH_COMPACT = 0x06;
const TX_TYPE_SINGLE_COMPACT_RESPONSE = 0x07;
const TX_TYPE_BATCH_COMPACT_RESPONSE = 0x08;
const BATCH_MAX_MESSAGES = 40;

export const POOL_ORCHARD = 0;
export const POOL_IRONWOOD = 1;

/**
 * One spend-authorization signature for one action.
 */
export interface SignatureContribution {
  pool: number; // 0 = Orchard, 1 = Ironwood
  actionIndex: number;
  signature: Uint8Array; // 64 bytes
}

/**
 * One message in the response: contains signatures for one PCZT.
 */
export interface CompactResponseMessage {
  pcztIndex: number;
  /** Echoed request id for this message (batch only; empty for single requests
   * and for legacy callers that never sent ids). */
  id: Uint8Array;
  signatures: SignatureContribution[];
}

/**
 * A parsed compact response: the wire version prefix plus the per-PCZT
 * signature messages. Mirrors envelope.rs's `CompactResponse`.
 *
 * The version prefix (envelope.rs:80-83, `COMPACT_RESPONSE_VERSION`) exists
 * so the wallet can refuse to merge a response shape it doesn't understand -
 * callers MUST check `version` against the version(s) they know how to merge
 * before calling `mergeContributions`.
 */
export interface ParsedCompactResponse {
  version: string;
  messages: CompactResponseMessage[];
}

/** Wire version this module knows how to merge. Bump only in lockstep with a
 * change to `mergeContributions` / the wasm merge side. */
export const SUPPORTED_COMPACT_RESPONSE_VERSION = '1';

/**
 * Parse a compact response: tx_type 0x07 (single) or 0x08 (batch).
 * Returns the wire version plus an array of {pcztIndex, id, signatures} for
 * merging back to original PCZTs.
 *
 * Throws on:
 *   - Wrong tx_type (not 0x07 or 0x08)
 *   - Truncated/malformed payload
 *   - Unknown pool values
 *
 * Does NOT enforce the version or reject empty signature sets - those are
 * business-level checks the caller makes (version: before calling this
 * function's result into `mergeContributions`; empty signatures:
 * `mergeContributions` itself fails closed on those, see there).
 */
export function parseCompactResponse(bytes: Uint8Array): ParsedCompactResponse {
  if (bytes.length < 3) {
    throw new Error('compact response too short');
  }

  if (bytes[0] !== PRELUDE_MARKER) {
    throw new Error(`expected prelude 0x53, got 0x${(bytes[0] ?? 0).toString(16)}`);
  }

  if (bytes[1] !== CRYPTO_TYPE_ZCASH) {
    throw new Error(`expected crypto type 0x04, got 0x${(bytes[1] ?? 0).toString(16)}`);
  }

  const txType = bytes[2];
  const isSingle = txType === TX_TYPE_SINGLE_COMPACT_RESPONSE;
  const isBatch = txType === TX_TYPE_BATCH_COMPACT_RESPONSE;

  if (!isSingle && !isBatch) {
    throw new Error(`unknown compact response tx_type 0x${(txType ?? 0).toString(16)}`);
  }

  let pos = 3;

  // Parse version string
  if (pos >= bytes.length) {
    throw new Error('compact response truncated at version length');
  }
  const verLen = bytes[pos]!;
  pos += 1;

  if (pos + verLen > bytes.length) {
    throw new Error('compact response truncated at version data');
  }
  const version = new TextDecoder().decode(bytes.slice(pos, pos + verLen));
  pos += verLen;

  const messages: CompactResponseMessage[] = [];

  if (isSingle) {
    // Single response: just the signatures, no ID
    const sigs = readSignatureContributions(bytes, pos);
    messages.push({
      pcztIndex: 0,
      id: new Uint8Array(0),
      signatures: sigs.signatures,
    });
  } else {
    // Batch response: count + (id_len + id + signatures) per message
    if (pos >= bytes.length) {
      throw new Error('compact batch response truncated at count');
    }
    const count = bytes[pos]!;
    pos += 1;

    if (count === 0 || count > BATCH_MAX_MESSAGES) {
      throw new Error(`invalid batch count ${count}`);
    }

    for (let i = 0; i < count; i++) {
      if (pos >= bytes.length) {
        throw new Error(`compact batch response truncated at message ${i} id length`);
      }
      const idLen = bytes[pos]!;
      pos += 1;

      if (pos + idLen > bytes.length) {
        throw new Error(`compact batch response truncated at message ${i} id data`);
      }
      const id = bytes.slice(pos, pos + idLen);
      pos += idLen;

      // The id is echoed from the request message at this position; zafu's
      // caller correlates positionally (pcztIndex: i) and, when it sent
      // non-empty ids, additionally verifies the echo matches (see
      // `mergeContributions`'s `expectedIds` option).
      const sigs = readSignatureContributions(bytes, pos);
      messages.push({
        pcztIndex: i,
        id,
        signatures: sigs.signatures,
      });
      pos = sigs.nextPos;
    }
  }

  return { version, messages };
}

/**
 * Parse signature contributions from position in buffer.
 * Returns {signatures, nextPos}.
 */
function readSignatureContributions(
  bytes: Uint8Array,
  pos: number,
): { signatures: SignatureContribution[]; nextPos: number } {
  if (pos + 2 > bytes.length) {
    throw new Error('compact response truncated at signature count');
  }

  // little-endian u16
  const sigCount = bytes[pos]! + (bytes[pos + 1]! << 8);
  pos += 2;

  const signatures: SignatureContribution[] = [];
  for (let i = 0; i < sigCount; i++) {
    if (pos + 1 + 4 + 64 > bytes.length) {
      throw new Error(`compact response truncated at signature ${i}`);
    }

    const pool = bytes[pos]!;
    if (pool !== POOL_ORCHARD && pool !== POOL_IRONWOOD) {
      throw new Error(`unknown pool value ${pool}`);
    }

    // little-endian u32. Accumulate with `+ b * 256^n` rather than `<< 8` /
    // `<< 24`: JS bitwise ops are signed 32-bit, so a top byte >= 0x80 would
    // sign-extend the result to a NEGATIVE action_index (e.g. action_index
    // 0x80000000 on the wire would decode to -2147483648), silently
    // corrupting which action the signature gets merged into. Multiplication
    // keeps the value a positive JS number. Mirrors the length-decoding idiom
    // in zcash-send-cbor-helpers.ts's `readLen`.
    const actionIndex =
      bytes[pos + 1]! +
      bytes[pos + 2]! * 256 +
      bytes[pos + 3]! * 65536 +
      bytes[pos + 4]! * 16777216;

    if (!Number.isSafeInteger(actionIndex) || actionIndex < 0) {
      throw new Error(`decoded action_index ${actionIndex} is not a safe non-negative integer`);
    }

    const signature = bytes.slice(pos + 5, pos + 5 + 64);

    signatures.push({
      pool,
      actionIndex,
      signature,
    });

    pos += 1 + 4 + 64;
  }

  return { signatures, nextPos: pos };
}

/**
 * Build a compact request for sending to zigner.
 *
 * @param pcztHexes - array of PCZT bytes as hex strings
 * @returns envelope bytes ready for ur_encode_frames with prelude
 *
 * Single: [0x53][0x04][0x05] || pczt_bytes
 * Batch (max 40): [0x53][0x04][0x06] || count:u8 || (pczt_len:u32(LE) || pczt_bytes)*
 *
 * For zafu, we don't use message IDs in batch, so id_len=0.
 */
export function buildCompactRequest(pcztHexes: string[]): Uint8Array {
  if (pcztHexes.length === 0) {
    throw new Error('at least one PCZT required');
  }

  if (pcztHexes.length > BATCH_MAX_MESSAGES) {
    throw new Error(`batch size ${pcztHexes.length} exceeds max ${BATCH_MAX_MESSAGES}`);
  }

  // Convert hex strings to bytes
  const pcztBytes = pcztHexes.map(hex => {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
  });

  const isSingle = pcztBytes.length === 1;

  if (isSingle) {
    // Single request: prelude + pczt_bytes
    const out = new Uint8Array(3 + pcztBytes[0]!.length);
    out[0] = PRELUDE_MARKER;
    out[1] = CRYPTO_TYPE_ZCASH;
    out[2] = TX_TYPE_SINGLE_COMPACT;
    out.set(pcztBytes[0]!, 3);
    return out;
  } else {
    // Batch request: prelude + count + (id_len:0 + pczt_len:u32(LE) + pczt_bytes)*
    let totalSize = 3 + 1; // prelude + count
    for (const pczt of pcztBytes) {
      totalSize += 1 + 4 + pczt.length; // id_len (0) + pczt_len + pczt_bytes
    }

    const out = new Uint8Array(totalSize);
    out[0] = PRELUDE_MARKER;
    out[1] = CRYPTO_TYPE_ZCASH;
    out[2] = TX_TYPE_BATCH_COMPACT;
    out[3] = pcztBytes.length;

    let pos = 4;
    for (const pczt of pcztBytes) {
      out[pos] = 0; // id_len = 0
      pos += 1;

      // pczt_len as little-endian u32
      const len = pczt.length;
      out[pos] = len & 0xff;
      out[pos + 1] = (len >> 8) & 0xff;
      out[pos + 2] = (len >> 16) & 0xff;
      out[pos + 3] = (len >> 24) & 0xff;
      pos += 4;

      out.set(pczt, pos);
      pos += pczt.length;
    }

    return out;
  }
}

/** Options that let a caller bind a compact response to what it actually sent. */
export interface MergeContributionsOptions {
  /**
   * The request id sent for each PCZT, positional (index i = the id sent for
   * `originalPcztHexes[i]`). Pass `undefined` (or an empty array) for a
   * caller that doesn't use ids - e.g. zafu today always sends `id_len=0`.
   * When an entry here is non-empty, the echoed `id` on the matching
   * response message MUST match byte-for-byte or the merge throws.
   */
  expectedIds?: (Uint8Array | undefined)[];
  /**
   * The number of shielded actions in each original PCZT, positional, if
   * known to the caller. When present, a signature whose `actionIndex` falls
   * outside `[0, actionCounts[i])` is rejected as out of range instead of
   * being merged.
   */
  actionCounts?: number[];
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Merge signature contributions back into the original PCZT hex strings.
 * Calls the wasm apply_signature_contributions for each PCZT.
 *
 * Fails CLOSED - never silently returns an original, unmerged PCZT as if
 * signing had succeeded. A device that has nothing to contribute for a PCZT
 * is expected to error rather than emit an empty contribution set (see
 * envelope.rs); on the wallet side a missing message or an empty signature
 * set for a requested PCZT is therefore always an error, not a pass-through.
 *
 * @param originalPcztHexes - original PCZT hex strings, in request order
 * @param messages - parsed compact response messages (`ParsedCompactResponse.messages`)
 * @param wasmApplySignatures - apply_signature_contributions(pcztHex, contributionsJson).
 *   May be sync (direct wasm) or async (dispatched to the worker that owns the
 *   wasm instance); both are awaited.
 * @param options - optional id / action-count binding, see `MergeContributionsOptions`
 * @returns updated PCZT hex strings with signatures applied
 */
export async function mergeContributions(
  originalPcztHexes: string[],
  messages: CompactResponseMessage[],
  wasmApplySignatures: (pcztHex: string, contributionsJson: string) => string | Promise<string>,
  options: MergeContributionsOptions = {},
): Promise<string[]> {
  if (messages.length !== originalPcztHexes.length) {
    throw new Error(
      `compact response carries ${messages.length} message(s) but ${originalPcztHexes.length} PCZT(s) were sent`,
    );
  }

  const results: string[] = [];

  for (let i = 0; i < originalPcztHexes.length; i++) {
    const originalHex = originalPcztHexes[i]!;
    const message = messages.find(m => m.pcztIndex === i);

    if (!message) {
      throw new Error(`compact response is missing signatures for PCZT ${i}`);
    }

    if (message.signatures.length === 0) {
      // A zero-signature message for a PCZT we asked to sign is never valid:
      // the device now errors instead of emitting one, so seeing one here
      // means the response was tampered with or the device is misbehaving.
      // Do NOT pass the original PCZT through as if it had been signed.
      throw new Error(`compact response contains zero signatures for PCZT ${i}`);
    }

    const expectedId = options.expectedIds?.[i];
    if (expectedId && expectedId.length > 0 && !bytesEqual(message.id, expectedId)) {
      throw new Error(`compact response id mismatch for PCZT ${i}`);
    }

    const actionCount = options.actionCounts?.[i];
    const seen = new Set<string>();
    for (const sig of message.signatures) {
      const key = `${sig.pool}:${sig.actionIndex}`;
      if (seen.has(key)) {
        throw new Error(
          `compact response has duplicate signature for pool ${sig.pool} action ${sig.actionIndex} in PCZT ${i}`,
        );
      }
      seen.add(key);

      if (actionCount !== undefined && (sig.actionIndex < 0 || sig.actionIndex >= actionCount)) {
        throw new Error(
          `compact response action_index ${sig.actionIndex} out of range [0, ${actionCount}) for PCZT ${i}`,
        );
      }
    }

    // Convert signatures to JSON format expected by wasm
    const contributionsJson = JSON.stringify({
      contributions: message.signatures.map(sig => ({
        pool: sig.pool,
        action_index: sig.actionIndex,
        signature: Array.from(sig.signature),
      })),
    });

    try {
      const updatedHex = await wasmApplySignatures(originalHex, contributionsJson);
      results.push(updatedHex);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(`failed to apply signatures to PCZT ${i}: ${reason}`);
    }
  }

  return results;
}
