/**
 * Zigner Cold Wallet Integration
 *
 * Enables importing watch-only wallets and signing transactions via QR codes
 * with a Zigner (air-gapped phone) cold wallet.
 *
 * QR Code Types:
 * - 0x01: FVK Export (Zigner → zigner-web) - Import viewing key
 * - 0x10: Transaction (zigner-web → Zigner) - Send tx to sign
 * - 0x10: Authorization (Zigner → zigner-web) - Receive signatures
 */

import {
  FullViewingKey,
  WalletId,
} from '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb';
import {
  AuthorizationData,
  TransactionPlan,
} from '@penumbra-zone/protobuf/penumbra/core/transaction/v1/transaction_pb';
import { fullViewingKeyFromBech32m } from '@penumbra-zone/bech32m/penumbrafullviewingkey';

// ============================================================================
// Constants
// ============================================================================

/** Penumbra chain identifier in QR prelude */
const PENUMBRA_CHAIN_ID = 0x03;

/** FVK export QR type */
const QR_TYPE_FVK_EXPORT = 0x01;

// ============================================================================
// FVK Import Types
// ============================================================================

/**
 * Data extracted from a Zigner FVK export QR code
 */
export interface ZignerFvkExportData {
  /** BIP44 account index used in Zigner */
  accountIndex: number;
  /** Optional wallet label from Zigner */
  label: string | null;
  /** Full viewing key bytes (64 bytes: ak || nk) - from legacy binary format */
  fvkBytes: Uint8Array;
  /** Wallet ID bytes (32 bytes) */
  walletIdBytes: Uint8Array;
  /** Full viewing key as bech32m string - from UR format */
  fvkBech32m?: string;
}

/**
 * Parsed Zigner wallet ready for import
 */
export interface ZignerWalletImport {
  /** Wallet label (from QR or default) */
  label: string;
  /** Full viewing key protobuf */
  fullViewingKey: FullViewingKey;
  /** Wallet ID protobuf */
  walletId: WalletId;
  /** Original account index from Zigner */
  accountIndex: number;
}

// ============================================================================
// FVK Import Functions
// ============================================================================

/**
 * Parse a Zigner FVK export QR code
 *
 * QR Format (from Zigner):
 * ```
 * [0x53][0x03][0x01]           - prelude (substrate compat, penumbra, fvk export)
 * [account_index: 4 bytes LE]  - which BIP44 account
 * [label_len: 1 byte]          - label length (0 = no label)
 * [label: label_len bytes]     - utf8 label
 * [fvk: 64 bytes]              - ak || nk
 * [wallet_id: 32 bytes]        - for verification
 * ```
 *
 * @param hex - Hex string from scanned QR code
 * @returns Parsed FVK export data
 * @throws Error if QR format is invalid
 */
export function parseZignerFvkQR(hex: string): ZignerFvkExportData {
  const data = hexToBytes(hex);

  // Validate minimum length: 3 (prelude) + 4 (account) + 1 (label_len) + 64 (fvk) + 32 (wallet_id) = 104
  if (data.length < 104) {
    throw new Error(`Invalid Zigner QR: too short (${data.length} bytes, need at least 104)`);
  }

  // Validate prelude
  if (data[0] !== 0x53) {
    throw new Error(`Invalid Zigner QR: expected 0x53, got 0x${data[0]?.toString(16)}`);
  }
  if (data[1] !== PENUMBRA_CHAIN_ID) {
    throw new Error(`Invalid Zigner QR: expected Penumbra chain 0x03, got 0x${data[1]?.toString(16)}`);
  }
  if (data[2] !== QR_TYPE_FVK_EXPORT) {
    throw new Error(`Invalid Zigner QR: expected FVK export type 0x01, got 0x${data[2]?.toString(16)}`);
  }

  let offset = 3;

  // Parse account index (4 bytes LE)
  const accountIndex = readUint32LE(data, offset);
  offset += 4;

  // Parse label
  const labelLen = data[offset]!;
  offset += 1;

  let label: string | null = null;
  if (labelLen > 0) {
    if (offset + labelLen > data.length) {
      throw new Error('Invalid Zigner QR: label extends beyond data');
    }
    label = new TextDecoder().decode(data.subarray(offset, offset + labelLen));
    offset += labelLen;
  }

  // Parse FVK bytes (64 bytes)
  if (offset + 64 > data.length) {
    throw new Error('Invalid Zigner QR: missing FVK data');
  }
  const fvkBytes = new Uint8Array(data.subarray(offset, offset + 64));
  offset += 64;

  // Parse wallet ID (32 bytes)
  if (offset + 32 > data.length) {
    throw new Error('Invalid Zigner QR: missing wallet ID');
  }
  const walletIdBytes = new Uint8Array(data.subarray(offset, offset + 32));

  return {
    accountIndex,
    label,
    fvkBytes,
    walletIdBytes,
  };
}

/**
 * Convert parsed FVK export data to protobuf types for wallet creation
 *
 * @param exportData - Parsed FVK export data from QR
 * @param defaultLabel - Default label if none in QR
 * @returns Wallet import data with protobuf types
 */
export function createWalletImport(
  exportData: ZignerFvkExportData,
  defaultLabel = 'Zigner Wallet',
): ZignerWalletImport {
  let fullViewingKey: FullViewingKey;

  // Check if we have bech32m FVK (from UR format) or raw bytes (legacy binary)
  if (exportData.fvkBech32m) {
    // Decode bech32m FVK string - returns inner bytes, wrap in FullViewingKey
    const fvkInner = fullViewingKeyFromBech32m(exportData.fvkBech32m);
    fullViewingKey = new FullViewingKey(fvkInner);
  } else {
    // Create FullViewingKey from raw bytes
    // FVK bytes are: ak (32 bytes) || nk (32 bytes)
    fullViewingKey = new FullViewingKey({
      inner: exportData.fvkBytes,
    });
  }

  // Create WalletId protobuf
  const walletId = new WalletId({
    inner: exportData.walletIdBytes,
  });

  return {
    label: exportData.label ?? defaultLabel,
    fullViewingKey,
    walletId,
    accountIndex: exportData.accountIndex,
  };
}

/**
 * Validate that a scanned QR code is a valid Zigner FVK export
 *
 * @param hex - Hex string from scanned QR
 * @returns true if valid FVK export QR
 */
export function isZignerFvkQR(hex: string): boolean {
  try {
    const data = hexToBytes(hex);
    return (
      data.length >= 104 &&
      data[0] === 0x53 &&
      data[1] === PENUMBRA_CHAIN_ID &&
      data[2] === QR_TYPE_FVK_EXPORT
    );
  } catch {
    return false;
  }
}

// ============================================================================
// Transaction Signing (legacy stub)
// ============================================================================

/**
 * Legacy stub — the actual signing flow is handled by the extension's popup-based
 * flow (authorization.ts → tx-approval → transaction/index.tsx) which computes
 * the correct effect hash via WASM using the FVK.
 */
export async function zignerAuthorize(_plan: TransactionPlan): Promise<AuthorizationData> {
  throw new Error('Legacy Zigner signing is not supported. Use the popup-based flow instead.');
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Convert hex string to Uint8Array. Throws on invalid input.
 */
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

/**
 * Read uint32 little-endian from Uint8Array
 */
function readUint32LE(data: Uint8Array, offset: number): number {
  return (
    (data[offset]!) |
    (data[offset + 1]! << 8) |
    (data[offset + 2]! << 16) |
    (data[offset + 3]! << 24)
  ) >>> 0;
}
