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
 *
 * The real worker lives in exactly one place: the offscreen document (the
 * same long-lived host that already runs the parallel proving worker). Every
 * other context - the popup, an approval window, settings - is a client that
 * proxies spawn/call/terminate through chrome.runtime messages and mirrors
 * the worker's events locally. Before this, every popup document created its
 * own real Worker (and its own wasm + sync loop), because each popup open is
 * a fresh page with a fresh copy of this module; closing the popup should
 * drop that Worker, but a dapp approval window, settings, and the main popup
 * can all be open at once, each syncing the same wallet independently. One
 * host, many clients, keeps exactly one zcash/penumbra worker alive.
 */

import type { NetworkType, VaultUnlock } from './types';
import type { SealedVault, WorkerKey } from '../../shared/vault-seal';
import type { DepositPlan, DepositRequest } from '../../workers/transparent-deposit';

/** true only inside the offscreen document - the one place that owns real Workers */
const isOffscreenHost = (): boolean =>
  typeof location !== 'undefined' && location.pathname.includes('offscreen');

/** ensure the offscreen document exists, retrying while the service worker wakes up */
const ensureOffscreenReady = async (): Promise<boolean> => {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'ZCASH_ENSURE_OFFSCREEN' });
      if (result?.ok) {
        return true;
      }
    } catch {
      // service worker waking up - transient, retry
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
};

/** the subset of Worker a client proxy needs; a real Worker satisfies this too */
type WorkerLike = Pick<Worker, 'postMessage' | 'terminate'>;

/**
 * chrome.storage.local key holding the last scan height the zcash worker
 * reported for a wallet. A UI hint only - IndexedDB (`meta.syncHeight`) is
 * what the worker actually resumes from. Per-wallet on purpose; see the
 * write site in the 'sync-progress' handler.
 */
export const zcashSyncHeightKey = (walletId: string): string => `zcashSyncHeight_${walletId}`;

export interface NetworkWorkerMessage {
  type:
    | 'init'
    | 'derive-address'
    | 'sync'
    | 'stop-sync'
    | 'reset-sync'
    | 'get-balance'
    | 'get-pool-balances'
    | 'vault-key'
    | 'send-tx'
    | 'send-tx-multi'
    | 'send-tx-complete'
    | 'send-tx-pczt'
    | 'send-tx-pczt-complete'
    | 'pczt-apply-contributions'
    | 'send-turnstile-migration'
    | 'send-turnstile-migration-complete'
    | 'shield'
    | 'shield-unsigned'
    | 'shield-complete'
    | 'transparent-deposit-plan'
    | 'transparent-deposit'
    | 'list-wallets'
    | 'delete-wallet'
    | 'get-notes'
    | 'note-sync-encode'
    | 'decrypt-memos'
    | 'get-transparent-history'
    | 'get-history'
    | 'get-pending-sends'
    | 'sync-memos'
    | 'frost-dkg-part1'
    | 'frost-dkg-part2'
    | 'frost-dkg-part3'
    | 'frost-sign-round1'
    | 'frost-spend-sign'
    | 'frost-spend-aggregate'
    | 'frost-derive-address'
    | 'frost-derive-address-from-sk'
    | 'frost-sample-fvk-sk'
    | 'frost-derive-ufvk'
    | 'frost-parse-tx-outputs'
    | 'frost-inspect-pczt-outputs'
    | 'complete-orchard-pczt'
    | 'broadcast-raw-tx'
    | 'pczt-extract-tx'
    | 'broadcast-signed-tx'
    | 'lookup-tx'
    | 'shield-eligible'
    | 'get-transparent-utxos'
    | 'generate-voting-hotkey'
    | 'build-delegation-pczt'
    | 'finalize-delegation'
    | 'cast-vote-hot-wire'
    | 'pir-fetch-imt-proofs'
    | 'get-orchard-account-info'
    | 'get-consensus-branch-id'
    | 'get-merkle-witnesses';
  id: string;
  network: NetworkType;
  walletId?: string;
  payload?: unknown;
}

export interface NetworkWorkerResponse {
  type:
    | 'ready'
    | 'address'
    | 'sync-progress'
    | 'sync-error'
    | 'send-progress'
    | 'sync-started'
    | 'sync-stopped'
    | 'sync-reset'
    | 'balance'
    | 'pool-balances'
    | 'vault-key'
    | 'tx-result'
    | 'tx-multi-result'
    | 'send-tx-unsigned'
    | 'send-tx-pczt-unsigned'
    | 'send-turnstile-migration-unsigned'
    | 'shield-result'
    | 'shield-unsigned-result'
    | 'wallets'
    | 'wallet-deleted'
    | 'notes'
    | 'note-sync-encoded'
    | 'memos'
    | 'transparent-history'
    | 'history'
    | 'pending-sends'
    | 'memos-result'
    | 'sync-memos-progress'
    | 'mempool-update'
    | 'prove-request'
    | 'frost-result'
    | 'voting-result'
    | 'terminated'
    | 'error';
  id: string;
  network: NetworkType;
  walletId?: string;
  payload?: unknown;
  error?: string;
}

interface WorkerState {
  worker: WorkerLike;
  ready: boolean;
  syncingWallets: Set<string>; // track which wallets are syncing
  pendingCallbacks: Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >;
}

const workers = new Map<NetworkType, WorkerState>();
const spawnPromises = new Map<NetworkType, Promise<void>>();

let messageId = 0;
// per-realm prefix: every popup counts from 1 and the host broadcasts replies
// to all of them, so a bare counter would let two popups resolve each other's calls
const realmId = crypto.randomUUID().slice(0, 8);
const nextId = () => `msg_${realmId}_${++messageId}`;

/**
 * spawn a dedicated worker for a network
 * worker loads its own wasm and handles sync independently
 * concurrent callers share the same spawn promise (no race condition)
 */
export const spawnNetworkWorker = async (network: NetworkType): Promise<void> => {
  if (workers.get(network)?.ready) {
    return;
  }

  // deduplicate concurrent spawn calls
  const existing = spawnPromises.get(network);
  if (existing) {
    return existing;
  }

  const promise = spawnNetworkWorkerInner(network);
  spawnPromises.set(network, promise);
  try {
    await promise;
  } finally {
    spawnPromises.delete(network);
  }
};

/**
 * Message types that put a transaction on the wire (build-only steps like
 * 'send-tx-pczt' or 'shield-unsigned' are not in here - nothing has been
 * broadcast yet). Tracked host-side only, by request id, so "stop sync on
 * last UI close" (see stopAllSyncInHost) can wait for one of these to land
 * before it stops anything - a send must never be cut off mid-flight.
 */
const SEND_SHAPED_TYPES: ReadonlySet<string> = new Set([
  'send-tx',
  'send-tx-multi',
  'send-tx-complete',
  'send-tx-pczt-complete',
  'send-turnstile-migration-complete',
  'shield-complete',
  'complete-orchard-pczt',
  'broadcast-raw-tx',
  'broadcast-signed-tx',
  'finalize-delegation',
  'cast-vote-hot-wire',
]);

/** host-only: request ids of sends currently on the wire */
const inFlightSendIds = new Set<string>();

/**
 * Shared by the host (reacting to the real worker's onmessage) and every
 * client (reacting to the host's rebroadcast). Same state shape, same
 * events, so a client behaves exactly like a page that owned the worker
 * directly - callers never need to know which side they are on.
 */
const handleWorkerMessage = (
  network: NetworkType,
  state: WorkerState,
  msg: NetworkWorkerResponse,
): void => {
  if (msg.type === 'ready') {
    state.ready = true;
    console.log(`[network-worker] ${network} worker ready`);
    return;
  }

  if (msg.type === 'terminated') {
    // the host tore the real worker down (explicit terminate, or a rescan
    // from another context) - drop the stale local entry so the next call
    // respawns instead of calling into nothing.
    workers.delete(network);
    return;
  }

  if (msg.type === 'sync-progress') {
    // emit progress event with walletId
    window.dispatchEvent(
      new CustomEvent('network-sync-progress', {
        detail: { network, walletId: msg.walletId, ...(msg.payload as object) },
      }),
    );
    // Persist the height for the next popup open. Two places already READ
    // chrome.storage.local.zcashSyncHeight - the sync hook's mount-time
    // hydration and the post-error retry's resume point - and nothing has
    // ever WRITTEN it, so both silently degraded: the bar started every
    // session at 0% until the worker's first emit landed, and a retry
    // resumed from `undefined` instead of where it left off.
    //
    // IDB remains the source of truth for what has actually been scanned;
    // this is only a hint so the UI does not have to claim ignorance it
    // does not have. Keyed PER WALLET: one shared key would let a
    // fully-synced wallet's height hydrate the bar for a wallet that has
    // scanned nothing, which is the same lie in the opposite direction.
    // offscreen documents have no chrome.storage; the clients write it
    if (network === 'zcash' && msg.walletId && !isOffscreenHost()) {
      const { currentHeight } = (msg.payload ?? {}) as { currentHeight?: number };
      if (typeof currentHeight === 'number' && currentHeight > 0) {
        void chrome.storage.local
          .set({ [zcashSyncHeightKey(msg.walletId)]: currentHeight })
          .catch(() => {});
      }
    }
    return;
  }

  if (msg.type === 'sync-error' && network === 'zcash') {
    // forward worker-side sync failures (HTTP 415, GetTip errors, etc) to
    // the UI via the same event the auto-sync hook uses. The sync bar
    // listener already picks this up and shows the "switch node" action.
    // `code` is the worker's own structured classification (see
    // state/sync-failure.ts). Relayed verbatim so the UI classifies on a
    // code we emitted rather than on the shape of an error string.
    const payload = msg.payload as { message?: string; code?: string } | undefined;
    window.dispatchEvent(
      new CustomEvent('zcash-sync-error', {
        detail: {
          walletId: msg.walletId,
          message: payload?.message ?? 'sync error',
          code: payload?.code,
        },
      }),
    );
    return;
  }

  if (msg.type === 'send-progress') {
    window.dispatchEvent(
      new CustomEvent('zcash-send-progress', {
        detail: { network, walletId: msg.walletId, ...(msg.payload as object) },
      }),
    );
    return;
  }

  if (msg.type === 'sync-memos-progress') {
    window.dispatchEvent(
      new CustomEvent('zcash-memo-sync-progress', {
        detail: { network, walletId: msg.walletId, ...(msg.payload as object) },
      }),
    );
    return;
  }

  if (msg.type === 'mempool-update') {
    // CONTRACT for consumers (hdevalence audit):
    //
    // `zcash-mempool-update` fires only when the worker found at least
    // one match (pendingIncoming or pendingSpends non-empty). That
    // means the *receipt* of this event is itself the signal "this
    // wallet matched something in mempool". Any handler whose
    // observable behavior differs between "got the event with N
    // matches" and "got the event with M matches" (or "got the event"
    // vs "didn't get the event") leaks the trial-decryption result to
    // any local code/page that can measure the side effect.
    //
    // Consumers MUST:
    //   - never fire a network request as a consequence of receipt;
    //   - never produce a visible UI change with timing distinguishable
    //     from the no-match path (use a refresh that already runs on
    //     other triggers, not one keyed to mempool events);
    //   - never log/store in a way the page or another extension can
    //     observe.
    //
    // If you find yourself wanting to react conditionally, audit
    // against the threat model: a co-located content script can read
    // CustomEvent dispatches in the same realm. There is currently
    // no consumer; add one only after confirming this discipline.
    window.dispatchEvent(
      new CustomEvent('zcash-mempool-update', {
        detail: { network, walletId: msg.walletId, ...(msg.payload as object) },
      }),
    );
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

/** fire-and-forget broadcast to every other extension context; nobody may be listening */
const broadcastWorkerEvent = (network: NetworkType, msg: unknown): void => {
  void chrome.runtime.sendMessage({ type: 'NW_EVENT', network, msg }).catch(() => {});
};

// client (popup / settings / approval window): one listener for the whole
// module, re-dispatching the host's rebroadcast through the same handler a
// host-side worker.onmessage would use. Installed once; the offscreen host
// never reaches this branch because it gets events straight from its real
// Worker instead.
let clientListenerInstalled = false;
const ensureClientListener = (): void => {
  if (clientListenerInstalled || isOffscreenHost()) {
    return;
  }
  clientListenerInstalled = true;
  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type !== 'NW_EVENT' || !msg.network) {
      return false;
    }
    const state = workers.get(msg.network as NetworkType);
    if (state) {
      handleWorkerMessage(msg.network as NetworkType, state, msg.msg as NetworkWorkerResponse);
    }
    return false;
  });
};

// offscreen host: owns the real Workers and answers NW_SPAWN / NW_CALL /
// NW_TERMINATE from every client. Installed once, only inside the offscreen
// document.
let hostListenerInstalled = false;
/** the host's own prover: the zcash worker and the build worker share this document */
let hostProver: ((request: unknown) => Promise<unknown>) | undefined;

/** called once from the offscreen document's own entry point, so the host
 *  can answer NW_SPAWN before any network's first real spawn happens, and
 *  prove without messaging itself (runtime messages never reach the sender). */
export const initNetworkWorkerHost = (prove: (request: unknown) => Promise<unknown>): void => {
  hostProver = prove;
  ensureHostListener();
};

const ensureHostListener = (): void => {
  if (hostListenerInstalled || !isOffscreenHost()) {
    return;
  }
  hostListenerInstalled = true;
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'NW_SPAWN' && msg.network) {
      void (async () => {
        try {
          await spawnNetworkWorker(msg.network as NetworkType);
        } finally {
          // covers the case where the worker was already running: the
          // requester's wait loop only ever hears 'ready' through this
          // broadcast, never from the (one-time) real worker message.
          broadcastWorkerEvent(msg.network, { type: 'ready' });
          sendResponse({ ok: true });
        }
      })();
      return true;
    }
    if (msg?.type === 'NW_CALL' && msg.network && msg.message) {
      const m = msg.message as NetworkWorkerMessage;
      // a sync asked for after the last stop comes from a window that is
      // open now: end any stop-on-close sweep so it can't kill this one
      if (m.type === 'sync' && typeof msg.sentAt === 'number' && msg.sentAt > lastStopAt) {
        stopGeneration++;
      }
      if (SEND_SHAPED_TYPES.has(m.type) && m.id) {
        inFlightSendIds.add(m.id);
      }
      workers.get(msg.network as NetworkType)?.worker.postMessage(msg.message);
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === 'NW_TERMINATE' && msg.network) {
      terminateNetworkWorker(msg.network as NetworkType);
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === 'NW_STOP_ALL_SYNC' && msg.network) {
      lastStopAt = typeof msg.at === 'number' ? msg.at : Date.now();
      void stopAllSyncInHost(msg.network as NetworkType).then(
        stopped => sendResponse({ ok: true, stopped }),
        () => sendResponse({ ok: false }),
      );
      return true;
    }
    return false;
  });
};

const spawnNetworkWorkerInner = async (network: NetworkType): Promise<void> => {
  if (!isOffscreenHost()) {
    ensureClientListener();
    const okOffscreen = await ensureOffscreenReady();
    if (!okOffscreen) {
      throw new Error(`could not activate offscreen document for ${network} worker`);
    }
    const state: WorkerState = {
      worker: {
        postMessage: m => broadcastToHost('NW_CALL', network, { message: m, sentAt: Date.now() }),
        terminate: () => void broadcastToHost('NW_TERMINATE', network, {}),
      },
      ready: false,
      syncingWallets: new Set(),
      pendingCallbacks: new Map(),
    };
    workers.set(network, state);
    await broadcastToHost('NW_SPAWN', network, {});
    await waitUntilReady(network, state);
    return;
  }

  ensureHostListener();

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

    // relay prove requests from zcash-worker to the parallel-build worker,
    // both hosted in this same offscreen document
    if (msg.type === 'prove-request' && (msg as any).id && (msg as any).request) {
      void relayProveRequest(worker, (msg as any).id, (msg as any).request);
      return;
    }

    inFlightSendIds.delete(msg.id);
    handleWorkerMessage(network, state, msg);
    // let every other context (popups, an approval window) mirror this
    // worker's state instead of spawning their own
    broadcastWorkerEvent(network, msg);
  };

  worker.onerror = e => {
    console.error(`[network-worker] ${network} error:`, e);
  };

  workers.set(network, state);
  await waitUntilReady(network, state);
};

/** ask the offscreen host to do something, waiting for the service worker if needed */
const broadcastToHost = async (
  type: 'NW_SPAWN' | 'NW_CALL' | 'NW_TERMINATE',
  network: NetworkType,
  extra: Record<string, unknown>,
): Promise<void> => {
  try {
    await chrome.runtime.sendMessage({ type, network, ...extra });
  } catch {
    // offscreen document not reachable yet/anymore - the caller's own
    // wait/retry (spawn's 30s loop, or the next call) covers this
  }
};

const waitUntilReady = async (network: NetworkType, state: WorkerState): Promise<void> => {
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
  }).catch(err => {
    // Without this, a dead-but-unready entry stays in `workers` forever and
    // every later spawn call sees `workers.get(network)?.ready === false`
    // skips the existing-worker fast path, then still finds the same stale
    // (unready) entry and no-ops instead of retrying - the worker never
    // comes back without a full extension reload.
    state.worker.terminate();
    workers.delete(network);
    throw err;
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
    if (isOffscreenHost()) {
      // the real worker is gone for everyone - tell every other context to
      // drop its mirrored entry instead of calling into nothing
      broadcastWorkerEvent(network, { type: 'terminated' });
    }
  }
};

/**
 * Stop a network's worker wherever it runs, and wait until it has stopped.
 * The real worker lives in the offscreen host; a client's terminate is a
 * fire-and-forget broadcast, and a fresh popup may not even have a mirror
 * entry to send it from, so erasing data asks the host directly.
 */
export const stopNetworkWorker = async (network: NetworkType): Promise<void> => {
  if (isOffscreenHost()) {
    terminateNetworkWorker(network);
    return;
  }
  workers.delete(network);
  try {
    await chrome.runtime.sendMessage({ type: 'NW_TERMINATE', network });
  } catch {
    // no offscreen host is running, so no worker holds anything open
  }
};

/**
 * send message to network worker and await response
 */
const callWorker = async <T>(
  network: NetworkType,
  type: NetworkWorkerMessage['type'],
  payload?: unknown,
  walletId?: string,
): Promise<T> => {
  let state = workers.get(network);
  if (!state?.ready) {
    // A call can arrive a beat before the worker has finished spinning up - e.g.
    // a sync/Zigner op fired during startup - which used to hard-reject with
    // "<network> worker not ready". Wait for it instead: spawnNetworkWorker is
    // idempotent (returns at once if ready, joins an in-flight spawn, else
    // spawns and waits with a 30s timeout), so an early call now blocks briefly
    // rather than throwing. Only a genuine init timeout or termination rejects.
    await spawnNetworkWorker(network);
    state = workers.get(network);
  }
  if (!state?.ready) {
    return Promise.reject(new Error(`${network} worker not ready`));
  }

  const ready = state;
  const id = nextId();
  return new Promise((resolve, reject) => {
    ready.pendingCallbacks.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
    });

    ready.worker.postMessage({
      type,
      id,
      network,
      walletId,
      payload,
    } satisfies NetworkWorkerMessage);
  });
};

/** the vault with the session key wrapped to a key the worker issued for this one call */
const sealFor = async (network: NetworkType, vault: VaultUnlock): Promise<SealedVault> =>
  vault.sealTo(await callWorker<WorkerKey>(network, 'vault-key'));

/**
 * derive address for a network (runs in worker)
 */
export const deriveAddressInWorker = async (
  network: NetworkType,
  mnemonic: string,
  accountIndex: number,
  /** zcash: the 11-byte diversifier index as 22 hex chars (see shielded-receive-index) */
  diversifierHex?: string,
  /** zcash: the pocket (zip32 account); accountIndex above is a diversifier index */
  pocket = 0,
): Promise<string> => {
  return callWorker(network, 'derive-address', { mnemonic, accountIndex, diversifierHex, pocket });
};

/**
 * start sync for a wallet on a network (runs in worker)
 */
export const startSyncInWorker = async (
  network: NetworkType,
  walletId: string,
  vault: VaultUnlock,
  serverUrl: string,
  startHeight?: number,
  backend: 'zidecar' | 'lightwalletd' = 'zidecar',
  mempoolWatch: 'off' | 'on' = 'off',
): Promise<void> => {
  // Defensive: mempool watch is meaningless on lightwalletd. Use the
  // single-source-of-truth gate from the strategy module.
  const { isMempoolWatchEnabled } = await import('../../services/mempool-watch/strategy');
  const effectiveMempoolWatch: 'off' | 'on' = isMempoolWatchEnabled(mempoolWatch, backend)
    ? 'on'
    : 'off';
  return callWorker(
    network,
    'sync',
    {
      vault: await sealFor(network, vault),
      serverUrl,
      startHeight,
      backend,
      mempoolWatch: effectiveMempoolWatch,
    },
    walletId,
  );
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
  backend: 'zidecar' | 'lightwalletd' = 'zidecar',
  mempoolWatch: 'off' | 'on' = 'off',
): Promise<void> => {
  const { isMempoolWatchEnabled } = await import('../../services/mempool-watch/strategy');
  const effectiveMempoolWatch: 'off' | 'on' = isMempoolWatchEnabled(mempoolWatch, backend)
    ? 'on'
    : 'off';
  return callWorker(
    network,
    'sync',
    { serverUrl, startHeight, ufvk, backend, mempoolWatch: effectiveMempoolWatch },
    walletId,
  );
};

/**
 * stop sync for a wallet on a network
 */
export const stopSyncInWorker = async (network: NetworkType, walletId: string): Promise<void> => {
  return callWorker(network, 'stop-sync', {}, walletId);
};

/**
 * Host-only: stop every wallet currently syncing on `network`, once nothing
 * is mid-broadcast. Called when the last zafu UI surface closes (see
 * ui-open-presence.ts in service-worker.ts) - the offscreen document and its
 * worker stay alive (proving still needs them), only network activity stops.
 * The next UI open resumes sync the same way it starts on any fresh popup.
 */
/** when the last window closed (sender's clock), and a counter bumped by any
 *  sync a window asks for after that - a sweep ends the moment it moves */
let lastStopAt = 0;
let stopGeneration = 0;

const stopAllSyncInHost = async (network: NetworkType): Promise<string[]> => {
  const generation = ++stopGeneration;
  const reopened = () => stopGeneration !== generation;
  const deadline = Date.now() + 60_000;
  while (inFlightSendIds.size > 0 && Date.now() < deadline && !reopened()) {
    await new Promise(r => setTimeout(r, 250));
  }
  if (inFlightSendIds.size > 0) {
    console.warn(
      `[network-worker] stopping sync with ${inFlightSendIds.size} send(s) still marked in-flight after 60s`,
    );
  }
  const stopped = new Set<string>();
  const stopOnce = async (): Promise<number> => {
    const wallets = [...(workers.get(network)?.syncingWallets ?? [])];
    wallets.forEach(w => stopped.add(w));
    await Promise.all(wallets.map(walletId => stopSyncInWorker(network, walletId).catch(() => {})));
    return wallets.length;
  };

  if (reopened()) {
    return [];
  }
  await stopOnce();
  // A popup's own 'sync' call can already be in flight (dispatched to the
  // host, not yet processed) the instant it closes - closing the page
  // cannot retract a message already sent. That call still lands here and
  // starts a fresh loop, silently undoing the stop above (runSync's own
  // restart guard resets syncAbort unconditionally). Re-check for a few
  // seconds and stop again if one lands late; stop sweeping once two
  // checks in a row find nothing left running.
  let quietChecks = 0;
  while (quietChecks < 2) {
    await new Promise(r => setTimeout(r, 500));
    if (reopened()) {
      break;
    }
    quietChecks = (await stopOnce()) === 0 ? quietChecks + 1 : 0;
  }
  return [...stopped];
};

/**
 * Client side: ask the offscreen host to stop all sync for `network`. Fired
 * from the service worker when the last UI surface disconnects - a no-op if
 * no worker is running yet (nothing to stop).
 */
export const requestStopAllSync = (network: NetworkType): void => {
  void chrome.runtime
    .sendMessage({ type: 'NW_STOP_ALL_SYNC', network, at: Date.now() })
    .then((r: unknown) => console.log(`[network-worker] requestStopAllSync(${network}) ->`, r))
    .catch(() => {});
};

/**
 * reset sync for a wallet - clears IDB notes/spent/meta and in-memory state
 */
export const resetSyncInWorker = async (network: NetworkType, walletId: string): Promise<void> => {
  return callWorker(network, 'reset-sync', {}, walletId);
};

/**
 * get balance for a wallet on a network
 */
export const getBalanceInWorker = async (
  network: NetworkType,
  walletId: string,
): Promise<string> => {
  return callWorker(network, 'get-balance', {}, walletId);
};

/**
 * Per-pool spendable balances (NU6.3 dual-pool), as zatoshi bigints.
 *
 * Additive to getBalanceInWorker: `total` equals the single balance that call
 * returns, split into `orchard` / `ironwood` by each note's pool tag (records
 * persisted before the ironwood rollout count as orchard). The worker sends
 * decimal strings over postMessage (bigint isn't structured-clone-safe), so we
 * re-hydrate to bigint here.
 */
export interface PoolBalances {
  /** orchard (legacy, migrate-only) spendable zatoshi */
  orchard: bigint;
  /** ironwood (NU6.3 active pool) spendable zatoshi */
  ironwood: bigint;
  /** orchard + ironwood; equals getBalanceInWorker's total */
  total: bigint;
  /** pending shielded change, NOT spendable (see worker PoolBalances) */
  pendingOrchard: bigint;
  /** pending shielded change, NOT spendable (see worker PoolBalances) */
  pendingIronwood: bigint;
  /** pendingOrchard + pendingIronwood */
  pendingTotal: bigint;
}

export const getPoolBalancesInWorker = async (
  network: NetworkType,
  walletId: string,
): Promise<PoolBalances> => {
  const raw = await callWorker<{
    orchard: string;
    ironwood: string;
    total: string;
    pendingOrchard: string;
    pendingIronwood: string;
    pendingTotal: string;
  }>(network, 'get-pool-balances', {}, walletId);
  return {
    orchard: BigInt(raw.orchard),
    ironwood: BigInt(raw.ironwood),
    total: BigInt(raw.total),
    pendingOrchard: BigInt(raw.pendingOrchard),
    pendingIronwood: BigInt(raw.pendingIronwood),
    pendingTotal: BigInt(raw.pendingTotal),
  };
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
export const deleteWalletInWorker = async (
  network: NetworkType,
  walletId: string,
): Promise<void> => {
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
  /** shielded pool (NU6.3); absent on pre-ironwood records means orchard */
  pool?: 'orchard' | 'ironwood';
  is_change?: boolean;
  spent?: boolean;
  spent_by_txid?: string;
  /**
   * Note secrets, already present on the worker's internal record and
   * spread through by 'get-notes' - just under-typed here previously.
   * Needed to build voting NoteInfoDto (rho_hex/rseed_hex/diversifier_hex).
   */
  rseed?: string;
  rho?: string;
  /** raw 43-byte orchard address hex (diversifier[11] + pk_d[32]) */
  recipient?: string;
}

/**
 * get all notes for a wallet (includes txid for memo retrieval)
 */
export const getNotesInWorker = async (
  network: NetworkType,
  walletId: string,
): Promise<DecryptedNoteWithTxid[]> => {
  return callWorker(network, 'get-notes', {}, walletId);
};

/** Pool a note belongs to; pre-ironwood records (no pool tag) are orchard. */
export const notesPoolOf = (note: DecryptedNoteWithTxid): 'orchard' | 'ironwood' =>
  note.pool ?? 'orchard';

/**
 * Notes grouped by shielded pool for the per-pool notes view (NU6.3). Each
 * entry carries value / height / spent status (already on DecryptedNoteWithTxid).
 * Built on top of getNotesInWorker so there's one note source, split by pool
 * (records with no pool tag default to orchard).
 */
export interface PoolNotes {
  orchard: DecryptedNoteWithTxid[];
  ironwood: DecryptedNoteWithTxid[];
}

export const getPoolNotesInWorker = async (
  network: NetworkType,
  walletId: string,
): Promise<PoolNotes> => {
  const notes = await getNotesInWorker(network, walletId);
  const orchard: DecryptedNoteWithTxid[] = [];
  const ironwood: DecryptedNoteWithTxid[] = [];
  for (const note of notes) {
    if (notesPoolOf(note) === 'ironwood') {
      ironwood.push(note);
    } else {
      orchard.push(note);
    }
  }
  return { orchard, ironwood };
};

/** encode notes bundle as UR-encoded QR frames for zigner sync */
export interface NoteSyncEncoded {
  frames: string[];
  noteCount: number;
  balance: string;
  cborBytes: number;
  /**
   * Which shielded pool this bundle carries. NU6.3 keeps orchard and ironwood
   * in separate commitment trees and the single-anchor bundle can only carry
   * one, so a mixed-pool wallet exports the larger pool and discloses the rest.
   */
  pool?: 'orchard' | 'ironwood';
  /** The pool left out of this bundle, when the wallet holds value in both. */
  excludedPool?: 'orchard' | 'ironwood';
  excludedNoteCount?: number;
  /** Zatoshi (as a decimal string) in the excluded pool. */
  excludedBalance?: string;
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
  txBytes: Uint8Array,
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

/**
 * computed history entry from worker
 *
 * `status` is the honest one: `confirmed` is claimed only on the strength of a
 * real block height, `pending` means broadcast and not yet seen (we do not know
 * whether it will confirm), `failed` means the wallet has scanned past the
 * transaction's own expiry height without finding it. The fields below `status`
 * exist only for transactions this wallet sent - the chain cannot supply them.
 */
export interface HistoryEntry {
  id: string;
  /** real block height, or 0 when there is not one yet - never a sentinel */
  height: number;
  type: 'send' | 'receive' | 'shield';
  /**
   * zatoshis as a string. For a send this is what LEFT the wallet - recipient
   * amount plus fee - not the gross value of the notes spent as inputs. Change
   * comes back to you and was never spent.
   */
  amount: string;
  asset: string;
  status: 'pending' | 'confirmed' | 'failed';
  /** `amount` is a ceiling: change may exist but has not been scanned yet */
  amountUpperBound?: boolean;
  kind?: 'send' | 'shield' | 'migrate';
  /** zatoshis the recipient received, excluding fee */
  recipientAmount?: string;
  recipient?: string;
  memo?: string;
  fee?: string;
  sentAt?: number;
  expiryHeight?: number;
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

/**
 * Sends this wallet broadcast that the chain has not confirmed (plus any that
 * provably expired). Answered from local state only - no network - so it is
 * cheap enough to refetch on every sync tick, which is what the balance panel
 * needs in order to explain a temporarily reduced figure.
 */
export const getPendingSendsInWorker = async (
  network: NetworkType,
  walletId: string,
): Promise<HistoryEntry[]> => {
  return callWorker(network, 'get-pending-sends', {}, walletId);
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
 * Memo-fetch strategy chosen by the user per-server. See
 * services/memo-sync/README.md for what each value means.
 */
export type MemoSyncStrategy = 'private' | 'fast';

/**
 * sync memos in worker (bucket fetch + decoys + decrypt - no per-tx round-trips)
 *
 * `strategy` selects the filter stack inside the worker. Default 'private'
 * (2x decoys, shuffle, cache, concurrency 4). 'fast' drops decoys + shuffle.
 * The leaky per-txid path is not reachable from any strategy.
 */
export const syncMemosInWorker = async (
  network: NetworkType,
  walletId: string,
  serverUrl: string,
  existingTxIds: string[],
  forceResync: boolean,
  strategy: MemoSyncStrategy = 'private',
): Promise<MemoSyncEntry[]> => {
  return callWorker(
    network,
    'sync-memos',
    { serverUrl, existingTxIds, forceResync, strategy },
    walletId,
  );
};

export interface ShieldResult {
  txid: string;
  shieldedZat: string;
  feeZat: string;
  utxoCount: number;
}

/**
 * shield transparent funds (the worker opens the vault, proves offscreen, signs itself)
 */
export const shieldInWorker = async (
  network: NetworkType,
  walletId: string,
  vault: VaultUnlock,
  serverUrl: string,
  tAddresses: string[],
  mainnet: boolean,
): Promise<ShieldResult> => {
  return callWorker(
    network,
    'shield',
    { vault: await sealFor(network, vault), serverUrl, tAddresses, mainnet },
    walletId,
  );
};

/** what a t->t deposit with an OP_RETURN costs from this address, priced with no key */
export const planTransparentDepositInWorker = (
  serverUrl: string,
  req: DepositRequest,
): Promise<DepositPlan> => callWorker('zcash', 'transparent-deposit-plan', { serverUrl, ...req });

/** build, sign (the worker opens the vault) and broadcast the reviewed deposit */
export const sendTransparentDepositInWorker = async (
  storeId: string,
  serverUrl: string,
  req: DepositRequest & { reviewedFee: string },
  vault: VaultUnlock,
): Promise<{ txid: string; fee: string }> =>
  callWorker(
    'zcash',
    'transparent-deposit',
    { serverUrl, ...req, vault: await sealFor('zcash', vault) },
    storeId,
  );

/** result of building an unsigned send transaction */
export interface SendTxUnsignedResult {
  sighash: string;
  alphas: string[];
  summary: string;
  fee: string;
  unsignedTx: string;
  /** action indices that need external spend auth signatures */
  spendIndices: number[];
  /**
   * Handle to the inputs / amount / fee / recipient / memo this build selected.
   *
   * A cold signing round splits one send across two worker messages, and the
   * completion sees only signed bytes: it cannot tell which notes were spent
   * (so they stayed "unspent" and got offered to the next send) nor recover the
   * recipient and memo the chain does not store. Pass this back on the matching
   * complete* call and the worker does the same bookkeeping a hot send does.
   *
   * Optional because stashing it is best-effort - a build that could not record
   * its context is still perfectly signable and broadcastable.
   */
  coldSendId?: string;
}

/**
 * build a send transaction (runs in worker with witness building)
 *
 * hot (vault passed): the worker opens the vault, signs, broadcasts, returns { txid, fee }
 * cold (no vault): builds unsigned tx for cold signing via QR (requires ufvk)
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
  vault?: VaultUnlock,
  ufvk?: string,
): Promise<SendTxUnsignedResult | { txid: string; fee: string }> => {
  return callWorker(
    network,
    'send-tx',
    {
      serverUrl,
      recipient,
      amount,
      memo,
      accountIndex,
      mainnet,
      vault: vault && (await sealFor(network, vault)),
      ufvk,
    },
    walletId,
  );
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
  outputs: { address: string; amount: string; memo?: string }[],
  accountIndex: number,
  mainnet: boolean,
  vault: VaultUnlock,
): Promise<MultiSendResult> => {
  return callWorker(
    network,
    'send-tx-multi',
    { serverUrl, outputs, accountIndex, mainnet, vault: await sealFor(network, vault) },
    walletId,
  );
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
  /** SendTxUnsignedResult.coldSendId from the matching build; see that field */
  coldSendId?: string,
): Promise<{ txid: string }> => {
  return callWorker(
    network,
    'send-tx-complete',
    { serverUrl, unsignedTx, signatures, spendIndices, coldSendId },
    walletId,
  );
};

/**
 * Result of building a PCZT for single-signer cold signing.
 *
 * The worker has already CBOR-wrapped the PCZT and UR-fragmented it into
 * animated-QR frames; the caller just hands `urFrames` to AnimatedQrDisplay.
 * `pcztHex` is kept around mostly for debug / round-trip verification.
 */
export interface SendTxPcztUnsignedResult {
  pcztHex: string;
  summary: string;
  actionCount: number;
  fee: string;
  urFrames: string[];
  cborBytes: number;
  /**
   * The raw UR-source bytes (the CBOR sign-request envelope) the frames were
   * fountained from. Lets the sign UI re-fountain at a user-chosen density (the
   * in-app "QR density" slider, twin of the playback-speed slider) instead of
   * being locked to the worker's default fragment size.
   */
  cborData?: Uint8Array;
  /** FROST multisig fields (gh #17): the canonical sighash + per-real-spend
   * alphas the host/joiner sign over, and the action indices those sigs map to.
   * Unused by the single-signer zigner cold-sign path. */
  sighash: string;
  alphas: string[];
  spendIndices: number[];
  /** see SendTxUnsignedResult.coldSendId - same handle, same contract */
  coldSendId?: string;
  /**
   * The request envelope went out COMPACT (tx_type 0x05), so the device will
   * answer with a signatures-only response (0x07). The UI binds the accepted
   * response type to this - a compact response for a legacy request (or the
   * reverse) is refused.
   */
  compactRequest?: boolean;
}

/**
 * Build a PCZT for cold signing via QR. Replaces the legacy simple-format
 * (sighash + alphas + summary string) for the single-signer zigner path.
 *
 * Caller must provide ufvk and target_height (any height ≥ NU6.1 activation
 * works for current mainnet).
 *
 * `fragmentSize` defaults to 400 (~v25 QR density). Drop to 200 for older /
 * cheaper Keystone-class cameras if frames don't lock.
 *
 * Set `frost` when the PCZT feeds a FROST multisig signing round (self-custody
 * or airgap co-signers). Those callers REQUIRE the `sighash` / `alphas` /
 * `spendIndices` fields, which only the orchard builder emits - the worker
 * fails closed rather than hand back a PCZT with empty FROST fields.
 */
export const buildSendTxPcztInWorker = async (
  network: NetworkType,
  walletId: string,
  serverUrl: string,
  recipient: string,
  amount: string,
  memo: string,
  targetHeight: number,
  mainnet: boolean,
  ufvk: string,
  /**
   * No longer gates anything. It existed only to drive the NU6.3 fail-closed
   * refusal of multisig sends, which is gone now that ironwood returns the
   * FROST inputs and has its own completion step. Kept because it sits before
   * `fragmentSize` positionally; removing it would silently shift that
   * argument at any call site that passes it positionally.
   */
  frost = false,
  fragmentSize = 400,
): Promise<SendTxPcztUnsignedResult> => {
  return callWorker(
    network,
    'send-tx-pczt',
    { serverUrl, recipient, amount, memo, targetHeight, mainnet, ufvk, fragmentSize, frost },
    walletId,
  );
};

/**
 * Extract a broadcast-ready v5 tx from a signed PCZT returned by zigner and
 * broadcast it. The caller has already reassembled the multi-frame UR scan
 * into raw PCZT bytes (hex) via wasm `ur_decode_frames`.
 */
/** One spend-auth signature the airgapped device produced. */
export interface SignatureContribution {
  pool: 'orchard' | 'ironwood';
  action_index: number;
  /** 64-byte RedPallas spend-auth signature, hex. */
  signature_hex: string;
}

/**
 * Merge a compact device response into the PCZT the wallet retained.
 *
 * The compact flow returns only the signatures the device produced (tx_type
 * 0x07/0x08) instead of a whole signed PCZT - that is what collapses the QR
 * return leg. The wasm applies each contribution to its (pool, action_index)
 * slot and verifies it against the action's randomized verification key, so an
 * invalid or tampered contribution REJECTS here rather than being absorbed.
 * Feed the result to `completeSendTxPcztInWorker` exactly like a full signed
 * PCZT from the legacy path.
 */
export const applySignatureContributionsInWorker = async (
  network: NetworkType,
  walletId: string,
  pcztHex: string,
  contributions: SignatureContribution[],
): Promise<string> => {
  const res = await callWorker<{ pcztHex: string }>(
    network,
    'pczt-apply-contributions',
    { pcztHex, contributionsJson: JSON.stringify(contributions) },
    walletId,
  );
  return res.pcztHex;
};

export const completeSendTxPcztInWorker = async (
  network: NetworkType,
  walletId: string,
  serverUrl: string,
  signedPcztHex: string,
  /** SendTxPcztUnsignedResult.coldSendId from the matching build */
  coldSendId?: string,
): Promise<{ txid: string }> => {
  return callWorker(
    network,
    'send-tx-pczt-complete',
    { serverUrl, signedPcztHex, coldSendId },
    walletId,
  );
};

/**
 * Result of building a NU6.3 turnstile migration PCZT (orchard -> ironwood).
 *
 * Same shape as SendTxPcztUnsignedResult plus `amount` (the migrated value:
 * full orchard balance minus fee) and a structured summary carrying the
 * ironwood action count / output values for device confirmation.
 */
export interface TurnstileMigrationUnsignedResult {
  pcztHex: string;
  /** PcztSummary from the wasm; includes ironwood_actions and outputs */
  summary: unknown;
  actionCount: number;
  fee: string;
  /** zatoshi migrated to the wallet's own ironwood address */
  amount: string;
  urFrames: string[];
  cborBytes: number;
  /** see SendTxUnsignedResult.coldSendId - same handle, same contract */
  coldSendId?: string;
}

/**
 * Build the NU6.3 turnstile migration: spends the wallet's FULL orchard
 * balance to its OWN ironwood address (derived inside the wasm) in a single V6
 * transaction. Feature-flagged (IRONWOOD_MIGRATION) at the UI layer.
 *
 * Two modes, selected by which key access is provided:
 * - HOT (vault passed): the worker opens the vault, has the PCZT proven, SIGNS
 *   it and broadcasts directly, resolving to `{ txid, fee }`. `ufvk` is ignored.
 * - COLD (vault omitted, ufvk passed): the worker builds an UNSIGNED PCZT
 *   for the zigner cold-sign QR machine, resolving to
 *   `TurnstileMigrationUnsignedResult` (frames etc.).
 */
export const buildTurnstileMigrationInWorker = async (
  network: NetworkType,
  walletId: string,
  serverUrl: string,
  accountIndex: number,
  mainnet: boolean,
  ufvk: string | undefined,
  backend: 'zidecar' | 'lightwalletd' = 'zidecar',
  vault?: VaultUnlock,
  fragmentSize = 400,
): Promise<TurnstileMigrationUnsignedResult | { txid: string; fee: string }> => {
  return callWorker(
    network,
    'send-turnstile-migration',
    {
      serverUrl,
      accountIndex,
      mainnet,
      ufvk,
      backend,
      vault: vault && (await sealFor(network, vault)),
      fragmentSize,
    },
    walletId,
  );
};

/**
 * Extract the signed V6 turnstile migration tx from the zigner-signed PCZT
 * and broadcast it. Mirrors completeSendTxPcztInWorker.
 */
export const completeTurnstileMigrationInWorker = async (
  network: NetworkType,
  walletId: string,
  serverUrl: string,
  signedPcztHex: string,
  /** TurnstileMigrationUnsignedResult.coldSendId from the matching build */
  coldSendId?: string,
): Promise<{ txid: string }> => {
  return callWorker(
    network,
    'send-turnstile-migration-complete',
    { serverUrl, signedPcztHex, coldSendId },
    walletId,
  );
};

/** result of building an unsigned shielding transaction */
export interface ShieldUnsignedResult {
  sighashes: string[];
  unsignedTxHex: string;
  summary: string;
  fee: string;
  addressIndices: number[];
  /** the one transparent pubkey that owns every input (ironwood builder only) */
  transparentPubkeyHex?: string;
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
  /** Ledger: one round of at most this many inputs, with the account's ovk */
  ledger?: { maxInputs: number },
): Promise<ShieldUnsignedResult> => {
  return callWorker(
    network,
    'shield-unsigned',
    { serverUrl, tAddresses, mainnet, ufvk, ...(ledger && { ...ledger, ledgerOvk: true }) },
    walletId,
  );
};

/** a signed PCZT's broadcast-ready tx and its (display-order) txid; no network */
export const extractSignedPcztTxInWorker = (
  signedPcztHex: string,
): Promise<{ txHex: string; txid: string }> =>
  callWorker('zcash', 'pczt-extract-tx', { signedPcztHex });

/** broadcast an extracted signed tx with the cold-send bookkeeping for
 *  `coldSendId`; "broadcast failed (code)" is a node rejection, any other
 *  throw an unknown outcome */
export const broadcastSignedTxInWorker = (
  walletId: string,
  serverUrl: string,
  txHex: string,
  coldSendId?: string,
): Promise<{ txid: string }> =>
  callWorker('zcash', 'broadcast-signed-tx', { serverUrl, txHex, coldSendId }, walletId);

/** whether the backend knows a display-order txid; a failure reads as not found */
export const lookupTxInWorker = (
  serverUrl: string,
  txid: string,
): Promise<{ found: boolean; height?: number }> =>
  callWorker('zcash', 'lookup-tx', { serverUrl, txid });

export interface ShieldEligibility {
  inputCount: number;
  totalZat: string;
  /** the next round's inputs would not cover its fee */
  belowThreshold: boolean;
}

/** shieldable transparent inputs right now; throws on a failed fetch, never 0 */
export const shieldEligibilityInWorker = (
  serverUrl: string,
  tAddresses: string[],
  maxInputs: number,
): Promise<ShieldEligibility> =>
  callWorker('zcash', 'shield-eligible', { serverUrl, tAddresses, maxInputs });

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
  if (state) {
    state.syncingWallets.add(walletId);
  }
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
 * answer a prove request from the zcash worker with the host's own prover.
 * Both workers live in the offscreen document, so the request (UFVK and
 * public data only, checked by prove-guard on each side) never touches the
 * extension message bus.
 */
async function relayProveRequest(worker: Worker, id: string, request: unknown): Promise<void> {
  try {
    if (!hostProver) {
      throw new Error('the prover is not running in this document');
    }
    worker.postMessage({ type: 'prove-response', id, data: await hostProver(request) });
  } catch (e) {
    worker.postMessage({
      type: 'prove-response',
      id,
      error: e instanceof Error ? e.message : String(e),
    });
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
  return callWorker('zcash', 'frost-dkg-part2', {
    secretHex,
    peerBroadcasts: JSON.stringify(peerBroadcasts),
  });
};

/** DKG round 3: finalize - returns key package + public key package */
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

/** signed FROST share - wrapping is required for cross-party aggregator (poker-escrow) to extract the signer identifier */
export const frostSpendSignInWorker = async (
  ephemeralSeedHex: string,
  keyPackageHex: string,
  noncesHex: string,
  sighashHex: string,
  alphaHex: string,
  commitments: string[],
): Promise<string> => {
  return callWorker('zcash', 'frost-spend-sign', {
    ephemeralSeedHex,
    keyPackageHex,
    noncesHex,
    sighashHex,
    alphaHex,
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
    publicKeyPackageHex,
    sighashHex,
    alphaHex,
    commitments: JSON.stringify(commitments),
    shares: JSON.stringify(shares),
  });
};

/** derive multisig Orchard address from FROST group key (non-deterministic
 * - only use for single-party derive-and-broadcast flows) */
export const frostDeriveAddressInWorker = async (
  publicKeyPackageHex: string,
  diversifierIndex: number,
): Promise<string> => {
  return callWorker('zcash', 'frost-derive-address', { publicKeyPackageHex, diversifierIndex });
};

/** derive multisig Orchard address deterministically from pkg + host-broadcast sk.
 * pair with `frostDeriveUfvkInWorker` so address and UFVK share one source of
 * truth for nk/rivk - otherwise participants end up with matching UFVK but
 * different addresses. */
export const frostDeriveAddressFromSkInWorker = async (
  publicKeyPackageHex: string,
  skHex: string,
  diversifierIndex: number,
): Promise<string> => {
  return callWorker('zcash', 'frost-derive-address-from-sk', {
    publicKeyPackageHex,
    skHex,
    diversifierIndex,
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
 * on every participant, output is byte-identical - this is the property
 * we echo-broadcast to verify before persisting the wallet.
 */
export const frostDeriveUfvkInWorker = async (
  publicKeyPackageHex: string,
  skHex: string,
  mainnet: boolean,
): Promise<string> => {
  return callWorker('zcash', 'frost-derive-ufvk', { publicKeyPackageHex, skHex, mainnet });
};

/** Multisig verifier: parse outputs of an unsigned v5 tx using the FROST UFVK
 * so each joiner can derive (recipient, amount, is_change) per Orchard action
 * without trusting the host's claim. Returns parsed JSON. */
export interface FrostParsedAction {
  index: number;
  amount_zat: number;
  recipient_raw_hex: string | null;
  is_change: boolean;
  decrypted: boolean;
  // ── additive, from frost_inspect_pczt_outputs (zcli feat/pczt-explicit-expiry).
  // Absent from the currently vendored wasm; verifySealedIntent refuses when
  // they are missing rather than guessing.
  pool?: 'orchard' | 'ironwood';
  /** Output note value, ONLY when `cmx_verified` (recomputed from the PCZT's
   * recipient/value/rseed and the sighash-bound cmx). */
  committed_value_zat?: number | null;
  /** Output note recipient (raw 43 bytes hex), ONLY when `cmx_verified`. */
  committed_recipient_raw_hex?: string | null;
  cmx_verified?: boolean;
  /** Scope of the inspecting UFVK the committed recipient derives from, or
   * null for a foreign address. A key-derivation fact, unlike `is_change`. */
  recipient_scope?: 'external' | 'internal' | null;
}
export interface FrostParsedTransparentOutput {
  value_zat: number;
  script_pubkey_hex: string;
  /** encoded P2PKH/P2SH address, null for any other script */
  address: string | null;
}
export interface FrostParsedTx {
  actions: FrostParsedAction[];
  summary: {
    total_send_zat: number;
    total_change_zat: number;
    decrypted_count: number;
    action_count: number;
  };
  /** ZIP-244 sighash recomputed from the unsigned tx bytes the joiner was
   * given. Compare to the host's claimed sighash from the SIGN: payload - * a mismatch means the host published a decoy bundle for display while
   * asking the joiner to actually sign a different tx. `null` means the
   * tx shape (transparent or sapling component present) isn't covered by
   * this verifier yet - fall back to OVK-only check with a warning. */
  computed_sighash_hex: string | null;
  // ── additive, transaction-level (see FrostParsedAction) ──
  expiry_height?: number;
  tx_version?: number;
  consensus_branch_id?: number;
  /** per-pool value balance the sighash binds (0 when the bundle is absent) */
  value_balance_zat?: { orchard: number; ironwood: number; sapling: number };
  sapling_present?: boolean;
  transparent_input_count?: number;
  transparent_input_total_zat?: number | null;
  transparent_outputs?: FrostParsedTransparentOutput[];
  /** value balances + transparent in - transparent out; null if negative */
  fee_zat?: number | null;
  /** null, or why the committed per-output view could not be produced */
  committed_outputs_error?: string | null;
}
export const frostParseTxOutputsInWorker = async (
  unsignedTxHex: string,
  orchardFvkUview: string,
): Promise<FrostParsedTx> => {
  const json = await callWorker<string>('zcash', 'frost-parse-tx-outputs', {
    unsignedTxHex,
    orchardFvkUview,
  });
  return JSON.parse(json) as FrostParsedTx;
};

/** PCZT-native variant: inspect a standard pczt::Pczt (the migration target - * mnemonic/zigner hosts + the escrow all publish a PCZT). Recomputes the
 * canonical sighash from the PCZT itself; same FrostParsedTx contract as the
 * v5-tx parser so computeVerdict is unchanged. */
export const frostInspectPcztOutputsInWorker = async (
  pcztHex: string,
  orchardFvkUview: string,
): Promise<FrostParsedTx> => {
  const json = await callWorker<string>('zcash', 'frost-inspect-pczt-outputs', {
    pcztHex,
    orchardFvkUview,
  });
  return JSON.parse(json) as FrostParsedTx;
};

/** Complete a FROST multisig PCZT: inject the aggregated orchard SpendAuth sigs
 * (one per real spend, in `spendIndices` order from the build) and extract the
 * broadcast-ready v5 tx hex. Mnemonic/zigner host + escrow all finish here. */
export const completeOrchardPcztInWorker = async (
  walletId: string,
  serverUrl: string,
  pcztHex: string,
  orchardSigs: string[],
  spendIndices: number[],
  /** SendTxPcztUnsignedResult.coldSendId from the matching build */
  coldSendId?: string,
): Promise<{ txid: string }> => {
  return callWorker<{ txid: string }>(
    'zcash',
    'complete-orchard-pczt',
    { serverUrl, pcztHex, orchardSigs, spendIndices, coldSendId },
    walletId,
  );
};

/** Broadcast a fully-signed transparent tx hex (e.g. from a Ledger t->t send).
 *  The device already built + signed it; this only submits it. */
export const broadcastRawTxInWorker = async (
  serverUrl: string,
  txHex: string,
): Promise<{ txid: string }> => {
  return callWorker<{ txid: string }>('zcash', 'broadcast-raw-tx', { serverUrl, txHex });
};

/** Spendable transparent UTXOs for the given addresses (e.g. a Ledger t-addr),
 *  each with the full previous-tx hex the Ledger legacy signer needs. */
export interface TransparentUtxoInfo {
  txid: string;
  vout: number;
  valueZat: number;
  scriptHex: string;
  prevTxHex: string;
}
export const getTransparentUtxosInWorker = async (
  serverUrl: string,
  addresses: string[],
): Promise<TransparentUtxoInfo[]> => {
  return callWorker<TransparentUtxoInfo[]>('zcash', 'get-transparent-utxos', {
    serverUrl,
    addresses,
  });
};

// --- Voting worker helpers ---

export const generateVotingHotkeyInWorker = async (
  network: string,
): Promise<{ hotkeySecretHex: string; hotkeyPubkeyHex: string }> => {
  return callWorker('zcash', 'generate-voting-hotkey', { network });
};

// Delegation is TWO-PHASE (the ZKP #1 circuit also excludes the padded dummy-note
// nullifiers, which only exist after the PCZT is built). Phase 1 builds + redacts
// the PCZT and reports the real + dummy nullifiers; the host then fetches their IMT
// proofs (PIR) + merkle witnesses and has the cold signer sign the redacted PCZT;
// phase 2 proves + attaches the sig. Delegation spends the voter's REAL notes with
// the COLD key, so it takes the account's fvk + seed_fingerprint + account_index,
// NOT the hotkey secret (the hotkey only supplies the output address).
export const buildDelegationPcztInWorker = async (a: {
  fvkHex: string;
  seedFingerprintHex: string;
  accountIndex: number;
  hotkeyPubkeyHex: string;
  notesJson: string;
  roundParamsJson: string;
  consensusBranchId: number;
  roundName: string;
  network: string;
  bundleIndex: number;
}): Promise<{
  redactedPcztHex: string;
  pcztSighashHex: string;
  rkHex: string;
  actionIndex: number;
  delegatedWeight: number;
  displayMemo: string;
  realNoteNullifiersHex: string[];
  dummyNoteNullifiersHex: string[];
  delegationContextJson: string;
  delegationStateJson: string;
  urFrames: string[];
  cborBytes: number;
}> => {
  return callWorker('zcash', 'build-delegation-pczt', a);
};

export const finalizeDelegationInWorker = async (a: {
  delegationContextJson: string;
  merkleWitnessesJson: string;
  imtProofsJson: string;
  spendAuthSigHex: string;
  sighashHex: string;
}): Promise<{ delegationSubmissionWireJson: string }> => {
  return callWorker('zcash', 'finalize-delegation', a);
};

export const castVoteHotInWorker = async (a: {
  network: string;
  hotkeySecretHex: string;
  roundParamsJson: string;
  delegationStateJson: string;
  vanWitnessJson: string;
  voteJson: string;
  submitAt: number;
}): Promise<{ proposalId: number; wire: string; shares: string; commitmentBundleJson: string }> => {
  return callWorker('zcash', 'cast-vote-hot-wire', a);
};

export const pirFetchImtProofsInWorker = async (a: {
  pirBaseUrl: string;
  nullifiersJson: string;
}): Promise<{ imtProofsJson: string }> => {
  return callWorker('zcash', 'pir-fetch-imt-proofs', a);
};

/** Raw Orchard FVK hex + a freshly ZIP-316-encoded UFVK string for a mnemonic
 *  wallet's account. `WalletKeys` only exports the raw FVK bytes; there is no
 *  stored UFVK for a hot wallet the way there is for watch-only/Ledger
 *  imports, so the worker encodes (and self-validates) one on demand. */
export const getOrchardAccountInfoInWorker = async (
  mnemonic: string,
  mainnet: boolean,
  pocket = 0,
): Promise<{ fvkHex: string; ufvkStr: string }> => {
  return callWorker('zcash', 'get-orchard-account-info', { mnemonic, mainnet, pocket });
};

/** Live consensus branch id (as a number) from the endpoint's GetLightdInfo,
 *  the same source `fetchBranchIdHex` uses for send-tx builds. */
export const getConsensusBranchIdInWorker = async (
  network: NetworkType,
  serverUrl: string,
): Promise<{ consensusBranchId: number }> => {
  return callWorker(network, 'get-consensus-branch-id', { serverUrl });
};

/** Merkle witnesses (WitnessDto shape) for a set of the wallet's own notes at
 *  a target height, in the SAME order as `nullifiers` - callers that feed
 *  `finalize_delegation` must pass nullifiers in the order the matching
 *  `notes_json` was given to `build_delegation_pczt`. */
export const getMerkleWitnessesInWorker = async (
  network: NetworkType,
  walletId: string,
  a: {
    nullifiers: string[];
    targetHeight: number;
    serverUrl: string;
    pool?: 'orchard' | 'ironwood';
  },
): Promise<{ merkleWitnessesJson: string }> => {
  return callWorker(network, 'get-merkle-witnesses', a, walletId);
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
