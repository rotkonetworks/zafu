import {
  AuthorizationData,
  TransactionPlan,
} from '@penumbra-zone/protobuf/penumbra/core/transaction/v1/transaction_pb';
import { blake2b } from '@noble/hashes/blake2b';
import { SpendAuthSignature } from '@penumbra-zone/protobuf/penumbra/crypto/decaf377_rdsa/v1/decaf377_rdsa_pb';
import { EffectHash } from '@penumbra-zone/protobuf/penumbra/core/txhash/v1/txhash_pb';

/**
 * Penumbra Cold Wallet QR Code Integration
 *
 * Enables signing transactions with an air-gapped cold wallet (Parity Signer)
 * via QR codes.
 */

/**
 * Encode a TransactionPlan to hex format for QR code display
 *
 * Format:
 * - Byte 0-2: Prelude (0x53 0x03 0x10)
 * - Byte 3: Metadata count
 * - Byte 4+: Length-prefixed asset name strings
 * - Byte N+: TransactionPlan protobuf bytes
 *
 * Note: Penumbra transactions are very compact (~560 bytes for sends,
 * ~700 bytes for swaps). A single QR code can hold 2900 bytes, so
 * multi-frame encoding is rarely needed.
 *
 * For future large transactions (governance, batches), see cold-wallet-multiframe.ts
 *
 * @param plan - The transaction plan to encode
 * @returns Hex string for QR code
 */
export function encodePlanToQR(plan: TransactionPlan): string {
  // Extract asset denominations from the plan for metadata
  const metadata = extractAssetNames(plan);

  // Prelude: Substrate format (0x53) + Penumbra (0x03) + Transaction (0x10)
  const prelude = new Uint8Array([0x53, 0x03, 0x10]);

  // Encode metadata (asset names)
  const metadataBytes = encodeMetadata(metadata);

  // Serialize the transaction plan to protobuf
  const planBytes = plan.toBinary();

  // Combine all parts
  const payload = new Uint8Array(prelude.length + metadataBytes.length + planBytes.length);
  payload.set(prelude, 0);
  payload.set(metadataBytes, prelude.length);
  payload.set(planBytes, prelude.length + metadataBytes.length);

  // Note: If payload exceeds 2900 bytes (very rare), implement multi-frame
  // using cold-wallet-multiframe.ts. For now, single QR is sufficient.
  if (payload.length > 2900) {
    console.warn(
      `Large transaction (${payload.length} bytes). Consider implementing multi-frame QR.`,
    );
  }

  // Return as hex string
  return bytesToHex(payload);
}

/**
 * Parse AuthorizationData from a scanned QR code hex string
 *
 * Format:
 * - Byte 0-2: Prelude (0x53 0x03 0x10)
 * - Byte 3-66: Effect hash (64 bytes)
 * - Byte 67-68: Spend auth count (uint16 LE)
 * - Byte 69+: Spend signatures (64 bytes each)
 * - Byte M-M+1: Vote auth count (uint16 LE)
 * - Byte M+2+: Vote signatures (64 bytes each)
 *
 * @param hex - Hex string from scanned return QR code
 * @returns AuthorizationData with effect hash and signatures
 */
export function parseAuthorizationQR(hex: string): AuthorizationData {
  const data = hexToBytes(hex);

  // Verify prelude
  if (data.length < 3 || data[0] !== 0x53 || data[1] !== 0x03 || data[2] !== 0x10) {
    throw new Error('Invalid QR code format: bad prelude');
  }

  let offset = 3;

  // Parse effect hash (64 bytes)
  if (data.length < offset + 64) {
    throw new Error('Invalid QR code: missing effect hash');
  }
  const effectHashBytes = new Uint8Array(data.subarray(offset, offset + 64));
  offset += 64;

  // Parse spend auth count (uint16 little-endian)
  if (data.length < offset + 2) {
    throw new Error('Invalid QR code: missing spend auth count');
  }
  const spendCount = readUint16LE(data, offset);
  offset += 2;

  // Parse spend auth signatures
  const spendAuths: SpendAuthSignature[] = [];
  for (let i = 0; i < spendCount; i++) {
    if (data.length < offset + 64) {
      throw new Error(`Invalid QR code: missing spend signature ${i}`);
    }
    const sigBytes = new Uint8Array(data.subarray(offset, offset + 64));
    spendAuths.push(new SpendAuthSignature({ inner: sigBytes }));
    offset += 64;
  }

  // Parse delegator vote count (uint16 little-endian)
  if (data.length < offset + 2) {
    throw new Error('Invalid QR code: missing vote auth count');
  }
  const voteCount = readUint16LE(data, offset);
  offset += 2;

  // Parse delegator vote signatures
  const delegatorVoteAuths: SpendAuthSignature[] = [];
  for (let i = 0; i < voteCount; i++) {
    if (data.length < offset + 64) {
      throw new Error(`Invalid QR code: missing vote signature ${i}`);
    }
    const sigBytes = new Uint8Array(data.subarray(offset, offset + 64));
    delegatorVoteAuths.push(new SpendAuthSignature({ inner: sigBytes }));
    offset += 64;
  }

  return new AuthorizationData({
    effectHash: new EffectHash({ inner: effectHashBytes }),
    spendAuths,
    delegatorVoteAuths,
  });
}

/**
 * Validate that the AuthorizationData matches the TransactionPlan
 *
 * @param plan - Original transaction plan
 * @param auth - Authorization data from cold wallet
 * @throws Error if validation fails
 */
export function validateAuthorization(plan: TransactionPlan, auth: AuthorizationData): void {
  // Compute expected effect hash
  const expectedHash = computeEffectHash(plan);

  // Verify effect hash matches
  if (!auth.effectHash?.inner || !arraysEqual(expectedHash, auth.effectHash.inner)) {
    throw new Error('Effect hash mismatch - signatures do not match transaction plan');
  }

  // Count spend actions in plan
  const spendCount = plan.actions.filter(a => a.action?.case === 'spend').length;

  // Verify spend signature count matches
  if (auth.spendAuths.length !== spendCount) {
    throw new Error(
      `Spend signature count mismatch: expected ${spendCount}, got ${auth.spendAuths.length}`,
    );
  }

  // Count delegator vote actions in plan
  const voteCount = plan.actions.filter(a => a.action?.case === 'delegatorVote').length;

  // Verify vote signature count matches
  if (auth.delegatorVoteAuths.length !== voteCount) {
    throw new Error(
      `Vote signature count mismatch: expected ${voteCount}, got ${auth.delegatorVoteAuths.length}`,
    );
  }
}

/**
 * Compute the effect hash of a transaction plan
 *
 * Effect hash = BLAKE2b-512(plan_bytes)
 *
 * @param plan - Transaction plan to hash
 * @returns 64-byte effect hash
 */
export function computeEffectHash(plan: TransactionPlan): Uint8Array {
  const planBytes = plan.toBinary();
  return blake2b(planBytes, { dkLen: 64 });
}

/**
 * Extract asset denomination names from a transaction plan
 *
 * @param plan - Transaction plan
 * @returns Array of unique asset denomination names
 */
function extractAssetNames(plan: TransactionPlan): string[] {
  const denoms = new Set<string>();

  // TODO: Extract actual asset names from plan actions
  // For now, return common assets as placeholder
  // In production, you'd query the asset registry or parse from actions

  for (const action of plan.actions) {
    // Extract from spend actions
    if (action.action?.case === 'spend') {
      // denoms.add(getAssetName(action.action.value.note?.value?.assetId));
    }
    // Extract from output actions
    if (action.action?.case === 'output') {
      // denoms.add(getAssetName(action.action.value.value?.assetId));
    }
    // Extract from swap actions
    if (action.action?.case === 'swap') {
      // denoms.add(getAssetName(action.action.value.swapPlaintext?.tradingPair?.asset1));
      // denoms.add(getAssetName(action.action.value.swapPlaintext?.tradingPair?.asset2));
    }
  }

  // Fallback: add penumbra if nothing found
  if (denoms.size === 0) {
    denoms.add('penumbra');
  }

  return Array.from(denoms);
}

/**
 * Encode metadata (asset names) to bytes
 *
 * Format:
 * - Byte 0: Count of strings
 * - For each string:
 *   - Byte N: Length of string
 *   - Byte N+1 to N+length: UTF-8 encoded string
 *
 * @param denoms - Array of asset denomination names
 * @returns Encoded metadata bytes
 */
function encodeMetadata(denoms: string[]): Uint8Array {
  // Calculate total size first
  let totalSize = 1; // 1 byte for count
  for (const denom of denoms) {
    const encoded = new TextEncoder().encode(denom);
    totalSize += 1 + encoded.length; // 1 byte for length + string bytes
  }

  // Allocate buffer and write data
  const result = new Uint8Array(totalSize);
  let offset = 0;
  result[offset++] = denoms.length;

  for (const denom of denoms) {
    const encoded = new TextEncoder().encode(denom);
    result[offset++] = encoded.length;
    result.set(encoded, offset);
    offset += encoded.length;
  }

  return result;
}

/**
 * Compare two Uint8Arrays for equality
 */
function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Estimate number of QR codes needed for a payload
 *
 * @param bytes - Size of payload in bytes
 * @returns Estimated number of QR code frames (with raptorq encoding)
 */
export function estimateQRCodeCount(bytes: number): number {
  // QR codes can hold ~2900 bytes per frame with error correction
  const BYTES_PER_QR = 2900;
  return Math.ceil(bytes / BYTES_PER_QR);
}

/**
 * Convert Uint8Array to hex string
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Read uint16 little-endian from Uint8Array
 */
function readUint16LE(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8);
}
