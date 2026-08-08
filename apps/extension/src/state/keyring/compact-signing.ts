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
  signatures: SignatureContribution[];
}

/**
 * Parse a compact response: tx_type 0x07 (single) or 0x08 (batch).
 * Returns array of {pcztIndex, signatures} for merging back to original PCZTs.
 *
 * Throws on:
 *   - Wrong tx_type (not 0x07 or 0x08)
 *   - Truncated/malformed payload
 *   - Unknown pool values
 */
export function parseCompactResponse(bytes: Uint8Array): CompactResponseMessage[] {
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
  // version = new TextDecoder().decode(bytes.slice(pos, pos + verLen));
  pos += verLen;

  const messages: CompactResponseMessage[] = [];

  if (isSingle) {
    // Single response: just the signatures, no ID
    const sigs = readSignatureContributions(bytes, pos);
    messages.push({
      pcztIndex: 0,
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
      // id = bytes.slice(pos, pos + idLen);
      pos += idLen;

      // For zafu, the id is the PCZT index in the request (but we use positional index i)
      const sigs = readSignatureContributions(bytes, pos);
      messages.push({
        pcztIndex: i,
        signatures: sigs.signatures,
      });
      pos = sigs.nextPos;
    }
  }

  return messages;
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

    // little-endian u32
    const actionIndex =
      bytes[pos + 1]! + (bytes[pos + 2]! << 8) + (bytes[pos + 3]! << 16) + (bytes[pos + 4]! << 24);

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

/**
 * Merge signature contributions back into the original PCZT hex strings.
 * Calls the wasm apply_signature_contributions for each PCZT.
 *
 * @param originalPcztHexes - original PCZT hex strings
 * @param parsed - parsed compact response messages
 * @param wasmApplySignatures - wasm function apply_signature_contributions(pcztHex, contributionsJson): string
 * @returns updated PCZT hex strings with signatures applied
 */
export function mergeContributions(
  originalPcztHexes: string[],
  parsed: CompactResponseMessage[],
  wasmApplySignatures: (pcztHex: string, contributionsJson: string) => string,
): string[] {
  const results: string[] = [];

  for (let i = 0; i < originalPcztHexes.length; i++) {
    const originalHex = originalPcztHexes[i]!;
    const message = parsed.find(m => m.pcztIndex === i);

    if (!message || message.signatures.length === 0) {
      // No signatures for this PCZT - return as-is (fail closed)
      results.push(originalHex);
      continue;
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
      const updatedHex = wasmApplySignatures(originalHex, contributionsJson);
      results.push(updatedHex);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(`failed to apply signatures to PCZT ${i}: ${reason}`);
    }
  }

  return results;
}
