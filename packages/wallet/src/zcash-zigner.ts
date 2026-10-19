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
  NOTE_SYNC: 0x04,
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
  /** ZID pubkey (hex) - canonical device identity, if present (bit 4 flag) */
  zidPublicKey?: string;
  /**
   * Cold signer kind. Optional; defaults to `'zigner'` when omitted, which
   * preserves backwards compat for every existing import path. Set to
   * `'keystone'` when the FVK came from a Keystone hardware wallet via
   * multipart `ur:zcash-accounts`.
   */
  coldSignerType?: 'zigner' | 'keystone';
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
  /** ZID pubkey (hex) - canonical device identity for zigner dedup */
  zidPublicKey?: string;
  /** Cold signer kind. Defaults to `'zigner'` when omitted. */
  coldSignerType?: 'zigner' | 'keystone';
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
      offset += addrLen;
    }
  }

  // Parse ZID pubkey if present (bit 4 = 0x10). 32 bytes hex.
  const hasZid = (flags & 0x10) !== 0;
  let zidPublicKey: string | undefined;
  if (hasZid && offset + 32 <= data.length) {
    zidPublicKey = Array.from(data.subarray(offset, offset + 32))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  return {
    accountIndex,
    label,
    orchardFvk,
    transparentXpub,
    mainnet,
    address,
    zidPublicKey,
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
    zidPublicKey: exportData.zidPublicKey,
    coldSignerType: exportData.coldSignerType,
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
    (data[offset]! |
      (data[offset + 1]! << 8) |
      (data[offset + 2]! << 16) |
      (data[offset + 3]! << 24)) >>>
    0
  );
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
// Zcash Note Sync (Balance Update for Zigner)
// ============================================================================

/**
 * A spendable note to sync to the air-gapped device
 */
export interface SyncNote {
  /** block height where note was mined */
  height: number;
  /** note value in zatoshis (as string for u64 precision) */
  value: string;
  /** 32-byte nullifier hex */
  nullifier: string;
  /** 32-byte note commitment hex */
  cmx: string;
  /** note position in the commitment tree */
  position: number;
}

/**
 * Encode spendable notes as compact binary for QR transfer.
 * Uses a simple binary format — NOT the substrate-compat prelude
 * since this goes through BC-UR multipart encoding.
 *
 * Format:
 * ```
 * [version: 1 byte]             - 0x01
 * [flags: 1 byte]               - bit 0: mainnet
 * [sync_height: 4 bytes LE]     - chain height at time of sync
 * [note_count: 2 bytes LE]
 * [per note:
 *   height: 4 bytes LE
 *   value: 8 bytes LE
 *   nullifier: 32 bytes
 *   cmx: 32 bytes
 *   position: 4 bytes LE
 * ]                              - 80 bytes per note
 * ```
 */
export function encodeNoteSyncPayload(
  notes: SyncNote[],
  syncHeight: number,
  mainnet: boolean,
): Uint8Array {
  const headerLen = 1 + 1 + 4 + 2; // version + flags + syncHeight + noteCount
  const noteLen = 4 + 8 + 32 + 32 + 4; // 80 bytes per note
  const totalLen = headerLen + notes.length * noteLen;
  const output = new Uint8Array(totalLen);
  let offset = 0;

  // version
  output[offset++] = 0x01;

  // flags
  output[offset++] = mainnet ? 0x01 : 0x00;

  // sync height
  writeUint32LE(output, offset, syncHeight);
  offset += 4;

  // note count
  writeUint16LE(output, offset, notes.length);
  offset += 2;

  for (const note of notes) {
    // height
    writeUint32LE(output, offset, note.height);
    offset += 4;

    // value as uint64 LE
    const val = BigInt(note.value);
    for (let i = 0; i < 8; i++) {
      output[offset + i] = Number((val >> BigInt(i * 8)) & 0xffn);
    }
    offset += 8;

    // nullifier (32 bytes from hex)
    const nf = hexToBytes(note.nullifier);
    output.set(nf.subarray(0, 32), offset);
    offset += 32;

    // cmx (32 bytes from hex)
    const cm = hexToBytes(note.cmx);
    output.set(cm.subarray(0, 32), offset);
    offset += 32;

    // position
    writeUint32LE(output, offset, note.position);
    offset += 4;
  }

  return output;
}

/**
 * Decode note sync payload back to notes.
 * Used by the scanning device (Zigner) to reconstruct balance.
 */
export function decodeNoteSyncPayload(data: Uint8Array): {
  notes: SyncNote[];
  syncHeight: number;
  mainnet: boolean;
} {
  if (data.length < 8) {
    throw new Error('note sync payload too short');
  }

  let offset = 0;

  const version = data[offset++]!;
  if (version !== 0x01) {
    throw new Error(`unsupported note sync version: ${version}`);
  }

  const flags = data[offset++]!;
  const mainnet = (flags & 0x01) !== 0;

  const syncHeight = readUint32LE(data, offset);
  offset += 4;

  const noteCount = readUint16LE(data, offset);
  offset += 2;

  const noteLen = 4 + 8 + 32 + 32 + 4; // 80 bytes per note
  if (offset + noteCount * noteLen > data.length) {
    throw new Error(
      `note sync payload truncated: need ${noteCount * noteLen} bytes for ${noteCount} notes, have ${data.length - offset}`,
    );
  }

  const notes: SyncNote[] = [];
  for (let i = 0; i < noteCount; i++) {
    const height = readUint32LE(data, offset);
    offset += 4;

    let val = 0n;
    for (let j = 0; j < 8; j++) {
      val |= BigInt(data[offset + j]!) << BigInt(j * 8);
    }
    offset += 8;

    const nullifier = bytesToHex(data.subarray(offset, offset + 32));
    offset += 32;

    const cmx = bytesToHex(data.subarray(offset, offset + 32));
    offset += 32;

    const position = readUint32LE(data, offset);
    offset += 4;

    notes.push({ height, value: val.toString(), nullifier, cmx, position });
  }

  return { notes, syncHeight, mainnet };
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
