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
  type: 'init' | 'derive-address' | 'sync' | 'stop-sync' | 'reset-sync' | 'get-balance' | 'send-tx' | 'send-tx-multi' | 'send-tx-complete' | 'shield' | 'shield-unsigned' | 'shield-complete' | 'list-wallets' | 'delete-wallet' | 'get-notes' | 'note-sync-encode' | 'decrypt-memos' | 'get-transparent-history' | 'get-history' | 'sync-memos' | 'frost-dkg-part1' | 'frost-dkg-part2' | 'frost-dkg-part3' | 'frost-sign-round1' | 'frost-spend-sign' | 'frost-spend-aggregate' | 'frost-derive-address' | 'frost-derive-address-from-sk' | 'frost-sample-fvk-sk' | 'frost-derive-ufvk';
  id: string;
  network: NetworkType;
  walletId?: string;
  payload?: unknown;
}

export interface NetworkWorkerResponse {
  type: 'ready' | 'address' | 'sync-progress' | 'send-progress' | 'sync-started' | 'sync-stopped' | 'sync-reset' | 'balance' | 'tx-result' | 'tx-multi-result' | 'send-tx-unsigned' | 'shield-result' | 'shield-unsigned-result' | 'wallets' | 'wallet-deleted' | 'notes' | 'note-sync-encoded' | 'memos' | 'transparent-history' | 'history' | 'memos-result' | 'sync-memos-progress' | 'mempool-update' | 'prove-request' | 'frost-result' | 'error';
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
const spawnPromises = new Map<NetworkType, Promise<void>>();

let messageId = 0;
const nextId = () => `msg_${++messageId}`;

/**
 * spawn a dedicated worker for a network
 * worker loads its own wasm and handles sync independently
 * concurrent callers share the same spawn promise (no race condition)
 */
export const spawnNetworkWorker = async (network: NetworkType): Promise<void> => {
  if (workers.get(network)?.ready) return;

  // deduplicate concurrent spawn calls
  const existing = spawnPromises.get(network);
  if (existing) return existing;

  const promise = spawnNetworkWorkerInner(network);
  spawnPromises.set(network, promise);
  try {
    await promise;
  } finally {
    spawnPromises.delete(network);
  }
};

const spawnNetworkWorkerInner = async (network: NetworkType): Promise<void> => {
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

    // relay prove requests from zcash-worker to offscreen via service worker
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (msg.type === 'prove-request' && (msg as any).id && (msg as any).request) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void relayProveRequest(worker, (msg as any).id, (msg as any).request);
      return;
    }

    if (msg.type === 'sync-progress') {
      // emit progress event with walletId
      window.dispatchEvent(new CustomEvent('network-sync-progress', {
        detail: { network, walletId: msg.walletId, ...msg.payload as object }
      }));
      return;
    }

    if (msg.type === 'send-progress') {
      window.dispatchEvent(new CustomEvent('zcash-send-progress', {
        detail: { network, walletId: msg.walletId, ...msg.payload as object }
      }));
      return;
    }

    if (msg.type === 'sync-memos-progress') {
      window.dispatchEvent(new CustomEvent('zcash-memo-sync-progress', {
        detail: { network, walletId: msg.walletId, ...msg.payload as object }
      }));
      return;
    }

    if (msg.type === 'mempool-update') {
      window.dispatchEvent(new CustomEvent('zcash-mempool-update', {
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
 * start watch-only sync for a wallet using UFVK (no mnemonic needed)
 */
export const startWatchOnlySyncInWorker = async (
  network: NetworkType,
  walletId: string,
  ufvk: string,
  serverUrl: string,
  startHeight?: number,
): Promise<void> => {
  return callWorker(network, 'sync', { mnemonic: '', serverUrl, startHeight, ufvk }, walletId);
};

/**
 * stop sync for a wallet on a network
 */
export const stopSyncInWorker = async (network: NetworkType, walletId: string): Promise<void> => {
  return callWorker(network, 'stop-sync', {}, walletId);
};

/**
 * reset sync for a wallet — clears IDB notes/spent/meta and in-memory state
 */
export const resetSyncInWorker = async (network: NetworkType, walletId: string): Promise<void> => {
  return callWorker(network, 'reset-sync', {}, walletId);
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

/** note with txid for memo retrieval */
export interface DecryptedNoteWithTxid {
  height: number;
  value: string;
  nullifier: string;
  cmx: string;
  txid: string;
  position: number;
  is_change?: boolean;
  spent?: boolean;
  spent_by_txid?: string;
}

/**
 * get all notes for a wallet (includes txid for memo retrieval)
 */
export const getNotesInWorker = async (network: NetworkType, walletId: string): Promise<DecryptedNoteWithTxid[]> => {
  return callWorker(network, 'get-notes', {}, walletId);
};

/** encode notes bundle as UR-encoded QR frames for zigner sync */
export interface NoteSyncEncoded {
  frames: string[];
  noteCount: number;
  balance: string;
  cborBytes: number;
}
export const encodeNoteSyncInWorker = async (
  network: NetworkType,
  walletId: string,
  mainnet: boolean,
  serverUrl: string,
): Promise<NoteSyncEncoded> => {
  return callWorker(network, 'note-sync-encode', { mainnet, serverUrl }, walletId);
};

/** decrypted memo from transaction */
export interface FoundNoteWithMemo {
  index: number;
  value: number;
  nullifier: string;
  cmx: string;
  memo: string;
  is_outgoing: boolean;
  memo_is_text: boolean;
}

/**
 * decrypt memos from a raw transaction (runs in worker using wallet keys)
 */
export const decryptMemosInWorker = async (
  network: NetworkType,
  walletId: string,
  txBytes: Uint8Array
): Promise<FoundNoteWithMemo[]> => {
  // convert to array for postMessage serialization
  return callWorker(network, 'decrypt-memos', { txBytes: Array.from(txBytes) }, walletId);
};

/** transparent transaction history entry */
export interface TransparentHistoryEntry {
  txid: string;
  height: number;
  received: string; // zatoshis received by our addresses
}

/**
 * get transparent transaction history for addresses
 */
export const getTransparentHistoryInWorker = async (
  network: NetworkType,
  serverUrl: string,
  tAddresses: string[],
): Promise<TransparentHistoryEntry[]> => {
  return callWorker(network, 'get-transparent-history', { serverUrl, tAddresses });
};

/** computed history entry from worker */
export interface HistoryEntry {
  id: string;
  height: number;
  type: 'send' | 'receive' | 'shield';
  amount: string; // zatoshis as string
  asset: string;
}

/**
 * compute full transaction history in worker (shielded + transparent)
 */
export const getHistoryInWorker = async (
  network: NetworkType,
  walletId: string,
  serverUrl: string,
  tAddresses: string[],
): Promise<HistoryEntry[]> => {
  return callWorker(network, 'get-history', { serverUrl, tAddresses }, walletId);
};

/** memo result from worker sync */
export interface MemoSyncEntry {
  txId: string;
  blockHeight: number;
  timestamp: number; // actual block time (unix ms) from server
  content: string;
  direction: string;
  amount: string;
  /** hex-encoded raw 512-byte memo (for structured/binary memos) */
  memoBytes?: string;
  /** diversifier index of the receiving address */
  diversifierIndex?: number;
}

/**
 * sync memos in worker (bucket fetch + noise + decrypt — no round-trips)
 */
export const syncMemosInWorker = async (
  network: NetworkType,
  walletId: string,
  serverUrl: string,
  existingTxIds: string[],
  forceResync: boolean,
): Promise<MemoSyncEntry[]> => {
  return callWorker(network, 'sync-memos', { serverUrl, existingTxIds, forceResync }, walletId);
};

export interface ShieldResult {
  txid: string;
  shieldedZat: string;
  feeZat: string;
  utxoCount: number;
}

/**
 * shield transparent funds to orchard (runs in worker with halo 2 proving)
 */
export const shieldInWorker = async (
  network: NetworkType,
  walletId: string,
  mnemonic: string,
  serverUrl: string,
  tAddresses: string[],
  mainnet: boolean,
  addressIndexMap?: Record<string, number>,
): Promise<ShieldResult> => {
  return callWorker(network, 'shield', { mnemonic, serverUrl, tAddresses, mainnet, addressIndexMap }, walletId);
};

/** result of building an unsigned send transaction */
export interface SendTxUnsignedResult {
  sighash: string;
  alphas: string[];
  summary: string;
  fee: string;
  unsignedTx: string;
  /** action indices that need external spend auth signatures */
  spendIndices: number[];
}

/**
 * build a send transaction (runs in worker with witness building)
 *
 * if mnemonic is provided: builds fully signed tx + broadcasts, returns { txid, fee }
 * if no mnemonic: builds unsigned tx for cold signing via QR (requires ufvk)
 */
export const buildSendTxInWorker = async (
  network: NetworkType,
  walletId: string,
  serverUrl: string,
  recipient: string,
  amount: string,
  memo: string,
  accountIndex: number,
  mainnet: boolean,
  mnemonic?: string,
  ufvk?: string,
): Promise<SendTxUnsignedResult | { txid: string; fee: string }> => {
  return callWorker(network, 'send-tx', { serverUrl, recipient, amount, memo, accountIndex, mainnet, mnemonic, ufvk }, walletId);
};

/** result of building multi-output transactions */
export interface MultiSendResult {
  txids: string[];
  fees: string[];
}

/**
 * build and broadcast multiple single-output transactions in sequence.
 * Used by poker escrow for atomic-ish rake + deposit.
 * Each output becomes a separate on-chain transaction.
 */
export const buildMultiSendTxInWorker = async (
  network: NetworkType,
  walletId: string,
  serverUrl: string,
  outputs: Array<{ address: string; amount: string; memo?: string }>,
  accountIndex: number,
  mainnet: boolean,
  mnemonic: string,
): Promise<MultiSendResult> => {
  return callWorker(network, 'send-tx-multi', { serverUrl, outputs, accountIndex, mainnet, mnemonic }, walletId);
};

/**
 * complete a send transaction with signatures and broadcast
 */
export const completeSendTxInWorker = async (
  network: NetworkType,
  walletId: string,
  serverUrl: string,
  unsignedTx: string,
  signatures: { orchardSigs: string[]; transparentSigs: string[] },
  spendIndices: number[],
): Promise<{ txid: string }> => {
  return callWorker(network, 'send-tx-complete', { serverUrl, unsignedTx, signatures, spendIndices }, walletId);
};

/** result of building an unsigned shielding transaction */
export interface ShieldUnsignedResult {
  sighashes: string[];
  unsignedTxHex: string;
  summary: string;
  fee: string;
  addressIndices: number[];
}

/**
 * build unsigned shielding transaction for cold-wallet signing
 */
export const buildUnsignedShieldInWorker = async (
  network: NetworkType,
  walletId: string,
  serverUrl: string,
  tAddresses: string[],
  mainnet: boolean,
  ufvk: string,
  addressIndexMap?: Record<string, number>,
): Promise<ShieldUnsignedResult> => {
  return callWorker(network, 'shield-unsigned', { serverUrl, tAddresses, mainnet, ufvk, addressIndexMap }, walletId);
};

/**
 * complete shielding transaction with signatures and broadcast
 */
export const completeShieldInWorker = async (
  network: NetworkType,
  walletId: string,
  serverUrl: string,
  unsignedTxHex: string,
  signatures: { sig_hex: string; pubkey_hex: string }[],
): Promise<{ txid: string }> => {
  return callWorker(network, 'shield-complete', { serverUrl, unsignedTxHex, signatures }, walletId);
};

/**
 * check if a specific wallet is syncing on a network
 */
export const isWalletSyncing = (network: NetworkType, walletId: string): boolean => {
  return workers.get(network)?.syncingWallets.has(walletId) ?? false;
};

/**
 * pre-mark a wallet as syncing (prevents race with auto-sync hook)
 */
export const markWalletSyncing = (network: NetworkType, walletId: string): void => {
  const state = workers.get(network);
  if (state) state.syncingWallets.add(walletId);
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

/**
 * relay a prove request from zcash-worker (Web Worker, no chrome APIs)
 * through to the service worker → offscreen document for parallel proving.
 */
async function relayProveRequest(worker: Worker, id: string, request: unknown): Promise<void> {
  try {
    // 1. ensure offscreen document exists
    const ensureResult = await chrome.runtime.sendMessage({ type: 'ZCASH_ENSURE_OFFSCREEN' });
    if (!ensureResult?.ok) {
      worker.postMessage({ type: 'prove-response', id, error: `failed to activate offscreen: ${ensureResult?.error ?? 'unknown'}` });
      return;
    }
    // 2. send build request to offscreen handler
    const response = await chrome.runtime.sendMessage({ type: 'ZCASH_BUILD', request });
    if (response?.error) {
      worker.postMessage({ type: 'prove-response', id, error: response.error.message ?? JSON.stringify(response.error) });
    } else if (response?.data === undefined) {
      worker.postMessage({ type: 'prove-response', id, error: 'offscreen returned no data' });
    } else {
      worker.postMessage({ type: 'prove-response', id, data: response.data });
    }
  } catch (e) {
    worker.postMessage({ type: 'prove-response', id, error: e instanceof Error ? e.message : String(e) });
  }
}

// ── FROST multisig worker helpers ──

/** DKG round 1: generate ephemeral identity + signed commitment */
export const frostDkgPart1InWorker = async (
  maxSigners: number,
  minSigners: number,
): Promise<{ secret: string; broadcast: string }> => {
  return callWorker('zcash', 'frost-dkg-part1', { maxSigners, minSigners });
};

/** DKG round 2: process signed round1 broadcasts */
export const frostDkgPart2InWorker = async (
  secretHex: string,
  peerBroadcasts: string[],
): Promise<{ secret: string; peer_packages: string[] }> => {
  return callWorker('zcash', 'frost-dkg-part2', { secretHex, peerBroadcasts: JSON.stringify(peerBroadcasts) });
};

/** DKG round 3: finalize — returns key package + public key package */
export const frostDkgPart3InWorker = async (
  secretHex: string,
  round1Broadcasts: string[],
  round2Packages: string[],
): Promise<{ key_package: string; public_key_package: string; ephemeral_seed: string }> => {
  return callWorker('zcash', 'frost-dkg-part3', {
    secretHex,
    round1Broadcasts: JSON.stringify(round1Broadcasts),
    round2Packages: JSON.stringify(round2Packages),
  });
};

/** signing round 1: generate nonces + signed commitments */
export const frostSignRound1InWorker = async (
  ephemeralSeedHex: string,
  keyPackageHex: string,
): Promise<{ nonces: string; commitments: string }> => {
  return callWorker('zcash', 'frost-sign-round1', { ephemeralSeedHex, keyPackageHex });
};

/** spend-authorize round 2: produce FROST share for each action */
export const frostSpendSignInWorker = async (
  keyPackageHex: string,
  noncesHex: string,
  sighashHex: string,
  alphaHex: string,
  commitments: string[],
): Promise<string> => {
  return callWorker('zcash', 'frost-spend-sign', {
    keyPackageHex, noncesHex, sighashHex, alphaHex,
    commitments: JSON.stringify(commitments),
  });
};

/** coordinator: aggregate shares into SpendAuth signature */
export const frostSpendAggregateInWorker = async (
  publicKeyPackageHex: string,
  sighashHex: string,
  alphaHex: string,
  commitments: string[],
  shares: string[],
): Promise<string> => {
  return callWorker('zcash', 'frost-spend-aggregate', {
    publicKeyPackageHex, sighashHex, alphaHex,
    commitments: JSON.stringify(commitments),
    shares: JSON.stringify(shares),
  });
};

/** derive multisig Orchard address from FROST group key (non-deterministic
 * — only use for single-party derive-and-broadcast flows) */
export const frostDeriveAddressInWorker = async (
  publicKeyPackageHex: string,
  diversifierIndex: number,
): Promise<string> => {
  return callWorker('zcash', 'frost-derive-address', { publicKeyPackageHex, diversifierIndex });
};

/** derive multisig Orchard address deterministically from pkg + host-broadcast sk.
 * pair with `frostDeriveUfvkInWorker` so address and UFVK share one source of
 * truth for nk/rivk — otherwise participants end up with matching UFVK but
 * different addresses. */
export const frostDeriveAddressFromSkInWorker = async (
  publicKeyPackageHex: string,
  skHex: string,
  diversifierIndex: number,
): Promise<string> => {
  return callWorker('zcash', 'frost-derive-address-from-sk', {
    publicKeyPackageHex, skHex, diversifierIndex,
  });
};

/**
 * host-only: sample a random 32-byte `sk` (hex) for nk/rivk derivation.
 * the host then broadcasts this sk to peers in its R1 message so every
 * participant can reconstruct the same UFVK locally.
 */
export const frostSampleFvkSkInWorker = async (): Promise<string> => {
  return callWorker('zcash', 'frost-sample-fvk-sk', {});
};

/**
 * derive the Orchard-only UFVK string (`uview1…`) from the FROST group
 * public key package and the host-broadcast `sk`. given identical inputs
 * on every participant, output is byte-identical — this is the property
 * we echo-broadcast to verify before persisting the wallet.
 */
export const frostDeriveUfvkInWorker = async (
  publicKeyPackageHex: string,
  skHex: string,
  mainnet: boolean,
): Promise<string> => {
  return callWorker('zcash', 'frost-derive-ufvk', { publicKeyPackageHex, skHex, mainnet });
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
