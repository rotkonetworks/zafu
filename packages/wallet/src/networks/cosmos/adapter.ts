/**
 * Cosmos Network Adapter
 *
 * supports IBC chains for penumbra integration:
 * - osmosis: DEX hub, IBC routing
 * - noble: native USDC
 * - nomic: bitcoin bridge (nBTC)
 * - celestia: DA layer
 *
 * same key derivation (m/44'/118'/0'/0/0) with different bech32 prefix
 */

import type {
  NetworkAdapter,
  NetworkBalance,
  NetworkTransaction,
  SendParams,
} from '../adapter';
import { bytesToHex } from '../common/qr';
import type { ZignerWallet, PendingTransaction } from '../common/types';
import {
  getBalance,
  buildUnsignedSend,
  encodeForSigning,
  disconnectAll,
  deriveAllAddresses,
} from './client';
import {
  COSMOS_CHAINS,
  isValidCosmosAddress,
  getChainFromAddress,
  type CosmosChainId,
} from './chains';

export class CosmosAdapter implements NetworkAdapter {
  readonly networkId = 'cosmos' as const;
  readonly name = 'Cosmos';

  private ready = false;
  /** default chain for operations */
  private defaultChain: CosmosChainId = 'osmosis';

  async initialize(): Promise<void> {
    console.log('[cosmos] initializing adapter');
    this.ready = true;
  }

  async shutdown(): Promise<void> {
    console.log('[cosmos] shutting down adapter');
    disconnectAll();
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready;
  }

  /** set the default chain for operations */
  setDefaultChain(chain: CosmosChainId): void {
    this.defaultChain = chain;
  }

  async getBalance(wallet: ZignerWallet): Promise<NetworkBalance> {
    const cosmosKeys = wallet.networks.cosmos;
    if (!cosmosKeys) {
      throw new Error('Wallet has no Cosmos keys');
    }

    const config = COSMOS_CHAINS[this.defaultChain];

    try {
      // derive address for default chain from the stored address
      const addresses = deriveAllAddresses(cosmosKeys.address);
      const chainAddress = addresses[this.defaultChain];

      const balance = await getBalance(this.defaultChain, chainAddress);

      return {
        total: balance.amount,
        available: balance.amount,
        pending: 0n,
        denom: config.symbol,
        decimals: config.decimals,
      };
    } catch (error) {
      console.error('[cosmos] failed to get balance:', error);
      return {
        total: 0n,
        available: 0n,
        pending: 0n,
        denom: config.symbol,
        decimals: config.decimals,
      };
    }
  }

  /** get balances across all cosmos chains */
  async getAllChainBalances(wallet: ZignerWallet): Promise<Record<CosmosChainId, NetworkBalance>> {
    const cosmosKeys = wallet.networks.cosmos;
    if (!cosmosKeys) {
      throw new Error('Wallet has no Cosmos keys');
    }

    const addresses = deriveAllAddresses(cosmosKeys.address);
    const balances: Record<string, NetworkBalance> = {};

    await Promise.all(
      Object.entries(COSMOS_CHAINS).map(async ([chainId, config]) => {
        try {
          const balance = await getBalance(chainId as CosmosChainId, addresses[chainId as CosmosChainId]!);
          balances[chainId] = {
            total: balance.amount,
            available: balance.amount,
            pending: 0n,
            denom: config.symbol,
            decimals: config.decimals,
          };
        } catch (error) {
          console.error(`[cosmos] failed to get ${chainId} balance:`, error);
          balances[chainId] = {
            total: 0n,
            available: 0n,
            pending: 0n,
            denom: config.symbol,
            decimals: config.decimals,
          };
        }
      })
    );

    return balances as Record<CosmosChainId, NetworkBalance>;
  }

  async getTransactions(
    _wallet: ZignerWallet,
    _limit = 50,
    _offset = 0
  ): Promise<NetworkTransaction[]> {
    // cosmos RPC doesn't support tx history queries well
    // would need an indexer (mintscan, etc)
    return [];
  }

  async buildSendTransaction(
    wallet: ZignerWallet,
    params: SendParams
  ): Promise<PendingTransaction> {
    const cosmosKeys = wallet.networks.cosmos;
    if (!cosmosKeys) {
      throw new Error('Wallet has no Cosmos keys');
    }

    // detect target chain from recipient address
    const targetChain = getChainFromAddress(params.recipient);
    if (!targetChain) {
      throw new Error(`Unknown address prefix: ${params.recipient}`);
    }

    const chainId = targetChain.id;
    const addresses = deriveAllAddresses(cosmosKeys.address);
    const fromAddress = addresses[chainId];

    // build unsigned transaction
    const unsignedTx = await buildUnsignedSend(
      chainId,
      fromAddress,
      params.recipient,
      params.amount,
      params.memo
    );

    // encode for signing (amino JSON)
    const signDoc = encodeForSigning(unsignedTx);

    // format for display
    const amountDisplay = this.formatAmountWithDecimals(
      params.amount,
      targetChain.decimals,
      targetChain.symbol
    );

    return {
      id: `cosmos-${chainId}-${Date.now()}`,
      network: 'cosmos',
      walletId: wallet.id,
      summary: `Send ${amountDisplay} on ${targetChain.name}`,
      signRequestQr: bytesToHex(new TextEncoder().encode(signDoc)),
      status: 'awaiting_signature',
      createdAt: Date.now(),
    };
  }

  async completeSendTransaction(
    _pendingTx: PendingTransaction,
    _signatureQrHex: string
  ): Promise<string> {
    // TODO: Apply signature and broadcast
    // 1. decode signature from zigner QR
    // 2. construct signed tx bytes
    // 3. broadcast via StargateClient.broadcastTx
    throw new Error('Not implemented - awaiting zigner cosmos signing format');
  }

  validateAddress(address: string): boolean {
    return isValidCosmosAddress(address);
  }

  formatAmount(amount: bigint): string {
    const config = COSMOS_CHAINS[this.defaultChain];
    return this.formatAmountWithDecimals(amount, config.decimals, config.symbol);
  }

  private formatAmountWithDecimals(amount: bigint, decimals: number, symbol: string): string {
    const divisor = BigInt(10 ** decimals);
    const whole = amount / divisor;
    const fractional = amount % divisor;
    const fractionalStr = fractional.toString().padStart(decimals, '0');
    return `${whole}.${fractionalStr.slice(0, 4)} ${symbol}`;
  }

  parseAmount(input: string): bigint {
    const config = COSMOS_CHAINS[this.defaultChain];
    const cleaned = input.replace(/[^\d.]/g, '');
    const value = parseFloat(cleaned);
    if (isNaN(value)) {
      throw new Error('Invalid amount');
    }
    return BigInt(Math.round(value * 10 ** config.decimals));
  }

  async sync(
    wallet: ZignerWallet,
    onProgress?: (percent: number) => void
  ): Promise<void> {
    const cosmosKeys = wallet.networks.cosmos;
    if (!cosmosKeys) {
      throw new Error('Wallet has no Cosmos keys');
    }

    // cosmos is account-based, no scanning needed
    // just verify we can connect
    try {
      const addresses = deriveAllAddresses(cosmosKeys.address);
      await getBalance(this.defaultChain, addresses[this.defaultChain]!);
      onProgress?.(100);
    } catch (error) {
      console.error('[cosmos] sync failed:', error);
      throw error;
    }
  }
}
