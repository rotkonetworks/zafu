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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const workerSelf = globalThis as any as DedicatedWorkerGlobalScope;

interface WorkerMessage {
  type: 'init' | 'derive-address' | 'sync' | 'stop-sync' | 'get-balance' | 'send-tx' | 'shield' | 'list-wallets' | 'delete-wallet' | 'get-notes' | 'decrypt-memos';
  id: string;
  network: 'zcash';
  walletId?: string;
  payload?: unknown;
}

interface FoundNoteWithMemo {
  index: number;
  value: number;
  nullifier: string;
  cmx: string;
  memo: string;
  memo_is_text: boolean;
}

interface WalletKeys {
  get_receiving_address(mainnet: boolean): string;
  get_receiving_address_at(index: number, mainnet: boolean): string;
  scan_actions(actionsJson: unknown): DecryptedNote[];
  scan_actions_parallel(actionsBytes: Uint8Array): DecryptedNote[];
  calculate_balance(notes: unknown, spent: unknown): bigint;
  decrypt_transaction_memos(txBytes: Uint8Array): FoundNoteWithMemo[];
  free(): void;
}

interface DecryptedNote {
  height: number;
  value: string;
  nullifier: string;
  cmx: string;
  txid: string;
}

interface WalletState {
  keys: WalletKeys | null;
  syncing: boolean;
  syncAbort: boolean;
  notes: DecryptedNote[];
  spentNullifiers: Set<string>;
}

interface WasmModule {
  WalletKeys: new (seed: string) => WalletKeys;
  build_shielding_transaction(utxos_json: string, privkey_hex: string, recipient: string, amount: bigint, fee: bigint, anchor_height: number, mainnet: boolean): string;
  derive_transparent_privkey(seed_phrase: string, account: number, index: number): string;
}

let wasmModule: WasmModule | null = null;
const walletStates = new Map<string, WalletState>();

const hexEncode = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, '0');
  return s;
};

const getOrCreateWalletState = (walletId: string): WalletState => {
  let state = walletStates.get(walletId);
  if (!state) {
    state = { keys: null, syncing: false, syncAbort: false, notes: [], spentNullifiers: new Set() };
    walletStates.set(walletId, state);
  }
  return state;
};

// ── indexeddb ──
// single connection held open during sync, closed when idle

const DB_NAME = 'zafu-zcash';
const DB_VERSION = 2;

let sharedDb: IDBDatabase | null = null;

const getDb = (): Promise<IDBDatabase> => {
  if (sharedDb) return Promise.resolve(sharedDb);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => { sharedDb = req.result; resolve(sharedDb); };
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const old = event.oldVersion;
      for (const name of ['notes', 'spent', 'meta'] as const) {
        if (db.objectStoreNames.contains(name) && old < 2) db.deleteObjectStore(name);
        if (!db.objectStoreNames.contains(name)) {
          const keyPath = name === 'meta' ? ['walletId', 'key'] : ['walletId', 'nullifier'];
          const store = db.createObjectStore(name, { keyPath });
          store.createIndex('byWallet', 'walletId', { unique: false });
        }
      }
      if (!db.objectStoreNames.contains('wallets')) {
        db.createObjectStore('wallets', { keyPath: 'walletId' });
      }
    };
  });
};

const closeDb = () => {
  if (sharedDb) { sharedDb.close(); sharedDb = null; }
};

const txComplete = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

const idbGet = async <T>(store: string, key: IDBValidKey): Promise<T | undefined> => {
  const db = await getDb();
  const tx = db.transaction(store, 'readonly');
  return new Promise((resolve, reject) => {
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
};

const idbGetAllByIndex = async <T>(store: string, indexName: string, key: IDBValidKey): Promise<T[]> => {
  const db = await getDb();
  const tx = db.transaction(store, 'readonly');
  return new Promise((resolve, reject) => {
    const req = tx.objectStore(store).index(indexName).getAll(key);
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
};

const registerWallet = async (walletId: string): Promise<void> => {
  const db = await getDb();
  const tx = db.transaction('wallets', 'readwrite');
  tx.objectStore('wallets').put({ walletId, createdAt: Date.now() });
  await txComplete(tx);
};

const listWallets = async (): Promise<string[]> => {
  const db = await getDb();
  const tx = db.transaction('wallets', 'readonly');
  const wallets: { walletId: string }[] = await new Promise((resolve, reject) => {
    const req = tx.objectStore('wallets').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return wallets.map(w => w.walletId);
};

const deleteWallet = async (walletId: string): Promise<void> => {
  const db = await getDb();
  // delete across all stores in parallel transactions
  for (const storeName of ['wallets', 'notes', 'spent', 'meta'] as const) {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    if (storeName === 'wallets') {
      store.delete(walletId);
    } else {
      const keys: IDBValidKey[] = await new Promise((resolve, reject) => {
        const req = store.index('byWallet').getAllKeys(walletId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      for (const key of keys) store.delete(key);
    }
    await txComplete(tx);
  }
  walletStates.delete(walletId);
};

const loadState = async (walletId: string): Promise<WalletState> => {
  const state = getOrCreateWalletState(walletId);
  state.notes = await idbGetAllByIndex<DecryptedNote>('notes', 'byWallet', walletId);
  const spentRecords = await idbGetAllByIndex<{ nullifier: string }>('spent', 'byWallet', walletId);
  state.spentNullifiers = new Set(spentRecords.map(r => r.nullifier));
  return state;
};

const getSyncHeight = async (walletId: string): Promise<number> => {
  const r = await idbGet<{ value: number }>('meta', [walletId, 'syncHeight']);
  return r?.value ?? 0;
};

/** batch-save notes + spent + sync height in one transaction */
const saveBatch = async (
  walletId: string,
  notes: DecryptedNote[],
  spent: string[],
  syncHeight: number,
): Promise<void> => {
  const db = await getDb();
  const tx = db.transaction(['notes', 'spent', 'meta'], 'readwrite');
  const notesStore = tx.objectStore('notes');
  const spentStore = tx.objectStore('spent');
  const metaStore = tx.objectStore('meta');
  for (const note of notes) notesStore.put({ ...note, walletId });
  for (const nf of spent) spentStore.put({ walletId, nullifier: nf });
  metaStore.put({ walletId, key: 'syncHeight', value: syncHeight });
  await txComplete(tx);
};

// ── wasm ──

const initWasm = async (): Promise<void> => {
  if (wasmModule) return;
  // @ts-expect-error — dynamic import in worker
  const wasm = await import(/* webpackIgnore: true */ '/zafu-wasm/zafu_wasm.js');
  await wasm.default({ module_or_path: '/zafu-wasm/zafu_wasm_bg.wasm' });
  wasm.init();
  wasmModule = wasm;
  console.log('[zcash-worker] wasm ready');
};

const deriveAddress = (mnemonic: string, accountIndex: number): string => {
  if (!wasmModule) throw new Error('wasm not initialized');
  const keys = new wasmModule.WalletKeys(mnemonic);
  try { return keys.get_receiving_address_at(accountIndex, true); }
  finally { keys.free(); }
};

// ── sync ──

const runSync = async (walletId: string, mnemonic: string, serverUrl: string, startHeight?: number): Promise<void> => {
  if (!wasmModule) throw new Error('wasm not initialized');

  const state = getOrCreateWalletState(walletId);

  // free old keys if re-syncing
  if (state.keys) { state.keys.free(); state.keys = null; }

  await registerWallet(walletId);
  state.keys = new wasmModule.WalletKeys(mnemonic);
  await loadState(walletId);

  const syncedHeight = await getSyncHeight(walletId);
  let currentHeight = startHeight ?? syncedHeight;

  const { ZidecarClient } = await import(/* webpackMode: "eager" */ '../state/keyring/zidecar-client');
  const client = new ZidecarClient(serverUrl);

  console.log(`[zcash-worker] sync start wallet=${walletId} height=${currentHeight}`);

  state.syncing = true;
  state.syncAbort = false;
  let consecutiveErrors = 0;

  while (!state.syncAbort) {
    try {
      const tip = await client.getTip();
      const chainHeight = tip.height;

      if (currentHeight >= chainHeight) {
        workerSelf.postMessage({
          type: 'sync-progress', id: '', network: 'zcash', walletId,
          payload: { currentHeight, chainHeight, notesFound: state.notes.length, blocksScanned: 0 },
        });
        await new Promise(r => setTimeout(r, 10000));
        continue;
      }

      // small batches — 50 blocks max to keep memory bounded
      const batchSize = 50;
      const endHeight = Math.min(currentHeight + batchSize, chainHeight);

      console.log(`[zcash-worker] blocks ${currentHeight + 1}..${endHeight}`);
      const blocks = await client.getCompactBlocks(currentHeight + 1, endHeight);

      // build cmx→txid lookup only from raw block data (for found note matching)
      const cmxToTxid = new Map<string, string>();
      let actionCount = 0;

      // pack actions into binary format for scan_actions_parallel
      // layout: [u32le count][per action: 32B nullifier | 32B cmx | 32B epk | 52B ct]
      const ACTION_SIZE = 32 + 32 + 32 + 52;
      for (const block of blocks) actionCount += block.actions.length;

      const newNotes: DecryptedNote[] = [];
      const newSpent: string[] = [];

      if (actionCount > 0 && state.keys) {
        // build binary buffer — single allocation, no JS object overhead
        const buf = new Uint8Array(4 + actionCount * ACTION_SIZE);
        const view = new DataView(buf.buffer);
        view.setUint32(0, actionCount, true);
        let off = 4;
        for (const block of blocks) {
          for (const a of block.actions) {
            if (a.nullifier.length === 32) buf.set(a.nullifier, off); off += 32;
            if (a.cmx.length === 32) buf.set(a.cmx, off); off += 32;
            if (a.ephemeralKey.length === 32) buf.set(a.ephemeralKey, off); off += 32;
            if (a.ciphertext.length >= 52) buf.set(a.ciphertext.subarray(0, 52), off); off += 52;
            // build cmx→txid map only during packing (one pass)
            cmxToTxid.set(hexEncode(a.cmx), hexEncode(a.txid));
          }
        }

        console.log(`[zcash-worker] scanning ${actionCount} actions (binary)`);
        const t0 = performance.now();

        let foundNotes: DecryptedNote[];
        try {
          foundNotes = state.keys.scan_actions_parallel(buf);
        } catch (err) {
          console.error('[zcash-worker] scan_actions_parallel crashed:', err);
          currentHeight = endHeight;
          continue;
        }

        console.log(`[zcash-worker] scanned in ${(performance.now() - t0).toFixed(0)}ms, found ${foundNotes.length}`);

        for (const note of foundNotes) {
          const full: DecryptedNote = { ...note, txid: cmxToTxid.get(note.cmx) ?? '' };
          newNotes.push(full);
          state.notes.push(full);

          if (!state.spentNullifiers.has(note.nullifier)) {
            const spent = state.notes.find(n => n.nullifier === note.nullifier && n !== full);
            if (spent) {
              state.spentNullifiers.add(note.nullifier);
              newSpent.push(note.nullifier);
            }
          }
        }
      }

      // single batched db write for entire batch
      currentHeight = endHeight;
      await saveBatch(walletId, newNotes, newSpent, currentHeight);

      // persist to chrome.storage for popup reactivity
      try { chrome.storage?.local?.set({ zcashSyncHeight: currentHeight }); } catch {}

      workerSelf.postMessage({
        type: 'sync-progress', id: '', network: 'zcash', walletId,
        payload: { currentHeight, chainHeight, notesFound: state.notes.length, blocksScanned: blocks.length },
      });

      consecutiveErrors = 0;
      // yield between batches
      await new Promise(r => setTimeout(r, 10));

    } catch (err) {
      consecutiveErrors++;
      console.error(`[zcash-worker] sync error (${consecutiveErrors}):`, err);
      // back off exponentially, max 30s
      const backoff = Math.min(30000, 2000 * Math.pow(2, consecutiveErrors - 1));
      await new Promise(r => setTimeout(r, backoff));
      // after 10 consecutive errors, give up
      if (consecutiveErrors >= 10) {
        console.error('[zcash-worker] too many errors, stopping sync');
        break;
      }
    }
  }

  state.syncing = false;
  console.log(`[zcash-worker] sync stopped wallet=${walletId}`);
};

const getBalance = (walletId: string): bigint => {
  const state = walletStates.get(walletId);
  if (!state?.keys) return 0n;
  return state.keys.calculate_balance(state.notes, [...state.spentNullifiers]);
};

// ── message handler ──

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
        if (!walletId) throw new Error('walletId required');
        await initWasm();
        const { mnemonic, serverUrl, startHeight } = payload as {
          mnemonic: string; serverUrl: string; startHeight?: number;
        };
        runSync(walletId, mnemonic, serverUrl, startHeight).catch(err =>
          console.error('[zcash-worker] runSync fatal:', err),
        );
        workerSelf.postMessage({ type: 'sync-started', id, network: 'zcash', walletId });
        return;
      }

      case 'stop-sync': {
        if (!walletId) throw new Error('walletId required');
        const state = walletStates.get(walletId);
        if (state) state.syncAbort = true;
        workerSelf.postMessage({ type: 'sync-stopped', id, network: 'zcash', walletId });
        return;
      }

      case 'get-balance': {
        if (!walletId) throw new Error('walletId required');
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
        if (!walletId) throw new Error('walletId required');
        const state = walletStates.get(walletId);
        if (state?.syncing) {
          state.syncAbort = true;
          await new Promise(r => setTimeout(r, 200));
        }
        if (state?.keys) { state.keys.free(); state.keys = null; }
        await deleteWallet(walletId);
        workerSelf.postMessage({ type: 'wallet-deleted', id, network: 'zcash', walletId });
        return;
      }

      case 'get-notes': {
        if (!walletId) throw new Error('walletId required');
        const noteState = await loadState(walletId);
        workerSelf.postMessage({ type: 'notes', id, network: 'zcash', walletId, payload: noteState.notes });
        return;
      }

      case 'decrypt-memos': {
        if (!walletId) throw new Error('walletId required');
        const memoState = walletStates.get(walletId);
        if (!memoState?.keys) throw new Error('wallet keys not loaded');
        const { txBytes } = payload as { txBytes: number[] };
        const memos = memoState.keys.decrypt_transaction_memos(new Uint8Array(txBytes));
        workerSelf.postMessage({ type: 'memos', id, network: 'zcash', walletId, payload: memos });
        return;
      }

      case 'shield': {
        if (!walletId) throw new Error('walletId required');
        await initWasm();
        if (!wasmModule) throw new Error('wasm not initialized');

        const { mnemonic, serverUrl, tAddresses, mainnet } = payload as {
          mnemonic: string; serverUrl: string; tAddresses: string[]; mainnet: boolean;
        };

        const { ZidecarClient } = await import(/* webpackMode: "eager" */ '../state/keyring/zidecar-client');
        const client = new ZidecarClient(serverUrl);
        const tip = await client.getTip();
        const utxos = await client.getAddressUtxos(tAddresses);
        if (utxos.length === 0) throw new Error('no transparent UTXOs to shield');

        const totalZat = utxos.reduce((sum, u) => sum + u.valueZat, 0n);
        const logicalActions = 2 + utxos.length;
        const fee = BigInt(5000 * Math.max(logicalActions, 2));
        if (totalZat <= fee) throw new Error(`insufficient: ${totalZat} zat, need > ${fee} fee`);

        const shieldAmount = totalZat - fee;
        const privkeyHex = wasmModule.derive_transparent_privkey(mnemonic, 0, 0);
        const keys = new wasmModule.WalletKeys(mnemonic);
        const recipient = keys.get_receiving_address(mainnet);
        keys.free();

        const utxosJson = JSON.stringify(utxos.map(u => ({
          txid: hexEncode(u.txid),
          vout: u.outputIndex,
          value: Number(u.valueZat),
          script: hexEncode(u.script),
        })));

        const txHex = wasmModule.build_shielding_transaction(
          utxosJson, privkeyHex, recipient, shieldAmount, fee, tip.height, mainnet,
        );
        const txData = new Uint8Array(txHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
        const result = await client.sendTransaction(txData);
        const txidHex = hexEncode(result.txid);
        if (result.errorCode !== 0) throw new Error(`broadcast failed (${result.errorCode}): ${result.errorMessage}`);

        workerSelf.postMessage({
          type: 'shield-result', id, network: 'zcash', walletId,
          payload: { txid: txidHex, shieldedZat: shieldAmount.toString(), feeZat: fee.toString(), utxoCount: utxos.length },
        });
        return;
      }

      default:
        throw new Error(`unknown message type: ${type}`);
    }
  } catch (err) {
    workerSelf.postMessage({
      type: 'error', id, network: 'zcash', walletId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

initWasm().then(() => {
  workerSelf.postMessage({ type: 'ready', id: '', network: 'zcash' });
}).catch(err => {
  console.error('[zcash-worker] wasm init failed:', err);
});
