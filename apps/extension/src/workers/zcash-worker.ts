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

import { fixOrchardAddress } from '@repo/wallet/networks/zcash/unified-address';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const workerSelf = globalThis as any as DedicatedWorkerGlobalScope;

interface WorkerMessage {
  type: 'init' | 'derive-address' | 'sync' | 'stop-sync' | 'reset-sync' | 'get-balance' | 'send-tx' | 'send-tx-complete' | 'shield' | 'shield-unsigned' | 'shield-complete' | 'list-wallets' | 'delete-wallet' | 'get-notes' | 'decrypt-memos';
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

/** Common scanning interface shared by WalletKeys and WatchOnlyWallet */
interface ScannerKeys {
  scan_actions_parallel(actionsBytes: Uint8Array): DecryptedNote[];
  decrypt_transaction_memos(txBytes: Uint8Array): FoundNoteWithMemo[];
  free(): void;
}

interface WalletKeys extends ScannerKeys {
  get_receiving_address(mainnet: boolean): string;
  get_receiving_address_at(index: number, mainnet: boolean): string;
  scan_actions(actionsJson: unknown): DecryptedNote[];
  calculate_balance(notes: unknown, spent: unknown): bigint;
}

interface WatchOnlyWallet extends ScannerKeys {
  get_address(): string;
  get_address_at(diversifierIndex: number): string;
  get_account_index(): number;
  is_mainnet(): boolean;
  export_fvk_hex(): string;
}

interface DecryptedNote {
  height: number;
  value: string;
  nullifier: string;
  cmx: string;
  txid: string;
  position: number;
  rseed?: string;
  rho?: string;
  recipient?: string;
}

interface WalletState {
  keys: ScannerKeys | null;
  syncing: boolean;
  syncAbort: boolean;
  notes: DecryptedNote[];
  spentNullifiers: Set<string>;
}

interface WasmModule {
  WalletKeys: new (seed: string) => WalletKeys;
  WatchOnlyWallet: {
    from_ufvk(ufvk: string): WatchOnlyWallet;
    from_qr_hex(qrHex: string): WatchOnlyWallet;
    new (fvkBytes: Uint8Array, accountIndex: number, mainnet: boolean): WatchOnlyWallet;
  };
  build_shielding_transaction(utxos_json: string, privkey_hex: string, recipient: string, amount: bigint, fee: bigint, anchor_height: number, mainnet: boolean): string;
  build_unsigned_transaction(notes_json: string, recipient: string, amount: bigint, fee: bigint, anchor_hex: string, merkle_paths_json: string, account_index: number, mainnet: boolean): string;
  build_signed_spend_transaction(seed_phrase: string, notes_json: unknown, recipient: string, amount: bigint, fee: bigint, anchor_hex: string, merkle_paths_json: unknown, account_index: number, mainnet: boolean): string;
  complete_transaction(unsigned_tx_json: string, signatures_json: string): string;
  build_unsigned_shielding_transaction(utxos_json: string, recipient: string, amount: bigint, fee: bigint, anchor_height: number, mainnet: boolean): string;
  complete_shielding_transaction(unsigned_tx_hex: string, signatures_json: string): string;
  derive_transparent_privkey(seed_phrase: string, account: number, index: number): string;
  build_merkle_paths(tree_state_hex: string, compact_blocks_json: string, note_positions_json: string, anchor_height: number): unknown;
  frontier_tree_size(tree_state_hex: string): bigint;
  tree_root_hex(tree_state_hex: string): string;
}

let wasmModule: WasmModule | null = null;
const walletStates = new Map<string, WalletState>();

const hexEncode = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, '0');
  return s;
};

/** Wait for sync loop to stop after setting syncAbort=true. Polls state.syncing with 50ms interval, max 2s. */
const waitForSyncStop = (state: WalletState, timeoutMs = 2000): Promise<void> => {
  if (!state.syncing) return Promise.resolve();
  return new Promise(resolve => {
    const start = Date.now();
    const check = () => {
      if (!state.syncing || Date.now() - start > timeoutMs) resolve();
      else setTimeout(check, 50);
    };
    check();
  });
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

/** close shared db connection — called when worker is idle */
export const closeDb = () => {
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

const getTreeSize = async (walletId: string): Promise<number> => {
  const r = await idbGet<{ value: number }>('meta', [walletId, 'orchardTreeSize']);
  return r?.value ?? 0;
};

/** batch-save notes + spent + sync height + tree size in one transaction */
const saveBatch = async (
  walletId: string,
  notes: DecryptedNote[],
  spent: string[],
  syncHeight: number,
  orchardTreeSize?: number,
): Promise<void> => {
  const db = await getDb();
  const tx = db.transaction(['notes', 'spent', 'meta'], 'readwrite');
  const notesStore = tx.objectStore('notes');
  const spentStore = tx.objectStore('spent');
  const metaStore = tx.objectStore('meta');
  for (const note of notes) notesStore.put({ ...note, walletId });
  for (const nf of spent) spentStore.put({ walletId, nullifier: nf });
  metaStore.put({ walletId, key: 'syncHeight', value: syncHeight });
  if (orchardTreeSize !== undefined) {
    metaStore.put({ walletId, key: 'orchardTreeSize', value: orchardTreeSize });
  }
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

// ── ZIP-317 fee computation ──

const MARGINAL_FEE = 5000n;
const GRACE_ACTIONS = 2;
const MIN_ORCHARD_ACTIONS = 2;

const computeFee = (nSpends: number, nZOutputs: number, nTOutputs: number, hasChange: boolean): bigint => {
  const nOrchardOutputs = nZOutputs + (hasChange ? 1 : 0);
  const nOrchardActions = Math.max(nSpends, nOrchardOutputs, MIN_ORCHARD_ACTIONS);
  const logicalActions = nOrchardActions + nTOutputs;
  return MARGINAL_FEE * BigInt(Math.max(logicalActions, GRACE_ACTIONS));
};

// ── note selection (largest first) ──

const selectNotes = (notes: DecryptedNote[], spentNullifiers: Set<string>, target: bigint): DecryptedNote[] => {
  const unspent = notes.filter(n => !spentNullifiers.has(n.nullifier));
  unspent.sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
  const selected: DecryptedNote[] = [];
  let total = 0n;
  for (const note of unspent) {
    total += BigInt(note.value);
    selected.push(note);
    if (total >= target) return selected;
  }
  throw new Error(`insufficient funds: have ${total} zat, need ${target} zat`);
};

// ── witness building helpers ──

const WITNESS_BATCH_SIZE = 1000;

/** binary search for checkpoint height whose tree size is just before target_position */
const findCheckpointHeight = async (
  client: { getTreeState(h: number): Promise<{ height: number; orchardTree: string }> },
  targetPosition: number,
  activation: number,
  tip: number,
): Promise<{ height: number; size: number }> => {
  if (!wasmModule) throw new Error('wasm not initialized');
  let lo = activation;
  let hi = tip;
  let bestHeight = activation;
  let bestSize = 0;

  while (lo + 100 < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const ts = await client.getTreeState(mid);
    const size = Number(wasmModule!.frontier_tree_size(ts.orchardTree));
    if (size <= targetPosition) {
      bestHeight = ts.height;
      bestSize = size;
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  return { height: bestHeight, size: bestSize };
};

/** build merkle witnesses by replaying blocks from checkpoint to anchor */
const buildWitnesses = async (
  client: {
    getTreeState(h: number): Promise<{ height: number; orchardTree: string }>;
    getCompactBlocks(start: number, end: number): Promise<Array<{ height: number; actions: Array<{ cmx: Uint8Array }> }>>;
  },
  notes: DecryptedNote[],
  anchorHeight: number,
  mainnet: boolean,
): Promise<{ anchorHex: string; paths: string }> => {
  if (!wasmModule) throw new Error('wasm not initialized');

  const activation = mainnet ? 1_687_104 : 1_842_420;
  const earliestPosition = Math.min(...notes.map(n => n.position));

  console.log(`[zcash-worker] earliest note position: ${earliestPosition}`);

  // find checkpoint
  const checkpoint = await findCheckpointHeight(client, earliestPosition, activation, anchorHeight);
  console.log(`[zcash-worker] checkpoint: height=${checkpoint.height} size=${checkpoint.size}`);

  // get tree state at checkpoint
  const ts = await client.getTreeState(checkpoint.height);

  // replay blocks from checkpoint+1 to anchorHeight
  const replayStart = checkpoint.height + 1;
  const compactBlocks: Array<{ height: number; actions: Array<{ cmx_hex: string }> }> = [];

  let current = replayStart;
  while (current <= anchorHeight) {
    const end = Math.min(current + WITNESS_BATCH_SIZE - 1, anchorHeight);
    const blocks = await client.getCompactBlocks(current, end);
    for (const block of blocks) {
      compactBlocks.push({
        height: block.height,
        actions: block.actions.map(a => ({ cmx_hex: hexEncode(a.cmx) })),
      });
    }
    current = end + 1;
  }

  console.log(`[zcash-worker] replayed ${compactBlocks.length} blocks for witnesses`);

  // call witness WASM
  const positions = notes.map(n => n.position);
  console.log(`[zcash-worker] building merkle paths: positions=${JSON.stringify(positions)}, anchorHeight=${anchorHeight}, blocks=${compactBlocks.length}`);
  let resultRaw: unknown;
  try {
    resultRaw = wasmModule!.build_merkle_paths(
      ts.orchardTree,
      JSON.stringify(compactBlocks),
      JSON.stringify(positions),
      anchorHeight,
    );
  } catch (e) {
    console.error('[zcash-worker] build_merkle_paths failed:', e);
    throw e;
  }

  // WASM returns JsValue::from_str(json) — comes through as a string
  const result = JSON.parse(resultRaw as string) as { anchor_hex: string; paths: unknown[] };
  console.log(`[zcash-worker] merkle paths built, anchor=${result.anchor_hex}`);

  // verify anchor matches network state
  const anchorTs = await client.getTreeState(anchorHeight);
  const networkRoot = wasmModule!.tree_root_hex(anchorTs.orchardTree);
  if (result.anchor_hex !== networkRoot) {
    console.error(`[zcash-worker] tree root mismatch: ours=${result.anchor_hex}, network=${networkRoot}`);
    throw new Error(`tree root mismatch at height ${anchorHeight} (ours=${result.anchor_hex}, network=${networkRoot})`);
  }

  return { anchorHex: result.anchor_hex, paths: JSON.stringify(result.paths) };
};

const deriveAddress = (mnemonic: string, accountIndex: number): string => {
  if (!wasmModule) throw new Error('wasm not initialized');
  const keys = new wasmModule.WalletKeys(mnemonic);
  try {
    const raw = keys.get_receiving_address_at(accountIndex, true);
    return fixOrchardAddress(raw, true);
  }
  finally { keys.free(); }
};

// ── sync ──

const runSync = async (walletId: string, mnemonic: string, serverUrl: string, startHeight?: number, ufvk?: string): Promise<void> => {
  if (!wasmModule) throw new Error('wasm not initialized');

  const state = getOrCreateWalletState(walletId);

  // abort existing sync if running — prevents concurrent loops
  if (state.syncing) {
    state.syncAbort = true;
    await waitForSyncStop(state);
  }

  // free old keys if re-syncing
  if (state.keys) { state.keys.free(); state.keys = null; }

  await registerWallet(walletId);
  // use WatchOnlyWallet for UFVK (zigner), WalletKeys for mnemonic
  if (ufvk) {
    state.keys = wasmModule.WatchOnlyWallet.from_ufvk(ufvk);
    console.log(`[zcash-worker] created WatchOnlyWallet from UFVK for wallet=${walletId}`);
  } else {
    state.keys = new wasmModule.WalletKeys(mnemonic);
  }
  await loadState(walletId);

  const syncedHeight = await getSyncHeight(walletId);
  // use whichever is higher — prevents re-scanning if chrome.storage was stale
  let currentHeight = Math.max(startHeight ?? 0, syncedHeight);

  const { ZidecarClient } = await import(/* webpackMode: "eager" */ '../state/keyring/zidecar-client');
  const client = new ZidecarClient(serverUrl);

  // track orchard commitment tree size for note position computation
  let orchardTreeSize = await getTreeSize(walletId);

  // if we don't have a tree size yet, fetch it from the network
  if (orchardTreeSize === 0 && currentHeight > 0) {
    try {
      const ts = await client.getTreeState(currentHeight);
      orchardTreeSize = Number(wasmModule!.frontier_tree_size(ts.orchardTree));
      console.log(`[zcash-worker] initial tree size from network: ${orchardTreeSize} at height ${currentHeight}`);
    } catch (e) {
      console.warn('[zcash-worker] failed to get initial tree size:', e);
    }
  }

  console.log(`[zcash-worker] sync start wallet=${walletId} height=${currentHeight} treeSize=${orchardTreeSize} (idb=${syncedHeight}, requested=${startHeight ?? 'none'})`);

  // emit initial sync-progress so UI gets persisted height + can fetch balance immediately
  workerSelf.postMessage({
    type: 'sync-progress', id: '', network: 'zcash', walletId,
    payload: { currentHeight, chainHeight: currentHeight, notesFound: state.notes.length, blocksScanned: 0 },
  });

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
      const actionNullifiers = new Set<string>();
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
            // build cmx→txid map + collect action nullifiers (one pass)
            cmxToTxid.set(hexEncode(a.cmx), hexEncode(a.txid));
            actionNullifiers.add(hexEncode(a.nullifier));
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
          // compute absolute tree position: batch start + index within batch
          const position = orchardTreeSize + (note as unknown as { index: number }).index;
          const full: DecryptedNote = { ...note, position, txid: cmxToTxid.get(note.cmx) ?? '' };
          console.log(`[zcash-worker] found note: value=${note.value}, pos=${position}, hasRseed=${!!note.rseed}, hasRho=${!!note.rho}, hasRecipient=${!!(note as unknown as { recipient?: string }).recipient}`);
          newNotes.push(full);
          state.notes.push(full);
        }

        // detect spent notes: check if any action nullifier matches an owned note's nullifier
        for (const note of state.notes) {
          if (!state.spentNullifiers.has(note.nullifier) && actionNullifiers.has(note.nullifier)) {
            state.spentNullifiers.add(note.nullifier);
            newSpent.push(note.nullifier);
          }
        }
      }

      // advance tree size by total actions in this batch
      orchardTreeSize += actionCount;

      // single batched db write for entire batch
      currentHeight = endHeight;
      await saveBatch(walletId, newNotes, newSpent, currentHeight, orchardTreeSize);

      // persist to chrome.storage for popup reactivity
      try { chrome.storage?.local?.set({ zcashSyncHeight: currentHeight }); } catch (e) {
        console.warn('[zcash-worker] chrome.storage set failed:', e);
      }

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
  if (!state) return 0n;
  let balance = 0n;
  for (const note of state.notes) {
    if (!state.spentNullifiers.has(note.nullifier)) {
      balance += BigInt(note.value);
    }
  }
  return balance;
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
        const { mnemonic, serverUrl, startHeight, ufvk } = payload as {
          mnemonic: string; serverUrl: string; startHeight?: number; ufvk?: string;
        };
        runSync(walletId, mnemonic, serverUrl, startHeight, ufvk).catch(err =>
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

      case 'reset-sync': {
        if (!walletId) throw new Error('walletId required');
        const resetState = walletStates.get(walletId);
        if (resetState) {
          resetState.syncAbort = true;
          if (resetState.keys) { resetState.keys.free(); resetState.keys = null; }
        }
        await waitForSyncStop(resetState ?? getOrCreateWalletState(walletId));
        // clear IDB data for this wallet
        await deleteWallet(walletId);
        // re-register so future sync can start clean
        await registerWallet(walletId);
        // reset in-memory state
        const freshState = getOrCreateWalletState(walletId);
        freshState.notes = [];
        freshState.spentNullifiers = new Set();
        freshState.syncing = false;
        freshState.syncAbort = false;
        workerSelf.postMessage({ type: 'sync-reset', id, network: 'zcash', walletId });
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
          await waitForSyncStop(state);
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

      case 'send-tx': {
        if (!walletId) throw new Error('walletId required');
        await initWasm();
        if (!wasmModule) throw new Error('wasm not initialized');

        const sendPayload = payload as {
          serverUrl: string; recipient: string; amount: string; memo: string;
          accountIndex: number; mainnet: boolean;
          mnemonic?: string;
        };

        const sendStart = performance.now();
        const emitProgress = (step: string, detail?: string) => {
          const elapsed = ((performance.now() - sendStart) / 1000).toFixed(1);
          console.log(`[zcash-worker] send [${elapsed}s] ${step}${detail ? ': ' + detail : ''}`);
          workerSelf.postMessage({
            type: 'send-progress', id: '', network: 'zcash', walletId,
            payload: { step, detail, elapsedMs: Math.round(performance.now() - sendStart) },
          });
        };

        emitProgress('loading wallet state');

        // load wallet state from IDB
        const sendState = await loadState(walletId);
        const amountZat = BigInt(sendPayload.amount);

        // determine recipient type for fee calc
        const isTransparent = sendPayload.recipient.startsWith('t1') || sendPayload.recipient.startsWith('tm');
        const nZOutputs = isTransparent ? 0 : 1;
        const nTOutputs = isTransparent ? 1 : 0;

        emitProgress('selecting notes', `${sendState.notes.length} notes available`);

        // estimate fee and select notes
        const estFee = computeFee(1, nZOutputs, nTOutputs, true);
        const selected = selectNotes(sendState.notes, sendState.spentNullifiers, amountZat + estFee);

        // compute exact fee
        const totalIn = selected.reduce((sum, n) => sum + BigInt(n.value), 0n);
        const hasChange = totalIn > amountZat + computeFee(selected.length, nZOutputs, nTOutputs, true);
        const fee = computeFee(selected.length, nZOutputs, nTOutputs, hasChange);
        if (totalIn < amountZat + fee) {
          throw new Error(`insufficient funds: have ${totalIn} zat, need ${amountZat + fee} zat`);
        }

        emitProgress('notes selected', `${selected.length} notes, fee=${fee}`);

        // build merkle witnesses
        const { ZidecarClient } = await import(/* webpackMode: "eager" */ '../state/keyring/zidecar-client');
        const sendClient = new ZidecarClient(sendPayload.serverUrl);

        emitProgress('fetching chain tip');
        const sendTip = await sendClient.getTip();

        emitProgress('building merkle witnesses', `anchor=${sendTip.height}`);
        const witnessStart = performance.now();

        const { anchorHex, paths } = await buildWitnesses(
          sendClient, selected, sendTip.height, sendPayload.mainnet,
        );

        const witnessDuration = ((performance.now() - witnessStart) / 1000).toFixed(1);
        emitProgress('witnesses built', `${witnessDuration}s`);

        if (sendPayload.mnemonic) {
          // mnemonic wallet: build fully signed transaction and broadcast directly
          const notesJson = selected.map(n => ({
            value: Number(n.value),
            nullifier: n.nullifier,
            cmx: n.cmx,
            position: n.position,
            rseed_hex: n.rseed ?? '',
            rho_hex: n.rho ?? '',
            recipient_hex: n.recipient ?? '',
          }));

          // parse merkle paths result for WASM
          const pathsResult = JSON.parse(paths) as Array<{ position: number; path: Array<{ hash: string }> }>;
          const merklePathsForWasm = pathsResult.map(p => ({
            path: p.path.map(e => e.hash),
            position: p.position,
          }));

          emitProgress('building & proving transaction (halo2)', `${selected.length} spends`);
          const proveStart = performance.now();

          let txHex: string;
          try {
            txHex = wasmModule.build_signed_spend_transaction(
              sendPayload.mnemonic,
              notesJson,
              sendPayload.recipient,
              amountZat,
              fee,
              anchorHex,
              merklePathsForWasm,
              sendPayload.accountIndex,
              sendPayload.mainnet,
            );
          } catch (e) {
            console.error('[zcash-worker] build_signed_spend_transaction failed:', e);
            throw e;
          }

          const proveDuration = ((performance.now() - proveStart) / 1000).toFixed(1);
          emitProgress('transaction proved', `${proveDuration}s, ${txHex.length / 2} bytes`);

          // broadcast
          emitProgress('broadcasting transaction');
          const txData = new Uint8Array(txHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
          const { ZidecarClient: ZC2 } = await import(/* webpackMode: "eager" */ '../state/keyring/zidecar-client');
          const broadcastClient = new ZC2(sendPayload.serverUrl);
          let result: { errorCode: number; errorMessage: string; txid: Uint8Array };
          try {
            result = await broadcastClient.sendTransaction(txData);
          } catch (e) {
            console.error('[zcash-worker] broadcast RPC failed:', e);
            throw e;
          }
          if (result.errorCode !== 0) {
            throw new Error(`broadcast failed (${result.errorCode}): ${result.errorMessage}`);
          }

          const txid = new TextDecoder().decode(result.txid);
          const totalDuration = ((performance.now() - sendStart) / 1000).toFixed(1);
          emitProgress('complete', `txid=${txid}, total=${totalDuration}s`);

          workerSelf.postMessage({
            type: 'tx-result', id, network: 'zcash', walletId,
            payload: { txid, fee: fee.toString() },
          });
          return;
        }

        // zigner wallet: build unsigned transaction for cold signing
        emitProgress('building unsigned transaction');

        const notesJson = JSON.stringify(selected.map(n => ({
          value: n.value,
          nullifier: n.nullifier,
          cmx: n.cmx,
          position: n.position,
        })));

        // build unsigned transaction
        const unsignedResult = wasmModule.build_unsigned_transaction(
          notesJson,
          sendPayload.recipient,
          amountZat,
          fee,
          anchorHex,
          paths,
          sendPayload.accountIndex,
          sendPayload.mainnet,
        );

        const parsed = JSON.parse(unsignedResult) as {
          sighash: string; alphas: string[]; unsigned_tx: string; summary: string;
        };

        const totalDuration = ((performance.now() - sendStart) / 1000).toFixed(1);
        emitProgress('unsigned tx ready', `total=${totalDuration}s`);

        workerSelf.postMessage({
          type: 'send-tx-unsigned', id, network: 'zcash', walletId,
          payload: {
            sighash: parsed.sighash,
            alphas: parsed.alphas,
            summary: parsed.summary,
            fee: fee.toString(),
            unsignedTx: parsed.unsigned_tx,
          },
        });
        return;
      }

      case 'send-tx-complete': {
        if (!walletId) throw new Error('walletId required');
        await initWasm();
        if (!wasmModule) throw new Error('wasm not initialized');

        const completePayload = payload as {
          serverUrl: string; unsignedTx: string;
          signatures: { orchardSigs: string[]; transparentSigs: string[] };
        };

        const signaturesJson = JSON.stringify(completePayload.signatures);
        const txHex = wasmModule.complete_transaction(completePayload.unsignedTx, signaturesJson);
        const txData = new Uint8Array(txHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));

        const { ZidecarClient: ZC } = await import(/* webpackMode: "eager" */ '../state/keyring/zidecar-client');
        const completeClient = new ZC(completePayload.serverUrl);
        const result = await completeClient.sendTransaction(txData);
        if (result.errorCode !== 0) {
          throw new Error(`broadcast failed (${result.errorCode}): ${result.errorMessage}`);
        }

        const txid = new TextDecoder().decode(result.txid);
        workerSelf.postMessage({
          type: 'tx-result', id, network: 'zcash', walletId,
          payload: { txid },
        });
        return;
      }

      case 'shield': {
        if (!walletId) throw new Error('walletId required');
        await initWasm();
        if (!wasmModule) throw new Error('wasm not initialized');

        const { mnemonic, serverUrl, tAddresses, mainnet, addressIndexMap } = payload as {
          mnemonic: string; serverUrl: string; tAddresses: string[]; mainnet: boolean;
          addressIndexMap?: Record<string, number>;
        };

        const { ZidecarClient } = await import(/* webpackMode: "eager" */ '../state/keyring/zidecar-client');
        const client = new ZidecarClient(serverUrl);
        const tip = await client.getTip();
        const allUtxos = await client.getAddressUtxos(tAddresses);
        if (allUtxos.length === 0) throw new Error('no transparent UTXOs to shield');

        // build address → derivation index lookup
        const addrToIndex = new Map<string, number>();
        if (addressIndexMap) {
          for (const [addr, idx] of Object.entries(addressIndexMap)) {
            addrToIndex.set(addr, idx);
          }
        } else {
          for (const addr of tAddresses) addrToIndex.set(addr, 0);
        }

        // group UTXOs by derivation index (WASM signs all inputs with one key)
        const byIndex = new Map<number, typeof allUtxos>();
        for (const utxo of allUtxos) {
          const idx = addrToIndex.get(utxo.address) ?? 0;
          let group = byIndex.get(idx);
          if (!group) { group = []; byIndex.set(idx, group); }
          group.push(utxo);
        }

        // orchard recipient (same for all txs)
        const keys = new wasmModule.WalletKeys(mnemonic);
        let rawRecipient: string;
        try {
          rawRecipient = keys.get_receiving_address(mainnet);
        } finally {
          keys.free();
        }
        const recipient = fixOrchardAddress(rawRecipient, mainnet);

        // shield each group with its matching privkey
        let totalShielded = 0n;
        let totalFee = 0n;
        let totalUtxos = 0;
        let lastTxid = '';

        for (const [addrIndex, utxos] of byIndex) {
          const groupZat = utxos.reduce((sum, u) => sum + u.valueZat, 0n);
          const logicalActions = 2 + utxos.length;
          const fee = BigInt(5000 * Math.max(logicalActions, 2));
          if (groupZat <= fee) {
            console.warn(`[zcash-worker] skipping index ${addrIndex}: ${groupZat} zat <= ${fee} fee`);
            continue;
          }

          const shieldAmount = groupZat - fee;
          const privkeyHex = wasmModule.derive_transparent_privkey(mnemonic, 0, addrIndex);

          const utxosJson = JSON.stringify(utxos.map(u => ({
            txid: hexEncode(u.txid),
            vout: u.outputIndex,
            value: u.valueZat.toString(),
            script: hexEncode(u.script),
          })));

          const txHex = wasmModule.build_shielding_transaction(
            utxosJson, privkeyHex, recipient, shieldAmount, fee, tip.height, mainnet,
          );
          const txData = new Uint8Array(txHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
          const result = await client.sendTransaction(txData);
          if (result.errorCode !== 0) throw new Error(`broadcast failed (${result.errorCode}): ${result.errorMessage}`);

          lastTxid = new TextDecoder().decode(result.txid);
          totalShielded += shieldAmount;
          totalFee += fee;
          totalUtxos += utxos.length;
        }

        if (totalUtxos === 0) throw new Error('all UTXO groups too small to cover fees');

        workerSelf.postMessage({
          type: 'shield-result', id, network: 'zcash', walletId,
          payload: { txid: lastTxid, shieldedZat: totalShielded.toString(), feeZat: totalFee.toString(), utxoCount: totalUtxos },
        });
        return;
      }

      case 'shield-unsigned': {
        if (!walletId) throw new Error('walletId required');
        await initWasm();
        if (!wasmModule) throw new Error('wasm not initialized');

        const shieldUnsignedPayload = payload as {
          serverUrl: string; tAddresses: string[]; mainnet: boolean;
          ufvk: string; addressIndexMap?: Record<string, number>;
        };

        const { ZidecarClient: ZCShieldU } = await import(/* webpackMode: "eager" */ '../state/keyring/zidecar-client');
        const shieldUClient = new ZCShieldU(shieldUnsignedPayload.serverUrl);
        const shieldUTip = await shieldUClient.getTip();
        const shieldUUtxos = await shieldUClient.getAddressUtxos(shieldUnsignedPayload.tAddresses);
        if (shieldUUtxos.length === 0) throw new Error('no transparent UTXOs to shield');

        // build address → derivation index lookup
        const shieldUAddrToIndex = new Map<string, number>();
        if (shieldUnsignedPayload.addressIndexMap) {
          for (const [addr, idx] of Object.entries(shieldUnsignedPayload.addressIndexMap)) {
            shieldUAddrToIndex.set(addr, idx);
          }
        } else {
          for (const addr of shieldUnsignedPayload.tAddresses) shieldUAddrToIndex.set(addr, 0);
        }

        // orchard recipient from watch-only wallet
        const shieldUWatch = wasmModule.WatchOnlyWallet.from_ufvk(shieldUnsignedPayload.ufvk);
        let shieldURecipient: string;
        try {
          shieldURecipient = shieldUWatch.get_address();
        } finally {
          shieldUWatch.free();
        }
        shieldURecipient = fixOrchardAddress(shieldURecipient, shieldUnsignedPayload.mainnet);

        // for simplicity, shield all UTXOs in a single tx
        const shieldUTotal = shieldUUtxos.reduce((sum, u) => sum + u.valueZat, 0n);
        const shieldULogicalActions = 2 + shieldUUtxos.length;
        const shieldUFee = BigInt(5000 * Math.max(shieldULogicalActions, 2));
        if (shieldUTotal <= shieldUFee) throw new Error('UTXOs too small to cover fee');
        const shieldUAmount = shieldUTotal - shieldUFee;

        // collect address indices in UTXO order
        const shieldUAddrIndices = shieldUUtxos.map(u => shieldUAddrToIndex.get(u.address) ?? 0);

        const shieldUUtxosJson = JSON.stringify(shieldUUtxos.map(u => ({
          txid: hexEncode(u.txid),
          vout: u.outputIndex,
          value: Number(u.valueZat),
          script: hexEncode(u.script),
        })));

        const shieldUResult = wasmModule.build_unsigned_shielding_transaction(
          shieldUUtxosJson, shieldURecipient, shieldUAmount, shieldUFee,
          shieldUTip.height, shieldUnsignedPayload.mainnet,
        );

        const shieldUParsed = JSON.parse(shieldUResult) as {
          sighashes: string[]; unsigned_tx_hex: string; summary: string;
        };

        workerSelf.postMessage({
          type: 'shield-unsigned-result', id, network: 'zcash', walletId,
          payload: {
            sighashes: shieldUParsed.sighashes,
            unsignedTxHex: shieldUParsed.unsigned_tx_hex,
            summary: shieldUParsed.summary,
            fee: shieldUFee.toString(),
            addressIndices: shieldUAddrIndices,
          },
        });
        return;
      }

      case 'shield-complete': {
        if (!walletId) throw new Error('walletId required');
        await initWasm();
        if (!wasmModule) throw new Error('wasm not initialized');

        const shieldCompletePayload = payload as {
          serverUrl: string; unsignedTxHex: string;
          signatures: { sig_hex: string; pubkey_hex: string }[];
        };

        const signaturesJson = JSON.stringify(shieldCompletePayload.signatures);
        const shieldCompleteTxHex = wasmModule.complete_shielding_transaction(
          shieldCompletePayload.unsignedTxHex, signaturesJson,
        );
        const shieldCompleteTxData = new Uint8Array(
          shieldCompleteTxHex.match(/.{2}/g)!.map((b: string) => parseInt(b, 16)),
        );

        const { ZidecarClient: ZCShieldC } = await import(/* webpackMode: "eager" */ '../state/keyring/zidecar-client');
        const shieldCompleteClient = new ZCShieldC(shieldCompletePayload.serverUrl);
        const shieldCompleteResult = await shieldCompleteClient.sendTransaction(shieldCompleteTxData);
        if (shieldCompleteResult.errorCode !== 0) {
          throw new Error(`broadcast failed (${shieldCompleteResult.errorCode}): ${shieldCompleteResult.errorMessage}`);
        }

        const shieldCompleteTxid = new TextDecoder().decode(shieldCompleteResult.txid);
        workerSelf.postMessage({
          type: 'tx-result', id, network: 'zcash', walletId,
          payload: { txid: shieldCompleteTxid },
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
