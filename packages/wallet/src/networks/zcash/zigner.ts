/**
 * Zcash Zigner Cold Wallet Integration
 *
 * Enables importing Zcash watch-only wallets and signing transactions via QR codes
 * with a Zigner (air-gapped phone) cold wallet.
 *
 * QR Code Types (chain ID 0x04):
 * - 0x01: FVK Export (Zigner → Zafu) - Import viewing key
 * - 0x02: Sign Request (Zafu → Zigner) - Send tx to sign
 * - 0x03: Signatures (Zigner → Zafu) - Receive signatures
 */

import {
  hexToBytes,
  bytesToHex,
  readUint16LE,
  readUint32LE,
  writeUint16LE,
  writeUint32LE,
  SUBSTRATE_COMPAT,
} from '../common/qr';
import { CHAIN_IDS, QR_TYPES } from '../common/types';

// re-export for backwards compat
export { SUBSTRATE_COMPAT };

/** Chain IDs for different networks */
export const CHAIN_ID = {
  PENUMBRA: CHAIN_IDS.PENUMBRA,
  ZCASH: CHAIN_IDS.ZCASH,
} as const;

/** QR operation types */
export const QR_TYPE = {
  FVK_EXPORT: QR_TYPES.FVK_EXPORT,
  SIGN_REQUEST: QR_TYPES.SIGN_REQUEST,
  SIGNATURES: QR_TYPES.SIGNATURES,
} as const;

// ============================================================================
// Zcash FVK Export Types
// ============================================================================

/**
 * Data extracted from a Zigner Zcash FVK export QR code
 */
export interface ZcashFvkExportData {
  /** BIP44 account index used in Zigner */
  accountIndex: number;
  /** Optional wallet label from Zigner */
  label: string | null;
  /** Orchard FVK bytes (96 bytes) - if present */
  orchardFvk: Uint8Array | null;
  /** Transparent xpub bytes - if present */
  transparentXpub: Uint8Array | null;
  /** Network: true = mainnet, false = testnet */
  mainnet: boolean;
}

/**
 * Parsed Zcash wallet ready for import
 */
export interface ZcashWalletImport {
  /** Wallet label (from QR or default) */
  label: string;
  /** Orchard FVK bytes (96 bytes) */
  orchardFvk: Uint8Array | null;
  /** Original account index from Zigner */
  accountIndex: number;
  /** Network: true = mainnet, false = testnet */
  mainnet: boolean;
}

// ============================================================================
// Zcash FVK Import Functions
// ============================================================================

/**
 * Parse a Zigner Zcash FVK export QR code
 *
 * QR Format (from Zigner):
 * ```
 * [0x53][0x04][0x01]           - prelude (substrate compat, zcash, fvk export)
 * [flags: 1 byte]              - bit 0: mainnet, bit 1: has orchard, bit 2: has transparent
 * [account_index: 4 bytes LE]
 * [label_len: 1 byte]
 * [label: label_len bytes]
 * [orchard_fvk: 96 bytes]      - if has orchard
 * [transparent_xpub_len: 1]    - if has transparent
 * [transparent_xpub: n bytes]  - if has transparent
 * ```
 *
 * @param hex - Hex string from scanned QR code
 * @returns Parsed FVK export data
 * @throws Error if QR format is invalid
 */
export function parseZcashFvkQR(hex: string): ZcashFvkExportData {
  const data = hexToBytes(hex);

  // Validate minimum length: 3 (prelude) + 1 (flags) + 4 (account) + 1 (label_len) = 9
  if (data.length < 9) {
    throw new Error(`Invalid Zcash FVK QR: too short (${data.length} bytes, need at least 9)`);
  }

  // Validate prelude
  if (data[0] !== SUBSTRATE_COMPAT) {
    throw new Error(`Invalid Zcash QR: expected 0x53, got 0x${data[0]?.toString(16)}`);
  }
  if (data[1] !== CHAIN_ID.ZCASH) {
    throw new Error(`Invalid Zcash QR: expected Zcash chain 0x04, got 0x${data[1]?.toString(16)}`);
  }
  if (data[2] !== QR_TYPE.FVK_EXPORT) {
    throw new Error(`Invalid Zcash QR: expected FVK export type 0x01, got 0x${data[2]?.toString(16)}`);
  }

  let offset = 3;

  // Parse flags
  const flags = data[offset]!;
  offset += 1;
  const mainnet = (flags & 0x01) !== 0;
  const hasOrchard = (flags & 0x02) !== 0;
  const hasTransparent = (flags & 0x04) !== 0;

  // Parse account index (4 bytes LE)
  const accountIndex = readUint32LE(data, offset);
  offset += 4;

  // Parse label
  const labelLen = data[offset]!;
  offset += 1;

  let label: string | null = null;
  if (labelLen > 0) {
    if (offset + labelLen > data.length) {
      throw new Error('Invalid Zcash QR: label extends beyond data');
    }
    label = new TextDecoder().decode(data.subarray(offset, offset + labelLen));
    offset += labelLen;
  }

  // Parse Orchard FVK (96 bytes) if present
  let orchardFvk: Uint8Array | null = null;
  if (hasOrchard) {
    if (offset + 96 > data.length) {
      throw new Error('Invalid Zcash QR: orchard FVK truncated');
    }
    orchardFvk = new Uint8Array(data.subarray(offset, offset + 96));
    offset += 96;
  }

  // Parse transparent xpub if present
  let transparentXpub: Uint8Array | null = null;
  if (hasTransparent) {
    if (offset >= data.length) {
      throw new Error('Invalid Zcash QR: transparent xpub length missing');
    }
    const xpubLen = data[offset]!;
    offset += 1;
    if (offset + xpubLen > data.length) {
      throw new Error('Invalid Zcash QR: transparent xpub truncated');
    }
    transparentXpub = new Uint8Array(data.subarray(offset, offset + xpubLen));
  }

  return {
    accountIndex,
    label,
    orchardFvk,
    transparentXpub,
    mainnet,
  };
}

/**
 * Convert parsed FVK export data to wallet import format
 *
 * @param exportData - Parsed FVK export data from QR
 * @param defaultLabel - Default label if none in QR
 * @returns Wallet import data
 */
export function createZcashWalletImport(
  exportData: ZcashFvkExportData,
  defaultLabel = 'Zcash Wallet',
): ZcashWalletImport {
  return {
    label: exportData.label ?? defaultLabel,
    orchardFvk: exportData.orchardFvk,
    accountIndex: exportData.accountIndex,
    mainnet: exportData.mainnet,
  };
}

/**
 * Validate that a scanned QR code is a valid Zcash FVK export
 *
 * @param hex - Hex string from scanned QR
 * @returns true if valid Zcash FVK export QR
 */
export function isZcashFvkQR(hex: string): boolean {
  try {
    const data = hexToBytes(hex);
    return (
      data.length >= 9 &&
      data[0] === SUBSTRATE_COMPAT &&
      data[1] === CHAIN_ID.ZCASH &&
      data[2] === QR_TYPE.FVK_EXPORT
    );
  } catch {
    return false;
  }
}

// ============================================================================
// Zcash Sign Request Types
// ============================================================================

/**
 * Zcash sign request to send to Zigner
 */
export interface ZcashSignRequest {
  /** Account index for key derivation */
  accountIndex: number;
  /** The transaction sighash (32 bytes) */
  sighash: Uint8Array;
  /** Orchard action randomizers (alpha values, 32 bytes each) */
  orchardAlphas: Uint8Array[];
  /** Human-readable summary for display */
  summary: string;
  /** Network: true = mainnet, false = testnet */
  mainnet: boolean;
}

/**
 * Encode a sign request to QR hex
 *
 * Format:
 * ```
 * [0x53][0x04][0x02]           - prelude
 * [flags: 1 byte]              - bit 0: mainnet
 * [account_index: 4 bytes LE]
 * [sighash: 32 bytes]
 * [action_count: 2 bytes LE]
 * [alphas: 32 bytes each]
 * [summary_len: 2 bytes LE]
 * [summary: summary_len bytes]
 * ```
 */
export function encodeZcashSignRequest(request: ZcashSignRequest): string {
  const summaryBytes = new TextEncoder().encode(request.summary);

  const totalLen = 3 + 1 + 4 + 32 + 2 + (request.orchardAlphas.length * 32) + 2 + summaryBytes.length;
  const output = new Uint8Array(totalLen);
  let offset = 0;

  // Prelude
  output[offset++] = SUBSTRATE_COMPAT;
  output[offset++] = CHAIN_ID.ZCASH;
  output[offset++] = QR_TYPE.SIGN_REQUEST;

  // Flags
  output[offset++] = request.mainnet ? 0x01 : 0x00;

  // Account index
  writeUint32LE(output, offset, request.accountIndex);
  offset += 4;

  // Sighash
  output.set(request.sighash, offset);
  offset += 32;

  // Action count
  writeUint16LE(output, offset, request.orchardAlphas.length);
  offset += 2;

  // Alphas
  for (const alpha of request.orchardAlphas) {
    output.set(alpha, offset);
    offset += 32;
  }

  // Summary
  writeUint16LE(output, offset, summaryBytes.length);
  offset += 2;
  output.set(summaryBytes, offset);

  return bytesToHex(output);
}

// ============================================================================
// Zcash Signature Response Types
// ============================================================================

/**
 * Zcash signature response from Zigner
 */
export interface ZcashSignatureResponse {
  /** The sighash that was signed */
  sighash: Uint8Array;
  /** Transparent signatures (DER + sighash byte) */
  transparentSigs: Uint8Array[];
  /** Orchard signatures (64 bytes each) */
  orchardSigs: Uint8Array[];
}

/**
 * Parse signature response from Zigner QR
 *
 * Format:
 * ```
 * [0x53][0x04][0x03]           - prelude
 * [sighash: 32 bytes]
 * [transparent_count: 2 bytes LE]
 * [for each: sig_len (2 bytes LE) + sig bytes]
 * [orchard_count: 2 bytes LE]
 * [orchard_sigs: 64 bytes each]
 * ```
 */
export function parseZcashSignatureResponse(hex: string): ZcashSignatureResponse {
  const data = hexToBytes(hex);

  // Validate prelude
  if (data.length < 37) {
    throw new Error('Invalid Zcash signature response: too short');
  }
  if (data[0] !== SUBSTRATE_COMPAT || data[1] !== CHAIN_ID.ZCASH || data[2] !== QR_TYPE.SIGNATURES) {
    throw new Error('Invalid Zcash signature response: bad prelude');
  }

  let offset = 3;

  // Sighash
  const sighash = new Uint8Array(data.subarray(offset, offset + 32));
  offset += 32;

  // Transparent signatures
  const tCount = readUint16LE(data, offset);
  offset += 2;

  const transparentSigs: Uint8Array[] = [];
  for (let i = 0; i < tCount; i++) {
    if (offset + 2 > data.length) {
      throw new Error('Invalid Zcash signature response: transparent sig length truncated');
    }
    const sigLen = readUint16LE(data, offset);
    offset += 2;

    if (offset + sigLen > data.length) {
      throw new Error('Invalid Zcash signature response: transparent sig truncated');
    }
    transparentSigs.push(new Uint8Array(data.subarray(offset, offset + sigLen)));
    offset += sigLen;
  }

  // Orchard signatures
  if (offset + 2 > data.length) {
    throw new Error('Invalid Zcash signature response: orchard count truncated');
  }
  const oCount = readUint16LE(data, offset);
  offset += 2;

  const orchardSigs: Uint8Array[] = [];
  for (let i = 0; i < oCount; i++) {
    if (offset + 64 > data.length) {
      throw new Error('Invalid Zcash signature response: orchard sig truncated');
    }
    orchardSigs.push(new Uint8Array(data.subarray(offset, offset + 64)));
    offset += 64;
  }

  return {
    sighash,
    transparentSigs,
    orchardSigs,
  };
}

/**
 * Validate that a scanned QR code is a valid Zcash signature response
 */
export function isZcashSignatureQR(hex: string): boolean {
  try {
    const data = hexToBytes(hex);
    return (
      data.length >= 37 &&
      data[0] === SUBSTRATE_COMPAT &&
      data[1] === CHAIN_ID.ZCASH &&
      data[2] === QR_TYPE.SIGNATURES
    );
  } catch {
    return false;
  }
}

// ============================================================================
// Network Detection
// ============================================================================

/**
 * Detect which network a QR code is for based on chain ID
 */
export function detectQRNetwork(hex: string): 'penumbra' | 'zcash' | 'unknown' {
  try {
    const data = hexToBytes(hex);
    if (data.length < 3 || data[0] !== SUBSTRATE_COMPAT) {
      return 'unknown';
    }

    switch (data[1]) {
      case CHAIN_ID.PENUMBRA:
        return 'penumbra';
      case CHAIN_ID.ZCASH:
        return 'zcash';
      default:
        return 'unknown';
    }
  } catch {
    return 'unknown';
  }
}

/**
 * Detect the operation type of a QR code
 */
export function detectQRType(hex: string): 'fvk_export' | 'sign_request' | 'signatures' | 'unknown' {
  try {
    const data = hexToBytes(hex);
    if (data.length < 3 || data[0] !== SUBSTRATE_COMPAT) {
      return 'unknown';
    }

    switch (data[2]) {
      case QR_TYPE.FVK_EXPORT:
        return 'fvk_export';
      case QR_TYPE.SIGN_REQUEST:
        return 'sign_request';
      case QR_TYPE.SIGNATURES:
        return 'signatures';
      default:
        return 'unknown';
    }
  } catch {
    return 'unknown';
  }
}
