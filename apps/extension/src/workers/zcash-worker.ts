/**
 * zcash network worker
 *
 * runs in isolated web worker with:
 * - own zafu-wasm instance
 * - own sync loop
 * - own indexeddb access
 *
 * communicates with main thread via postMessage
 */

/// <reference lib="webworker" />

// worker-specific globals - cast to worker type
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const workerSelf = globalThis as any as DedicatedWorkerGlobalScope;

interface WorkerMessage {
  type: 'init' | 'derive-address' | 'sync' | 'stop-sync' | 'get-balance' | 'send-tx' | 'list-wallets' | 'delete-wallet';
  id: string;
  network: 'zcash';
  walletId?: string; // identifies which wallet this message is for
  payload?: unknown;
}

interface WalletKeys {
  get_receiving_address_at(index: number, mainnet: boolean): string;
  scan_actions_parallel(actionsBytes: Uint8Array): DecryptedNote[];
  calculate_balance(notes: unknown, spent: unknown): bigint;
  free(): void;
}

interface DecryptedNote {
  height: number;
  value: string;
  nullifier: string;
  cmx: string;
}

// state - per wallet
interface WalletState {
  keys: WalletKeys | null;
  syncing: boolean;
  syncAbort: boolean;
  notes: DecryptedNote[];
  spentNullifiers: string[];
}

let wasmModule: { WalletKeys: new (seed: string) => WalletKeys } | null = null;
const walletStates = new Map<string, WalletState>();

const getOrCreateWalletState = (walletId: string): WalletState => {
  let state = walletStates.get(walletId);
  if (!state) {
    state = {
      keys: null,
      syncing: false,
      syncAbort: false,
      notes: [],
      spentNullifiers: [],
    };
    walletStates.set(walletId, state);
  }
  return state;
};

// indexeddb for persistence - multi-wallet schema
const DB_NAME = 'zafu-zcash';
const DB_VERSION = 2; // bumped for multi-wallet schema

const openDb = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;

      // notes: compound key [walletId, nullifier]
      if (!db.objectStoreNames.contains('notes')) {
        const notesStore = db.createObjectStore('notes', { keyPath: ['walletId', 'nullifier'] });
        notesStore.createIndex('byWallet', 'walletId', { unique: false });
      } else if (oldVersion < 2) {
        // migrate from v1 - delete old store and recreate
        db.deleteObjectStore('notes');
        const notesStore = db.createObjectStore('notes', { keyPath: ['walletId', 'nullifier'] });
        notesStore.createIndex('byWallet', 'walletId', { unique: false });
      }

      // spent: compound key [walletId, nullifier]
      if (!db.objectStoreNames.contains('spent')) {
        const spentStore = db.createObjectStore('spent', { keyPath: ['walletId', 'nullifier'] });
        spentStore.createIndex('byWallet', 'walletId', { unique: false });
      } else if (oldVersion < 2) {
        db.deleteObjectStore('spent');
        const spentStore = db.createObjectStore('spent', { keyPath: ['walletId', 'nullifier'] });
        spentStore.createIndex('byWallet', 'walletId', { unique: false });
      }

      // meta: compound key [walletId, key]
      if (!db.objectStoreNames.contains('meta')) {
        const metaStore = db.createObjectStore('meta', { keyPath: ['walletId', 'key'] });
        metaStore.createIndex('byWallet', 'walletId', { unique: false });
      } else if (oldVersion < 2) {
        db.deleteObjectStore('meta');
        const metaStore = db.createObjectStore('meta', { keyPath: ['walletId', 'key'] });
        metaStore.createIndex('byWallet', 'walletId', { unique: false });
      }

      // wallets: list of wallet ids for this network
      if (!db.objectStoreNames.contains('wallets')) {
        db.createObjectStore('wallets', { keyPath: 'walletId' });
      }
    };
  });
};

// register wallet in db
const registerWallet = async (walletId: string): Promise<void> => {
  const db = await openDb();
  const tx = db.transaction('wallets', 'readwrite');
  const store = tx.objectStore('wallets');
  store.put({ walletId, createdAt: Date.now() });
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
};

// list all wallets for this network
const listWallets = async (): Promise<string[]> => {
  const db = await openDb();
  const tx = db.transaction('wallets', 'readonly');
  const store = tx.objectStore('wallets');
  const wallets: { walletId: string }[] = await new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return wallets.map(w => w.walletId);
};

// delete wallet and all its data
const deleteWallet = async (walletId: string): Promise<void> => {
  const db = await openDb();

  // delete from wallets store
  const walletTx = db.transaction('wallets', 'readwrite');
  walletTx.objectStore('wallets').delete(walletId);
  await new Promise<void>((resolve, reject) => {
    walletTx.oncomplete = () => resolve();
    walletTx.onerror = () => reject(walletTx.error);
  });

  // delete notes by wallet index
  const notesTx = db.transaction('notes', 'readwrite');
  const notesStore = notesTx.objectStore('notes');
  const notesIndex = notesStore.index('byWallet');
  const notesKeys: IDBValidKey[] = await new Promise((resolve, reject) => {
    const req = notesIndex.getAllKeys(walletId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  for (const key of notesKeys) {
    notesStore.delete(key);
  }
  await new Promise<void>((resolve, reject) => {
    notesTx.oncomplete = () => resolve();
    notesTx.onerror = () => reject(notesTx.error);
  });

  // delete spent by wallet index
  const spentTx = db.transaction('spent', 'readwrite');
  const spentStore = spentTx.objectStore('spent');
  const spentIndex = spentStore.index('byWallet');
  const spentKeys: IDBValidKey[] = await new Promise((resolve, reject) => {
    const req = spentIndex.getAllKeys(walletId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  for (const key of spentKeys) {
    spentStore.delete(key);
  }
  await new Promise<void>((resolve, reject) => {
    spentTx.oncomplete = () => resolve();
    spentTx.onerror = () => reject(spentTx.error);
  });

  // delete meta by wallet index
  const metaTx = db.transaction('meta', 'readwrite');
  const metaStore = metaTx.objectStore('meta');
  const metaIndex = metaStore.index('byWallet');
  const metaKeys: IDBValidKey[] = await new Promise((resolve, reject) => {
    const req = metaIndex.getAllKeys(walletId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  for (const key of metaKeys) {
    metaStore.delete(key);
  }
  await new Promise<void>((resolve, reject) => {
    metaTx.oncomplete = () => resolve();
    metaTx.onerror = () => reject(metaTx.error);
  });

  db.close();

  // clear in-memory state
  walletStates.delete(walletId);
};

const loadState = async (walletId: string): Promise<WalletState> => {
  const state = getOrCreateWalletState(walletId);
  const db = await openDb();

  // load notes for this wallet
  const notesTx = db.transaction('notes', 'readonly');
  const notesStore = notesTx.objectStore('notes');
  const notesIndex = notesStore.index('byWallet');
  state.notes = await new Promise((resolve, reject) => {
    const req = notesIndex.getAll(walletId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  // load spent nullifiers for this wallet
  const spentTx = db.transaction('spent', 'readonly');
  const spentStore = spentTx.objectStore('spent');
  const spentIndex = spentStore.index('byWallet');
  const spentRecords: { walletId: string; nullifier: string }[] = await new Promise((resolve, reject) => {
    const req = spentIndex.getAll(walletId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  state.spentNullifiers = spentRecords.map(r => r.nullifier);

  db.close();
  return state;
};

const saveNote = async (walletId: string, note: DecryptedNote): Promise<void> => {
  const db = await openDb();
  const tx = db.transaction('notes', 'readwrite');
  const store = tx.objectStore('notes');
  store.put({ ...note, walletId });
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
};

const saveSpent = async (walletId: string, nullifier: string): Promise<void> => {
  const db = await openDb();
  const tx = db.transaction('spent', 'readwrite');
  const store = tx.objectStore('spent');
  store.put({ walletId, nullifier });
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
};

const getSyncHeight = async (walletId: string): Promise<number> => {
  const db = await openDb();
  const tx = db.transaction('meta', 'readonly');
  const store = tx.objectStore('meta');
  const result: { walletId: string; key: string; value: number } | undefined = await new Promise((resolve, reject) => {
    const req = store.get([walletId, 'syncHeight']);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result?.value ?? 0;
};

const setSyncHeight = async (walletId: string, height: number): Promise<void> => {
  const db = await openDb();
  const tx = db.transaction('meta', 'readwrite');
  const store = tx.objectStore('meta');
  store.put({ walletId, key: 'syncHeight', value: height });
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
};

// init wasm
const initWasm = async (): Promise<void> => {
  if (wasmModule) return;

  // import from worker context - use webpackIgnore to load from extension root at runtime
  // @ts-expect-error - dynamic import in worker
  const wasm = await import(/* webpackIgnore: true */ '/zafu-wasm/zafu_wasm.js');
  await wasm.default('/zafu-wasm/zafu_wasm_bg.wasm');
  wasm.init();

  // init thread pool (in worker, use 2 threads to not starve main)
  const threads = Math.min(navigator.hardwareConcurrency || 2, 4);
  await wasm.initThreadPool(threads);

  wasmModule = wasm;
  console.log('[zcash-worker] wasm initialized with', threads, 'threads');
};

// derive address
const deriveAddress = (mnemonic: string, accountIndex: number): string => {
  if (!wasmModule) throw new Error('wasm not initialized');

  const keys = new wasmModule.WalletKeys(mnemonic);
  try {
    return keys.get_receiving_address_at(accountIndex, true); // mainnet
  } finally {
    keys.free();
  }
};

// sync loop for a specific wallet
const runSync = async (walletId: string, mnemonic: string, serverUrl: string, startHeight?: number): Promise<void> => {
  if (!wasmModule) throw new Error('wasm not initialized');

  const state = getOrCreateWalletState(walletId);

  // register wallet in db
  await registerWallet(walletId);

  // create wallet keys for scanning
  state.keys = new wasmModule.WalletKeys(mnemonic);

  // load persisted state
  await loadState(walletId);

  const syncedHeight = await getSyncHeight(walletId);
  let currentHeight = startHeight ?? syncedHeight;

  // import zidecar client - bundled with worker
  const { ZidecarClient } = await import(/* webpackMode: "eager" */ '../state/keyring/zidecar-client');
  const client = new ZidecarClient(serverUrl);

  console.log(`[zcash-worker] starting sync for wallet ${walletId} from height`, currentHeight);

  state.syncing = true;
  state.syncAbort = false;

  while (!state.syncAbort) {
    try {
      // get chain tip
      const tip = await client.getTip();
      const chainHeight = tip.height;

      if (currentHeight >= chainHeight) {
        // caught up, wait for new blocks
        await new Promise(r => setTimeout(r, 10000));
        continue;
      }

      // fetch blocks in batches
      const batchSize = 1000;
      const endHeight = Math.min(currentHeight + batchSize, chainHeight);

      const blocks = await client.getCompactBlocks(currentHeight + 1, endHeight);

      // collect all actions for batch scanning
      const allActions: { height: number; action: unknown }[] = [];
      for (const block of blocks) {
        for (const action of block.actions) {
          allActions.push({ height: block.height, action });
        }
      }

      if (allActions.length > 0 && state.keys) {
        // build binary format for parallel scanning
        const binaryActions = ZidecarClient.buildBinaryActions(
          allActions.map(a => a.action as Parameters<typeof ZidecarClient.buildBinaryActions>[0][0])
        );

        // scan in parallel
        const foundNotes = state.keys.scan_actions_parallel(binaryActions);

        for (const note of foundNotes) {
          state.notes.push(note);
          await saveNote(walletId, note);

          // check if this nullifier spends one of our notes
          const spentNote = state.notes.find(n => n.nullifier === note.nullifier);
          if (spentNote && !state.spentNullifiers.includes(note.nullifier)) {
            state.spentNullifiers.push(note.nullifier);
            await saveSpent(walletId, note.nullifier);
          }
        }
      }

      currentHeight = endHeight;
      await setSyncHeight(walletId, currentHeight);

      // report progress
      workerSelf.postMessage({
        type: 'sync-progress',
        id: '',
        network: 'zcash',
        walletId,
        payload: {
          currentHeight,
          chainHeight,
          notesFound: state.notes.length,
          blocksScanned: blocks.length,
        },
      });

    } catch (err) {
      console.error(`[zcash-worker] sync error for wallet ${walletId}:`, err);
      await new Promise(r => setTimeout(r, 5000)); // retry after 5s
    }
  }

  state.syncing = false;
  console.log(`[zcash-worker] sync stopped for wallet ${walletId}`);
};

// calculate balance for a specific wallet
const getBalance = (walletId: string): bigint => {
  const state = walletStates.get(walletId);
  if (!state?.keys) return 0n;
  return state.keys.calculate_balance(state.notes, state.spentNullifiers);
};

// message handler
workerSelf.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const { type, id, walletId, payload } = e.data;

  try {
    switch (type) {
      case 'init':
        await initWasm();
        workerSelf.postMessage({ type: 'ready', id, network: 'zcash' });
        return;

      case 'derive-address': {
        await initWasm();
        const { mnemonic, accountIndex } = payload as { mnemonic: string; accountIndex: number };
        const address = deriveAddress(mnemonic, accountIndex);
        workerSelf.postMessage({ type: 'address', id, network: 'zcash', walletId, payload: address });
        return;
      }

      case 'sync': {
        if (!walletId) throw new Error('walletId required for sync');
        await initWasm();
        const { mnemonic, serverUrl, startHeight } = payload as {
          mnemonic: string;
          serverUrl: string;
          startHeight?: number;
        };
        // run sync in background (don't await)
        runSync(walletId, mnemonic, serverUrl, startHeight).catch(console.error);
        workerSelf.postMessage({ type: 'sync-started', id, network: 'zcash', walletId });
        return;
      }

      case 'stop-sync': {
        if (!walletId) throw new Error('walletId required for stop-sync');
        const state = walletStates.get(walletId);
        if (state) {
          state.syncAbort = true;
        }
        workerSelf.postMessage({ type: 'sync-stopped', id, network: 'zcash', walletId });
        return;
      }

      case 'get-balance': {
        if (!walletId) throw new Error('walletId required for get-balance');
        const balance = getBalance(walletId);
        workerSelf.postMessage({ type: 'balance', id, network: 'zcash', walletId, payload: balance.toString() });
        return;
      }

      case 'list-wallets': {
        const wallets = await listWallets();
        workerSelf.postMessage({ type: 'wallets', id, network: 'zcash', payload: wallets });
        return;
      }

      case 'delete-wallet': {
        if (!walletId) throw new Error('walletId required for delete-wallet');
        // stop sync first if running
        const state = walletStates.get(walletId);
        if (state?.syncing) {
          state.syncAbort = true;
          // wait a bit for sync to stop
          await new Promise(r => setTimeout(r, 100));
        }
        await deleteWallet(walletId);
        workerSelf.postMessage({ type: 'wallet-deleted', id, network: 'zcash', walletId });
        return;
      }

      default:
        throw new Error(`unknown message type: ${type}`);
    }
  } catch (err) {
    workerSelf.postMessage({
      type: 'error',
      id,
      network: 'zcash',
      walletId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

// signal ready after wasm init
initWasm().then(() => {
  workerSelf.postMessage({ type: 'ready', id: '', network: 'zcash' });
}).catch(console.error);
