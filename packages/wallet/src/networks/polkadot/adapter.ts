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
import {
  getLightClient,
  disconnectAll,
  CHAIN_INFO,
  getUnifiedBalance,
  detectChainFromAddress,
  type SupportedChain,
  type RelayChain,
  type ChainAsset,
} from './light-client';
import { hexToBytes } from '../common/qr';
import { isValidSs58 } from './zigner';

export class PolkadotAdapter implements NetworkAdapter {
  readonly networkId = 'polkadot' as const;
  readonly name = 'Polkadot';

  private ready = false;
  private defaultChain: SupportedChain = 'polkadot';

  /**
   * active relay network - must be explicitly set
   *
   * polkadot and paseo use same ss58 prefix (0), so we can't
   * auto-detect from address. user must choose their network.
   */
  private relay: RelayChain = 'polkadot';

  /** cached unified balances for seamless UX */
  private cachedAssets: ChainAsset[] = [];

  /** set active relay network (polkadot/kusama/paseo) */
  setRelay(relay: RelayChain): void {
    this.relay = relay;
    this.defaultChain = relay;
    this.cachedAssets = []; // clear cache on network switch
  }

  /** get current relay network */
  getRelay(): RelayChain {
    return this.relay;
  }

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

  /**
   * get all assets across all parachains - unified "one network" UX
   *
   * when user selects "Polkadot", they see HDX, GLMR, ACA, DOT etc. all together
   */
  async getAllEcosystemAssets(wallet: ZignerWallet): Promise<ChainAsset[]> {
    const polkadotKeys = wallet.networks.polkadot;
    if (!polkadotKeys) {
      return [];
    }

    this.cachedAssets = await getUnifiedBalance(this.relay, hexToBytes(polkadotKeys.publicKey));
    return this.cachedAssets;
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

    // detect chain from recipient address ss58 prefix
    // note: polkadot/paseo share prefix 0, so use user's selected relay for those
    const detectedChain = detectChainFromAddress(params.recipient);
    let chain: SupportedChain;

    if (detectedChain && detectedChain !== 'polkadot') {
      // specific parachain detected (hydration, moonbeam, etc.) - use it
      chain = detectedChain;
    } else {
      // generic polkadot address (prefix 0) or unknown - use user's selected relay
      // this handles polkadot vs paseo ambiguity
      chain = (polkadotKeys.chain || this.relay) as SupportedChain;
    }

    const chainInfo = CHAIN_INFO[chain];
    console.log(`[polkadot] sending on ${chain} (relay: ${this.relay})`);

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
