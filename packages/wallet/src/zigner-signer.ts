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
import { encodePlanToQR, parseAuthorizationQR, validateAuthorization } from './airgap-signer';

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
  /** Full viewing key bytes (64 bytes: ak || nk) */
  fvkBytes: Uint8Array;
  /** Wallet ID bytes (32 bytes) */
  walletIdBytes: Uint8Array;
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
  // Create FullViewingKey protobuf
  // FVK bytes are: ak (32 bytes) || nk (32 bytes)
  const fullViewingKey = new FullViewingKey({
    inner: exportData.fvkBytes,
  });

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
// Transaction Signing
// ============================================================================

/**
 * UI callback interface for Zigner signing flow
 *
 * The extension must provide these callbacks to handle the QR code UI.
 */
export interface ZignerSigningUI {
  /**
   * Display transaction QR code for user to scan with Zigner
   * @param qrHex - Hex string to encode as QR
   * @param planSummary - Human-readable summary of the transaction
   */
  showTransactionQR: (qrHex: string, planSummary: string) => Promise<void>;

  /**
   * Prompt user to scan signature QR from Zigner
   * @returns Hex string from scanned QR code
   */
  scanSignatureQR: () => Promise<string>;

  /**
   * Called on error during signing flow
   */
  onError: (error: Error) => void;

  /**
   * Called when signing is complete
   */
  onComplete: () => void;
}

// Global UI callback - set by the extension
let signingUI: ZignerSigningUI | null = null;

/**
 * Set the Zigner signing UI callbacks
 *
 * Must be called by the extension before any signing operations.
 */
export function setZignerSigningUI(ui: ZignerSigningUI): void {
  signingUI = ui;
}

/**
 * Get a summary of a transaction plan for display
 *
 * @param plan - Transaction plan to summarize
 * @returns Human-readable summary
 */
function getTransactionSummary(plan: TransactionPlan): string {
  const spendCount = plan.actions.filter(a => a.action?.case === 'spend').length;
  const outputCount = plan.actions.filter(a => a.action?.case === 'output').length;
  const swapCount = plan.actions.filter(a => a.action?.case === 'swap').length;
  const delegateCount = plan.actions.filter(a => a.action?.case === 'delegate').length;
  const undelegateCount = plan.actions.filter(a => a.action?.case === 'undelegate').length;
  const voteCount = plan.actions.filter(a => a.action?.case === 'delegatorVote').length;

  const parts: string[] = [];

  if (spendCount > 0 || outputCount > 0) {
    parts.push(`${spendCount} spend(s), ${outputCount} output(s)`);
  }
  if (swapCount > 0) {
    parts.push(`${swapCount} swap(s)`);
  }
  if (delegateCount > 0) {
    parts.push(`${delegateCount} delegation(s)`);
  }
  if (undelegateCount > 0) {
    parts.push(`${undelegateCount} undelegation(s)`);
  }
  if (voteCount > 0) {
    parts.push(`${voteCount} vote(s)`);
  }

  return parts.length > 0 ? parts.join(', ') : 'Transaction';
}

/**
 * Authorize a transaction plan using Zigner via QR codes
 *
 * Flow:
 * 1. Encode transaction plan to QR hex
 * 2. Display QR for user to scan with Zigner
 * 3. User reviews and signs on Zigner
 * 4. Scan signature QR from Zigner
 * 5. Parse and validate signatures
 * 6. Return AuthorizationData
 *
 * @param plan - Transaction plan to authorize
 * @returns AuthorizationData with signatures from Zigner
 * @throws Error if signing fails or is cancelled
 */
export async function zignerAuthorize(plan: TransactionPlan): Promise<AuthorizationData> {
  if (!signingUI) {
    throw new Error(
      'Zigner signing UI not initialized. Call setZignerSigningUI() first.',
    );
  }

  try {
    // 1. Encode transaction plan to QR hex (reuse airgap-signer encoder)
    const planHex = encodePlanToQR(plan);
    const summary = getTransactionSummary(plan);

    // 2. Display QR for user to scan with Zigner
    await signingUI.showTransactionQR(planHex, summary);

    // 3. User scans and signs on Zigner device (external)

    // 4. Scan signature QR from Zigner
    const signatureHex = await signingUI.scanSignatureQR();

    // 5. Parse authorization data (reuse airgap-signer parser)
    const authData = parseAuthorizationQR(signatureHex);

    // 6. Validate signatures match plan
    validateAuthorization(plan, authData);

    // Success!
    signingUI.onComplete();

    return authData;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    signingUI.onError(err);
    throw err;
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
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
