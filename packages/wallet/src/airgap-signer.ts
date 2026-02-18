import {
  AuthorizationData,
  TransactionPlan,
} from '@penumbra-zone/protobuf/penumbra/core/transaction/v1/transaction_pb';
import { SpendAuthSignature } from '@penumbra-zone/protobuf/penumbra/crypto/decaf377_rdsa/v1/decaf377_rdsa_pb';
import { EffectHash } from '@penumbra-zone/protobuf/penumbra/core/txhash/v1/txhash_pb';

/**
 * Penumbra Cold Wallet QR Code Integration
 *
 * Enables signing transactions with an air-gapped cold wallet (Zigner)
 * via QR codes.
 *
 * QR format (Zigner v2):
 * [0x53][0x03][0x10]             - prelude
 * [metadata]                     - asset names (count + length-prefixed strings)
 * [plan_bytes_len:4 LE]          - length of plan bytes
 * [plan_bytes]                   - raw protobuf plan
 * [effect_hash:64]               - computed effect hash
 * [spend_count:2 LE]             - number of spend randomizers
 * [spend_randomizers:32 each]    - randomizer for each spend
 * [vote_count:2 LE]              - number of vote randomizers
 * [vote_randomizers:32 each]     - randomizer for each vote
 *
 * Zigner response format (NO prelude):
 * [effect_hash:64]               - the effect hash that was signed
 * [spend_auth_count:2 LE]        - spend signature count
 * [spend_auth_sigs:64 each]      - spend signatures
 * [delegator_vote_count:2 LE]    - vote signature count
 * [delegator_vote_sigs:64 each]  - vote signatures
 * [lqt_vote_count:2 LE]          - lqt vote signature count
 * [lqt_vote_sigs:64 each]        - lqt vote signatures
 */

/**
 * Encode a TransactionPlan to hex format for QR code display.
 * The effectHash must be pre-computed using WASM (computeEffectHash from @rotko/penumbra-wasm)
 * since it requires the FullViewingKey to build the correct Penumbra structured hash.
 */
export function encodePlanToQR(plan: TransactionPlan, effectHash: Uint8Array): string {
  if (effectHash.length !== 64) {
    throw new Error(`Effect hash must be 64 bytes, got ${effectHash.length}`);
  }

  const metadata = extractAssetNames(plan);

  // Prelude: Substrate format (0x53) + Penumbra (0x03) + Transaction (0x10)
  const prelude = new Uint8Array([0x53, 0x03, 0x10]);

  // Encode metadata (asset names)
  const metadataBytes = encodeMetadata(metadata);

  // Serialize the transaction plan to protobuf
  const planBytes = plan.toBinary();

  // Plan length as 4-byte LE
  const planLenBytes = new Uint8Array(4);
  new DataView(planLenBytes.buffer).setUint32(0, planBytes.length, true);

  // Extract randomizers from plan actions
  const spendRandomizers = extractSpendRandomizers(plan);
  const voteRandomizers = extractVoteRandomizers(plan);

  // Spend count (2-byte LE) + randomizers
  const spendCountBytes = new Uint8Array(2);
  new DataView(spendCountBytes.buffer).setUint16(0, spendRandomizers.length, true);

  // Vote count (2-byte LE) + randomizers
  const voteCountBytes = new Uint8Array(2);
  new DataView(voteCountBytes.buffer).setUint16(0, voteRandomizers.length, true);

  // Calculate total size
  const totalSize =
    prelude.length +
    metadataBytes.length +
    4 + // plan length prefix
    planBytes.length +
    64 + // effect hash
    2 + spendRandomizers.length * 32 + // spend randomizers
    2 + voteRandomizers.length * 32; // vote randomizers

  // Combine all parts
  const payload = new Uint8Array(totalSize);
  let offset = 0;

  payload.set(prelude, offset);
  offset += prelude.length;

  payload.set(metadataBytes, offset);
  offset += metadataBytes.length;

  payload.set(planLenBytes, offset);
  offset += 4;

  payload.set(planBytes, offset);
  offset += planBytes.length;

  payload.set(effectHash, offset);
  offset += 64;

  payload.set(spendCountBytes, offset);
  offset += 2;
  for (const r of spendRandomizers) {
    payload.set(r, offset);
    offset += 32;
  }

  payload.set(voteCountBytes, offset);
  offset += 2;
  for (const r of voteRandomizers) {
    payload.set(r, offset);
    offset += 32;
  }

  if (payload.length > 2900) {
    console.warn(
      `Large transaction (${payload.length} bytes). Consider implementing multi-frame QR.`,
    );
  }

  return bytesToHex(payload);
}

/**
 * Parse AuthorizationData from a scanned QR code hex string
 *
 * Zigner response format (NO prelude):
 * [effect_hash:64] [spend_count:2 LE] [spend_sigs:64 each]
 * [vote_count:2 LE] [vote_sigs:64 each]
 * [lqt_count:2 LE] [lqt_sigs:64 each]
 */
export function parseAuthorizationQR(hex: string): AuthorizationData {
  const data = hexToBytes(hex);
  let offset = 0;

  // Parse effect hash (64 bytes) - no prelude in Zigner response
  if (data.length < 64) {
    throw new Error('Invalid authorization QR: too short for effect hash');
  }
  const effectHashBytes = new Uint8Array(data.subarray(offset, offset + 64));
  offset += 64;

  // Parse spend auth count (uint16 LE)
  if (data.length < offset + 2) {
    throw new Error('Invalid authorization QR: missing spend auth count');
  }
  const spendCount = readUint16LE(data, offset);
  offset += 2;

  // Parse spend auth signatures
  const spendAuths: SpendAuthSignature[] = [];
  for (let i = 0; i < spendCount; i++) {
    if (data.length < offset + 64) {
      throw new Error(`Invalid authorization QR: missing spend signature ${i}`);
    }
    spendAuths.push(new SpendAuthSignature({ inner: new Uint8Array(data.subarray(offset, offset + 64)) }));
    offset += 64;
  }

  // Parse delegator vote count (uint16 LE)
  if (data.length < offset + 2) {
    throw new Error('Invalid authorization QR: missing vote auth count');
  }
  const voteCount = readUint16LE(data, offset);
  offset += 2;

  // Parse delegator vote signatures
  const delegatorVoteAuths: SpendAuthSignature[] = [];
  for (let i = 0; i < voteCount; i++) {
    if (data.length < offset + 64) {
      throw new Error(`Invalid authorization QR: missing vote signature ${i}`);
    }
    delegatorVoteAuths.push(new SpendAuthSignature({ inner: new Uint8Array(data.subarray(offset, offset + 64)) }));
    offset += 64;
  }

  // Skip lqt vote signatures if present (not used in AuthorizationData proto)
  // Zigner encodes them but the protobuf doesn't have a field for them yet

  return new AuthorizationData({
    effectHash: new EffectHash({ inner: effectHashBytes }),
    spendAuths,
    delegatorVoteAuths,
  });
}

/**
 * Validate that the AuthorizationData matches the expected effect hash and plan structure.
 * The expectedEffectHash must be pre-computed using WASM.
 */
export function validateAuthorization(plan: TransactionPlan, auth: AuthorizationData, expectedEffectHash: Uint8Array): void {
  if (!auth.effectHash?.inner || !arraysEqual(expectedEffectHash, auth.effectHash.inner)) {
    throw new Error('Effect hash mismatch - signatures do not match transaction plan');
  }

  const spendCount = plan.actions.filter(a => a.action?.case === 'spend').length;
  if (auth.spendAuths.length !== spendCount) {
    throw new Error(
      `Spend signature count mismatch: expected ${spendCount}, got ${auth.spendAuths.length}`,
    );
  }

  const voteCount = plan.actions.filter(a => a.action?.case === 'delegatorVote').length;
  if (auth.delegatorVoteAuths.length !== voteCount) {
    throw new Error(
      `Vote signature count mismatch: expected ${voteCount}, got ${auth.delegatorVoteAuths.length}`,
    );
  }
}

/**
 * Estimate number of QR codes needed for a payload
 */
export function estimateQRCodeCount(bytes: number): number {
  const BYTES_PER_QR = 2900;
  return Math.ceil(bytes / BYTES_PER_QR);
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Extract spend randomizers from plan actions (32 bytes each)
 */
function extractSpendRandomizers(plan: TransactionPlan): Uint8Array[] {
  const randomizers: Uint8Array[] = [];
  for (const action of plan.actions) {
    if (action.action?.case === 'spend') {
      const r = action.action.value.randomizer;
      if (r && r.length === 32) {
        randomizers.push(r);
      }
    }
  }
  return randomizers;
}

/**
 * Extract delegator vote randomizers from plan actions (32 bytes each)
 */
function extractVoteRandomizers(plan: TransactionPlan): Uint8Array[] {
  const randomizers: Uint8Array[] = [];
  for (const action of plan.actions) {
    if (action.action?.case === 'delegatorVote') {
      const r = action.action.value.randomizer;
      if (r && r.length === 32) {
        randomizers.push(r);
      }
    }
  }
  return randomizers;
}

/**
 * Extract asset denomination names from a transaction plan
 */
function extractAssetNames(plan: TransactionPlan): string[] {
  const denoms = new Set<string>();

  for (const action of plan.actions) {
    if (action.action?.case === 'spend') {
      // placeholder - actual name extraction would need registry lookup
    }
    if (action.action?.case === 'output') {
      // placeholder
    }
  }

  if (denoms.size === 0) {
    denoms.add('penumbra');
  }

  return Array.from(denoms);
}

/**
 * Encode metadata (asset names) to bytes
 *
 * Format: [count:1] [len:1 + name_bytes]...
 */
function encodeMetadata(denoms: string[]): Uint8Array {
  let totalSize = 1;
  for (const denom of denoms) {
    const encoded = new TextEncoder().encode(denom);
    totalSize += 1 + encoded.length;
  }

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

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;

  if (cleanHex.length % 2 !== 0) {
    throw new Error(`invalid hex: odd length (${cleanHex.length})`);
  }
  if (!/^[0-9a-fA-F]*$/.test(cleanHex)) {
    throw new Error('invalid hex: contains non-hex characters');
  }

  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function readUint16LE(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8);
}
