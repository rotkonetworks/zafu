/**
 * network worker manager - isolates each network in its own web worker
 *
 * benefits:
 * - separate memory space per network (no cross-contamination)
 * - parallel sync without blocking UI
 * - can terminate worker to fully free memory
 * - networks don't slow each other down
 *
 * each network gets:
 * - dedicated web worker
 * - own wasm instance
 * - own sync loop
 * - own indexeddb store
 */

import type { NetworkType } from './types';

export interface NetworkWorkerMessage {
  type: 'init' | 'derive-address' | 'sync' | 'stop-sync' | 'get-balance' | 'send-tx' | 'list-wallets' | 'delete-wallet';
  id: string;
  network: NetworkType;
  walletId?: string;
  payload?: unknown;
}

export interface NetworkWorkerResponse {
  type: 'ready' | 'address' | 'sync-progress' | 'sync-started' | 'sync-stopped' | 'balance' | 'tx-result' | 'wallets' | 'wallet-deleted' | 'error';
  id: string;
  network: NetworkType;
  walletId?: string;
  payload?: unknown;
  error?: string;
}

interface WorkerState {
  worker: Worker;
  ready: boolean;
  syncingWallets: Set<string>; // track which wallets are syncing
  pendingCallbacks: Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>;
}

const workers = new Map<NetworkType, WorkerState>();

let messageId = 0;
const nextId = () => `msg_${++messageId}`;

/**
 * spawn a dedicated worker for a network
 * worker loads its own wasm and handles sync independently
 */
export const spawnNetworkWorker = async (network: NetworkType): Promise<void> => {
  if (workers.has(network)) return;

  // each network has its own worker script
  const workerUrl = getWorkerUrl(network);
  if (!workerUrl) {
    console.warn(`[network-worker] no worker for ${network}`);
    return;
  }

  const worker = new Worker(workerUrl, { type: 'module' });
  const state: WorkerState = {
    worker,
    ready: false,
    syncingWallets: new Set(),
    pendingCallbacks: new Map(),
  };

  worker.onmessage = (e: MessageEvent<NetworkWorkerResponse>) => {
    const msg = e.data;

    if (msg.type === 'ready') {
      state.ready = true;
      console.log(`[network-worker] ${network} worker ready`);
      return;
    }

    if (msg.type === 'sync-progress') {
      // emit progress event with walletId
      window.dispatchEvent(new CustomEvent('network-sync-progress', {
        detail: { network, walletId: msg.walletId, ...msg.payload as object }
      }));
      return;
    }

    // track sync state per wallet
    if (msg.type === 'sync-started' && msg.walletId) {
      state.syncingWallets.add(msg.walletId);
    }
    if (msg.type === 'sync-stopped' && msg.walletId) {
      state.syncingWallets.delete(msg.walletId);
    }

    // resolve pending callback
    const callback = state.pendingCallbacks.get(msg.id);
    if (callback) {
      state.pendingCallbacks.delete(msg.id);
      if (msg.error) {
        callback.reject(new Error(msg.error));
      } else {
        callback.resolve(msg.payload);
      }
    }
  };

  worker.onerror = (e) => {
    console.error(`[network-worker] ${network} error:`, e);
  };

  workers.set(network, state);

  // wait for worker to be ready
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('worker init timeout')), 30000);
    const check = () => {
      if (state.ready) {
        clearTimeout(timeout);
        resolve();
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });
};

/**
 * terminate a network's worker and free memory
 */
export const terminateNetworkWorker = (network: NetworkType): void => {
  const state = workers.get(network);
  if (state) {
    state.worker.terminate();
    workers.delete(network);
    console.log(`[network-worker] ${network} worker terminated`);
  }
};

/**
 * send message to network worker and await response
 */
const callWorker = <T>(
  network: NetworkType,
  type: NetworkWorkerMessage['type'],
  payload?: unknown,
  walletId?: string,
): Promise<T> => {
  const state = workers.get(network);
  if (!state?.ready) {
    return Promise.reject(new Error(`${network} worker not ready`));
  }

  const id = nextId();
  return new Promise((resolve, reject) => {
    state.pendingCallbacks.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
    });

    state.worker.postMessage({
      type,
      id,
      network,
      walletId,
      payload,
    } satisfies NetworkWorkerMessage);
  });
};

/**
 * derive address for a network (runs in worker)
 */
export const deriveAddressInWorker = async (
  network: NetworkType,
  mnemonic: string,
  accountIndex: number,
): Promise<string> => {
  return callWorker(network, 'derive-address', { mnemonic, accountIndex });
};

/**
 * start sync for a wallet on a network (runs in worker)
 */
export const startSyncInWorker = async (
  network: NetworkType,
  walletId: string,
  mnemonic: string,
  serverUrl: string,
  startHeight?: number,
): Promise<void> => {
  return callWorker(network, 'sync', { mnemonic, serverUrl, startHeight }, walletId);
};

/**
 * stop sync for a wallet on a network
 */
export const stopSyncInWorker = async (network: NetworkType, walletId: string): Promise<void> => {
  return callWorker(network, 'stop-sync', {}, walletId);
};

/**
 * get balance for a wallet on a network
 */
export const getBalanceInWorker = async (network: NetworkType, walletId: string): Promise<string> => {
  return callWorker(network, 'get-balance', {}, walletId);
};

/**
 * list all wallets for a network
 */
export const listWalletsInWorker = async (network: NetworkType): Promise<string[]> => {
  return callWorker(network, 'list-wallets', {});
};

/**
 * delete a wallet and all its data from a network
 */
export const deleteWalletInWorker = async (network: NetworkType, walletId: string): Promise<void> => {
  return callWorker(network, 'delete-wallet', {}, walletId);
};

/**
 * check if a specific wallet is syncing on a network
 */
export const isWalletSyncing = (network: NetworkType, walletId: string): boolean => {
  return workers.get(network)?.syncingWallets.has(walletId) ?? false;
};

/**
 * check if any wallet is syncing on a network
 */
export const isNetworkSyncing = (network: NetworkType): boolean => {
  const state = workers.get(network);
  return state ? state.syncingWallets.size > 0 : false;
};

/**
 * check if network worker is running
 */
export const isNetworkWorkerRunning = (network: NetworkType): boolean => {
  return workers.has(network);
};

// worker URLs per network
const getWorkerUrl = (network: NetworkType): string | null => {
  switch (network) {
    case 'zcash':
      return '/workers/zcash-worker.js';
    case 'penumbra':
      return '/workers/penumbra-worker.js';
    default:
      return null;
  }
};
