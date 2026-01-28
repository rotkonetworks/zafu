/**
 * Penumbra Network Adapter
 *
 * Implements the NetworkAdapter interface for Penumbra.
 * This is the primary network that was originally supported.
 */

import type {
  NetworkAdapter,
  NetworkBalance,
  NetworkTransaction,
  SendParams,
} from '../adapter';
import type { ZignerWallet, PendingTransaction } from '../common/types';

export class PenumbraAdapter implements NetworkAdapter {
  readonly networkId = 'penumbra' as const;
  readonly name = 'Penumbra';

  private ready = false;

  async initialize(): Promise<void> {
    console.log('[penumbra] initializing adapter');
    // Penumbra uses the existing @rotko/penumbra-wasm infrastructure
    // This will be dynamically imported when needed
    this.ready = true;
  }

  async shutdown(): Promise<void> {
    console.log('[penumbra] shutting down adapter');
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready;
  }

  async getBalance(wallet: ZignerWallet): Promise<NetworkBalance> {
    const penumbraKeys = wallet.networks.penumbra;
    if (!penumbraKeys) {
      throw new Error('Wallet has no Penumbra keys');
    }

    // TODO: Query ViewServer for balance
    // The existing Zafu implementation already handles this
    // This adapter will wrap that functionality
    return {
      total: 0n,
      available: 0n,
      pending: 0n,
      denom: 'UM',
      decimals: 6,
    };
  }

  async getTransactions(
    _wallet: ZignerWallet,
    _limit = 50,
    _offset = 0
  ): Promise<NetworkTransaction[]> {
    // TODO: Query ViewServer for transactions
    return [];
  }

  async buildSendTransaction(
    _wallet: ZignerWallet,
    _params: SendParams
  ): Promise<PendingTransaction> {
    // TODO: Build Penumbra transaction with spend proof
    throw new Error('Not implemented - use existing Zafu flow');
  }

  async completeSendTransaction(
    _pendingTx: PendingTransaction,
    _signatureQrHex: string
  ): Promise<string> {
    // TODO: Apply signature and broadcast
    throw new Error('Not implemented - use existing Zafu flow');
  }

  validateAddress(address: string): boolean {
    // Penumbra addresses are bech32m with 'penumbra1' prefix (full) or 'penumbracompat1' (opaque)
    return (
      address.startsWith('penumbra1') ||
      address.startsWith('penumbracompat1') ||
      address.startsWith('penumbratestnet')
    );
  }

  formatAmount(amount: bigint): string {
    const um = Number(amount) / 1e6;
    return `${um.toFixed(6)} UM`;
  }

  parseAmount(input: string): bigint {
    const cleaned = input.replace(/[^\d.]/g, '');
    const um = parseFloat(cleaned);
    if (isNaN(um)) {
      throw new Error('Invalid amount');
    }
    return BigInt(Math.round(um * 1e6));
  }

  async sync(
    wallet: ZignerWallet,
    onProgress?: (percent: number) => void
  ): Promise<void> {
    const penumbraKeys = wallet.networks.penumbra;
    if (!penumbraKeys) {
      throw new Error('Wallet has no Penumbra keys');
    }

    // TODO: Sync with ViewServer
    // The existing Zafu implementation handles this
    console.log('[penumbra] sync not yet implemented in adapter');
    onProgress?.(100);
  }
}
