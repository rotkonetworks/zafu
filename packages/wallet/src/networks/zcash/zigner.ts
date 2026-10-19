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

import { hexToBytes, readUint32LE, SUBSTRATE_COMPAT } from '../common/qr';
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
    throw new Error(
      `Invalid Zcash QR: expected FVK export type 0x01, got 0x${data[2]?.toString(16)}`,
    );
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
export function detectQRType(
  hex: string,
): 'fvk_export' | 'sign_request' | 'signatures' | 'unknown' {
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
