/**
 * Network Adapter Interface
 *
 * Each network (Penumbra, Zcash, Polkadot, etc.) implements this interface.
 * Adapters are lazy-loaded only when the network is enabled by the user.
 */

import type { NetworkType, ZignerWallet, PendingTransaction } from './common/types';

export interface NetworkBalance {
  /** Total balance in base units */
  total: bigint;
  /** Available (spendable) balance */
  available: bigint;
  /** Pending incoming */
  pending: bigint;
  /** Display denomination (e.g., 'ZEC', 'PENUMBRA', 'DOT') */
  denom: string;
  /** Decimals for display */
  decimals: number;
}

export interface NetworkTransaction {
  /** Transaction hash */
  hash: string;
  /** Block height */
  height: number;
  /** Timestamp */
  timestamp: number;
  /** Direction: in or out */
  direction: 'in' | 'out';
  /** Amount (absolute value) */
  amount: bigint;
  /** Human-readable summary */
  summary: string;
  /** Status */
  status: 'pending' | 'confirmed' | 'failed';
}

export interface SendParams {
  /** Recipient address */
  recipient: string;
  /** Amount in base units */
  amount: bigint;
  /** Optional memo/note */
  memo?: string;
}

/**
 * Network Adapter - the interface each network must implement
 *
 * All methods that require network access are async.
 * Adapters should be lazy-loaded when enabled.
 */
export interface NetworkAdapter {
  /** Network identifier */
  readonly networkId: NetworkType;

  /** Human-readable name */
  readonly name: string;

  /** Initialize the adapter (load WASM, connect to node, etc.) */
  initialize(): Promise<void>;

  /** Shut down the adapter (disconnect, cleanup) */
  shutdown(): Promise<void>;

  /** Check if adapter is ready for operations */
  isReady(): boolean;

  /** Get balance for a wallet */
  getBalance(wallet: ZignerWallet): Promise<NetworkBalance>;

  /** Get transaction history */
  getTransactions(
    wallet: ZignerWallet,
    limit?: number,
    offset?: number
  ): Promise<NetworkTransaction[]>;

  /** Build an unsigned transaction (returns QR to display) */
  buildSendTransaction(
    wallet: ZignerWallet,
    params: SendParams
  ): Promise<PendingTransaction>;

  /** Complete a transaction after receiving signature from Zigner */
  completeSendTransaction(
    pendingTx: PendingTransaction,
    signatureQrHex: string
  ): Promise<string>; // Returns tx hash

  /** Validate an address for this network */
  validateAddress(address: string): boolean;

  /** Format an amount for display */
  formatAmount(amount: bigint): string;

  /** Parse an amount from user input */
  parseAmount(input: string): bigint;

  /** Sync wallet state (scan blockchain, update notes, etc.) */
  sync(wallet: ZignerWallet, onProgress?: (percent: number) => void): Promise<void>;
}

/**
 * Lazy load a network adapter
 *
 * Each network's adapter is loaded dynamically only when needed.
 */
export async function loadNetworkAdapter(network: NetworkType): Promise<NetworkAdapter> {
  switch (network) {
    case 'penumbra':
      const { PenumbraAdapter } = await import('./penumbra/adapter');
      return new PenumbraAdapter();

    case 'zcash':
      const { ZcashAdapter } = await import('./zcash/adapter');
      return new ZcashAdapter();

    case 'polkadot':
      const { PolkadotAdapter } = await import('./polkadot/adapter');
      return new PolkadotAdapter();

    case 'cosmos':
      const { CosmosAdapter } = await import('./cosmos/adapter');
      return new CosmosAdapter();

    default:
      throw new Error(`Unknown network: ${network}`);
  }
}

/** Registry of loaded adapters */
const loadedAdapters = new Map<NetworkType, NetworkAdapter>();

/**
 * Get or load a network adapter
 *
 * Caches loaded adapters for reuse.
 */
export async function getNetworkAdapter(network: NetworkType): Promise<NetworkAdapter> {
  let adapter = loadedAdapters.get(network);

  if (!adapter) {
    adapter = await loadNetworkAdapter(network);
    await adapter.initialize();
    loadedAdapters.set(network, adapter);
  }

  return adapter;
}

/**
 * Unload a network adapter
 *
 * Call this when a user disables a network.
 */
export async function unloadNetworkAdapter(network: NetworkType): Promise<void> {
  const adapter = loadedAdapters.get(network);

  if (adapter) {
    await adapter.shutdown();
    loadedAdapters.delete(network);
  }
}

/**
 * Get all currently loaded adapters
 */
export function getLoadedAdapters(): NetworkAdapter[] {
  return Array.from(loadedAdapters.values());
}

/**
 * Check if a network adapter is loaded
 */
export function isAdapterLoaded(network: NetworkType): boolean {
  return loadedAdapters.has(network);
}
