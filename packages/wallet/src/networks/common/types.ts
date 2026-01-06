/**
 * Zigner-First Multi-Network Wallet Types
 *
 * Every wallet in Zafu is a Zigner wallet - watch-only with signing via QR.
 */

/** Supported network types */
export type NetworkType = 'penumbra' | 'zcash' | 'polkadot' | 'cosmos';

/** Network chain IDs for QR protocol */
export const CHAIN_IDS = {
  SUBSTRATE_SR25519: 0x00,
  SUBSTRATE_ED25519: 0x01,
  SUBSTRATE_ECDSA: 0x02,
  PENUMBRA: 0x03,
  ZCASH: 0x04,
} as const;

/** QR operation types */
export const QR_TYPES = {
  FVK_EXPORT: 0x01,
  SIGN_REQUEST: 0x02,
  SIGNATURES: 0x03,
} as const;

// =============================================================================
// Network-Specific Viewing Keys (Watch-Only)
// =============================================================================

/** Penumbra network keys */
export interface PenumbraNetworkKeys {
  /** Full Viewing Key (bech32m encoded) */
  fullViewingKey: string;
  /** Default receiving address */
  address: string;
}

/** Zcash network keys */
export interface ZcashNetworkKeys {
  /** Orchard FVK (96 bytes, hex) */
  orchardFvk: string;
  /** Unified address */
  unifiedAddress: string;
  /** Mainnet or testnet */
  mainnet: boolean;
}

/** Polkadot network keys */
export interface PolkadotNetworkKeys {
  /** Public key (32 bytes, hex) */
  publicKey: string;
  /** SS58 encoded address */
  ss58Address: string;
  /** Signature scheme */
  scheme: 'sr25519' | 'ed25519';
  /** Chain name (e.g., 'polkadot', 'kusama') */
  chain: string;
}

/** Cosmos network keys */
export interface CosmosNetworkKeys {
  /** Public key (secp256k1, hex) */
  publicKey: string;
  /** Bech32 address */
  address: string;
  /** Enabled chain IDs */
  enabledChains: string[];
}

// =============================================================================
// ZignerWallet - The Core Type
// =============================================================================

/**
 * A Zigner Wallet represents a single account from the Zigner device.
 * It can have viewing keys for multiple networks, all imported via QR.
 */
export interface ZignerWallet {
  /** Unique wallet ID */
  id: string;

  /** User-defined label */
  label: string;

  /** Account index on the Zigner device */
  zignerAccountIndex: number;

  /** When this wallet was first imported */
  importedAt: number;

  /** Network-specific viewing keys (all watch-only) */
  networks: {
    penumbra?: PenumbraNetworkKeys;
    zcash?: ZcashNetworkKeys;
    polkadot?: PolkadotNetworkKeys;
    cosmos?: CosmosNetworkKeys;
  };
}

/** Get list of enabled networks for a wallet */
export function getEnabledNetworks(wallet: ZignerWallet): NetworkType[] {
  const networks: NetworkType[] = [];
  if (wallet.networks.penumbra) networks.push('penumbra');
  if (wallet.networks.zcash) networks.push('zcash');
  if (wallet.networks.polkadot) networks.push('polkadot');
  if (wallet.networks.cosmos) networks.push('cosmos');
  return networks;
}

/** Network display info */
export interface NetworkInfo {
  type: NetworkType;
  name: string;
  icon: string;
  color: string;
}

export const NETWORK_INFO: Record<NetworkType, NetworkInfo> = {
  penumbra: { type: 'penumbra', name: 'Penumbra', icon: '🔴', color: '#E11D48' },
  zcash: { type: 'zcash', name: 'Zcash', icon: '💛', color: '#F4B728' },
  polkadot: { type: 'polkadot', name: 'Polkadot', icon: '🔵', color: '#E6007A' },
  cosmos: { type: 'cosmos', name: 'Cosmos', icon: '⚛️', color: '#6F7390' },
};

// =============================================================================
// Pending Transactions
// =============================================================================

export type TransactionStatus =
  | 'building'           // Building the transaction
  | 'awaiting_signature' // QR displayed, waiting for Zigner
  | 'signed'             // Signature scanned from Zigner
  | 'broadcasting'       // Sending to network
  | 'confirmed'          // Included in block
  | 'failed';            // Failed at any stage

export interface PendingTransaction {
  /** Unique transaction ID (local) */
  id: string;

  /** Which network this tx is for */
  network: NetworkType;

  /** Which wallet is sending */
  walletId: string;

  /** Human-readable summary */
  summary: string;

  /** QR hex to display for signing */
  signRequestQr: string;

  /** Current status */
  status: TransactionStatus;

  /** When created */
  createdAt: number;

  /** Signature QR hex (after scanning from Zigner) */
  signatureQr?: string;

  /** On-chain transaction hash (after broadcast) */
  txHash?: string;

  /** Error message if failed */
  error?: string;
}

// =============================================================================
// Sync State
// =============================================================================

export interface NetworkSyncState {
  /** Last synced block height */
  height: number;
  /** Currently syncing */
  syncing: boolean;
  /** Last sync timestamp */
  lastSync: number;
  /** Error if sync failed */
  error?: string;
}

// =============================================================================
// QR Import Result
// =============================================================================

export interface QrImportResult {
  /** Detected network from QR */
  network: NetworkType;
  /** Account index (if available) */
  accountIndex?: number;
  /** The network-specific keys */
  keys: PenumbraNetworkKeys | ZcashNetworkKeys | PolkadotNetworkKeys | CosmosNetworkKeys;
}
