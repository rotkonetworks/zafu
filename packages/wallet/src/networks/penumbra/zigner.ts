/**
 * Penumbra Zigner Cold Wallet Integration
 *
 * Enables importing Penumbra watch-only wallets and signing transactions via QR codes
 * with a Zigner (air-gapped phone) cold wallet.
 *
 * QR Code Types (chain ID 0x03):
 * - 0x01: FVK Export (Zigner → Zafu) - Import viewing key
 * - 0x02: Sign Request (Zafu → Zigner) - Send tx to sign
 * - 0x03: Signatures (Zigner → Zafu) - Receive signatures
 * - 0x12: Schema Update (Zafu → Zigner) - Update action schema
 * - 0x13: Schema Digest (Zafu → Zigner) - Verify schema version
 * - 0x14: Registry Digest (Zafu → Zigner) - Update asset registry
 */

import {
  SUBSTRATE_COMPAT,
  CHAIN_ID_PENUMBRA,
  QR_TYPE,
  type PenumbraFvkExport,
  type PenumbraWalletImport,
  type PenumbraSignRequest,
  type PenumbraSignatureResponse,
} from './types';
import { hexToBytes, bytesToHex, readUint16LE, readUint32LE, writeUint16LE, writeUint32LE } from '../common/qr';

// =============================================================================
// FVK Import (Zigner → Zafu)
// =============================================================================

/**
 * Parse a Zigner Penumbra FVK export QR code
 *
 * QR Format:
 * ```
 * [0x53][0x03][0x01]           - prelude (substrate compat, penumbra, fvk export)
 * [account_index: 4 bytes LE]
 * [label_len: 1 byte]
 * [label: label_len bytes]
 * [wallet_id_len: 1 byte]
 * [wallet_id: wallet_id_len bytes]
 * [fvk_len: 2 bytes LE]
 * [fvk: fvk_len bytes]          - bech32m encoded FVK
 * ```
 */
export function parsePenumbraFvkQR(hex: string): PenumbraFvkExport {
  const data = hexToBytes(hex);

  // validate minimum length
  if (data.length < 10) {
    throw new Error(`Invalid Penumbra FVK QR: too short (${data.length} bytes)`);
  }

  // validate prelude
  if (data[0] !== SUBSTRATE_COMPAT) {
    throw new Error(`Invalid QR: expected 0x53, got 0x${data[0]?.toString(16)}`);
  }
  if (data[1] !== CHAIN_ID_PENUMBRA) {
    throw new Error(`Invalid QR: expected Penumbra chain 0x03, got 0x${data[1]?.toString(16)}`);
  }
  if (data[2] !== QR_TYPE.FVK_EXPORT) {
    throw new Error(`Invalid QR: expected FVK export 0x01, got 0x${data[2]?.toString(16)}`);
  }

  let offset = 3;

  // account index (4 bytes LE)
  const accountIndex = readU32LE(data, offset);
  offset += 4;

  // label
  const labelLen = data[offset]!;
  offset += 1;
  let label: string | null = null;
  if (labelLen > 0) {
    if (offset + labelLen > data.length) {
      throw new Error('Invalid QR: label truncated');
    }
    label = new TextDecoder().decode(data.subarray(offset, offset + labelLen));
    offset += labelLen;
  }

  // wallet id
  const walletIdLen = data[offset]!;
  offset += 1;
  if (offset + walletIdLen > data.length) {
    throw new Error('Invalid QR: wallet ID truncated');
  }
  const walletId = new TextDecoder().decode(data.subarray(offset, offset + walletIdLen));
  offset += walletIdLen;

  // fvk (2 byte length + bech32m string)
  const fvkLen = readU16LE(data, offset);
  offset += 2;
  if (offset + fvkLen > data.length) {
    throw new Error('Invalid QR: FVK truncated');
  }
  const fullViewingKey = new TextDecoder().decode(data.subarray(offset, offset + fvkLen));

  return {
    accountIndex,
    label,
    fullViewingKey,
    walletId,
  };
}

/**
 * Convert parsed FVK export to wallet import format
 */
export function createPenumbraWalletImport(
  exportData: PenumbraFvkExport,
  defaultLabel = 'Penumbra Wallet'
): PenumbraWalletImport {
  return {
    label: exportData.label ?? defaultLabel,
    fullViewingKey: exportData.fullViewingKey,
    accountIndex: exportData.accountIndex,
    walletId: exportData.walletId,
  };
}

/**
 * Check if a QR code is a Penumbra FVK export
 */
export function isPenumbraFvkQR(hex: string): boolean {
  try {
    const data = hexToBytes(hex);
    return (
      data.length >= 10 &&
      data[0] === SUBSTRATE_COMPAT &&
      data[1] === CHAIN_ID_PENUMBRA &&
      data[2] === QR_TYPE.FVK_EXPORT
    );
  } catch {
    return false;
  }
}

// =============================================================================
// Sign Request (Zafu → Zigner)
// =============================================================================

/**
 * Encode a sign request to QR payload
 *
 * Format:
 * ```
 * [0x53][0x03][0x02]           - prelude
 * [account_index: 4 bytes LE]
 * [effect_hash: 32 bytes]
 * [plan_len: 4 bytes LE]
 * [plan: plan_len bytes]       - protobuf encoded TransactionPlan
 * [summary_len: 2 bytes LE]
 * [summary: summary_len bytes]
 * ```
 */
export function encodePenumbraSignRequest(request: PenumbraSignRequest): Uint8Array {
  const summaryBytes = new TextEncoder().encode(request.summary);

  const totalLen =
    3 + // prelude
    4 + // account index
    32 + // effect hash
    4 + // plan length
    request.transactionPlan.length +
    2 + // summary length
    summaryBytes.length;

  const output = new Uint8Array(totalLen);
  let offset = 0;

  // prelude
  output[offset++] = SUBSTRATE_COMPAT;
  output[offset++] = CHAIN_ID_PENUMBRA;
  output[offset++] = QR_TYPE.SIGN_REQUEST;

  // account index
  writeU32LE(output, offset, request.accountIndex);
  offset += 4;

  // effect hash
  output.set(request.effectHash, offset);
  offset += 32;

  // transaction plan
  writeU32LE(output, offset, request.transactionPlan.length);
  offset += 4;
  output.set(request.transactionPlan, offset);
  offset += request.transactionPlan.length;

  // summary
  writeU16LE(output, offset, summaryBytes.length);
  offset += 2;
  output.set(summaryBytes, offset);

  return output;
}

/**
 * Build sign request QR hex string
 */
export function buildSignRequestQR(request: PenumbraSignRequest): string {
  return bytesToHex(encodePenumbraSignRequest(request));
}

// =============================================================================
// Signature Response (Zigner → Zafu)
// =============================================================================

/**
 * Parse signature response from Zigner QR
 *
 * Format:
 * ```
 * [0x53][0x03][0x03]           - prelude
 * [effect_hash: 32 bytes]
 * [auth_sig_count: 2 bytes LE]
 * [auth_sigs: 64 bytes each]   - SpendAuth signatures
 * [binding_sig: 64 bytes]
 * ```
 */
export function parsePenumbraSignatureResponse(hex: string): PenumbraSignatureResponse {
  const data = hexToBytes(hex);

  // validate minimum length: prelude(3) + hash(32) + count(2) + binding(64) = 101
  if (data.length < 101) {
    throw new Error('Invalid Penumbra signature response: too short');
  }

  // validate prelude
  if (
    data[0] !== SUBSTRATE_COMPAT ||
    data[1] !== CHAIN_ID_PENUMBRA ||
    data[2] !== QR_TYPE.SIGNATURES
  ) {
    throw new Error('Invalid Penumbra signature response: bad prelude');
  }

  let offset = 3;

  // effect hash
  const effectHash = new Uint8Array(data.subarray(offset, offset + 32));
  offset += 32;

  // auth signatures
  const authSigCount = readU16LE(data, offset);
  offset += 2;

  const authSigs: Uint8Array[] = [];
  for (let i = 0; i < authSigCount; i++) {
    if (offset + 64 > data.length) {
      throw new Error('Invalid Penumbra signature response: auth sig truncated');
    }
    authSigs.push(new Uint8Array(data.subarray(offset, offset + 64)));
    offset += 64;
  }

  // binding signature
  if (offset + 64 > data.length) {
    throw new Error('Invalid Penumbra signature response: binding sig truncated');
  }
  const bindingSig = new Uint8Array(data.subarray(offset, offset + 64));

  return {
    effectHash,
    authSigs,
    bindingSig,
  };
}

/**
 * Check if a QR code is a Penumbra signature response
 */
export function isPenumbraSignatureQR(hex: string): boolean {
  try {
    const data = hexToBytes(hex);
    return (
      data.length >= 101 &&
      data[0] === SUBSTRATE_COMPAT &&
      data[1] === CHAIN_ID_PENUMBRA &&
      data[2] === QR_TYPE.SIGNATURES
    );
  } catch {
    return false;
  }
}

// =============================================================================
// QR Type Detection
// =============================================================================

/**
 * Detect if a QR code is for Penumbra
 */
export function isPenumbraQR(hex: string): boolean {
  try {
    const data = hexToBytes(hex);
    return data.length >= 3 && data[0] === SUBSTRATE_COMPAT && data[1] === CHAIN_ID_PENUMBRA;
  } catch {
    return false;
  }
}

/**
 * Get the QR type for a Penumbra QR code
 */
export function getPenumbraQRType(
  hex: string
): 'fvk_export' | 'sign_request' | 'signatures' | 'schema_update' | 'schema_digest' | 'registry_digest' | 'unknown' {
  try {
    const data = hexToBytes(hex);
    if (data.length < 3 || data[0] !== SUBSTRATE_COMPAT || data[1] !== CHAIN_ID_PENUMBRA) {
      return 'unknown';
    }

    switch (data[2]) {
      case QR_TYPE.FVK_EXPORT:
        return 'fvk_export';
      case QR_TYPE.SIGN_REQUEST:
        return 'sign_request';
      case QR_TYPE.SIGNATURES:
        return 'signatures';
      case QR_TYPE.SCHEMA_UPDATE:
        return 'schema_update';
      case QR_TYPE.SCHEMA_DIGEST:
        return 'schema_digest';
      case QR_TYPE.REGISTRY_DIGEST:
        return 'registry_digest';
      default:
        return 'unknown';
    }
  } catch {
    return 'unknown';
  }
}

// utility functions imported from ../common/qr
// aliased for backwards compat with existing code
const readU16LE = readUint16LE;
const readU32LE = readUint32LE;
const writeU16LE = writeUint16LE;
const writeU32LE = writeUint32LE;
