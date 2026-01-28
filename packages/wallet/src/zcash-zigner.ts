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

// ============================================================================
// Chain ID Constants
// ============================================================================

/** Substrate compatibility byte in QR prelude */
export const SUBSTRATE_COMPAT = 0x53;

/** Chain IDs for different networks */
export const CHAIN_ID = {
  PENUMBRA: 0x03,
  ZCASH: 0x04,
} as const;

/** QR operation types */
export const QR_TYPE = {
  FVK_EXPORT: 0x01,
  SIGN_REQUEST: 0x02,
  SIGNATURES: 0x03,
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
  /** Orchard FVK bytes (96 bytes) - if present (legacy binary format) */
  orchardFvk: Uint8Array | null;
  /** Transparent xpub bytes - if present (legacy binary format) */
  transparentXpub: Uint8Array | null;
  /** Network: true = mainnet, false = testnet */
  mainnet: boolean;
  /** Unified address (u1... or utest1...) - if present */
  address: string | null;
  /** Unified Full Viewing Key (uview1... or uviewtest1...) - from UR format */
  ufvk?: string;
}

/**
 * Parsed Zcash wallet ready for import
 */
export interface ZcashWalletImport {
  /** Wallet label (from QR or default) */
  label: string;
  /** Orchard FVK bytes (96 bytes) - legacy binary format */
  orchardFvk: Uint8Array | null;
  /** Original account index from Zigner */
  accountIndex: number;
  /** Network: true = mainnet, false = testnet */
  mainnet: boolean;
  /** Unified address (u1... or utest1...) */
  address: string | null;
  /** Unified Full Viewing Key (uview1... or uviewtest1...) - from UR format */
  ufvk?: string;
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
    offset += xpubLen;
  }

  // Parse unified address if present (bit 3 = 0x08)
  const hasAddress = (flags & 0x08) !== 0;
  let address: string | null = null;
  if (hasAddress && offset + 2 <= data.length) {
    const addrLen = readUint16LE(data, offset);
    offset += 2;
    if (offset + addrLen <= data.length) {
      address = new TextDecoder().decode(data.subarray(offset, offset + addrLen));
    }
  }

  return {
    accountIndex,
    label,
    orchardFvk,
    transparentXpub,
    mainnet,
    address,
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
    address: exportData.address,
    ufvk: exportData.ufvk,
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
// Utility Functions
// ============================================================================

/**
 * Convert hex string to Uint8Array.
 * Throws on invalid input (odd length, non-hex chars).
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
 * Convert Uint8Array to hex string
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
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

/**
 * Read uint16 little-endian from Uint8Array
 */
function readUint16LE(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8);
}

/**
 * Write uint32 little-endian to Uint8Array
 */
function writeUint32LE(data: Uint8Array, offset: number, value: number): void {
  data[offset] = value & 0xff;
  data[offset + 1] = (value >> 8) & 0xff;
  data[offset + 2] = (value >> 16) & 0xff;
  data[offset + 3] = (value >> 24) & 0xff;
}

/**
 * Write uint16 little-endian to Uint8Array
 */
function writeUint16LE(data: Uint8Array, offset: number, value: number): void {
  data[offset] = value & 0xff;
  data[offset + 1] = (value >> 8) & 0xff;
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
