/**
 * Penumbra Action Schema
 *
 * Dynamic schema system for parsing and displaying Penumbra transaction actions.
 * Mirrors the schema format used in Zigner (rust/definitions/src/penumbra_schema.rs).
 *
 * Schemas can be updated via QR code without app updates - Zafu generates the
 * update QR, user scans with Zigner, Zigner stores new schema.
 */

import { QR_TYPE, SUBSTRATE_COMPAT, CHAIN_ID_PENUMBRA } from './types';

// =============================================================================
// Schema Version
// =============================================================================

/** Current schema format version */
export const SCHEMA_VERSION = 1;

// =============================================================================
// Field Types
// =============================================================================

/** Types of fields that can appear in actions */
export type FieldType =
  | { type: 'string' }
  | { type: 'bool' }
  | { type: 'u32' }
  | { type: 'u64' }
  | { type: 'amount'; decimals: number }
  | { type: 'assetId' }
  | { type: 'address' }
  | { type: 'identityKey' }
  | { type: 'bytes' }
  | { type: 'message'; typeName: string }
  | { type: 'enum'; variants: Array<{ value: number; name: string }> };

// =============================================================================
// Schema Definitions
// =============================================================================

/**
 * Definition of a field within an action
 */
export interface FieldDefinition {
  /** Protobuf field path (e.g., "metadata.symbol") */
  path: string;
  /** Human-readable label */
  label: string;
  /** Field type for parsing/display */
  fieldType: FieldType;
  /** Whether to show in UI */
  visible: boolean;
  /** Display priority (lower = first) */
  priority: number;
}

/**
 * Definition of a single action type
 */
export interface ActionDefinition {
  /** Internal action name (e.g., "ActionSpend") */
  name: string;
  /** Human-readable display name (e.g., "Spend") */
  displayName: string;
  /** Description of what this action does */
  description: string;
  /** Whether this action requires a signature */
  requiresSignature: boolean;
  /** Fields to extract and display */
  fields: FieldDefinition[];
}

/**
 * Complete schema for Penumbra transaction parsing
 */
export interface PenumbraActionSchema {
  /** Schema format version */
  version: number;
  /** Chain ID (e.g., "penumbra-1") */
  chainId: string;
  /** Protocol version (e.g., "2.1.0") */
  protocolVersion: string;
  /** Action definitions keyed by protobuf field number */
  actions: Record<number, ActionDefinition>;
}

/**
 * Compact schema digest (merkle root)
 */
export interface SchemaDigest {
  /** Digest format version */
  version: number;
  /** Chain ID */
  chainId: string;
  /** Protocol version */
  protocolVersion: string;
  /** Merkle root of action definitions (32 bytes) */
  actionTreeRoot: Uint8Array;
  /** Number of actions */
  actionCount: number;
}

/**
 * Asset registry digest
 */
export interface RegistryDigest {
  /** Digest format version */
  version: number;
  /** Chain ID */
  chainId: string;
  /** Merkle root of assets (32 bytes) */
  assetTreeRoot: Uint8Array;
  /** Number of assets */
  assetCount: number;
  /** Timestamp of snapshot */
  timestamp: number;
}

// =============================================================================
// Default Schema (matches Zigner's default_penumbra_schema)
// =============================================================================

/**
 * Create the default schema with all known Penumbra actions
 */
export function createDefaultSchema(): PenumbraActionSchema {
  return {
    version: SCHEMA_VERSION,
    chainId: 'penumbra-1',
    protocolVersion: '2.1.0',
    actions: {
      // Field 1: Spend
      1: {
        name: 'ActionSpend',
        displayName: 'Spend',
        description: 'Spend a note from your wallet',
        requiresSignature: true,
        fields: [
          { path: 'note.value.amount', label: 'Amount', fieldType: { type: 'amount', decimals: 6 }, visible: true, priority: 1 },
          { path: 'note.value.asset_id', label: 'Asset', fieldType: { type: 'assetId' }, visible: true, priority: 2 },
        ],
      },

      // Field 2: Output
      2: {
        name: 'ActionOutput',
        displayName: 'Output',
        description: 'Create an output note',
        requiresSignature: false,
        fields: [
          { path: 'value.amount', label: 'Amount', fieldType: { type: 'amount', decimals: 6 }, visible: true, priority: 1 },
          { path: 'value.asset_id', label: 'Asset', fieldType: { type: 'assetId' }, visible: true, priority: 2 },
          { path: 'dest_address', label: 'To', fieldType: { type: 'address' }, visible: true, priority: 3 },
        ],
      },

      // Field 3: Swap
      3: {
        name: 'ActionSwap',
        displayName: 'Swap',
        description: 'Swap assets via DEX',
        requiresSignature: false,
        fields: [
          { path: 'swap_plaintext.delta_1_i', label: 'Input Amount', fieldType: { type: 'amount', decimals: 6 }, visible: true, priority: 1 },
          { path: 'swap_plaintext.trading_pair.asset_1', label: 'From Asset', fieldType: { type: 'assetId' }, visible: true, priority: 2 },
          { path: 'swap_plaintext.trading_pair.asset_2', label: 'To Asset', fieldType: { type: 'assetId' }, visible: true, priority: 3 },
        ],
      },

      // Field 4: SwapClaim
      4: {
        name: 'ActionSwapClaim',
        displayName: 'Claim Swap',
        description: 'Claim outputs from a completed swap',
        requiresSignature: false,
        fields: [],
      },

      // Field 16: Delegate
      16: {
        name: 'ActionDelegate',
        displayName: 'Delegate',
        description: 'Delegate stake to a validator',
        requiresSignature: false,
        fields: [
          { path: 'unbonded_amount', label: 'Amount', fieldType: { type: 'amount', decimals: 6 }, visible: true, priority: 1 },
          { path: 'validator_identity', label: 'Validator', fieldType: { type: 'identityKey' }, visible: true, priority: 2 },
        ],
      },

      // Field 17: Undelegate
      17: {
        name: 'ActionUndelegate',
        displayName: 'Undelegate',
        description: 'Undelegate stake from a validator',
        requiresSignature: false,
        fields: [
          { path: 'delegation_amount', label: 'Amount', fieldType: { type: 'amount', decimals: 6 }, visible: true, priority: 1 },
          { path: 'validator_identity', label: 'Validator', fieldType: { type: 'identityKey' }, visible: true, priority: 2 },
        ],
      },

      // Field 18: UndelegateClaim
      18: {
        name: 'ActionUndelegateClaim',
        displayName: 'Claim Undelegation',
        description: 'Claim unbonded stake',
        requiresSignature: false,
        fields: [],
      },

      // Field 20: DelegatorVote
      20: {
        name: 'ActionDelegatorVote',
        displayName: 'Vote',
        description: 'Vote on a governance proposal',
        requiresSignature: true,
        fields: [
          { path: 'proposal', label: 'Proposal', fieldType: { type: 'u64' }, visible: true, priority: 1 },
          {
            path: 'vote.vote',
            label: 'Vote',
            fieldType: {
              type: 'enum',
              variants: [
                { value: 0, name: 'Abstain' },
                { value: 1, name: 'Yes' },
                { value: 2, name: 'No' },
              ],
            },
            visible: true,
            priority: 2,
          },
        ],
      },

      // Field 30: PositionOpen
      30: {
        name: 'ActionPositionOpen',
        displayName: 'Open LP Position',
        description: 'Open a liquidity position',
        requiresSignature: false,
        fields: [],
      },

      // Field 31: PositionClose
      31: {
        name: 'ActionPositionClose',
        displayName: 'Close LP Position',
        description: 'Close a liquidity position',
        requiresSignature: false,
        fields: [],
      },

      // Field 32: PositionWithdraw
      32: {
        name: 'ActionPositionWithdraw',
        displayName: 'Withdraw LP',
        description: 'Withdraw from a closed position',
        requiresSignature: false,
        fields: [],
      },

      // Field 53: DutchAuctionSchedule
      53: {
        name: 'ActionDutchAuctionSchedule',
        displayName: 'Schedule Auction',
        description: 'Schedule a Dutch auction',
        requiresSignature: false,
        fields: [
          { path: 'description.input.amount', label: 'Input Amount', fieldType: { type: 'amount', decimals: 6 }, visible: true, priority: 1 },
          { path: 'description.input.asset_id', label: 'Selling', fieldType: { type: 'assetId' }, visible: true, priority: 2 },
          { path: 'description.output_id', label: 'For Asset', fieldType: { type: 'assetId' }, visible: true, priority: 3 },
        ],
      },

      // Field 54: DutchAuctionEnd
      54: {
        name: 'ActionDutchAuctionEnd',
        displayName: 'End Auction',
        description: 'End a Dutch auction early',
        requiresSignature: false,
        fields: [],
      },

      // Field 55: DutchAuctionWithdraw
      55: {
        name: 'ActionDutchAuctionWithdraw',
        displayName: 'Withdraw Auction',
        description: 'Withdraw from ended auction',
        requiresSignature: false,
        fields: [],
      },

      // Field 61: TokenFactoryCreate
      61: {
        name: 'ActionTokenFactoryCreate',
        displayName: 'Create Token',
        description: 'Create a new token via Token Factory',
        requiresSignature: false,
        fields: [
          { path: 'metadata.name', label: 'Name', fieldType: { type: 'string' }, visible: true, priority: 1 },
          { path: 'metadata.symbol', label: 'Symbol', fieldType: { type: 'string' }, visible: true, priority: 2 },
          { path: 'initial_supply', label: 'Initial Supply', fieldType: { type: 'amount', decimals: 6 }, visible: true, priority: 3 },
          { path: 'enable_mint', label: 'Minting Enabled', fieldType: { type: 'bool' }, visible: true, priority: 4 },
          { path: 'metadata.description', label: 'Description', fieldType: { type: 'string' }, visible: true, priority: 5 },
        ],
      },

      // Field 62: TokenFactoryMint
      62: {
        name: 'ActionTokenFactoryMint',
        displayName: 'Mint Tokens',
        description: 'Mint additional tokens using mint capability',
        requiresSignature: false,
        fields: [
          { path: 'token_id.inner', label: 'Token ID', fieldType: { type: 'bytes' }, visible: true, priority: 1 },
          { path: 'amount', label: 'Amount to Mint', fieldType: { type: 'amount', decimals: 6 }, visible: true, priority: 2 },
          { path: 'current_seq', label: 'Sequence', fieldType: { type: 'u64' }, visible: true, priority: 3 },
        ],
      },

      // Field 63: LiquidityTournamentVote
      63: {
        name: 'ActionLiquidityTournamentVote',
        displayName: 'LQT Vote',
        description: 'Vote in liquidity tournament',
        requiresSignature: true,
        fields: [
          { path: 'body.incentivized_asset', label: 'Vote For', fieldType: { type: 'assetId' }, visible: true, priority: 1 },
        ],
      },

      // Field 200: ICS20Withdrawal (IBC)
      200: {
        name: 'ActionIcs20Withdrawal',
        displayName: 'IBC Transfer Out',
        description: 'Transfer assets via IBC',
        requiresSignature: false,
        fields: [
          { path: 'amount', label: 'Amount', fieldType: { type: 'amount', decimals: 6 }, visible: true, priority: 1 },
          { path: 'denom', label: 'Asset', fieldType: { type: 'string' }, visible: true, priority: 2 },
          { path: 'destination_chain_address', label: 'To', fieldType: { type: 'string' }, visible: true, priority: 3 },
        ],
      },
    },
  };
}

// =============================================================================
// Schema Encoding (for QR generation)
// =============================================================================

/**
 * Encode a full schema to QR payload (type 0x12)
 *
 * Format:
 * - 3 bytes: prelude (0x53, 0x03, 0x12)
 * - 4 bytes: version (LE)
 * - 1 byte: chainId length
 * - N bytes: chainId
 * - 1 byte: protocolVersion length
 * - M bytes: protocolVersion
 * - 2 bytes: action count (LE)
 * - For each action:
 *   - 4 bytes: field number (LE)
 *   - 2 bytes: serialized action length (LE)
 *   - N bytes: JSON-encoded action definition
 */
export function encodeSchemaUpdateQR(schema: PenumbraActionSchema): Uint8Array {
  const chainIdBytes = new TextEncoder().encode(schema.chainId);
  const protoBytes = new TextEncoder().encode(schema.protocolVersion);

  // encode actions as JSON for simplicity (Zigner will parse)
  const actionEntries = Object.entries(schema.actions).map(([fieldNum, action]) => ({
    fieldNum: parseInt(fieldNum),
    data: new TextEncoder().encode(JSON.stringify(action)),
  }));

  // calculate total length
  let totalLen = 3 + 4 + 1 + chainIdBytes.length + 1 + protoBytes.length + 2;
  for (const entry of actionEntries) {
    totalLen += 4 + 2 + entry.data.length;
  }

  const output = new Uint8Array(totalLen);
  let offset = 0;

  // prelude
  output[offset++] = SUBSTRATE_COMPAT;
  output[offset++] = CHAIN_ID_PENUMBRA;
  output[offset++] = QR_TYPE.SCHEMA_UPDATE;

  // version
  writeU32LE(output, offset, schema.version);
  offset += 4;

  // chainId
  output[offset++] = chainIdBytes.length;
  output.set(chainIdBytes, offset);
  offset += chainIdBytes.length;

  // protocolVersion
  output[offset++] = protoBytes.length;
  output.set(protoBytes, offset);
  offset += protoBytes.length;

  // action count
  writeU16LE(output, offset, actionEntries.length);
  offset += 2;

  // actions
  for (const entry of actionEntries) {
    writeU32LE(output, offset, entry.fieldNum);
    offset += 4;
    writeU16LE(output, offset, entry.data.length);
    offset += 2;
    output.set(entry.data, offset);
    offset += entry.data.length;
  }

  return output;
}

/**
 * Encode a schema digest to QR payload (type 0x13)
 */
export function encodeSchemaDigestQR(digest: SchemaDigest): Uint8Array {
  const chainIdBytes = new TextEncoder().encode(digest.chainId);
  const protoBytes = new TextEncoder().encode(digest.protocolVersion);

  const totalLen = 3 + 4 + 1 + chainIdBytes.length + 1 + protoBytes.length + 32 + 4;
  const output = new Uint8Array(totalLen);
  let offset = 0;

  // prelude
  output[offset++] = SUBSTRATE_COMPAT;
  output[offset++] = CHAIN_ID_PENUMBRA;
  output[offset++] = QR_TYPE.SCHEMA_DIGEST;

  // version
  writeU32LE(output, offset, digest.version);
  offset += 4;

  // chainId
  output[offset++] = chainIdBytes.length;
  output.set(chainIdBytes, offset);
  offset += chainIdBytes.length;

  // protocolVersion
  output[offset++] = protoBytes.length;
  output.set(protoBytes, offset);
  offset += protoBytes.length;

  // merkle root
  output.set(digest.actionTreeRoot, offset);
  offset += 32;

  // action count
  writeU32LE(output, offset, digest.actionCount);

  return output;
}

/**
 * Encode a registry digest to QR payload (type 0x14)
 */
export function encodeRegistryDigestQR(digest: RegistryDigest): Uint8Array {
  const chainIdBytes = new TextEncoder().encode(digest.chainId);

  const totalLen = 3 + 4 + 1 + chainIdBytes.length + 32 + 4 + 8;
  const output = new Uint8Array(totalLen);
  let offset = 0;

  // prelude
  output[offset++] = SUBSTRATE_COMPAT;
  output[offset++] = CHAIN_ID_PENUMBRA;
  output[offset++] = QR_TYPE.REGISTRY_DIGEST;

  // version
  writeU32LE(output, offset, digest.version);
  offset += 4;

  // chainId
  output[offset++] = chainIdBytes.length;
  output.set(chainIdBytes, offset);
  offset += chainIdBytes.length;

  // merkle root
  output.set(digest.assetTreeRoot, offset);
  offset += 32;

  // asset count
  writeU32LE(output, offset, digest.assetCount);
  offset += 4;

  // timestamp
  writeU64LE(output, offset, digest.timestamp);

  return output;
}

// =============================================================================
// Utility Functions
// =============================================================================

function writeU16LE(arr: Uint8Array, offset: number, value: number): void {
  arr[offset] = value & 0xff;
  arr[offset + 1] = (value >> 8) & 0xff;
}

function writeU32LE(arr: Uint8Array, offset: number, value: number): void {
  arr[offset] = value & 0xff;
  arr[offset + 1] = (value >> 8) & 0xff;
  arr[offset + 2] = (value >> 16) & 0xff;
  arr[offset + 3] = (value >> 24) & 0xff;
}

function writeU64LE(arr: Uint8Array, offset: number, value: number): void {
  // JavaScript numbers are 53-bit, so this works for reasonable timestamps
  arr[offset] = value & 0xff;
  arr[offset + 1] = (value >> 8) & 0xff;
  arr[offset + 2] = (value >> 16) & 0xff;
  arr[offset + 3] = (value >> 24) & 0xff;
  // upper 32 bits (usually 0 for timestamps until year 2106)
  const upper = Math.floor(value / 0x100000000);
  arr[offset + 4] = upper & 0xff;
  arr[offset + 5] = (upper >> 8) & 0xff;
  arr[offset + 6] = (upper >> 16) & 0xff;
  arr[offset + 7] = (upper >> 24) & 0xff;
}

/**
 * Convert bytes to hex string
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
