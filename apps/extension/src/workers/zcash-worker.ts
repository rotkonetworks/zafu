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
  type: 'init' | 'derive-address' | 'sync' | 'stop-sync' | 'reset-sync' | 'get-balance' | 'send-tx' | 'send-tx-multi' | 'send-tx-complete' | 'shield' | 'shield-unsigned' | 'shield-complete' | 'list-wallets' | 'delete-wallet' | 'get-notes' | 'note-sync-encode' | 'decrypt-memos' | 'get-transparent-history' | 'get-history' | 'sync-memos' | 'frost-dkg-part1' | 'frost-dkg-part2' | 'frost-dkg-part3' | 'frost-sign-round1' | 'frost-spend-sign' | 'frost-spend-aggregate' | 'frost-derive-address';
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
  is_outgoing: boolean;
  /** hex-encoded raw 512-byte memo */
  memo_bytes: string;
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
  is_change?: boolean;
  spent_by_txid?: string;
  spent_at_height?: number;
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
  build_unsigned_transaction(ufvk_str: string, notes_json: unknown, recipient: string, amount: bigint, fee: bigint, anchor_hex: string, merkle_paths_json: unknown, account_index: number, mainnet: boolean, memo_hex?: string | null): unknown;
  build_signed_spend_transaction(seed_phrase: string, notes_json: unknown, recipient: string, amount: bigint, fee: bigint, anchor_hex: string, merkle_paths_json: unknown, account_index: number, mainnet: boolean): string;
  complete_transaction(unsigned_tx_hex: string, signatures: unknown, spend_indices: unknown): string;
  build_unsigned_shielding_transaction(utxos_json: string, recipient: string, amount: bigint, fee: bigint, anchor_height: number, mainnet: boolean): string;
  complete_shielding_transaction(unsigned_tx_hex: string, signatures_json: string): string;
  derive_transparent_privkey(seed_phrase: string, account: number, index: number): string;
  build_merkle_paths(tree_state_hex: string, compact_blocks_json: string, note_positions_json: string, anchor_height: number): unknown;
  frontier_tree_size(tree_state_hex: string): bigint;
  tree_root_hex(tree_state_hex: string): string;

  // FROST multisig
  frost_dealer_keygen(min_signers: number, max_signers: number): string;
  frost_dkg_part1(max_signers: number, min_signers: number): string;
  frost_dkg_part2(secret_hex: string, peer_broadcasts_json: string): string;
  frost_dkg_part3(secret_hex: string, round1_broadcasts_json: string, round2_packages_json: string): string;
  frost_sign_round1(ephemeral_seed_hex: string, key_package_hex: string): string;
  frost_generate_randomizer(ephemeral_seed_hex: string, message_hex: string, commitments_json: string): string;
  frost_sign_round2(ephemeral_seed_hex: string, key_package_hex: string, nonces_hex: string, message_hex: string, commitments_json: string, randomizer_hex: string): string;
  frost_aggregate_shares(public_key_package_hex: string, message_hex: string, commitments_json: string, shares_json: string, randomizer_hex: string): string;
  frost_derive_address_raw(public_key_package_hex: string, diversifier_index: number): string;
  frost_spend_sign_round2(key_package_hex: string, nonces_hex: string, sighash_hex: string, alpha_hex: string, commitments_json: string): string;
  frost_spend_aggregate(public_key_package_hex: string, sighash_hex: string, alpha_hex: string, commitments_json: string, shares_json: string): string;

  // note sync encoding (CBOR + UR/ZT)
  encode_notes_bundle(notes_json: string, merkle_result_json: string, anchor_height: number, mainnet: boolean, attestation_hex?: string | null): Uint8Array;
  ur_encode_frames(cbor_data: Uint8Array, ur_type: string, fragment_size: number): string;
  zt_encode_frames(cbor_data: Uint8Array, zt_type: string, k: number, n: number): string;

  // attestation
  frost_attestation_digest(public_key_package_hex: string, anchor_hex: string, anchor_height: number, mainnet: boolean): string;
  frost_attestation_verify(attestation_hex: string, public_key_package_hex: string, anchor_hex: string, anchor_height: number, mainnet: boolean): boolean;
}

let wasmModule: WasmModule | null = null;
const walletStates = new Map<string, WalletState>();

const hexEncode = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, '0');
  return s;
};

const hexDecode = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  return out;
};

/**
 * patch consensus branch ID in a v5 tx to NU5 (0xC2D6D0B4)
 * allows older zcash_primitives to parse NU6+ transactions
 * v5 layout: [4B header][4B versionGroupId][4B consensusBranchId]...
 * NU5 branch ID in LE: B4 D0 D6 C2
 */
const NU5_BRANCH_ID_LE = [0xb4, 0xd0, 0xd6, 0xc2];
const patchBranchId = (buf: Uint8Array): void => {
  // only patch v5 transactions (header byte 0 = 0x05, byte 3 = 0x80 for fOverwintered)
  if (buf.length > 12 && buf[0] === 0x05 && buf[3] === 0x80) {
    buf[8] = NU5_BRANCH_ID_LE[0]!;
    buf[9] = NU5_BRANCH_ID_LE[1]!;
    buf[10] = NU5_BRANCH_ID_LE[2]!;
    buf[11] = NU5_BRANCH_ID_LE[3]!;
  }
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

// ── base58check decode (for transparent address → pubkey hash) ──

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const base58checkDecode = (addr: string): Uint8Array | null => {
  // decode base58 to bytes
  let num = 0n;
  for (const c of addr) {
    const idx = BASE58_ALPHABET.indexOf(c);
    if (idx < 0) return null;
    num = num * 58n + BigInt(idx);
  }
  // zcash t-addresses: 2-byte version + 20-byte hash + 4-byte checksum = 26 bytes
  const bytes = new Uint8Array(26);
  for (let i = 25; i >= 0; i--) {
    bytes[i] = Number(num & 0xffn);
    num >>= 8n;
  }
  // skip 2-byte version prefix, return 20-byte pubkey hash (ignore 4-byte checksum)
  return bytes.subarray(2, 22);
};

// ── parse transparent inputs/outputs from raw zcash v5 transaction ──

/** read a compactSize uint from buf at offset, returns [value, newOffset] */
const readCompactSize = (buf: Uint8Array, off: number): [number, number] => {
  const first = buf[off]!;
  if (first < 0xfd) return [first, off + 1];
  if (first === 0xfd) {
    return [buf[off + 1]! | (buf[off + 2]! << 8), off + 3];
  }
  if (first === 0xfe) {
    return [buf[off + 1]! | (buf[off + 2]! << 8) | (buf[off + 3]! << 16) | (buf[off + 4]! << 24), off + 5];
  }
  // 0xff — 8 byte, unlikely for tx counts
  return [0, off + 9];
};

/** read little-endian u64 as bigint */
const readU64LE = (buf: Uint8Array, off: number): bigint => {
  let v = 0n;
  for (let i = 0; i < 8; i++) v |= BigInt(buf[off + i]!) << BigInt(i * 8);
  return v;
};

/**
 * parse a zcash v5 transaction's transparent outputs to find amounts
 * matching our scripts (scriptPubKey hex strings in ourScripts set)
 *
 * returns total zatoshis received by our addresses
 */
const parseTransparentTx = (
  data: Uint8Array,
  ourScripts: Set<string>,
): bigint => {
  let received = 0n;
  let off = 0;

  // v5 tx format: https://zips.z.cash/zip-0225
  // header (4 bytes) + nVersionGroupId (4 bytes) + nConsensusBranchId (4 bytes)
  // + nLockTime (4 bytes) + nExpiryHeight (4 bytes)
  off += 4 + 4 + 4 + 4 + 4; // = 20 bytes header

  // transparent bundle
  const [nVin, vinOff] = readCompactSize(data, off);
  off = vinOff;

  // parse inputs — check scriptSig for our pubkey hash
  for (let i = 0; i < nVin; i++) {
    // prevout: txid(32) + index(4)
    off += 36;
    // scriptSig
    const [sigLen, sigOff] = readCompactSize(data, off);
    off = sigOff;
    // note: transparent inputs don't carry value — we can't determine sent amount
    // from the tx alone without looking up the referenced UTXOs
    off += sigLen;
    // nSequence
    off += 4;
  }

  // parse outputs
  const [nVout, voutOff] = readCompactSize(data, off);
  off = voutOff;

  for (let i = 0; i < nVout; i++) {
    // value: 8 bytes LE
    const value = readU64LE(data, off);
    off += 8;
    // scriptPubKey
    const [scriptLen, scriptOff] = readCompactSize(data, off);
    off = scriptOff;
    const scriptHex = hexEncode(data.subarray(off, off + scriptLen));
    const isOurs = ourScripts.has(scriptHex);
    if (isOurs) {
      received += value;
    }
    off += scriptLen;
  }

  return received;
};

// ── indexeddb ──
// single connection held open during sync, closed when idle

const DB_NAME = 'zafu-zcash';
const DB_VERSION = 3;

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
      if (!db.objectStoreNames.contains('memo-cache')) {
        db.createObjectStore('memo-cache');
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

const getActionsCommitment = async (walletId: string): Promise<string> => {
  const r = await idbGet<{ value: string }>('meta', [walletId, 'actionsCommitment']);
  return r?.value ?? '0'.repeat(64); // genesis: all zeros
};

const saveActionsCommitment = async (walletId: string, commitment: string): Promise<void> => {
  const db = await getDb();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ walletId, key: 'actionsCommitment', value: commitment });
  await txComplete(tx);
};

/** verify header proof + commitment proofs + nullifier proofs after sync catches up */
const verifySyncProofs = async (
  client: InstanceType<typeof import('../state/keyring/zidecar-client').ZidecarClient>,
  tip: number,
  mainnet: boolean,
  pendingCmxs: Uint8Array[],
  pendingPositions: number[],
  state: WalletState,
  actionsCommitment: string,
): Promise<void> => {
  if (!zyncModule) return;
  console.log(`[zcash-worker] verifying proofs: ${pendingCmxs.length} notes`);
  const t0 = performance.now();

  // 1. verify header proof
  const proven = await verifyHeaderProof(client, tip, mainnet);
  console.log(`[zcash-worker] header proof valid, roots: tree=${proven.tree_root.slice(0, 16)}...`);

  // 2. verify commitment proofs for found notes
  if (pendingCmxs.length > 0) {
    const { proofs, treeRoot } = await client.getCommitmentProofs(pendingCmxs, pendingPositions, tip);
    const treeRootHex = hexEncode(treeRoot);

    // bind server root to proven root
    if (treeRootHex !== proven.tree_root) {
      throw new Error(`commitment tree root mismatch: server=${treeRootHex.slice(0, 16)} proven=${proven.tree_root.slice(0, 16)}`);
    }

    // verify each proof
    for (const proof of proofs) {
      const valid = zyncModule['verify_commitment_proof'](
        hexEncode(proof.cmx),
        hexEncode(proof.treeRoot),
        proof.pathProofRaw,
        hexEncode(proof.valueHash),
      ) as boolean;
      if (!valid) {
        throw new Error(`commitment proof invalid for cmx ${hexEncode(proof.cmx).slice(0, 16)}`);
      }
    }
    console.log(`[zcash-worker] ${proofs.length} commitment proofs verified`);
  }

  // 3. verify nullifier proofs for unspent notes
  const unspentNfs = state.notes
    .filter(n => !state.spentNullifiers.has(n.nullifier))
    .map(n => hexDecode(n.nullifier));

  if (unspentNfs.length > 0) {
    const { proofs: nfProofs, nullifierRoot } = await client.getNullifierProofs(unspentNfs, tip);
    const nfRootHex = hexEncode(nullifierRoot);

    if (nfRootHex !== proven.nullifier_root) {
      throw new Error(`nullifier root mismatch: server=${nfRootHex.slice(0, 16)} proven=${proven.nullifier_root.slice(0, 16)}`);
    }

    let newlySpent = 0;
    for (const proof of nfProofs) {
      const valid = zyncModule['verify_nullifier_proof'](
        hexEncode(proof.nullifier),
        hexEncode(proof.nullifierRoot),
        proof.isSpent,
        proof.pathProofRaw,
        hexEncode(proof.valueHash),
      ) as boolean;
      if (!valid) {
        throw new Error(`nullifier proof invalid for ${hexEncode(proof.nullifier).slice(0, 16)}`);
      }
      if (proof.isSpent) {
        const nfHex = hexEncode(proof.nullifier);
        if (!state.spentNullifiers.has(nfHex)) {
          state.spentNullifiers.add(nfHex);
          newlySpent++;
        }
      }
    }
    console.log(`[zcash-worker] ${nfProofs.length} nullifier proofs verified (${newlySpent} newly spent)`);
  }

  // 4. verify actions commitment chain
  const hasSaved = actionsCommitment !== '0'.repeat(64);
  zyncModule['verify_actions_commitment'](actionsCommitment, proven.actions_commitment, hasSaved);
  console.log(`[zcash-worker] actions commitment verified`);

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`[zcash-worker] all proofs verified in ${elapsed}s`);
};

/** get cached orchard tree frontier from IDB */
const getTreeFrontier = async (walletId: string): Promise<string | null> => {
  const r = await idbGet<{ value: string }>('meta', [walletId, 'orchardTreeFrontier']);
  return r?.value ?? null;
};

/** batch-save notes + spent + sync height + tree size in one transaction */
const saveBatch = async (
  walletId: string,
  notes: DecryptedNote[],
  spent: string[],
  syncHeight: number,
  orchardTreeSize?: number,
  updatedNotes?: DecryptedNote[],
  orchardTreeFrontier?: string,
): Promise<void> => {
  const db = await getDb();
  const tx = db.transaction(['notes', 'spent', 'meta'], 'readwrite');
  const notesStore = tx.objectStore('notes');
  const spentStore = tx.objectStore('spent');
  const metaStore = tx.objectStore('meta');
  for (const note of notes) notesStore.put({ ...note, walletId });
  // re-save notes that were updated (e.g. spent_by_txid added)
  if (updatedNotes) {
    for (const note of updatedNotes) notesStore.put({ ...note, walletId });
  }
  for (const nf of spent) spentStore.put({ walletId, nullifier: nf });
  metaStore.put({ walletId, key: 'syncHeight', value: syncHeight });
  if (orchardTreeSize !== undefined) {
    metaStore.put({ walletId, key: 'orchardTreeSize', value: orchardTreeSize });
  }
  if (orchardTreeFrontier) {
    metaStore.put({ walletId, key: 'orchardTreeFrontier', value: orchardTreeFrontier });
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

// ── zync-core (verification) ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let zyncModule: Record<string, any> | null = null;

const initZync = async (): Promise<void> => {
  if (zyncModule) return;
  // @ts-expect-error dynamic import in worker
  const zync = await import(/* webpackIgnore: true */ '/zync-core/zync_core.js');
  await zync.default({ module_or_path: '/zync-core/zync_core_bg.wasm' });
  zync.wasm_init();
  zyncModule = zync;
  console.log('[zcash-worker] zync-core ready');
};

interface ProvenRoots {
  tree_root: string;
  nullifier_root: string;
  actions_commitment: string;
}

/** fetch and verify header proof from zidecar, returns proven NOMT roots */
const verifyHeaderProof = async (
  client: InstanceType<typeof import('../state/keyring/zidecar-client').ZidecarClient>,
  tip: number,
  mainnet: boolean,
): Promise<ProvenRoots> => {
  if (!zyncModule) throw new Error('zync-core not initialized');
  const { proofBytes } = await client.getHeaderProof();
  const json = zyncModule['verify_header_proof'](proofBytes, tip, mainnet) as string;
  return JSON.parse(json) as ProvenRoots;
};

// ── offscreen proving ──
// Halo 2 proving is CPU-intensive (~2min single-threaded). Route it through
// the offscreen document which has a persistent rayon thread pool, so MSM/FFT
// runs in parallel across all cores. The offscreen survives popup close.

interface ZcashBuildRequest {
  fn: 'build_signed_spend' | 'build_unsigned' | 'build_shielding' | 'build_unsigned_shielding';
  args: unknown[];
}

// pending prove requests waiting for parent (network-worker) to relay response
const pendingProveRequests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let proveRequestCounter = 0;

const proveViaOffscreen = async (req: ZcashBuildRequest): Promise<unknown> => {
  // web workers don't have chrome.runtime — relay through parent (network-worker/popup)
  // which has chrome APIs and can forward to service worker → offscreen document
  const id = `prove-${++proveRequestCounter}`;
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  pendingProveRequests.set(id, { resolve, reject });

  self.postMessage({
    type: 'prove-request',
    id,
    request: req,
  });

  return promise;
};

// handle prove responses from parent
self.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data;
  if (msg?.type === 'prove-response' && msg.id) {
    const pending = pendingProveRequests.get(msg.id);
    if (pending) {
      pendingProveRequests.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(msg.data);
      }
    }
  }
});

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


/**
 * Build merkle witnesses for spending notes.
 *
 * Strategy: use the cached tree frontier from sync (stored in IDB at the last
 * synced height). We only need to replay the gap between the cached frontier
 * height and the anchor height - typically <100 blocks instead of 100k+.
 *
 * Fallback: if no cached frontier, binary search for a checkpoint (slow path).
 */
const buildWitnesses = async (
  client: {
    getTreeState(h: number): Promise<{ height: number; orchardTree: string }>;
    getCompactBlocks(start: number, end: number): Promise<Array<{ height: number; actions: Array<{ cmx: Uint8Array }> }>>;
  },
  walletId: string,
  notes: DecryptedNote[],
  anchorHeight: number,
): Promise<{ anchorHex: string; paths: unknown[] }> => {
  if (!wasmModule) throw new Error('wasm not initialized');

  const positions = notes.map(n => n.position);
  console.log(`[zcash-worker] witness build: positions=${JSON.stringify(positions)}, anchor=${anchorHeight}`);

  // try cached frontier first (fast path: only replay gap blocks)
  let frontierHex: string | null = null;
  let frontierHeight = 0;

  const cachedFrontier = await getTreeFrontier(walletId);
  const cachedFrontierHeight = (await idbGet<{ value: number }>('meta', [walletId, 'orchardTreeFrontierHeight']))?.value ?? 0;

  if (cachedFrontier && cachedFrontierHeight > 0 && cachedFrontierHeight <= anchorHeight) {
    const cachedSize = Number(wasmModule.frontier_tree_size(cachedFrontier));
    const earliestPosition = Math.min(...positions);

    // the cached frontier must contain all note positions
    if (cachedSize > earliestPosition) {
      frontierHex = cachedFrontier;
      frontierHeight = cachedFrontierHeight;
      console.log(`[zcash-worker] using cached frontier: height=${frontierHeight}, size=${cachedSize}, gap=${anchorHeight - frontierHeight} blocks`);
    } else {
      console.log(`[zcash-worker] cached frontier too small (size=${cachedSize}, need>=${earliestPosition}), falling back to search`);
    }
  }

  // no cached frontier: fetch tree state at sync height (single RPC, no position leak)
  if (!frontierHex) {
    const syncHeight = (await idbGet<{ value: number }>('meta', [walletId, 'syncHeight']))?.value ?? 0;
    if (syncHeight > 0 && syncHeight <= anchorHeight) {
      console.log(`[zcash-worker] no cached frontier, fetching at sync height ${syncHeight}`);
      const ts = await client.getTreeState(syncHeight);
      frontierHex = ts.orchardTree;
      frontierHeight = syncHeight;

      // cache it for next time
      const db = await getDb();
      const metaTx = db.transaction('meta', 'readwrite');
      metaTx.objectStore('meta').put({ walletId, key: 'orchardTreeFrontier', value: frontierHex });
      metaTx.objectStore('meta').put({ walletId, key: 'orchardTreeFrontierHeight', value: frontierHeight });
      await txComplete(metaTx);
    } else {
      throw new Error('wallet must be synced before spending - no tree frontier available');
    }
  }

  const checkpointTreeSize = Number(wasmModule.frontier_tree_size(frontierHex));

  // replay blocks from frontier+1 to anchorHeight
  const replayStart = frontierHeight + 1;
  const compactBlocks: Array<{ height: number; actions: Array<{ cmx_hex: string }> }> = [];
  let totalActions = 0;

  if (replayStart <= anchorHeight) {
    let current = replayStart;
    while (current <= anchorHeight) {
      const end = Math.min(current + WITNESS_BATCH_SIZE - 1, anchorHeight);
      const blocks = await client.getCompactBlocks(current, end);
      for (const block of blocks) {
        totalActions += block.actions.length;
        compactBlocks.push({
          height: block.height,
          actions: block.actions.map(a => ({ cmx_hex: hexEncode(a.cmx) })),
        });
      }
      current = end + 1;
    }
  }

  console.log(`[zcash-worker] replayed ${compactBlocks.length} blocks, ${totalActions} actions (${replayStart}..${anchorHeight})`);

  // call witness WASM
  let resultRaw: unknown;
  try {
    resultRaw = wasmModule.build_merkle_paths(
      frontierHex,
      JSON.stringify(compactBlocks),
      JSON.stringify(positions),
      anchorHeight,
    );
  } catch (e) {
    console.error('[zcash-worker] build_merkle_paths failed:', e);
    throw e;
  }

  const result = JSON.parse(resultRaw as string) as { anchor_hex: string; paths: unknown[] };
  console.log(`[zcash-worker] merkle paths built, anchor=${result.anchor_hex}`);

  // verify anchor matches network
  const anchorTs = await client.getTreeState(anchorHeight);
  const networkRoot = wasmModule.tree_root_hex(anchorTs.orchardTree);
  if (result.anchor_hex !== networkRoot) {
    const networkSize = Number(wasmModule.frontier_tree_size(anchorTs.orchardTree));
    console.error(`[zcash-worker] root mismatch: ours=${result.anchor_hex}, network=${networkRoot}, replayed=${totalActions}, expected=${checkpointTreeSize + totalActions}, networkSize=${networkSize}`);
    throw new Error(`tree root mismatch at height ${anchorHeight}`);
  }

  return { anchorHex: result.anchor_hex, paths: result.paths };
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

  // initialize zync-core for verification
  try {
    await initZync();
  } catch (e) {
    console.warn('[zcash-worker] zync-core init failed, syncing without verification:', e);
  }

  // emit initial sync-progress so UI gets persisted height + can fetch balance immediately
  workerSelf.postMessage({
    type: 'sync-progress', id: '', network: 'zcash', walletId,
    payload: { currentHeight, chainHeight: currentHeight, notesFound: state.notes.length, blocksScanned: 0 },
  });

  state.syncing = true;
  state.syncAbort = false;
  let consecutiveErrors = 0;

  // running actions commitment for integrity verification
  let actionsCommitment = await getActionsCommitment(walletId);
  // notes found since last header proof verification
  const pendingCmxs: Uint8Array[] = [];
  const pendingPositions: number[] = [];

  while (!state.syncAbort) {
    try {
      const tip = await client.getTip();
      const chainHeight = tip.height;

      if (currentHeight >= chainHeight) {
        // caught up: cache the tree frontier at sync height for fast witness building
        try {
          const syncTs = await client.getTreeState(currentHeight);
          const db = await getDb();
          const metaTx = db.transaction('meta', 'readwrite');
          metaTx.objectStore('meta').put({ walletId, key: 'orchardTreeFrontier', value: syncTs.orchardTree });
          metaTx.objectStore('meta').put({ walletId, key: 'orchardTreeFrontierHeight', value: currentHeight });
          await txComplete(metaTx);
          console.log(`[zcash-worker] cached tree frontier at height ${currentHeight}`);
        } catch (e) {
          console.warn('[zcash-worker] failed to cache tree frontier:', e);
        }

        // verify proofs if we have pending notes and zync-core
        if (zyncModule && pendingCmxs.length > 0) {
          try {
            await verifySyncProofs(client, tip.height, true, pendingCmxs, pendingPositions, state, actionsCommitment);
            pendingCmxs.length = 0;
            pendingPositions.length = 0;
          } catch (e) {
            console.error('[zcash-worker] proof verification failed:', e);
          }
        }

        // scan mempool for pending incoming/spends
        try {
          const mempoolBlocks = await client.getMempoolStream();
          let mempoolActions = 0;
          for (const mb of mempoolBlocks) mempoolActions += mb.actions.length;

          if (mempoolActions > 0 && state.keys) {
            // build binary buffer for trial decryption (same format as block scanning)
            const ACTION_SIZE = 32 + 32 + 32 + 52;
            const mbuf = new Uint8Array(4 + mempoolActions * ACTION_SIZE);
            const mview = new DataView(mbuf.buffer);
            mview.setUint32(0, mempoolActions, true);
            let moff = 4;

            // collect mempool nullifiers for spend detection
            const mempoolNullifiers = new Map<string, string>(); // nfHex -> txidHex

            for (const mb of mempoolBlocks) {
              const txidHex = hexEncode(mb.hash); // hash = txid for mempool blocks
              for (const a of mb.actions) {
                if (a.nullifier.length === 32) mbuf.set(a.nullifier, moff); moff += 32;
                if (a.cmx.length === 32) mbuf.set(a.cmx, moff); moff += 32;
                if (a.ephemeralKey.length === 32) mbuf.set(a.ephemeralKey, moff); moff += 32;
                if (a.ciphertext.length >= 52) mbuf.set(a.ciphertext.subarray(0, 52), moff); moff += 52;
                mempoolNullifiers.set(hexEncode(a.nullifier), txidHex);
              }
            }

            // trial decrypt mempool actions
            const pendingIncoming: Array<{ value: string; txid: string; isChange: boolean }> = [];
            const pendingSpends: Array<{ nullifier: string; txid: string }> = [];

            try {
              const found = state.keys.scan_actions_parallel(mbuf);
              for (const note of found) {
                pendingIncoming.push({
                  value: note.value,
                  txid: note.cmx, // use cmx as identifier since no confirmed txid yet
                  isChange: note.is_change ?? false,
                });
              }
            } catch (err) {
              console.log('[zcash-worker] mempool scan decrypt error:', err);
            }

            // check if any wallet nullifiers appear in mempool (pending spends)
            for (const note of state.notes) {
              if (!state.spentNullifiers.has(note.nullifier) && mempoolNullifiers.has(note.nullifier)) {
                pendingSpends.push({
                  nullifier: note.nullifier,
                  txid: mempoolNullifiers.get(note.nullifier)!,
                });
              }
            }

            if (pendingIncoming.length > 0 || pendingSpends.length > 0) {
              console.log(`[zcash-worker] mempool: ${pendingIncoming.length} incoming, ${pendingSpends.length} pending spends`);
              workerSelf.postMessage({
                type: 'mempool-update', id: '', network: 'zcash', walletId,
                payload: { pendingIncoming, pendingSpends },
              });
            }
          }
        } catch (e) {
          // mempool scan is best-effort, don't break the sync loop
          console.log('[zcash-worker] mempool scan skipped:', e);
        }

        workerSelf.postMessage({
          type: 'sync-progress', id: '', network: 'zcash', walletId,
          payload: { currentHeight, chainHeight, notesFound: state.notes.length, blocksScanned: 0 },
        });
        await new Promise(r => setTimeout(r, 10000));
        continue;
      }

      // 200 blocks per batch - balances memory vs RPC overhead
      const batchSize = 200;
      const endHeight = Math.min(currentHeight + batchSize, chainHeight);

      // prefetch: start fetching this batch while previous iteration's IDB write completes
      console.log(`[zcash-worker] blocks ${currentHeight + 1}..${endHeight}`);
      const blocks = await client.getCompactBlocks(currentHeight + 1, endHeight);

      // single-pass: count actions, build lookups, pack binary buffer, and compute
      // actions commitment all in one iteration over blocks
      const cmxToTxid = new Map<string, string>();
      const cmxToHeight = new Map<string, number>();
      const nfToTxid = new Map<string, string>();
      const nfToHeight = new Map<string, number>();
      const actionNullifiers = new Set<string>();
      let actionCount = 0;
      for (const block of blocks) actionCount += block.actions.length;

      const ACTION_SIZE = 32 + 32 + 32 + 52;
      const newNotes: DecryptedNote[] = [];
      const newSpent: string[] = [];
      let spentUpdatedNotes: DecryptedNote[] = [];

      if (actionCount > 0 && state.keys) {
        // single allocation for scan buffer
        const buf = new Uint8Array(4 + actionCount * ACTION_SIZE);
        const view = new DataView(buf.buffer);
        view.setUint32(0, actionCount, true);
        let off = 4;

        // actions commitment buffer: reuse across blocks (max action count per block)
        let commitBuf: Uint8Array | null = null;
        let commitView: DataView | null = null;

        for (const block of blocks) {
          // compute actions commitment inline (single pass, no second iteration)
          if (zyncModule) {
            if (block.actions.length > 0) {
              const needed = 4 + block.actions.length * 96;
              if (!commitBuf || commitBuf.length < needed) {
                commitBuf = new Uint8Array(needed);
                commitView = new DataView(commitBuf.buffer);
              }
              commitView!.setUint32(0, block.actions.length, true);
              let aoff = 4;
              for (const a of block.actions) {
                commitBuf.set(a.cmx, aoff); aoff += 32;
                commitBuf.set(a.nullifier, aoff); aoff += 32;
                commitBuf.set(a.ephemeralKey, aoff); aoff += 32;
              }
              const actionsRoot = zyncModule['compute_actions_root'](commitBuf.subarray(0, needed)) as string;
              actionsCommitment = zyncModule['update_actions_commitment'](
                actionsCommitment, actionsRoot, block.height,
              ) as string;
            } else {
              actionsCommitment = zyncModule['update_actions_commitment'](
                actionsCommitment, '0'.repeat(64), block.height,
              ) as string;
            }
          }

          for (const a of block.actions) {
            // pack binary for WASM scan
            if (a.nullifier.length === 32) buf.set(a.nullifier, off); off += 32;
            if (a.cmx.length === 32) buf.set(a.cmx, off); off += 32;
            if (a.ephemeralKey.length === 32) buf.set(a.ephemeralKey, off); off += 32;
            if (a.ciphertext.length >= 52) buf.set(a.ciphertext.subarray(0, 52), off); off += 52;
            // build lookups (single pass with binary packing)
            const cmxHex = hexEncode(a.cmx);
            const nfHex = hexEncode(a.nullifier);
            const txidHex = hexEncode(a.txid);
            cmxToTxid.set(cmxHex, txidHex);
            cmxToHeight.set(cmxHex, block.height);
            nfToTxid.set(nfHex, txidHex);
            nfToHeight.set(nfHex, block.height);
            actionNullifiers.add(nfHex);
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
          const full: DecryptedNote = { ...note, position, txid: cmxToTxid.get(note.cmx) ?? '', height: cmxToHeight.get(note.cmx) ?? 0 };
          console.log(`[zcash-worker] found note: value=${note.value}, pos=${position}, hasRseed=${!!note.rseed}, hasRho=${!!note.rho}, hasRecipient=${!!(note as unknown as { recipient?: string }).recipient}`);
          newNotes.push(full);
          state.notes.push(full);

          // track for verification
          pendingCmxs.push(hexDecode(note.cmx));
          pendingPositions.push(position);
        }

        // detect spent notes: check if any action nullifier matches an owned note's nullifier
        spentUpdatedNotes = [];
        for (const note of state.notes) {
          if (!state.spentNullifiers.has(note.nullifier) && actionNullifiers.has(note.nullifier)) {
            state.spentNullifiers.add(note.nullifier);
            // record which txid spent this note and at which height
            note.spent_by_txid = nfToTxid.get(note.nullifier) ?? '';
            note.spent_at_height = nfToHeight.get(note.nullifier) ?? 0;
            newSpent.push(note.nullifier);
            spentUpdatedNotes.push(note);
          }
        }
      }

      // advance tree size by total actions in this batch
      orchardTreeSize += actionCount;

      // single batched db write for entire batch
      currentHeight = endHeight;
      await saveBatch(walletId, newNotes, newSpent, currentHeight, orchardTreeSize, spentUpdatedNotes.length > 0 ? spentUpdatedNotes : undefined);

      // persist actions commitment
      if (zyncModule) {
        await saveActionsCommitment(walletId, actionsCommitment);
      }

      workerSelf.postMessage({
        type: 'sync-progress', id: '', network: 'zcash', walletId,
        payload: { currentHeight, chainHeight, notesFound: state.notes.length, blocksScanned: blocks.length },
      });

      consecutiveErrors = 0;

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

const getBalance = async (walletId: string): Promise<bigint> => {
  // always load from IDB — in-memory state may be stale after rescan
  const state = await loadState(walletId);
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
        const balance = await getBalance(walletId);
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
        const notesWithSpent = noteState.notes.map(n => ({
          ...n,
          spent: noteState.spentNullifiers.has(n.nullifier),
        }));
        workerSelf.postMessage({ type: 'notes', id, network: 'zcash', walletId, payload: notesWithSpent });
        return;
      }

      case 'note-sync-encode': {
        // Build CBOR notes bundle with merkle paths, encode as UR frames
        if (!walletId) throw new Error('walletId required');
        if (!wasmModule) throw new Error('wasm not initialized');
        const { mainnet: isMainnet, serverUrl: syncServerUrl } = payload as { mainnet: boolean; serverUrl: string };
        const syncState = await loadState(walletId);
        const unspent = syncState.notes.filter(n => !syncState.spentNullifiers.has(n.nullifier));
        if (unspent.length === 0) {
          workerSelf.postMessage({ type: 'note-sync-encoded', id, network: 'zcash', walletId, payload: { frames: [], noteCount: 0, balance: '0', cborBytes: 0 } });
          return;
        }

        const anchorHeight = Math.max(...unspent.map(n => n.height));

        // build merkle witnesses
        const client = {
          getTreeState: async (h: number) => {
            const resp = await fetch(`${syncServerUrl}/tree-state/${h}`);
            if (!resp.ok) throw new Error(`tree-state ${h}: ${resp.status}`);
            return resp.json() as Promise<{ height: number; orchardTree: string }>;
          },
          getCompactBlocks: async (start: number, end: number) => {
            const resp = await fetch(`${syncServerUrl}/compact-blocks/${start}/${end}`);
            if (!resp.ok) throw new Error(`compact-blocks ${start}-${end}: ${resp.status}`);
            return resp.json() as Promise<Array<{ height: number; actions: Array<{ cmx: Uint8Array }> }>>;
          },
        };
        const witnessResult = await buildWitnesses(client, walletId, unspent, anchorHeight);

        // prepare notes JSON for WASM encoder
        const notesJson = JSON.stringify(unspent.map(n => ({
          value: Number(n.value),
          nullifier: n.nullifier,
          cmx: n.cmx,
          position: n.position,
          block_height: n.height,
        })));

        // buildWitnesses returns { anchorHex, paths } but WASM expects { anchor_hex, paths }
        const merkleJson = JSON.stringify({
          anchor_hex: witnessResult.anchorHex,
          paths: witnessResult.paths,
        });

        // encode to CBOR via WASM
        const cborBytes = wasmModule.encode_notes_bundle(
          notesJson,
          merkleJson,
          anchorHeight,
          isMainnet,
          null, // no attestation (TODO: FROST attestation)
        );

        // encode to QR frames via WASM
        // use zoda transport (verified erasure coding) — 12-of-16 for redundancy
        const framesJson = wasmModule.zt_encode_frames(cborBytes, 'zcash-notes', 12, 16);
        const urFrames = JSON.parse(framesJson) as string[];

        // compute balance
        let balance = 0n;
        for (const n of unspent) balance += BigInt(n.value);

        workerSelf.postMessage({
          type: 'note-sync-encoded',
          id,
          network: 'zcash',
          walletId,
          payload: {
            frames: urFrames,
            noteCount: unspent.length,
            balance: balance.toString(),
            cborBytes: cborBytes.length,
          },
        });
        return;
      }

      case 'decrypt-memos': {
        if (!walletId) throw new Error('walletId required');
        const memoState = walletStates.get(walletId);
        if (!memoState?.keys) throw new Error('wallet keys not loaded');
        const { txBytes } = payload as { txBytes: number[] };
        const txBuf = new Uint8Array(txBytes);
        // patch consensus branch ID to NU5 (0xC2D6D0B4) so older zcash_primitives can parse it
        // v5 tx layout: [4B header][4B versionGroupId][4B consensusBranchId]...
        // the v5 structure is identical across NU5/NU6/NU7, only the branch ID differs
        patchBranchId(txBuf);
        const memos = memoState.keys.decrypt_transaction_memos(txBuf);
        workerSelf.postMessage({ type: 'memos', id, network: 'zcash', walletId, payload: memos });
        return;
      }

      case 'get-transparent-history': {
        const { serverUrl, tAddresses } = payload as { serverUrl: string; tAddresses: string[] };
        if (!tAddresses?.length) {
          workerSelf.postMessage({ type: 'transparent-history', id, network: 'zcash', payload: [] });
          return;
        }

        const { ZidecarClient } = await import(/* webpackMode: "eager" */ '../state/keyring/zidecar-client');
        const tClient = new ZidecarClient(serverUrl);

        // build script set for our addresses (p2pkh: OP_DUP OP_HASH160 <20> <hash> OP_EQUALVERIFY OP_CHECKSIG)
        const ourScripts = new Set<string>();
        for (const addr of tAddresses) {
          const decoded = base58checkDecode(addr);
          if (decoded) {
            ourScripts.add('76a914' + hexEncode(decoded) + '88ac');
          }
        }

        const txids = await tClient.getTaddressTxids(tAddresses);

        // fetch raw txs in parallel (concurrency-limited to avoid overwhelming server)
        const CONCURRENCY = 5;
        const history: Array<{ txid: string; height: number; received: string }> = [];

        for (let i = 0; i < txids.length; i += CONCURRENCY) {
          const batch = txids.slice(i, i + CONCURRENCY);
          const results = await Promise.allSettled(
            batch.map(async (txidBytes) => {
              const rawTx = await tClient.getTransaction(txidBytes);
              const parsed = parseTransparentTx(rawTx.data, ourScripts);
              return {
                txid: hexEncode(txidBytes),
                height: rawTx.height,
                received: parsed.toString(),
              };
            }),
          );
          for (const r of results) {
            if (r.status === 'fulfilled') history.push(r.value);
          }
        }

        workerSelf.postMessage({ type: 'transparent-history', id, network: 'zcash', payload: history });
        return;
      }

      case 'get-history': {
        if (!walletId) throw new Error('walletId required');
        const { serverUrl: histServerUrl, tAddresses: histTAddresses } = payload as { serverUrl: string; tAddresses: string[] };

        // load shielded notes from IDB
        const histState = await loadState(walletId);
        const histNotes = histState.notes.map(n => ({
          ...n,
          spent: histState.spentNullifiers.has(n.nullifier),
        }));

        // fetch transparent history
        const tHistory: Array<{ txid: string; height: number; received: string }> = [];
        if (histTAddresses?.length) {
          try {
            const { ZidecarClient } = await import(/* webpackMode: "eager" */ '../state/keyring/zidecar-client');
            const tClient = new ZidecarClient(histServerUrl);

            const ourScripts = new Set<string>();
            for (const addr of histTAddresses) {
              const decoded = base58checkDecode(addr);
              if (decoded) {
                ourScripts.add('76a914' + hexEncode(decoded) + '88ac');
              }
            }

            const txids = await tClient.getTaddressTxids(histTAddresses);
            const CONCURRENCY = 5;
            for (let i = 0; i < txids.length; i += CONCURRENCY) {
              const batch = txids.slice(i, i + CONCURRENCY);
              const results = await Promise.allSettled(
                batch.map(async (txidBytes) => {
                  const rawTx = await tClient.getTransaction(txidBytes);
                  const parsed = parseTransparentTx(rawTx.data, ourScripts);
                  return {
                    txid: hexEncode(txidBytes),
                    height: rawTx.height,
                    received: parsed.toString(),
                  };
                }),
              );
              for (const r of results) {
                if (r.status === 'fulfilled') tHistory.push(r.value);
              }
            }
          } catch (e) {
            console.warn('[zcash-worker] get-history: transparent history failed:', e);
          }
        }

        // build maps for sent amount calculation
        const histTxMap = new Map<string, { height: number; position: number; changeValue: bigint; receiveValue: bigint; isChange: boolean }>();
        const histSpentByMap = new Map<string, bigint>();

        for (const note of histNotes) {
          if (note.spent && note.spent_by_txid) {
            const prev = histSpentByMap.get(note.spent_by_txid) ?? 0n;
            histSpentByMap.set(note.spent_by_txid, prev + BigInt(note.value));
          }

          const existing = histTxMap.get(note.txid);
          if (existing) {
            existing.position = Math.max(existing.position, note.position ?? 0);
            if (note.is_change) {
              existing.isChange = true;
              existing.changeValue += BigInt(note.value);
            } else {
              existing.receiveValue += BigInt(note.value);
            }
          } else {
            histTxMap.set(note.txid, {
              height: note.height ?? 0,
              position: note.position ?? 0,
              changeValue: note.is_change ? BigInt(note.value) : 0n,
              receiveValue: note.is_change ? 0n : BigInt(note.value),
              isChange: !!note.is_change,
            });
          }
        }

        // build result array (amounts as zatoshi strings)
        const histTxs: Array<{ id: string; height: number; type: string; amount: string; asset: string }> = [];
        for (const [txid, info] of histTxMap) {
          const isSend = info.isChange;
          let amount: bigint;
          if (isSend) {
            const inputTotal = histSpentByMap.get(txid) ?? 0n;
            if (inputTotal > 0n) {
              amount = inputTotal - info.changeValue;
            } else {
              amount = info.changeValue;
            }
          } else {
            amount = info.receiveValue;
          }
          histTxs.push({
            id: txid,
            height: info.height || info.position,
            type: isSend ? 'send' : 'receive',
            amount: amount.toString(),
            asset: 'ZEC',
          });
        }

        // merge transparent history
        const seenTxids = new Map(histTxs.map((tx, i) => [tx.id, i]));
        for (const tTx of tHistory) {
          const existingIdx = seenTxids.get(tTx.txid);
          if (existingIdx !== undefined) {
            histTxs[existingIdx]!.type = 'shield';
            continue;
          }
          const receivedZat = BigInt(tTx.received);
          if (receivedZat > 0n) {
            histTxs.push({
              id: tTx.txid,
              height: tTx.height,
              type: 'receive',
              amount: receivedZat.toString(),
              asset: 'ZEC',
            });
          }
        }

        // sort by height descending (newest first)
        histTxs.sort((a, b) => b.height - a.height);

        workerSelf.postMessage({ type: 'history', id, network: 'zcash', walletId, payload: histTxs });
        return;
      }

      case 'sync-memos': {
        if (!walletId) throw new Error('walletId required');
        const { serverUrl: memoServerUrl, existingTxIds, forceResync } = payload as {
          serverUrl: string; existingTxIds: string[]; forceResync: boolean;
        };

        const memoState = await loadState(walletId);
        const memoKeys = walletStates.get(walletId)?.keys;
        if (!memoKeys) throw new Error('wallet keys not loaded');

        const memoNotes = memoState.notes.map(n => ({
          ...n,
          spent: memoState.spentNullifiers.has(n.nullifier),
        }));

        if (memoNotes.length === 0) {
          workerSelf.postMessage({ type: 'memos-result', id, network: 'zcash', walletId, payload: [] });
          return;
        }

        // load persisted set of note txids already scanned (no memo found)
        const db = await getDb();
        const scannedKey = `${walletId}:scanned-txids`;
        const scannedTxids: Set<string> = await new Promise(resolve => {
          const tx = db.transaction('memo-cache', 'readonly');
          const req = tx.objectStore('memo-cache').get(scannedKey);
          req.onsuccess = () => resolve(new Set(req.result as string[] ?? []));
          req.onerror = () => resolve(new Set());
        });

        // filter notes not yet processed
        const processedTxids = new Set([...existingTxIds, ...scannedTxids]);
        const notesToProcess = memoNotes.filter(n => n.txid && !processedTxids.has(n.txid));
        // also check spent_by_txids that haven't been processed
        const unprocessedSpent = memoNotes.some(n => n.spent_by_txid && !processedTxids.has(n.spent_by_txid));
        if (notesToProcess.length === 0 && !unprocessedSpent) {
          workerSelf.postMessage({ type: 'memos-result', id, network: 'zcash', walletId, payload: [] });
          return;
        }

        // group notes by block height (received notes)
        const notesByHeight = new Map<number, typeof notesToProcess>();
        for (const note of notesToProcess) {
          const existing = notesByHeight.get(note.height) ?? [];
          existing.push(note);
          notesByHeight.set(note.height, existing);
        }

        // collect heights where notes were spent (for sent memo detection via OVK)
        // build txid→height map from all notes (change notes share txid with spending tx)
        const txidToHeight = new Map<string, number>();
        for (const note of memoNotes) {
          if (note.txid) txidToHeight.set(note.txid, note.height);
        }

        const spentHeights = new Set<number>();
        const spentTxIds = new Map<number, Set<string>>(); // height → spent_by_txids
        for (const note of memoNotes) {
          if (!note.spent_by_txid || processedTxids.has(note.spent_by_txid)) continue;
          const h = note.spent_at_height || txidToHeight.get(note.spent_by_txid);
          if (h) {
            spentHeights.add(h);
            let set = spentTxIds.get(h);
            if (!set) { set = new Set(); spentTxIds.set(h, set); }
            set.add(note.spent_by_txid);
          }
        }

        // determine which buckets we need
        const BUCKET_SIZE = 100;
        const ORCHARD_ACTIVATION_HEIGHT = 1687104;
        const NOISE_BUCKET_RATIO = 2;
        const FETCH_CONCURRENCY = 4;

        const getBucketStart = (h: number) => Math.floor(h / BUCKET_SIZE) * BUCKET_SIZE;

        const bucketSet = new Set<number>();
        for (const height of notesByHeight.keys()) {
          bucketSet.add(getBucketStart(height));
        }
        for (const height of spentHeights) {
          bucketSet.add(getBucketStart(height));
        }

        // check memo-cache in IDB (db already opened above)
        const isBucketCached = (bucketStart: number): Promise<boolean> =>
          new Promise(resolve => {
            const tx = db.transaction('memo-cache', 'readonly');
            const req = tx.objectStore('memo-cache').get(`${walletId}:${bucketStart}`);
            req.onsuccess = () => resolve(req.result !== undefined);
            req.onerror = () => resolve(false);
          });
        const markBucketCached = (bucketStart: number): Promise<void> =>
          new Promise((resolve, reject) => {
            const tx = db.transaction('memo-cache', 'readwrite');
            const req = tx.objectStore('memo-cache').put(Date.now(), `${walletId}:${bucketStart}`);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
          });

        // clear cache on force resync
        if (forceResync) {
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('memo-cache', 'readwrite');
            const store = tx.objectStore('memo-cache');
            const req = store.openCursor();
            req.onsuccess = () => {
              const cursor = req.result;
              if (cursor) {
                if ((cursor.key as string).startsWith(`${walletId}:`)) cursor.delete();
                cursor.continue();
              } else resolve();
            };
            req.onerror = () => reject(req.error);
          });
        }

        // buckets containing spent heights must always be fetched (for OVK decryption)
        const spentBucketSet = new Set<number>();
        for (const h of spentHeights) spentBucketSet.add(getBucketStart(h));

        const allBuckets = Array.from(bucketSet).sort((a, b) => a - b);
        const uncachedBuckets: number[] = [];
        const cachedBucketSet = new Set<number>();
        for (const bucket of allBuckets) {
          if (spentBucketSet.has(bucket)) {
            // always re-fetch spent buckets for OVK decryption
            uncachedBuckets.push(bucket);
          } else if (!forceResync && await isBucketCached(bucket)) {
            cachedBucketSet.add(bucket);
          } else {
            uncachedBuckets.push(bucket);
          }
        }

        if (uncachedBuckets.length === 0) {
          workerSelf.postMessage({ type: 'memos-result', id, network: 'zcash', walletId, payload: [] });
          return;
        }

        // generate noise buckets
        const { ZidecarClient: MemoZidecarClient } = await import(/* webpackMode: "eager" */ '../state/keyring/zidecar-client');
        const memoClient = new MemoZidecarClient(memoServerUrl);
        const { height: currentTip } = await memoClient.getTip();

        // estimate block time from tip (no per-height GetBlock calls — preserves bucket privacy)
        const tipTimeMs = Date.now();
        const estimateBlockTimeMs = (h: number): number =>
          tipTimeMs + (h - currentTip) * 75000;

        const noiseCount = uncachedBuckets.length * NOISE_BUCKET_RATIO;
        const noiseBuckets: number[] = [];
        const realSet = new Set(uncachedBuckets);
        const minBucket = getBucketStart(ORCHARD_ACTIVATION_HEIGHT);
        const maxBucket = getBucketStart(currentTip);
        const bucketRange = (maxBucket - minBucket) / BUCKET_SIZE;

        const noiseBucketSet = new Set<number>();
        if (bucketRange >= noiseCount * 2) {
          const randomBytes = new Uint32Array(noiseCount * 2);
          crypto.getRandomValues(randomBytes);
          for (let i = 0; i < randomBytes.length && noiseBuckets.length < noiseCount; i++) {
            const bucketIndex = randomBytes[i]! % bucketRange;
            const bucket = minBucket + bucketIndex * BUCKET_SIZE;
            if (realSet.has(bucket) || cachedBucketSet.has(bucket) || noiseBucketSet.has(bucket)) continue;
            noiseBuckets.push(bucket);
            noiseBucketSet.add(bucket);
          }
        }

        // shuffle real + noise buckets
        const allFetchBuckets = [...uncachedBuckets, ...noiseBuckets];
        {
          const rnd = new Uint32Array(allFetchBuckets.length);
          crypto.getRandomValues(rnd);
          for (let i = allFetchBuckets.length - 1; i > 0; i--) {
            const j = rnd[i]! % (i + 1);
            [allFetchBuckets[i], allFetchBuckets[j]] = [allFetchBuckets[j]!, allFetchBuckets[i]!];
          }
        }

        // process buckets sequentially to avoid race conditions on processedTxids
        const results: Array<{ txId: string; blockHeight: number; timestamp: number; content: string; direction: string; amount: string; memoBytes?: string; diversifierIndex?: number }> = [];
        const totalBuckets = allFetchBuckets.length;

        for (let i = 0; i < allFetchBuckets.length; i += FETCH_CONCURRENCY) {
          const batch = allFetchBuckets.slice(i, i + FETCH_CONCURRENCY);

          // fetch all blocks in parallel (network I/O)
          const batchResults = await Promise.all(batch.map(async (bucketStart) => {
            const isNoise = noiseBucketSet.has(bucketStart);
            const bucketEnd = Math.min(bucketStart + BUCKET_SIZE - 1, currentTip);
            let hadError = false;

            const blockData: Array<{ height: number; txs: Array<{ data: Uint8Array }> }> = [];
            for (let height = bucketStart; height <= bucketEnd; height++) {
              try {
                const { txs } = await memoClient.getBlockTransactions(height);
                if (!isNoise) blockData.push({ height, txs });
              } catch (err) {
                if (!isNoise) {
                  hadError = true;
                  console.error(`[zcash-worker] memo: failed block ${height}:`, err);
                }
              }
            }

            return { bucketStart, isNoise, blockData, hadError };
          }));

          // process results sequentially (no race on processedTxids)
          for (const { bucketStart, isNoise, blockData, hadError } of batchResults) {
            if (isNoise) continue;

            for (const { height, txs } of blockData) {
              const heightNotes = notesByHeight.get(height);
              const isSpentHeight = spentHeights.has(height);
              if ((!heightNotes || heightNotes.length === 0) && !isSpentHeight) continue;

              const cmxSet = new Set(heightNotes?.map(n => n.cmx) ?? []);

              for (const { data: txBytes } of txs) {
                if (txBytes.length < 200) continue;

                const txBuf = new Uint8Array(txBytes);
                patchBranchId(txBuf);
                const foundMemos = memoKeys.decrypt_transaction_memos(txBuf);

                for (const memo of foundMemos) {
                  // structured binary memos (0xF6 prefix) are handled separately
                  // check if this is a zafu structured binary memo (0xFF 0x5A magic)
                  const memoRawHex = memo.memo_bytes || '';
                  const isStructured = memoRawHex.length === 1024 && memoRawHex.startsWith('ff5a');
                  if (!isStructured && (!memo.memo_is_text || !memo.memo.trim())) continue;

                  if (memo.is_outgoing) {
                    const heightTxIds = spentTxIds.get(height);
                    if (heightTxIds) {
                      for (const spentTxId of heightTxIds) {
                        if (!processedTxids.has(spentTxId)) {
                          results.push({
                            txId: spentTxId,
                            blockHeight: height,
                            timestamp: estimateBlockTimeMs(height),
                            content: memo.memo,
                            direction: 'sent',
                            amount: (memo.value / 100_000_000).toFixed(8),
                            memoBytes: isStructured ? memoRawHex : undefined,
                          });
                          processedTxids.add(spentTxId);
                        }
                      }
                    }
                  } else {
                    if (!cmxSet.has(memo.cmx)) continue;
                    const matchingNote = heightNotes?.find(n => n.cmx === memo.cmx);
                    if (!matchingNote) continue;
                    if (processedTxids.has(matchingNote.txid)) continue;

                    results.push({
                      txId: matchingNote.txid,
                      blockHeight: height,
                      timestamp: estimateBlockTimeMs(height),
                      content: memo.memo,
                      direction: 'received',
                      amount: (memo.value / 100_000_000).toFixed(8),
                      memoBytes: isStructured ? memoRawHex : undefined,
                    });
                    processedTxids.add(matchingNote.txid);
                  }
                }
              }
            }

            // only cache bucket if no blocks errored
            if (!hadError) {
              await markBucketCached(bucketStart);
            }
          }

          workerSelf.postMessage({
            type: 'sync-memos-progress', id: '', network: 'zcash', walletId,
            payload: { current: Math.min(i + FETCH_CONCURRENCY, totalBuckets), total: totalBuckets },
          });
        }

        // persist all scanned note txids + spent_by_txids so we don't re-scan next time
        const allScanned = new Set(scannedTxids);
        for (const n of notesToProcess) if (n.txid) allScanned.add(n.txid);
        for (const n of memoNotes) if (n.spent_by_txid) allScanned.add(n.spent_by_txid);
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('memo-cache', 'readwrite');
          const req = tx.objectStore('memo-cache').put([...allScanned], scannedKey);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });

        workerSelf.postMessage({ type: 'memos-result', id, network: 'zcash', walletId, payload: results });
        return;
      }

      case 'send-tx': {
        if (!walletId) throw new Error('walletId required');
        await initWasm();
        if (!wasmModule) throw new Error('wasm not initialized');

        const sendPayload = payload as {
          serverUrl: string; recipient: string; amount: string; memo: string;
          accountIndex: number; mainnet: boolean;
          mnemonic?: string; ufvk?: string;
        };

        // encode memo to hex for WASM:
        // - if already hex (starts with ff5a = zafu structured memo), pass through
        // - if plain text, encode as UTF-8 bytes → hex
        // - if empty, null (WASM uses all-zero memo)
        let memoHex: string | null = null;
        if (sendPayload.memo) {
          if (/^[0-9a-f]+$/i.test(sendPayload.memo) && sendPayload.memo.startsWith('ff5a')) {
            memoHex = sendPayload.memo;
          } else {
            const bytes = new TextEncoder().encode(sendPayload.memo);
            memoHex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
          }
        }

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
          sendClient, walletId, selected, sendTip.height,
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
          const pathsResult = paths as Array<{ position: number; path: Array<{ hash: string }> }>;
          const merklePathsForWasm = pathsResult.map(p => ({
            path: p.path.map(e => e.hash),
            position: p.position,
          }));

          emitProgress('building & proving transaction (halo2, parallel)', `${selected.length} spends`);
          const proveStart = performance.now();
          // keep the clock ticking during proving so the UI doesn't look frozen
          const provingTicker = setInterval(() => {
            const elapsed = ((performance.now() - proveStart) / 1000).toFixed(0);
            emitProgress('proving (halo2)', `${elapsed}s elapsed`);
          }, 2000);

          let txHex: string;
          try {
            txHex = await proveViaOffscreen({
              fn: 'build_signed_spend',
              args: [
                sendPayload.mnemonic, notesJson, sendPayload.recipient,
                amountZat.toString(), fee.toString(), anchorHex,
                merklePathsForWasm, sendPayload.accountIndex, sendPayload.mainnet,
                memoHex,
              ],
            }) as string;
          } catch (e) {
            console.error('[zcash-worker] build_signed_spend_transaction failed:', e);
            throw e;
          } finally {
            clearInterval(provingTicker);
          }

          const proveDuration = ((performance.now() - proveStart) / 1000).toFixed(1);
          emitProgress('transaction proved', `${proveDuration}s, ${txHex.length / 2} bytes`);

          // broadcast
          emitProgress('broadcasting transaction');
          const txData = hexDecode(txHex);
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

        // zigner wallet: build unsigned transaction for cold signing (real v5 tx bytes)
        if (!sendPayload.ufvk) {
          throw new Error('UFVK required for zigner wallet send');
        }

        emitProgress('building & proving unsigned transaction (halo2)', `${selected.length} spends`);
        const proveStartZ = performance.now();

        // pass full note data (with rseed, rho, recipient) for real Orchard bundle construction
        const notesForWasm = selected.map(n => ({
          value: Number(n.value),
          nullifier: n.nullifier,
          cmx: n.cmx,
          position: n.position,
          rseed_hex: n.rseed ?? '',
          rho_hex: n.rho ?? '',
          recipient_hex: n.recipient ?? '',
        }));

        const pathsForWasm = (paths as Array<{ position: number; path: Array<{ hash: string }> }>).map(p => ({
          path: p.path.map(e => e.hash),
          position: p.position,
        }));

        // build unsigned transaction with real Halo 2 proofs (parallel via offscreen)
        const unsignedResult = await proveViaOffscreen({
          fn: 'build_unsigned',
          args: [
            sendPayload.ufvk, notesForWasm, sendPayload.recipient,
            amountZat.toString(), fee.toString(), anchorHex,
            pathsForWasm, sendPayload.accountIndex, sendPayload.mainnet,
            memoHex,
          ],
        });

        const proveDurationZ = ((performance.now() - proveStartZ) / 1000).toFixed(1);
        emitProgress('unsigned transaction proved', `${proveDurationZ}s`);

        const parsed = unsignedResult as unknown as {
          sighash: string; alphas: string[]; unsigned_tx: string;
          spend_indices: number[]; summary: string;
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
            spendIndices: parsed.spend_indices,
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
          spendIndices: number[];
        };

        // pass orchard spend auth signatures and their action indices
        const txHex = wasmModule.complete_transaction(
          completePayload.unsignedTx,
          completePayload.signatures.orchardSigs,
          completePayload.spendIndices,
        );
        const txData = hexDecode(txHex);

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

      // ── multi-output send (sequential single-output txs) ──
      // Used by poker escrow: builds one tx per output, broadcasting each in sequence.
      // Each output gets its own note selection, witness build, prove, and broadcast cycle.
      // If any tx fails mid-way, previously broadcast txs are NOT rolled back.
      case 'send-tx-multi': {
        if (!walletId) throw new Error('walletId required');
        await initWasm();
        if (!wasmModule) throw new Error('wasm not initialized');

        const multiPayload = payload as {
          serverUrl: string;
          outputs: Array<{ address: string; amount: string; memo?: string }>;
          accountIndex: number;
          mainnet: boolean;
          mnemonic: string;
        };

        if (!multiPayload.outputs || multiPayload.outputs.length === 0) {
          throw new Error('outputs array required');
        }
        if (!multiPayload.mnemonic) {
          throw new Error('mnemonic required for multi-output send');
        }

        // validate all outputs up front before building any tx
        for (let i = 0; i < multiPayload.outputs.length; i++) {
          const out = multiPayload.outputs[i]!;
          if (!out.address || typeof out.address !== 'string') {
            throw new Error(`output ${i}: address required`);
          }
          const amt = BigInt(out.amount);
          if (amt <= 0n) {
            throw new Error(`output ${i}: amount must be positive`);
          }
          // validate address prefix
          const addr = out.address.trim();
          const validPrefix = addr.startsWith('u1') || addr.startsWith('utest1')
            || addr.startsWith('zs') || addr.startsWith('t1') || addr.startsWith('tm');
          if (!validPrefix) {
            throw new Error(`output ${i}: invalid zcash address prefix`);
          }
        }

        const multiStart = performance.now();
        const emitMultiProgress = (step: string, detail?: string) => {
          const elapsed = ((performance.now() - multiStart) / 1000).toFixed(1);
          console.log(`[zcash-worker] multi-send [${elapsed}s] ${step}${detail ? ': ' + detail : ''}`);
          workerSelf.postMessage({
            type: 'send-progress', id: '', network: 'zcash', walletId,
            payload: { step, detail, elapsedMs: Math.round(performance.now() - multiStart) },
          });
        };

        const txids: string[] = [];
        const fees: string[] = [];

        for (let outputIdx = 0; outputIdx < multiPayload.outputs.length; outputIdx++) {
          const out = multiPayload.outputs[outputIdx]!;
          const recipient = out.address.trim();
          const amountZat = BigInt(out.amount);

          emitMultiProgress(
            `building output ${outputIdx + 1}/${multiPayload.outputs.length}`,
            `${recipient.slice(0, 12)}... ${amountZat} zat`,
          );

          // encode memo
          let memoHex: string | null = null;
          if (out.memo) {
            if (/^[0-9a-f]+$/i.test(out.memo) && out.memo.startsWith('ff5a')) {
              memoHex = out.memo;
            } else {
              const bytes = new TextEncoder().encode(out.memo);
              memoHex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
            }
          }

          // reload state each iteration (previous tx spent notes)
          const multiState = await loadState(walletId);

          // determine recipient type for fee calc
          const isTransparent = recipient.startsWith('t1') || recipient.startsWith('tm');
          const nZOutputs = isTransparent ? 0 : 1;
          const nTOutputs = isTransparent ? 1 : 0;

          // estimate fee and select notes
          const estFee = computeFee(1, nZOutputs, nTOutputs, true);
          const selected = selectNotes(multiState.notes, multiState.spentNullifiers, amountZat + estFee);

          // compute exact fee
          const totalIn = selected.reduce((sum, n) => sum + BigInt(n.value), 0n);
          const hasChange = totalIn > amountZat + computeFee(selected.length, nZOutputs, nTOutputs, true);
          const fee = computeFee(selected.length, nZOutputs, nTOutputs, hasChange);
          if (totalIn < amountZat + fee) {
            throw new Error(`output ${outputIdx}: insufficient funds: have ${totalIn} zat, need ${amountZat + fee} zat`);
          }

          emitMultiProgress(`output ${outputIdx + 1}: notes selected`, `${selected.length} notes, fee=${fee}`);

          // build merkle witnesses
          const { ZidecarClient } = await import(/* webpackMode: "eager" */ '../state/keyring/zidecar-client');
          const multiClient = new ZidecarClient(multiPayload.serverUrl);
          const multiTip = await multiClient.getTip();

          emitMultiProgress(`output ${outputIdx + 1}: building witnesses`);
          const { anchorHex: multiAnchor, paths: multiPaths } = await buildWitnesses(
            multiClient, walletId, selected, multiTip.height,
          );

          // build note data for WASM
          const notesJson = selected.map(n => ({
            value: Number(n.value),
            nullifier: n.nullifier,
            cmx: n.cmx,
            position: n.position,
            rseed_hex: n.rseed ?? '',
            rho_hex: n.rho ?? '',
            recipient_hex: n.recipient ?? '',
          }));
          const pathsResult = multiPaths as Array<{ position: number; path: Array<{ hash: string }> }>;
          const merklePathsForWasm = pathsResult.map(p => ({
            path: p.path.map(e => e.hash),
            position: p.position,
          }));

          emitMultiProgress(`output ${outputIdx + 1}: proving (halo2)`, `${selected.length} spends`);
          const proveStart = performance.now();
          const provingTicker = setInterval(() => {
            const elapsed = ((performance.now() - proveStart) / 1000).toFixed(0);
            emitMultiProgress(`output ${outputIdx + 1}: proving`, `${elapsed}s elapsed`);
          }, 2000);

          let txHex: string;
          try {
            txHex = await proveViaOffscreen({
              fn: 'build_signed_spend',
              args: [
                multiPayload.mnemonic, notesJson, recipient,
                amountZat.toString(), fee.toString(), multiAnchor,
                merklePathsForWasm, multiPayload.accountIndex, multiPayload.mainnet,
                memoHex,
              ],
            }) as string;
          } finally {
            clearInterval(provingTicker);
          }

          // broadcast
          emitMultiProgress(`output ${outputIdx + 1}: broadcasting`);
          const txData = hexDecode(txHex);
          const broadcastClient = new ZidecarClient(multiPayload.serverUrl);
          const broadcastResult = await broadcastClient.sendTransaction(txData);
          if (broadcastResult.errorCode !== 0) {
            throw new Error(`output ${outputIdx}: broadcast failed (${broadcastResult.errorCode}): ${broadcastResult.errorMessage}`);
          }

          const outputTxid = new TextDecoder().decode(broadcastResult.txid);
          txids.push(outputTxid);
          fees.push(fee.toString());

          // mark spent nullifiers so next iteration picks different notes
          for (const note of selected) {
            multiState.spentNullifiers.add(note.nullifier);
          }
          // persist spent nullifiers to IDB so next iteration picks different notes
          const db = await getDb();
          const spentTx = db.transaction('spent', 'readwrite');
          for (const note of selected) {
            spentTx.objectStore('spent').put({ walletId, nullifier: note.nullifier });
          }
          await txComplete(spentTx);

          emitMultiProgress(`output ${outputIdx + 1}: complete`, `txid=${outputTxid}`);
        }

        const totalDuration = ((performance.now() - multiStart) / 1000).toFixed(1);
        emitMultiProgress('all outputs complete', `${txids.length} txs, total=${totalDuration}s`);

        workerSelf.postMessage({
          type: 'tx-multi-result', id, network: 'zcash', walletId,
          payload: { txids, fees },
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
            value: Number(u.valueZat),
            script: hexEncode(u.script),
          })));

          const txHex = await proveViaOffscreen({
            fn: 'build_shielding',
            args: [utxosJson, privkeyHex, recipient, shieldAmount.toString(), fee.toString(), tip.height, mainnet],
          }) as string;
          const txData = hexDecode(txHex);
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

        const shieldUResult = await proveViaOffscreen({
          fn: 'build_unsigned_shielding',
          args: [shieldUUtxosJson, shieldURecipient, shieldUAmount.toString(), shieldUFee.toString(), shieldUTip.height, shieldUnsignedPayload.mainnet],
        }) as string;

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
        const shieldCompleteTxData = hexDecode(shieldCompleteTxHex);

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

      // ── FROST multisig ──

      case 'frost-dkg-part1': {
        await initWasm();
        const { maxSigners, minSigners } = payload as { maxSigners: number; minSigners: number };
        const result = JSON.parse(wasmModule!.frost_dkg_part1(maxSigners, minSigners));
        workerSelf.postMessage({ type: 'frost-result', id, network: 'zcash', payload: result });
        return;
      }

      case 'frost-dkg-part2': {
        await initWasm();
        const { secretHex, peerBroadcasts } = payload as { secretHex: string; peerBroadcasts: string };
        const result = JSON.parse(wasmModule!.frost_dkg_part2(secretHex, peerBroadcasts));
        workerSelf.postMessage({ type: 'frost-result', id, network: 'zcash', payload: result });
        return;
      }

      case 'frost-dkg-part3': {
        await initWasm();
        const { secretHex, round1Broadcasts, round2Packages } = payload as {
          secretHex: string; round1Broadcasts: string; round2Packages: string;
        };
        const result = JSON.parse(wasmModule!.frost_dkg_part3(secretHex, round1Broadcasts, round2Packages));
        workerSelf.postMessage({ type: 'frost-result', id, network: 'zcash', payload: result });
        return;
      }

      case 'frost-sign-round1': {
        await initWasm();
        const { ephemeralSeedHex, keyPackageHex } = payload as { ephemeralSeedHex: string; keyPackageHex: string };
        const result = JSON.parse(wasmModule!.frost_sign_round1(ephemeralSeedHex, keyPackageHex));
        workerSelf.postMessage({ type: 'frost-result', id, network: 'zcash', payload: result });
        return;
      }

      case 'frost-spend-sign': {
        await initWasm();
        const { keyPackageHex, noncesHex, sighashHex, alphaHex, commitments } = payload as {
          keyPackageHex: string; noncesHex: string; sighashHex: string; alphaHex: string; commitments: string;
        };
        const result = wasmModule!.frost_spend_sign_round2(keyPackageHex, noncesHex, sighashHex, alphaHex, commitments);
        workerSelf.postMessage({ type: 'frost-result', id, network: 'zcash', payload: result });
        return;
      }

      case 'frost-spend-aggregate': {
        await initWasm();
        const { publicKeyPackageHex, sighashHex, alphaHex, commitments, shares } = payload as {
          publicKeyPackageHex: string; sighashHex: string; alphaHex: string; commitments: string; shares: string;
        };
        const result = wasmModule!.frost_spend_aggregate(publicKeyPackageHex, sighashHex, alphaHex, commitments, shares);
        workerSelf.postMessage({ type: 'frost-result', id, network: 'zcash', payload: result });
        return;
      }

      case 'frost-derive-address': {
        await initWasm();
        const { publicKeyPackageHex, diversifierIndex } = payload as { publicKeyPackageHex: string; diversifierIndex: number };
        const rawHex = wasmModule!.frost_derive_address_raw(publicKeyPackageHex, diversifierIndex);
        workerSelf.postMessage({ type: 'frost-result', id, network: 'zcash', payload: rawHex });
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
