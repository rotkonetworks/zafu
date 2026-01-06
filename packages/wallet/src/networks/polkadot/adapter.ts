/**
 * Polkadot Network Adapter
 *
 * Implements the NetworkAdapter interface for Polkadot/Kusama.
 * Uses smoldot light client for trustless access.
 */

import type {
  NetworkAdapter,
  NetworkBalance,
  NetworkTransaction,
  SendParams,
} from '../adapter';
import type { ZignerWallet, PendingTransaction } from '../common/types';
import { getLightClient, disconnectAll, CHAIN_INFO, type SupportedChain } from './light-client';
import { isValidSs58 } from './zigner';

export class PolkadotAdapter implements NetworkAdapter {
  readonly networkId = 'polkadot' as const;
  readonly name = 'Polkadot';

  private ready = false;
  private defaultChain: SupportedChain = 'polkadot';

  async initialize(): Promise<void> {
    console.log('[polkadot] initializing adapter with smoldot light client');
    this.ready = true;
  }

  async shutdown(): Promise<void> {
    console.log('[polkadot] shutting down adapter');
    await disconnectAll();
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready;
  }

  async getBalance(wallet: ZignerWallet): Promise<NetworkBalance> {
    const polkadotKeys = wallet.networks.polkadot;
    if (!polkadotKeys) {
      throw new Error('Wallet has no Polkadot keys');
    }

    const chain = (polkadotKeys.chain || 'polkadot') as SupportedChain;
    const chainInfo = CHAIN_INFO[chain];

    try {
      const client = await getLightClient(chain);
      const balance = await client.getBalance(polkadotKeys);

      return {
        total: balance,
        available: balance,
        pending: 0n,
        denom: chainInfo.symbol,
        decimals: chainInfo.decimals,
      };
    } catch (error) {
      console.error('[polkadot] failed to get balance:', error);
      return {
        total: 0n,
        available: 0n,
        pending: 0n,
        denom: chainInfo.symbol,
        decimals: chainInfo.decimals,
      };
    }
  }

  async getTransactions(
    _wallet: ZignerWallet,
    _limit = 50,
    _offset = 0
  ): Promise<NetworkTransaction[]> {
    // Polkadot light clients don't support transaction history queries
    // Would need an indexer service
    return [];
  }

  async buildSendTransaction(
    wallet: ZignerWallet,
    params: SendParams
  ): Promise<PendingTransaction> {
    const polkadotKeys = wallet.networks.polkadot;
    if (!polkadotKeys) {
      throw new Error('Wallet has no Polkadot keys');
    }

    const chain = (polkadotKeys.chain || 'polkadot') as SupportedChain;
    const chainInfo = CHAIN_INFO[chain];

    // Build the unsigned transfer transaction
    const client = await getLightClient(chain);
    const callData = await client.buildTransfer(polkadotKeys, params.recipient, params.amount);

    // Format for display
    const amountDisplay = this.formatAmountWithDecimals(params.amount, chainInfo.decimals, chainInfo.symbol);

    // Convert to hex without Buffer
    const signRequestQr = Array.from(callData).map(b => b.toString(16).padStart(2, '0')).join('');

    return {
      id: `polkadot-${Date.now()}`,
      network: 'polkadot',
      walletId: wallet.id,
      summary: `Send ${amountDisplay} to ${params.recipient.slice(0, 8)}...`,
      signRequestQr,
      status: 'awaiting_signature',
      createdAt: Date.now(),
    };
  }

  async completeSendTransaction(
    _pendingTx: PendingTransaction,
    _signatureQrHex: string
  ): Promise<string> {
    // TODO: Apply signature and broadcast via light client
    throw new Error('Not implemented');
  }

  validateAddress(address: string): boolean {
    return isValidSs58(address);
  }

  formatAmount(amount: bigint): string {
    const chainInfo = CHAIN_INFO[this.defaultChain];
    return this.formatAmountWithDecimals(amount, chainInfo.decimals, chainInfo.symbol);
  }

  private formatAmountWithDecimals(amount: bigint, decimals: number, symbol: string): string {
    const divisor = BigInt(10 ** decimals);
    const whole = amount / divisor;
    const fractional = amount % divisor;
    const fractionalStr = fractional.toString().padStart(decimals, '0');
    return `${whole}.${fractionalStr.slice(0, 4)} ${symbol}`;
  }

  parseAmount(input: string): bigint {
    const chainInfo = CHAIN_INFO[this.defaultChain];
    const cleaned = input.replace(/[^\d.]/g, '');
    const value = parseFloat(cleaned);
    if (isNaN(value)) {
      throw new Error('Invalid amount');
    }
    return BigInt(Math.round(value * (10 ** chainInfo.decimals)));
  }

  async sync(
    wallet: ZignerWallet,
    onProgress?: (percent: number) => void
  ): Promise<void> {
    const polkadotKeys = wallet.networks.polkadot;
    if (!polkadotKeys) {
      throw new Error('Wallet has no Polkadot keys');
    }

    const chain = (polkadotKeys.chain || 'polkadot') as SupportedChain;

    try {
      await getLightClient(chain);
      onProgress?.(100);
    } catch (error) {
      console.error('[polkadot] sync failed:', error);
      throw error;
    }
  }
}
