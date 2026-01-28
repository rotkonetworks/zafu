/**
 * Common QR encoding/decoding utilities for Zigner communication
 */

import { CHAIN_IDS, QR_TYPES, type NetworkType } from './types';

/** Substrate compatibility byte (0x53 = 'S') */
export const SUBSTRATE_COMPAT = 0x53;

/** Convert hex string to Uint8Array. Throws on invalid input. */
export function hexToBytes(hex: string): Uint8Array {
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

/** Convert Uint8Array to hex string */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Read uint16 little-endian */
export function readUint16LE(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8);
}

/** Read uint32 little-endian */
export function readUint32LE(data: Uint8Array, offset: number): number {
  return (
    (data[offset]! |
      (data[offset + 1]! << 8) |
      (data[offset + 2]! << 16) |
      (data[offset + 3]! << 24)) >>>
    0
  );
}

/** Write uint16 little-endian */
export function writeUint16LE(data: Uint8Array, offset: number, value: number): void {
  data[offset] = value & 0xff;
  data[offset + 1] = (value >> 8) & 0xff;
}

/** Write uint32 little-endian */
export function writeUint32LE(data: Uint8Array, offset: number, value: number): void {
  data[offset] = value & 0xff;
  data[offset + 1] = (value >> 8) & 0xff;
  data[offset + 2] = (value >> 16) & 0xff;
  data[offset + 3] = (value >> 24) & 0xff;
}

/** Detect network from QR hex */
export function detectNetwork(hex: string): NetworkType | null {
  try {
    const data = hexToBytes(hex);
    if (data.length < 3 || data[0] !== SUBSTRATE_COMPAT) {
      return null;
    }

    switch (data[1]) {
      case CHAIN_IDS.PENUMBRA:
        return 'penumbra';
      case CHAIN_IDS.ZCASH:
        return 'zcash';
      case CHAIN_IDS.SUBSTRATE_SR25519:
      case CHAIN_IDS.SUBSTRATE_ED25519:
      case CHAIN_IDS.SUBSTRATE_ECDSA:
        return 'polkadot';
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Detect QR type from hex */
export function detectQrType(hex: string): 'fvk_export' | 'sign_request' | 'signatures' | null {
  try {
    const data = hexToBytes(hex);
    if (data.length < 3 || data[0] !== SUBSTRATE_COMPAT) {
      return null;
    }

    switch (data[2]) {
      case QR_TYPES.FVK_EXPORT:
        return 'fvk_export';
      case QR_TYPES.SIGN_REQUEST:
        return 'sign_request';
      case QR_TYPES.SIGNATURES:
        return 'signatures';
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Get chain ID for network */
export function getChainId(network: NetworkType): number {
  switch (network) {
    case 'penumbra':
      return CHAIN_IDS.PENUMBRA;
    case 'zcash':
      return CHAIN_IDS.ZCASH;
    case 'polkadot':
      return CHAIN_IDS.SUBSTRATE_ED25519; // default to ed25519
    case 'cosmos':
      // Cosmos doesn't use this protocol yet
      throw new Error('Cosmos QR protocol not implemented');
  }
}

/** Create QR prelude bytes */
export function createPrelude(network: NetworkType, qrType: number): Uint8Array {
  return new Uint8Array([SUBSTRATE_COMPAT, getChainId(network), qrType]);
}
