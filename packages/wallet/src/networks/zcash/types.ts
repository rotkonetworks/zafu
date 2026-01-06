/**
 * Zcash-specific types
 */

import type { ZcashNetworkKeys } from '../common/types';

/** Zcash transaction for sending */
export interface ZcashSendParams {
  /** Recipient unified address */
  recipient: string;
  /** Amount in zatoshis */
  amount: bigint;
  /** Fee in zatoshis */
  fee: bigint;
  /** Optional memo */
  memo?: string;
}

/** Spendable note (from chain scan) */
export interface SpendableNote {
  /** Note commitment x-coordinate (hex) */
  cmx: string;
  /** Nullifier (hex) */
  nullifier: string;
  /** Note value in zatoshis */
  value: bigint;
  /** Position in commitment tree */
  position: bigint;
  /** Block height */
  height: number;
}

/** Unsigned Zcash transaction ready for signing */
export interface UnsignedZcashTx {
  /** Local transaction ID */
  id: string;
  /** Anchor (merkle root) */
  anchor: string;
  /** Notes being spent */
  spends: SpendableNote[];
  /** Computed sighash */
  sighash: Uint8Array;
  /** Alpha randomizers for each action */
  alphas: Uint8Array[];
  /** Recipient address */
  recipient: string;
  /** Send amount */
  amount: bigint;
  /** Fee */
  fee: bigint;
  /** Change amount */
  change: bigint;
  /** Summary for display */
  summary: string;
  /** Account index */
  accountIndex: number;
  /** Mainnet or testnet */
  mainnet: boolean;
}

/** Signed Zcash transaction */
export interface SignedZcashTx extends UnsignedZcashTx {
  /** Orchard signatures (64 bytes each) */
  orchardSignatures: Uint8Array[];
  /** Transparent signatures (if any) */
  transparentSignatures: Uint8Array[];
}

/** Zcash wallet state */
export interface ZcashWalletState {
  /** Wallet info */
  wallet: ZcashNetworkKeys;
  /** Scanned notes */
  notes: SpendableNote[];
  /** Current balance (zatoshis) */
  balance: bigint;
  /** Last synced height */
  syncHeight: number;
  /** Pending transactions */
  pendingTxs: UnsignedZcashTx[];
}

/** Zcash network configuration */
export interface ZcashNetworkConfig {
  /** Network name */
  name: string;
  /** Is mainnet */
  mainnet: boolean;
  /** Lightwalletd URL */
  lightwalletdUrl: string;
  /** Explorer URL template */
  explorerUrl: string;
}

/** Default Zcash networks */
export const ZCASH_NETWORKS: ZcashNetworkConfig[] = [
  {
    name: 'Zcash Mainnet',
    mainnet: true,
    lightwalletdUrl: 'https://mainnet.lightwalletd.com:9067',
    explorerUrl: 'https://zcashblockexplorer.com/transactions/{txid}',
  },
  {
    name: 'Zcash Testnet',
    mainnet: false,
    lightwalletdUrl: 'https://testnet.lightwalletd.com:9067',
    explorerUrl: 'https://testnet.zcashblockexplorer.com/transactions/{txid}',
  },
];
