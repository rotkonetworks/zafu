/**
 * Zcash Network Adapter
 *
 * Implements the NetworkAdapter interface for Zcash.
 * Uses Orchard shielded pool for privacy transactions.
 */

import type {
  NetworkAdapter,
  NetworkBalance,
  NetworkTransaction,
  SendParams,
} from '../adapter';
import type { ZignerWallet, PendingTransaction } from '../common/types';
// import { ZCASH_NETWORKS, type ZcashNetworkConfig } from './types';

export class ZcashAdapter implements NetworkAdapter {
  readonly networkId = 'zcash' as const;
  readonly name = 'Zcash';

  private ready = false;

  async initialize(): Promise<void> {
    // Zcash uses Orchard (Halo 2) - no proving params needed
    // Just need to connect to lightwalletd
    console.log('[zcash] initializing adapter');
    this.ready = true;
  }

  async shutdown(): Promise<void> {
    console.log('[zcash] shutting down adapter');
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready;
  }

  async getBalance(wallet: ZignerWallet): Promise<NetworkBalance> {
    const zcashKeys = wallet.networks.zcash;
    if (!zcashKeys) {
      throw new Error('Wallet has no Zcash keys');
    }

    // TODO: Query lightwalletd for balance
    return {
      total: 0n,
      available: 0n,
      pending: 0n,
      denom: 'ZEC',
      decimals: 8,
    };
  }

  async getTransactions(
    _wallet: ZignerWallet,
    _limit = 50,
    _offset = 0
  ): Promise<NetworkTransaction[]> {
    // TODO: Query lightwalletd for transactions
    return [];
  }

  async buildSendTransaction(
    _wallet: ZignerWallet,
    _params: SendParams
  ): Promise<PendingTransaction> {
    // TODO: Build unsigned Zcash transaction
    // This creates the transaction structure and QR for Zigner
    throw new Error('Not implemented');
  }

  async completeSendTransaction(
    _pendingTx: PendingTransaction,
    _signatureQrHex: string
  ): Promise<string> {
    // TODO: Apply signatures and broadcast
    throw new Error('Not implemented');
  }

  validateAddress(address: string): boolean {
    // Zcash unified addresses start with 'u1' (mainnet) or 'utest1' (testnet)
    // Sapling addresses start with 'zs' or 'ztestsapling'
    // Transparent addresses start with 't1' or 't3' (mainnet) or 'tm' (testnet)
    return (
      address.startsWith('u1') ||
      address.startsWith('utest1') ||
      address.startsWith('zs') ||
      address.startsWith('t1') ||
      address.startsWith('t3')
    );
  }

  formatAmount(amount: bigint): string {
    const zec = Number(amount) / 1e8;
    return `${zec.toFixed(8)} ZEC`;
  }

  parseAmount(input: string): bigint {
    const cleaned = input.replace(/[^\d.]/g, '');
    const zec = parseFloat(cleaned);
    if (isNaN(zec)) {
      throw new Error('Invalid amount');
    }
    return BigInt(Math.round(zec * 1e8));
  }

  async sync(
    wallet: ZignerWallet,
    onProgress?: (percent: number) => void
  ): Promise<void> {
    const zcashKeys = wallet.networks.zcash;
    if (!zcashKeys) {
      throw new Error('Wallet has no Zcash keys');
    }

    // TODO: Sync with lightwalletd
    // Trial-decrypt blocks to find notes belonging to this FVK
    console.log('[zcash] sync not yet implemented');
    onProgress?.(100);
  }
}
