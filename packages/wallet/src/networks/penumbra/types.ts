/**
 * Penumbra network types
 *
 * Types for Penumbra wallet integration with Zigner cold signing.
 */

// =============================================================================
// QR Protocol Constants
// =============================================================================

/** Substrate compatibility byte in QR prelude */
export const SUBSTRATE_COMPAT = 0x53;

/** Penumbra chain ID in QR protocol */
export const CHAIN_ID_PENUMBRA = 0x03;

/** QR operation types */
export const QR_TYPE = {
  /** FVK export from Zigner */
  FVK_EXPORT: 0x01,
  /** Sign request to Zigner */
  SIGN_REQUEST: 0x02,
  /** Signature response from Zigner */
  SIGNATURES: 0x03,
  /** Schema update (full schema) */
  SCHEMA_UPDATE: 0x12,
  /** Schema digest (merkle root) */
  SCHEMA_DIGEST: 0x13,
  /** Asset registry digest */
  REGISTRY_DIGEST: 0x14,
} as const;

// =============================================================================
// Viewing Key Types
// =============================================================================

/**
 * Penumbra Full Viewing Key export from Zigner
 */
export interface PenumbraFvkExport {
  /** Account index on Zigner device */
  accountIndex: number;
  /** Optional wallet label */
  label: string | null;
  /** Full Viewing Key (bech32m encoded) */
  fullViewingKey: string;
  /** Wallet ID (derived from FVK) */
  walletId: string;
}

/**
 * Penumbra wallet ready for import
 */
export interface PenumbraWalletImport {
  /** Wallet label */
  label: string;
  /** Full Viewing Key (bech32m) */
  fullViewingKey: string;
  /** Account index from Zigner */
  accountIndex: number;
  /** Wallet ID */
  walletId: string;
}

// =============================================================================
// Transaction Types
// =============================================================================

/**
 * Penumbra sign request to send to Zigner
 */
export interface PenumbraSignRequest {
  /** Account index for key derivation */
  accountIndex: number;
  /** Effect hash to sign (32 bytes) */
  effectHash: Uint8Array;
  /** Transaction plan (protobuf encoded) */
  transactionPlan: Uint8Array;
  /** Human-readable summary */
  summary: string;
}

/**
 * Penumbra signature response from Zigner
 */
export interface PenumbraSignatureResponse {
  /** Effect hash that was signed */
  effectHash: Uint8Array;
  /** Authorization signatures for each action */
  authSigs: Uint8Array[];
  /** Binding signature */
  bindingSig: Uint8Array;
}

// =============================================================================
// Action Types (for display)
// =============================================================================

/**
 * Parsed action for UI display
 */
export interface ParsedAction {
  /** Action type name */
  name: string;
  /** Human-readable description */
  description: string;
  /** Key-value fields to display */
  fields: Array<{ label: string; value: string }>;
  /** Whether action was recognized by schema */
  recognized: boolean;
}

/**
 * Transaction summary for display
 */
export interface TransactionSummary {
  /** Total fee */
  fee: string;
  /** List of actions */
  actions: ParsedAction[];
  /** Chain ID */
  chainId: string;
}
