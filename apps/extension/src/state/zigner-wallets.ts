/**
 * zigner-wallets state slice
 *
 * manages multiple zigner wallets, each with viewing keys for multiple networks.
 * this is the core state for the multi-network zigner-first wallet architecture.
 */

import type { AllSlices, SliceCreator } from '.';
import type { ExtensionStorage } from '@repo/storage-chrome/base';
import type { LocalStorageState } from '@repo/storage-chrome/local';
import type {
  ZignerWallet,
  NetworkType,
  PenumbraNetworkKeys,
  ZcashNetworkKeys,
  PolkadotNetworkKeys,
  CosmosNetworkKeys,
  PendingTransaction,
  TransactionStatus,
} from '@repo/wallet/networks';

// ============================================================================
// types
// ============================================================================

export interface ZignerWalletsSlice {
  /** all zigner wallets */
  wallets: ZignerWallet[];

  /** index of currently active wallet */
  activeWalletIndex: number;

  /** pending transactions awaiting signature */
  pendingTransactions: PendingTransaction[];

  // wallet management
  /** add a new wallet */
  addWallet: (wallet: Omit<ZignerWallet, 'id' | 'importedAt'>) => Promise<string>;

  /** remove a wallet by id */
  removeWallet: (walletId: string) => Promise<void>;

  /** update wallet label */
  updateWalletLabel: (walletId: string, label: string) => Promise<void>;

  /** set active wallet */
  setActiveWallet: (index: number) => Promise<void>;

  /** get current active wallet */
  getActiveWallet: () => ZignerWallet | undefined;

  // network management
  /** add network keys to a wallet */
  addNetworkToWallet: (
    walletId: string,
    network: NetworkType,
    keys: PenumbraNetworkKeys | ZcashNetworkKeys | PolkadotNetworkKeys | CosmosNetworkKeys,
  ) => Promise<void>;

  /** remove a network from a wallet */
  removeNetworkFromWallet: (walletId: string, network: NetworkType) => Promise<void>;

  // transaction management
  /** add a pending transaction */
  addPendingTransaction: (tx: Omit<PendingTransaction, 'id' | 'createdAt'>) => string;

  /** update transaction status */
  updateTransactionStatus: (
    txId: string,
    status: TransactionStatus,
    extra?: { signatureQr?: string; txHash?: string; error?: string },
  ) => void;

  /** remove a pending transaction */
  removePendingTransaction: (txId: string) => void;

  /** get pending transactions for active wallet */
  getActivePendingTransactions: () => PendingTransaction[];
}

// ============================================================================
// helpers
// ============================================================================

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ============================================================================
// slice creator
// ============================================================================

export const createZignerWalletsSlice =
  (local: ExtensionStorage<LocalStorageState>): SliceCreator<ZignerWalletsSlice> =>
  (set, get) => ({
    wallets: [],
    activeWalletIndex: 0,
    pendingTransactions: [],

    addWallet: async wallet => {
      const id = generateId();
      const newWallet: ZignerWallet = {
        ...wallet,
        id,
        importedAt: Date.now(),
      };

      set(state => {
        state.zignerWallets.wallets.push(newWallet);
      });

      await persistWallets(local, get().zignerWallets.wallets);
      return id;
    },

    removeWallet: async walletId => {
      set(state => {
        const idx = state.zignerWallets.wallets.findIndex(w => w.id === walletId);
        if (idx !== -1) {
          state.zignerWallets.wallets.splice(idx, 1);
          // adjust active index if needed
          if (state.zignerWallets.activeWalletIndex >= state.zignerWallets.wallets.length) {
            state.zignerWallets.activeWalletIndex = Math.max(
              0,
              state.zignerWallets.wallets.length - 1,
            );
          }
        }
      });

      await persistWallets(local, get().zignerWallets.wallets);
    },

    updateWalletLabel: async (walletId, label) => {
      set(state => {
        const wallet = state.zignerWallets.wallets.find(w => w.id === walletId);
        if (wallet) {
          wallet.label = label;
        }
      });

      await persistWallets(local, get().zignerWallets.wallets);
    },

    setActiveWallet: async index => {
      set(state => {
        if (index >= 0 && index < state.zignerWallets.wallets.length) {
          state.zignerWallets.activeWalletIndex = index;
        }
      });

      await local.set('activeWalletIndex', index);
    },

    getActiveWallet: () => {
      const { wallets, activeWalletIndex } = get().zignerWallets;
      return wallets[activeWalletIndex];
    },

    addNetworkToWallet: async (walletId, network, keys) => {
      set(state => {
        const wallet = state.zignerWallets.wallets.find(w => w.id === walletId);
        if (wallet) {
          switch (network) {
            case 'penumbra':
              wallet.networks.penumbra = keys as PenumbraNetworkKeys;
              break;
            case 'zcash':
              wallet.networks.zcash = keys as ZcashNetworkKeys;
              break;
            case 'polkadot':
              wallet.networks.polkadot = keys as PolkadotNetworkKeys;
              break;
            case 'cosmos':
              wallet.networks.cosmos = keys as CosmosNetworkKeys;
              break;
          }
        }
      });

      await persistWallets(local, get().zignerWallets.wallets);
    },

    removeNetworkFromWallet: async (walletId, network) => {
      set(state => {
        const wallet = state.zignerWallets.wallets.find(w => w.id === walletId);
        if (wallet) {
          delete wallet.networks[network];
        }
      });

      await persistWallets(local, get().zignerWallets.wallets);
    },

    addPendingTransaction: tx => {
      const id = generateId();
      const newTx: PendingTransaction = {
        ...tx,
        id,
        createdAt: Date.now(),
      };

      set(state => {
        state.zignerWallets.pendingTransactions.push(newTx);
      });

      return id;
    },

    updateTransactionStatus: (txId, status, extra) => {
      set(state => {
        const tx = state.zignerWallets.pendingTransactions.find(t => t.id === txId);
        if (tx) {
          tx.status = status;
          if (extra?.signatureQr !== undefined) tx.signatureQr = extra.signatureQr;
          if (extra?.txHash !== undefined) tx.txHash = extra.txHash;
          if (extra?.error !== undefined) tx.error = extra.error;
        }
      });
    },

    removePendingTransaction: txId => {
      set(state => {
        const idx = state.zignerWallets.pendingTransactions.findIndex(t => t.id === txId);
        if (idx !== -1) {
          state.zignerWallets.pendingTransactions.splice(idx, 1);
        }
      });
    },

    getActivePendingTransactions: () => {
      const { wallets, activeWalletIndex, pendingTransactions } = get().zignerWallets;
      const activeWallet = wallets[activeWalletIndex];
      if (!activeWallet) return [];
      return pendingTransactions.filter(tx => tx.walletId === activeWallet.id);
    },
  });

// ============================================================================
// persistence helper
// ============================================================================

async function persistWallets(
  local: ExtensionStorage<LocalStorageState>,
  wallets: ZignerWallet[],
): Promise<void> {
  // serialize wallets to storage format
  // for now, store full zigner wallets structure
  // TODO: once storage v3 is defined, use proper schema
  await local.set('zignerWallets' as keyof LocalStorageState, wallets as never);
}

// ============================================================================
// selectors
// ============================================================================

export const zignerWalletsSelector = (state: AllSlices) => state.zignerWallets;

export const activeZignerWalletSelector = (state: AllSlices) => {
  const { wallets, activeWalletIndex } = state.zignerWallets;
  return wallets[activeWalletIndex];
};

export const zignerWalletListSelector = (state: AllSlices) => ({
  wallets: state.zignerWallets.wallets,
  activeIndex: state.zignerWallets.activeWalletIndex,
  setActiveWallet: state.zignerWallets.setActiveWallet,
});
