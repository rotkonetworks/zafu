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

// egress guard first: nothing may capture fetch or open a socket before it
import '../net/egress-install-lite';
import { fixOrchardAddress } from '@repo/wallet/networks/zcash/unified-address';
import { blockRangeFetcher } from '../services/memo-sync/block-range-fetcher';
import { buildStrategy } from '../services/memo-sync/strategy';
import { idbBucketStore } from '../services/memo-sync/filters/cache';
import { bucketOf, BUCKET_SIZE as MEMO_BUCKET_SIZE } from '../services/memo-sync/types';
import type { BucketStart as MemoBucketStart, MemoSyncStrategy } from '../services/memo-sync/types';
import {
  ZCASH_BACKENDS,
  backendKey,
  backendOfEndpoint,
  createRedetector,
  detectZcashBackend,
  isZcashBackend,
  utxosEach,
  zcashClient,
  zidecarExtras,
  type ZcashBackend,
  type ZcashClient,
} from '../state/keyring/zcash-backend';
import { eachAddress } from '../state/keyring/each-address';
import { txidMemoFetcher } from '../services/memo-sync/txid-fetcher';
import { COMPACT_SIGN_REQUEST } from '../config/feature-flags';
import {
  cborWrapPczt,
  orchardSignRequest,
  zignerBatchRequest,
  zignerSignRequest,
} from '../routes/popup/send/zcash-send-cbor-helpers';
import { nu63ActivationHeight } from '../config/feature-flags';
import {
  applyTreeWrites,
  legacyWitnesses,
  loadTree,
  MAX_CHECKPOINTS,
  openTrees,
  RECOVERY_ROUNDING,
  retiredLegacy,
  treePaths,
  withoutWitness,
  type LegacyIronwoodRow,
  type LegacyNoteRecord,
  type NoteTree,
  type RecoveryProgress,
  type TreeBlock,
  type TreeChain,
  type TreePool,
  type Trees,
  type TreeWrite,
} from './note-trees';
import { ironwoodBranchRefusal } from './branch-ids';
import { describeNode, measuredProtocol, type NodeInfo } from '../state/keyring/node-info';
import type { ZcashChainCheck } from '../state/keyring/network-worker';
import {
  checkChain,
  FLY_BURIAL,
  FLY_PROOF_MAX_BYTES,
  poolsOffProof,
  type ProvenChain,
} from './fly-verify';
import { installGracefulNetworkErrorHandler } from '../utils/graceful-network-errors';
import { BlockPrefetcher } from './block-prefetcher';
import { once } from './once';
import { assessAmbientRayonIsolation, RAYON_ISOLATION_WARNING } from '../perf/rayon-isolation';
import { loadVotingWasm } from '../state/voting-wasm';
import { hotSpendAccount, isStoreOfWallet, parsePocketStoreId } from '../state/pocket-id';
import {
  isP2pkhOf,
  pocketWalletKeys,
  tIndexOf,
  shieldRoundUtxos,
  utxosByTIndex,
  type PocketKeysCtor,
} from './pocket-keys';
import { unsealVault, withSpendKeys, type SpendKeysCtor } from './hot-sign';
import {
  checkThorRequest,
  signThorDeposit,
  thorAddressFrom,
  type ThorDepositRequest,
  type ThorKeySource,
} from './thor-sign';
import {
  buildDeposit,
  coldDepositTx,
  finishDeposit,
  planDeposit,
  sendDeposit,
  wantOf,
  withCoin,
  type DepositChain,
  type MoveCoin,
  type DepositRequest,
  type DepositWasm,
  type FinalizeWasm,
} from './transparent-deposit';
import { DEPOSIT_OUTLIVES_MOVE } from '../signing/move-and-deposit';
import { assertProveRequest, type ProveRequest } from '../shared/prove-guard';
import { issueWorkerKey, openCall, type SealedCall, type SealedVault } from '../shared/vault-seal';
import {
  parseExpiryHeight,
  reconcileSentTxs,
  type HistoryTx,
  type SentKind,
  type SentPool,
  type SentTxRecord,
} from './sent-tx-reconcile';
import {
  isChainContinuityError,
  rewindDistanceForAttempt,
  syncErrorCodeOf,
  syncRetryDelayMs,
  MAX_REWINDS_PER_RUN,
  SYNC_STALL_ERRORS,
  type SyncErrorCode,
} from '../state/sync-failure';
import { startRun, stopRun, STOP_WAIT_MS, type RunSlot } from './sync-runs';
import { errText, storageFailure } from '@penumbra-zone/query/error-text';
import { mergeLoadedNotes, mergeLoadedSpent, readAcrossRewinds } from './wallet-state-merge';
import { allowMismatchRewind, rewindPurge } from './rewind-purge';
import { isWrongNetwork, walletIsMainnet } from './chain-network';
import { storeFellBehind } from './store-reset';
import { createBuildRegistry } from './build-abort';

export type { SentTxRecord } from './sent-tx-reconcile';

const workerSelf = globalThis as any as DedicatedWorkerGlobalScope;

/** builds a page may stop before they broadcast (see build-abort.ts) */
const builds = createBuildRegistry();

/** a build's progress label for its page, in the send-progress shape */
const buildProgress =
  (walletId: string | undefined, start = performance.now()) =>
  (step: string, detail?: string) =>
    workerSelf.postMessage({
      type: 'send-progress',
      id: '',
      network: 'zcash',
      walletId,
      payload: { step, detail, elapsedMs: Math.round(performance.now() - start) },
    });

// One line per real worker boot, for counting live instances (should be
// exactly one, hosted in the offscreen document - see network-worker.ts).
console.debug('[zcash-worker] module start');

// This worker runs in the popup's console context, so any rejection that is
// not awaited here surfaces there as "Uncaught (in promise)". First-party
// call sites all catch, but wasm-bindgen glue (module/pthread fetches) and
// best-effort background calls can still reject with a bare TypeError:
// "Failed to fetch" when an endpoint is unreachable. Downgrade only those
// transient network errors to console.debug; everything else stays loud.
installGracefulNetworkErrorHandler();

/**
 * Tag an error we raise ourselves with its classification.
 *
 * The UI must never render a raw worker error, and guessing what an error
 * MEANS from its text is brittle - but we own both sides of this boundary, so
 * anything thrown here can simply say what it is. Only errors from wasm, from
 * `fetch`, and from IndexedDB fall back to substring sniffing in
 * `state/sync-failure.ts`.
 */
const syncError = (code: SyncErrorCode, message: string): Error =>
  Object.assign(new Error(message), { syncCode: code });

/**
 * Worker-local endpoint→backend registry, seeded by 'sync'. What a node is
 * comes from the node: when the page has no cached answer, 'sync' asks it
 * with the standard GetLightdInfo (detectZcashBackend) before building a
 * client. A zidecar-only rpc is never used to find out - it is a request
 * signature no other wallet sends, so even a failed probe marks the wallet.
 *
 * An endpoint nothing has classified gets backendOfEndpoint's guess, which
 * is lightwalletd for every third-party host: an unclassified node never
 * sees a zidecar-only rpc.
 */
const backendRegistry = new Map<string, ZcashBackend>();

/** one re-ask per node per cooldown, after a zidecar call failed */
const redetectBackend = createRedetector();

/** tell the page what a node said it is, so it is cached per endpoint */
const announceBackend = (serverUrl: string, backend: ZcashBackend): void =>
  workerSelf.postMessage({
    type: 'zcash-backend-detected',
    id: '',
    network: 'zcash',
    payload: { serverUrl, backend },
  });

/**
 * One of zidecar's own calls failed. The node may not be (or no longer be) a
 * zidecar: ask it again with the standard GetLightdInfo. Only an answer
 * changes the kind - a node that is merely down keeps it. A changed kind
 * reaches the page, which restarts the sync with the right client.
 */
const suspectBackend = (serverUrl: string): void => {
  void redetectBackend(serverUrl).then(backend => {
    if (backend && backend !== lookupBackend(serverUrl)) {
      console.warn(`[zcash-worker] ${serverUrl} now reports itself as ${backend}`);
      registerBackend(serverUrl, backend);
      announceBackend(serverUrl, backend);
    }
  });
};

/**
 * One-shot warning latches for conditions that are stable for the life of the
 * worker. Sync runs on every pass, so a per-pass `console`
 * line for a condition that cannot change turns a healthy sync into hundreds of
 * identical lines and hides the ones that matter. These warn once, then stay
 * silent; the condition itself is unaffected.
 */

function registerBackend(serverUrl: string, backend: ZcashBackend): void {
  if (!isZcashBackend(backend)) {
    throw new Error(`unknown zcash backend: ${String(backend)}`);
  }
  backendRegistry.set(backendKey(serverUrl), backend);
}

function lookupBackend(serverUrl: string): ZcashBackend {
  return backendRegistry.get(backendKey(serverUrl)) ?? backendOfEndpoint(serverUrl);
}

/** the sync client for an endpoint; call sites without a backend in scope use the registry */
const makeZcashClient = (serverUrl: string, backend?: ZcashBackend): ZcashClient =>
  zcashClient(serverUrl, backend ?? lookupBackend(serverUrl));

interface WorkerMessage {
  type:
    | 'init'
    | 'vault-key'
    | 'derive-address'
    | 'sync'
    | 'stop-sync'
    | 'reset-sync'
    | 'get-balance'
    | 'get-pool-balances'
    | 'send-tx'
    | 'build-stop'
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
    | 'transparent-deposit-unsigned'
    | 'transparent-deposit-complete'
    | 'transparent-deposit'
    | 'chain-tip'
    | 'list-wallets'
    | 'delete-wallet'
    | 'get-notes'
    | 'note-sync-encode'
    | 'decrypt-memos'
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
    | 'build-vote-shares-from-recovery'
    | 'pir-fetch-imt-proofs'
    | 'get-consensus-branch-id'
    | 'get-merkle-witnesses'
    | 'thor-address'
    | 'thor-sign-deposit';
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
  /**
   * NU6.3 ironwood pool scan (mirror of scan_actions_parallel). Optional:
   * absent from pre-ironwood wasm blobs, so all callers feature-detect.
   * Property (not method) syntax so feature-detection references don't trip
   * @typescript-eslint/unbound-method.
   */
  scan_actions_ironwood_parallel?: (actionsBytes: Uint8Array) => DecryptedNote[];
  decrypt_transaction_memos(txBytes: Uint8Array): FoundNoteWithMemo[];
  free(): void;
}

interface WalletKeys extends ScannerKeys {
  get_receiving_address(mainnet: boolean): string;
  get_receiving_address_at(index: number, mainnet: boolean): string;
  /** full 11-byte diversifier index as 22 hex chars, little-endian */
  get_receiving_address_at_index(indexHex: string, mainnet: boolean): string;
  scan_actions(actionsJson: unknown): DecryptedNote[];
  calculate_balance(notes: unknown, spent: unknown): bigint;
  /** Raw 96-byte Orchard FVK as hex (not a bech32m UFVK string). */
  get_fvk_hex(): string;
}

interface WatchOnlyWallet extends ScannerKeys {
  get_address(): string;
  get_address_at(diversifierIndex: number): string;
  /** full 11-byte diversifier index as 22 hex chars, little-endian */
  get_address_at_index(indexHex: string): string;
  get_account_index(): number;
  is_mainnet(): boolean;
  export_fvk_hex(): string;
}

/** Shielded pool a note lives in. NU6.3 adds the ironwood pool. */
type NotePool = 'orchard' | 'ironwood';

interface DecryptedNote {
  height: number;
  value: string;
  nullifier: string;
  cmx: string;
  txid: string;
  position: number;
  /**
   * Pool the note belongs to. Optional for backward compatibility with
   * records persisted before the ironwood rollout: absent means 'orchard'.
   * Use `poolOf(note)` instead of reading this directly.
   */
  pool?: NotePool;
  is_change?: boolean;
  spent_by_txid?: string;
  spent_at_height?: number;
  rseed?: string;
  rho?: string;
  recipient?: string;
}

/** Pool of a note; records persisted pre-ironwood default to orchard. */
const poolOf = (note: DecryptedNote): NotePool => note.pool ?? 'orchard';

interface WalletState extends RunSlot {
  keys: ScannerKeys | null;
  notes: DecryptedNote[];
  spentNullifiers: Set<string>;
  /**
   * Abort controller for the mempool watcher task, when one is running.
   * Lifted out of runSync's scope so stop-sync / reset-sync can abort the
   * watcher directly without waiting for runSync's backoff to drain.
   */
  mempoolAbort?: AbortController;
  /**
   * Promise of the watcher's IIFE. stopSync awaits this alongside the run
   * so a follow-up runSync can't race a still-alive watcher.
   */
  mempoolTask?: Promise<void>;
  /** the running sync's note trees, read live by a send */
  noteTrees?: Trees;
  /** a recovery of notes the trees lost, which a send waits for */
  treeRecovery?: Promise<void>;
  /** rewinds of the scan cursor so far: a read that spans one reads again */
  rewinds?: number;
}

interface WasmModule extends DepositWasm, FinalizeWasm {
  /** a pool's note commitment tree as shards; absent on older blobs */
  NoteTree?: new (maxCheckpoints: number) => NoteTree;
  WalletKeys: PocketKeysCtor<WalletKeys>;
  /** hot spend authority, built per send from the phrase this worker unsealed */
  SpendKeys: SpendKeysCtor;
  WatchOnlyWallet: {
    from_ufvk(ufvk: string): WatchOnlyWallet;
    from_qr_hex(qrHex: string): WatchOnlyWallet;
    new (fvkBytes: Uint8Array, accountIndex: number, mainnet: boolean): WatchOnlyWallet;
  };
  build_unsigned_transaction(
    ufvk_str: string,
    notes_json: unknown,
    recipient: string,
    amount: bigint,
    fee: bigint,
    anchor_hex: string,
    merkle_paths_json: unknown,
    account_index: number,
    mainnet: boolean,
    memo_hex?: string | null,
    // live consensus branch id (hex, e.g. "37a5165b"); null/'' -> WASM NU6.2 fallback
    branch_id_hex?: string | null,
  ): unknown;
  complete_transaction(
    unsigned_tx_hex: string,
    signatures: unknown,
    spend_indices: unknown,
  ): string;
  // PCZT signing flow (replaces simple-format sighash+alphas QR for single-signer zigner)
  build_unsigned_pczt(
    ufvk_str: string,
    notes_json: unknown,
    recipient: string,
    amount: bigint,
    fee: bigint,
    anchor_hex: string,
    merkle_paths_json: unknown,
    target_height: number,
    mainnet: boolean,
    memo_hex?: string | null,
  ): unknown;
  extract_signed_tx_from_pczt(pczt_hex: string): string;
  apply_signature_contributions: (pcztHex: string, contributionsJson: string) => string;
  complete_orchard_pczt(
    pczt_hex: string,
    orchard_sigs_json: unknown,
    spend_indices_json: unknown,
  ): string;
  complete_ironwood_pczt(
    pczt_hex: string,
    ironwood_sigs_json: unknown,
    spend_indices_json: unknown,
  ): string;
  pczt_has_ironwood_actions(pczt_hex: string): boolean;
  compute_txid(tx_hex: string): string;
  validate_ufvk(ufvk_str: string): boolean;
  ur_decode_frames(parts_json: string, expected_type: string): string;
  build_unsigned_shielding_transaction(
    utxos_json: string,
    recipient: string,
    amount: bigint,
    fee: bigint,
    anchor_height: number,
    mainnet: boolean,
    // live consensus branch id (hex, e.g. "37a5165b"); null/'' -> WASM NU6.2 fallback
    branch_id_hex?: string | null,
  ): string;
  complete_shielding_transaction(unsigned_tx_hex: string, signatures_json: string): string;
  /** 33-byte compressed secp256k1 pubkey for a UFVK's transparent address index */
  transparent_pubkey_from_ufvk(ufvk_str: string, address_index: number): string;
  build_merkle_paths(
    tree_state_hex: string,
    compact_blocks_json: string,
    note_positions_json: string,
    anchor_height: number,
  ): unknown;
  tree_root_hex(tree_state_hex: string): string;
  verify_flyclient(
    resp_proto: Uint8Array,
    now_secs: bigint,
    min_height: number,
    mainnet: boolean,
  ): string;
  /** leaves in a zcashd-format frontier (the orchard pool) */
  frontier_tree_size?: (tree_state_hex: string) => bigint;
  frontier_tree_size_ironwood?: (tree_state_hex: string) => bigint;

  // ── NU6.3 ironwood pool (frozen interface contract, Section 2) ──
  // All optional: pre-ironwood wasm blobs don't export them, so every call
  // site feature-detects. Signatures mirror the orchard equivalents above.
  // Property (not method) syntax so feature-detection references and
  // destructuring don't trip @typescript-eslint/unbound-method.
  build_merkle_paths_ironwood?: (
    tree_state_hex: string,
    compact_blocks_json: string,
    note_positions_json: string,
    anchor_height: number,
  ) => unknown;
  tree_root_hex_ironwood?: (tree_state_hex: string) => string;
  /**
   * Turnstile migration PCZT: spends the given ORCHARD notes and outputs to
   * the wallet's OWN ironwood address (derived internally from the UFVK).
   * Returns JSON `{ pczt_hex, summary, action_count }` with the same
   * redaction contract as build_unsigned_pczt. Invoked via the offscreen
   * prover (proveViaOffscreen), declared here for completeness.
   */
  build_turnstile_migration_pczt?: (
    ufvk_str: string,
    orchard_notes_json: string,
    fee: bigint,
    orchard_anchor_hex: string,
    orchard_merkle_paths_json: string,
    account_index: number,
    target_height: number,
    // expected_branch_id is the 8th param (before mainnet), matching the
    // shipped producer signature. It is the fail-closed guard value read from
    // GetLightdInfo; the producer REFUSES to build unless the branch id it
    // binds equals this (NU6.3 = 0x37a5165b).
    expected_branch_id: number,
    mainnet: boolean,
    memo_hex?: string | null,
  ) => unknown;

  // FROST multisig
  frost_dealer_keygen(min_signers: number, max_signers: number): string;
  frost_dkg_part1(max_signers: number, min_signers: number): string;
  frost_dkg_part2(secret_hex: string, peer_broadcasts_json: string): string;
  frost_dkg_part3(
    secret_hex: string,
    round1_broadcasts_json: string,
    round2_packages_json: string,
  ): string;
  frost_sign_round1(ephemeral_seed_hex: string, key_package_hex: string): string;
  frost_generate_randomizer(
    ephemeral_seed_hex: string,
    message_hex: string,
    commitments_json: string,
  ): string;
  frost_sign_round2(
    ephemeral_seed_hex: string,
    key_package_hex: string,
    nonces_hex: string,
    message_hex: string,
    commitments_json: string,
    randomizer_hex: string,
  ): string;
  frost_aggregate_shares(
    public_key_package_hex: string,
    message_hex: string,
    commitments_json: string,
    shares_json: string,
    randomizer_hex: string,
  ): string;
  frost_derive_address_raw(public_key_package_hex: string, diversifier_index: number): string;
  frost_derive_address_from_sk(
    public_key_package_hex: string,
    sk_hex: string,
    diversifier_index: number,
  ): string;
  frost_sample_fvk_sk(): string;
  frost_derive_ufvk(public_key_package_hex: string, sk_hex: string, mainnet: boolean): string;
  frost_spend_sign_round2(
    key_package_hex: string,
    nonces_hex: string,
    sighash_hex: string,
    alpha_hex: string,
    commitments_json: string,
  ): string;
  frost_spend_sign_round2_signed(
    ephemeral_seed_hex: string,
    key_package_hex: string,
    nonces_hex: string,
    sighash_hex: string,
    alpha_hex: string,
    commitments_json: string,
  ): string;
  frost_spend_aggregate(
    public_key_package_hex: string,
    sighash_hex: string,
    alpha_hex: string,
    commitments_json: string,
    shares_json: string,
  ): string;
  frost_parse_tx_outputs(unsigned_tx_hex: string, orchard_fvk_uview: string): string;
  frost_inspect_pczt_outputs(pczt_hex: string, orchard_fvk_uview: string): string;

  // note sync encoding (CBOR + UR/ZT)
  encode_notes_bundle(
    notes_json: string,
    merkle_result_json: string,
    anchor_height: number,
    mainnet: boolean,
    attestation_hex?: string | null,
  ): Uint8Array;
  ur_encode_frames(cbor_data: Uint8Array, ur_type: string, fragment_size: number): string;
  /** further-redact a signer PCZT for a compact (tx_type 0x05) request */
  redact_pczt_compact(pczt_hex: string): string;
  zt_encode_frames(cbor_data: Uint8Array, zt_type: string, k: number, n: number): string;
  zt_encode_frames_auto(
    cbor_data: Uint8Array,
    zt_type: string,
    max_qr_bytes: number,
    redundancy_pct: number,
  ): string;

  // attestation
  frost_attestation_digest(
    public_key_package_hex: string,
    anchor_hex: string,
    anchor_height: number,
    mainnet: boolean,
  ): string;
  frost_attestation_verify(
    attestation_hex: string,
    public_key_package_hex: string,
    anchor_hex: string,
    anchor_height: number,
    mainnet: boolean,
  ): boolean;
}

/**
 * Default UR fountain fragment size (bytes/frame) for the zigner sign QR. 200 is
 * the BC-UR spec default and keeps each frame at a low QR version that scans on
 * a phone camera; the frame COUNT is not the scan bottleneck, the physical QR
 * size on screen is (handled UI-side). The UI can override via
 * sendPayload.fragmentSize.
 */
const DEFAULT_ZIGNER_FRAG_SIZE = 200;

const fragOf = (fragmentSize?: number) =>
  fragmentSize && fragmentSize > 0 ? fragmentSize : DEFAULT_ZIGNER_FRAG_SIZE;

/**
 * The zigner module request for a shielded PCZT: compact (tx_type 0x05,
 * signatures-only answer) while COMPACT_SIGN_REQUEST is on, else full.
 */
const zignerShieldedRequest = (wasm: WasmModule, pcztHex: string, fragmentSize?: number) =>
  zignerSignRequest(wasm, pcztHex, {
    compact: COMPACT_SIGN_REQUEST,
    fragmentSize: fragOf(fragmentSize),
  });

let wasmModule: WasmModule | null = null;
const walletStates = new Map<string, WalletState>();

const hexEncode = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    s += b[i]!.toString(16).padStart(2, '0');
  }
  return s;
};

const hexDecode = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
};

/**
 * patch consensus branch ID in a v5 tx to NU5 (0xC2D6D0B4)
 * allows older zcash_primitives to parse NU6+ transactions
 * v5 layout: [4B header][4B versionGroupId][4B consensusBranchId]...
 * NU5 branch ID in LE: B4 D0 D6 C2
 */
// which branch ids carry the ironwood pool on which network: branch-ids.ts
/** Placeholder branch id from a pre-activation / not-yet-real fork. Never build against it. */
const PLACEHOLDER_BRANCH_ID_HEX = 'ffffffff';

/**
 * Fetch the endpoint's live consensus branch id (GetLightdInfo.consensusBranchId)
 * as a normalized lowercase hex string with no `0x` prefix, e.g. "5437f330"
 * (NU6.2) or "37a5165b" (NU6.3). This is threaded verbatim into the ordinary
 * send/shield WASM builders, which bind it into the ZIP-244 sighash + v5 header.
 *
 * FAIL-CLOSED. This used to return '' on any RPC failure or placeholder value,
 * on the theory that ordinary sends must keep working across the NU6.3
 * boundary. They did not: the WASM side quietly substituted its compiled-in
 * NU6.2 value, so the wallet paid for a full Halo 2 proof and produced a
 * transaction whose sighash bound the wrong branch, which the node then
 * rejected with "incorrect consensus branch id" - and the only trace was a
 * console.warn nobody reads. The WASM builders now refuse a missing branch id
 * outright; throwing here surfaces the same condition early, with a message
 * that says what to do (retry / check the endpoint) instead of a proof-time
 * failure.
 */
const fetchBranchIdHex = async (client: ZcashClient): Promise<string> => {
  let info;
  try {
    info = await client.getLightdInfo();
  } catch (e) {
    throw new Error(
      `cannot read the consensus branch id from the endpoint (GetLightdInfo failed: ${
        e instanceof Error ? e.message : String(e)
      }); refusing to build a transaction that would bind a guessed branch id - retry, ` +
        'or switch to a reachable endpoint',
    );
  }
  const hex = (info.consensusBranchId || '').trim().toLowerCase().replace(/^0x/, '');
  if (!hex || hex === PLACEHOLDER_BRANCH_ID_HEX) {
    throw new Error(
      `endpoint reported no/placeholder consensus branch id (${JSON.stringify(
        info.consensusBranchId,
      )}); refusing to build a transaction that would bind a guessed branch id`,
    );
  }
  return hex;
};

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

/** whether the running sync's note tree holds a note (so its send needs no recovery) */
const heldBy =
  (walletId: string, pool: NotePool) =>
  (n: DecryptedNote): boolean =>
    walletStates.get(walletId)?.noteTrees?.get(pool)?.is_marked(n.position) ?? false;

/** stop the wallet's sync and wait until its loop and mempool watcher have ended */
const stopSync = async (state: WalletState): Promise<void> => {
  state.mempoolAbort?.abort();
  await Promise.all([
    stopRun(state),
    Promise.race([
      state.mempoolTask?.catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, STOP_WAIT_MS)),
    ]),
  ]);
  state.mempoolTask = undefined;
  state.mempoolAbort = undefined;
};

/** a sleep that wakes the moment the run is stopped */
const sleepUnlessAborted = async (signal: AbortSignal, ms: number): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!signal.aborted) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return;
    }
    await new Promise(r => setTimeout(r, Math.min(250, remaining)));
  }
};

const getOrCreateWalletState = (walletId: string): WalletState => {
  let state = walletStates.get(walletId);
  if (!state) {
    state = { keys: null, notes: [], spentNullifiers: new Set() };
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
    if (idx < 0) {
      return null;
    }
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
  if (first < 0xfd) {
    return [first, off + 1];
  }
  if (first === 0xfd) {
    return [buf[off + 1]! | (buf[off + 2]! << 8), off + 3];
  }
  if (first === 0xfe) {
    return [
      buf[off + 1]! | (buf[off + 2]! << 8) | (buf[off + 3]! << 16) | (buf[off + 4]! << 24),
      off + 5,
    ];
  }
  // 0xff - 8 byte, unlikely for tx counts
  return [0, off + 9];
};

/** read little-endian u64 as bigint */
const readU64LE = (buf: Uint8Array, off: number): bigint => {
  let v = 0n;
  for (let i = 0; i < 8; i++) {
    v |= BigInt(buf[off + i]!) << BigInt(i * 8);
  }
  return v;
};

/**
 * parse a zcash v5 transaction's transparent outputs to find amounts
 * matching our scripts (scriptPubKey hex strings in ourScripts set)
 *
 * returns total zatoshis received by our addresses
 */
const parseTransparentTx = (data: Uint8Array, ourScripts: Set<string>): bigint => {
  let received = 0n;
  let off = 0;

  // v5 tx format: https://zips.z.cash/zip-0225
  // header (4 bytes) + nVersionGroupId (4 bytes) + nConsensusBranchId (4 bytes)
  // + nLockTime (4 bytes) + nExpiryHeight (4 bytes)
  off += 4 + 4 + 4 + 4 + 4; // = 20 bytes header

  // transparent bundle
  const [nVin, vinOff] = readCompactSize(data, off);
  off = vinOff;

  // parse inputs - check scriptSig for our pubkey hash
  for (let i = 0; i < nVin; i++) {
    // prevout: txid(32) + index(4)
    off += 36;
    // scriptSig
    const [sigLen, sigOff] = readCompactSize(data, off);
    off = sigOff;
    // note: transparent inputs don't carry value - we can't determine sent amount
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
// v4: NU6.3 ironwood - adds the 'witnesses-ironwood' store and the
// ironwoodTreeSize / ironwoodTreeFrontier / ironwoodTreeFrontierHeight meta
// keys (meta needs no schema change; the store is generic key/value).
// Strictly additive: orchard stores and keys are untouched, so v3 databases
// upgrade cleanly with no data migration.
const DB_VERSION = 5;

let sharedDb: IDBDatabase | null = null;
/** counts connections lost under us (closed by the browser, asked to let go) */
let dbLost = 0;

const getDb = (): Promise<IDBDatabase> => {
  if (sharedDb) {
    return Promise.resolve(sharedDb);
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    // A version upgrade (4 -> 5 added the 'sent' store) cannot run while any
    // other context still holds a lower-version connection to 'zafu-zcash'.
    // The open request then fires 'blocked' and NEVER settles: no success, no
    // error. Every await on getDb() hangs, runSync stalls before it emits a
    // single height, and the wallet sits at "scanning notes 0%" with nothing
    // in the log. Fail loudly instead - the caller surfaces it and a reload
    // (which drops the other connection) fixes it.
    req.onblocked = () =>
      reject(
        new Error(
          `IndexedDB upgrade to v${DB_VERSION} blocked by another open connection to ${DB_NAME} - reload the extension`,
        ),
      );
    req.onsuccess = () => {
      const db = req.result;
      // A connection can die under us: the browser closes it when the
      // backing store fails or the site's data is cleared ('close'), and
      // another realm upgrading or deleting the database asks us to let go
      // ('versionchange'). Either way forget it, so the next getDb() opens a
      // fresh one instead of every call throwing InvalidStateError forever.
      const forget = () => {
        if (sharedDb === db) {
          sharedDb = null;
          dbLost++;
        }
      };
      db.onclose = forget;
      db.onversionchange = () => {
        db.close();
        forget();
      };
      sharedDb = db;
      resolve(db);
    };
    req.onupgradeneeded = event => {
      const db = req.result;
      const old = event.oldVersion;
      for (const name of ['notes', 'spent', 'meta'] as const) {
        if (db.objectStoreNames.contains(name) && old < 2) {
          db.deleteObjectStore(name);
        }
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
      // v4 (NU6.3 ironwood): per-note ironwood witnesses live in their own
      // store instead of on the note record - additive so old databases
      // upgrade cleanly and the orchard paths never touch it.
      if (!db.objectStoreNames.contains('witnesses-ironwood')) {
        const store = db.createObjectStore('witnesses-ironwood', {
          keyPath: ['walletId', 'nullifier'],
        });
        store.createIndex('byWallet', 'walletId', { unique: false });
      }
      // v5: a local record of what WE sent.
      //
      // History was derived entirely by re-scanning the chain, which cannot
      // work for outgoing payments: a note sent to someone else is encrypted
      // to THEIR key, so scanning recovers it only via OVK decryption, and the
      // recipient/memo/fee the user actually chose are not reliably
      // reconstructible at all. The result is a send that shows up partially,
      // late, or not until a rescan.
      //
      // We know all of it at broadcast time. Write it down then, and treat the
      // chain as confirmation rather than as the source of truth.
      if (!db.objectStoreNames.contains('sent')) {
        const store = db.createObjectStore('sent', { keyPath: ['walletId', 'txid'] });
        store.createIndex('byWallet', 'walletId', { unique: false });
      }
    };
  });
};

/** close shared db connection - called when worker is idle */
export const closeDb = () => {
  if (sharedDb) {
    sharedDb.close();
    sharedDb = null;
  }
};

const txComplete = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    // a transaction the browser aborts (its connection closed) has no error
    // object: reject with one that says so, never with null
    const failed = () =>
      reject(tx.error ?? new DOMException('The transaction was aborted.', 'AbortError'));
    tx.oncomplete = () => resolve();
    tx.onerror = failed;
    tx.onabort = failed;
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

/** one row of a wallet's `meta` store */
const idbPutMeta = async (walletId: string, key: string, value: unknown): Promise<void> => {
  const db = await getDb();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ walletId, key, value });
  await txComplete(tx);
};

const idbGetAllByIndex = async <T>(
  store: string,
  indexName: string,
  key: IDBValidKey,
): Promise<T[]> => {
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
  for (const storeName of ['wallets', 'notes', 'spent', 'meta', 'witnesses-ironwood'] as const) {
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
      for (const key of keys) {
        store.delete(key);
      }
    }
    await txComplete(tx);
  }
  walletStates.get(walletId)?.noteTrees?.free();
  walletStates.delete(walletId);
};

const loadState = async (walletId: string): Promise<WalletState> => {
  const state = getOrCreateWalletState(walletId);
  // Read everything before touching `state`: the sync loop can run between
  // these awaits.
  const [notes, spentRecords] = await readAcrossRewinds(
    () => state.rewinds ?? 0,
    () =>
      Promise.all([
        idbGetAllByIndex<DecryptedNote>('notes', 'byWallet', walletId),
        idbGetAllByIndex<{ nullifier: string }>('spent', 'byWallet', walletId),
      ]),
  );

  // A live sync run owns the note objects (see wallet-state-merge.ts).
  const syncing = !!state.stop && !state.stop.signal.aborted;
  state.notes = mergeLoadedNotes(state.notes, notes, syncing);
  state.spentNullifiers = mergeLoadedSpent(
    state.spentNullifiers,
    spentRecords.map(r => r.nullifier),
    syncing,
  );
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

// ── NU6.3 ironwood pool meta (mirrors the orchard keys above) ──

const getIronwoodTreeSize = async (walletId: string): Promise<number> => {
  const r = await idbGet<{ value: number }>('meta', [walletId, 'ironwoodTreeSize']);
  return r?.value ?? 0;
};

/**
 * Append the anchor block's own Unix timestamp to a note-sync CBOR bundle as
 * map key 7 (uint). The block header time is objective chain truth - unlike the
 * device clock the zigner stamps at import (`synced_at`), which can drift - so
 * the cold device can render "as of block N" toggleable with that block's real
 * date without any network access it doesn't have.
 *
 * Done in JS rather than the wasm encoder deliberately: it's purely additive and
 * the zigner decoder already accepts `map(4+)` and skips unknown keys, so this
 * ships without a wasm rebuild and an older zigner ignores it harmlessly.
 *
 * The bundle's outer map header is a single byte (`0xa0 | len`, len ≤ 7), so we
 * bump it by one and append `07 1a <u32 BE>` (CBOR uint key 7 + 4-byte uint - * unix seconds fit u32 until 2106).
 */
const appendCborAnchorTime = (cbor: Uint8Array, unixSeconds: number): Uint8Array => {
  const t = Math.max(0, Math.floor(unixSeconds));
  if (t === 0 || cbor.length === 0) {
    return cbor;
  }
  const header = cbor[0]!;
  // only handle the definite-length single-byte map header we emit; bail safe
  // (return unchanged) if the shape is ever unexpected rather than corrupt it.
  if ((header & 0xe0) !== 0xa0 || (header & 0x1f) >= 0x17) {
    return cbor;
  }
  const out = new Uint8Array(cbor.length + 6);
  out.set(cbor, 0);
  out[0] = header + 1; // one more map entry
  const n = cbor.length;
  out[n] = 0x07; // key: uint 7
  out[n + 1] = 0x1a; // value: uint, 4-byte big-endian follows
  out[n + 2] = (t >>> 24) & 0xff;
  out[n + 3] = (t >>> 16) & 0xff;
  out[n + 4] = (t >>> 8) & 0xff;
  out[n + 5] = t & 0xff;
  return out;
};

/** blocks between comparisons of the note trees with the server's tree state */
const TREE_CHECK_INTERVAL = 5_000;
/** pause before asking the same node again about a root that differs */
const SECOND_ANSWER_DELAY_MS = 3_000;

/**
 * Heights per `GetCompactBlocks` request on the catch-up path.
 *
 * Left at 200 deliberately. Measured against zcash.rotko.net, serial
 * throughput barely moves with batch size (205 blocks/s at 200, 265 at 1000)
 * and at the depths we actually use it is a wash - the server is per-request
 * latency bound, not per-block. 200 keeps the cost of discarding a batch on
 * reorg/abort small, keeps peak worker memory at depth * ~110KB, and keeps
 * sync-progress updates frequent.
 */
const SYNC_BATCH_SIZE = 200;

/**
 * Compact-block requests in flight during catch-up. The fetch stage measured
 * 205 blocks/s at depth 1, 614 at 4, ~730 at 6 and flat past that over a
 * single HTTP/2 connection, so 6 sits at the knee: it takes the remaining
 * ~17% over depth 4 and nothing beyond it is available on one connection.
 *
 * Browsers multiplex a single HTTP/2 connection per origin, which is what
 * flattens this. A later measurement reached 544-627 blocks/s at depth 8-12,
 * but that ran under node's undici, which pools HTTP/1.1 connections - so it
 * measured multi-connection fan-out, not depth. Unlocking that region needs
 * batches sharded across 2-3 hostnames onto the same anycast edge, NOT a
 * bigger number here.
 *
 * Cost at 6: ~675KB of undecoded blocks held, and a reorg or abort throws
 * away a few hundred milliseconds of fetch.
 *
 * The real ceiling is upstream of all of this: zidecar spends ~7.5ms per
 * block serving a range (1.6s for 200 blocks, 88ms TTFB), so the client is
 * pipelining around server-side work. See docs - the fix there is an
 * append-only action log, not a client change.
 */
const SYNC_PREFETCH_DEPTH = 6;

/**
 * How stale the cached chain tip may get while catching up.
 *
 * `getTip` is a full round trip (~95ms measured) and the old loop paid it
 * once per 200-block batch. When the wallet is half a million blocks behind,
 * re-asking for the tip after every batch tells us nothing we act on; the
 * loop only needs an accurate tip as it approaches one. The cache is dropped
 * the moment the cursor reaches the cached height, so "caught up" is still
 * decided against a fresh tip, and a tip that grows during the interval only
 * delays discovering new blocks by at most this long.
 */
const TIP_CACHE_MS = 30_000;

/**
 * Mark the notes we just spent as spent, immediately, without waiting for a rescan.
 *
 * Both pools' only spend signal is the scan-time nullifier match in runSync,
 * which fires while walking the block that contains the spend. That block is
 * mined after we broadcast, so the scan reaches it later; until then the note
 * would keep counting toward the balance and could be picked for a second
 * spend.
 *
 * We know exactly which notes we spent, so record it at broadcast. Worst case
 * the transaction never mines and the note is wrongly held back, which the
 * mempool/reorg path already has to handle - strictly safer than the reverse,
 * which is double-spending a note we believe is still ours.
 */
const markNotesSpentLocally = async (
  walletId: string,
  state: WalletState,
  notes: DecryptedNote[],
  txid: string,
): Promise<void> => {
  const updated: DecryptedNote[] = [];
  const nullifiers: string[] = [];
  for (const note of notes) {
    if (state.spentNullifiers.has(note.nullifier)) {
      continue;
    }
    state.spentNullifiers.add(note.nullifier);
    note.spent_by_txid = txid;
    nullifiers.push(note.nullifier);
    updated.push(note);
  }
  if (nullifiers.length === 0) {
    return;
  }
  try {
    const db = await getDb();
    const tx = db.transaction(['notes', 'spent'], 'readwrite');
    const notesStore = tx.objectStore('notes');
    const spentStore = tx.objectStore('spent');
    for (const note of updated) {
      notesStore.put({ ...note, walletId });
    }
    for (const nf of nullifiers) {
      spentStore.put({ walletId, nullifier: nf });
    }
    // MUST await the commit. Returning early cannot observe onerror/onabort,
    // so a QuotaExceededError or a version-change abort was swallowed while
    // state.spentNullifiers had already been mutated: the wallet looked
    // correct until reload, then offered the spent note again. Every other
    // writer in this file awaits txComplete; this one did not.
    await txComplete(tx);
  } catch (e) {
    // Roll the in-memory marks back so memory cannot claim a durability the
    // store does not have - better to re-detect the spend on the next scan
    // than to believe a write that never landed.
    for (const nf of nullifiers) {
      state.spentNullifiers.delete(nf);
    }
    for (const note of updated) {
      note.spent_by_txid = undefined;
    }
    console.error(`[zcash-worker] failed to persist local spend marks: ${errText(e)}`);
    return;
  }
  console.log(
    `[zcash-worker] marked ${nullifiers.length} note(s) spent locally by ${txid.slice(0, 16)}`,
  );
};

/**
 * How many rayon threads the scan is ACTUALLY running on, and why if it is 1.
 *
 * This is exported into sync status rather than left in a console line. Every
 * bug worth finding today shared one shape: a check that degraded to a no-op
 * and reported nothing. A thread pool that silently fails to start is the same
 * shape - sync still completes, still looks normal, and merely takes several
 * times longer. Nobody notices, because the only evidence lands in a worker
 * console that has to be opened deliberately.
 *
 * `threads: 1` with a `reason` is the degraded state; the UI can say so.
 * The value rides on every sync progress message - see `scanThreads` there.
 */
export interface ScanParallelism {
  threads: number;
  reason?: string;
}

let scanParallelism: ScanParallelism = { threads: 1, reason: 'not initialized yet' };

/** batch-save notes + spent + sync height + tree sizes + tree rows in one transaction */
const saveBatch = async (
  walletId: string,
  notes: DecryptedNote[],
  spent: string[],
  syncHeight: number,
  orchardTreeSize?: number,
  updatedNotes?: DecryptedNote[],
  ironwoodTreeSize?: number,
  /** note-tree rows describing the same batch */
  treeWrites?: readonly TreeWrite[],
  /** what a rewind takes back (nullifiers), in the same transaction */
  removed?: { notes: readonly string[]; spent: readonly string[] },
): Promise<void> => {
  const db = await getDb();
  const tx = db.transaction(['notes', 'spent', 'meta'], 'readwrite');
  const notesStore = tx.objectStore('notes');
  const spentStore = tx.objectStore('spent');
  const metaStore = tx.objectStore('meta');
  for (const nf of removed?.notes ?? []) {
    notesStore.delete([walletId, nf]);
  }
  for (const nf of removed?.spent ?? []) {
    spentStore.delete([walletId, nf]);
  }
  for (const note of [...notes, ...(updatedNotes ?? [])]) {
    notesStore.put({ ...note, walletId });
  }
  for (const nf of spent) {
    spentStore.put({ walletId, nullifier: nf });
  }
  metaStore.put({ walletId, key: 'syncHeight', value: syncHeight });
  if (orchardTreeSize !== undefined) {
    metaStore.put({ walletId, key: 'orchardTreeSize', value: orchardTreeSize });
  }
  if (ironwoodTreeSize !== undefined) {
    metaStore.put({ walletId, key: 'ironwoodTreeSize', value: ironwoodTreeSize });
  }
  if (treeWrites) {
    applyTreeWrites(metaStore, walletId, treeWrites);
  }
  await txComplete(tx);
};

// ── note trees ──

/** every note-tree row of a wallet */
const readTreeRows = async (walletId: string): Promise<{ key: string; value: unknown }[]> => {
  const db = await getDb();
  const tx = db.transaction('meta', 'readonly');
  const req = tx
    .objectStore('meta')
    .getAll(IDBKeyRange.bound([walletId, 'st:'], [walletId, 'st:\uffff']));
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as { key: string; value: unknown }[]);
    req.onerror = () => reject(req.error ?? new Error('note tree rows unreadable'));
  });
};

const writeTreeRows = async (walletId: string, writes: readonly TreeWrite[]): Promise<void> => {
  if (writes.length === 0) {
    return;
  }
  const db = await getDb();
  const tx = db.transaction('meta', 'readwrite');
  applyTreeWrites(tx.objectStore('meta'), walletId, writes);
  await txComplete(tx);
};

/** mainnet NU6.3 activation: below it the ironwood tree is empty */
const NU63_MAINNET = nu63ActivationHeight(true);
/** NU5 activation, the orchard pool's first block */
const NU5_HEIGHT = { mainnet: 1_687_104, testnet: 1_842_420 } as const;

/** the server's public tree state, roots and blocks, as the trees ask for them */
const treeChain = (
  client: WitnessClient & Pick<ZcashClient, 'getSubtreeRoots'>,
  mainnet: boolean,
): TreeChain => {
  const frontierAt: TreeChain['frontierAt'] = async (pool, height) => {
    if (height <= 0) {
      return '';
    }
    const ts = await client.getTreeState(height);
    if (pool === 'orchard') {
      return ts.orchardTree;
    }
    return ts.ironwoodTree || (height < NU63_MAINNET ? '' : undefined);
  };
  return {
    frontierAt,
    async sizeAt(pool, height) {
      const f = await frontierAt(pool, height);
      if (f === undefined) {
        return undefined;
      }
      if (f === '') {
        return 0;
      }
      const size =
        pool === 'ironwood'
          ? wasmModule?.frontier_tree_size_ironwood?.(f)
          : wasmModule?.frontier_tree_size?.(f);
      return size === undefined ? undefined : Number(size);
    },
    subtreeRoots: (pool, start) => client.getSubtreeRoots(pool, start),
    blocks: (pool, from, to, signal) => fetchPoolBlocks(client, pool, from, to, signal),
    poolStart: pool =>
      pool === 'ironwood'
        ? nu63ActivationHeight(mainnet)
        : NU5_HEIGHT[mainnet ? 'mainnet' : 'testnet'],
  };
};

/**
 * Per-note witnesses the wallet stored before the trees: orchard ones on the
 * note records, ironwood ones in the `witnesses-ironwood` store.
 */
const readLegacyWitnesses = async (walletId: string, spent: ReadonlySet<string>) => {
  const [notes, rows] = await Promise.all([
    idbGetAllByIndex<LegacyNoteRecord>('notes', 'byWallet', walletId),
    idbGetAllByIndex<LegacyIronwoodRow>('witnesses-ironwood', 'byWallet', walletId),
  ]);
  const stale = notes.filter(n => n.witness_hex !== undefined || n.witness_tree_size !== undefined);
  return { byPool: legacyWitnesses(notes, rows, spent), stale, rows: rows.length };
};

/**
 * Write a run's opened trees and the sizes they end at, and drop what the
 * per-note era stored for each pool that now has a tree: the
 * `witnesses-ironwood` rows, the witness fields on orchard note records, the
 * frontier meta. A pool left without a tree (a server with no tree state for
 * it) keeps its legacy witnesses for a later run to migrate. One transaction.
 */
const saveTreeStart = async (
  walletId: string,
  stale: readonly LegacyNoteRecord[],
  treeWrites: readonly TreeWrite[],
  sizes: { orchardTreeSize: number; ironwoodTreeSize: number },
  seeded: { orchard: boolean; ironwood: boolean },
): Promise<void> => {
  const retired = retiredLegacy(seeded);
  const db = await getDb();
  const tx = db.transaction(['notes', 'meta', 'witnesses-ironwood'], 'readwrite');
  const notes = tx.objectStore('notes');
  if (retired.orchardWitnessFields) {
    for (const n of stale) {
      notes.put({ ...withoutWitness(n), walletId });
    }
  }
  if (retired.ironwoodRows) {
    const iw = tx.objectStore('witnesses-ironwood');
    const keys: IDBValidKey[] = await new Promise((resolve, reject) => {
      const req = iw.index('byWallet').getAllKeys(walletId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('witness rows unreadable'));
    });
    for (const key of keys) {
      iw.delete(key);
    }
  }
  const meta = tx.objectStore('meta');
  for (const key of retired.metaKeys) {
    meta.delete([walletId, key]);
  }
  meta.put({ walletId, key: 'orchardTreeSize', value: sizes.orchardTreeSize });
  meta.put({ walletId, key: 'ironwoodTreeSize', value: sizes.ironwoodTreeSize });
  applyTreeWrites(meta, walletId, treeWrites);
  await txComplete(tx);
};

// ── wasm ──

// Every message handler starts with `await initWasm()`, and the handlers run
// concurrently - network-worker sends `init` and the first real command back to
// back. A bare `if (wasmModule) return` guard does not survive that: both calls
// see `null` and both initialize the SAME wasm instance. The second
// `initThreadPool` then throws, gets swallowed by the fallback below, and
// scanning drops to one core for the life of the worker. `once` shares the
// in-flight promise so the initializer runs exactly once.
const initWasm = once(async (): Promise<void> => {
  // @ts-expect-error - dynamic import in worker
  const wasm = await import(/* webpackIgnore: true */ '/zafu-wasm/zafu_wasm.js');
  await wasm.default({ module_or_path: '/zafu-wasm/zafu_wasm_bg.wasm' });
  wasm.init();

  // Rayon thread pool. scan_actions_parallel is only actually parallel once a
  // pool exists - without it rayon runs sequentially, so trial decryption was
  // using ONE core no matter how many the machine has. The offscreen prover
  // has always done this; the scan worker never did.
  //
  // rayon's workerHelpers spawn sub-workers via import.meta.url, which
  // resolves wrong inside an extension worker, so the Worker constructor is
  // patched to absolute extension URLs exactly as zcash-build-parallel does.
  // Failure degrades to sequential scanning rather than breaking sync.
  const OriginalWorker = globalThis.Worker;
  try {
    const extOrigin = self.location.origin + '/';
    globalThis.Worker = class PatchedWorker extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        let urlStr = url instanceof URL ? url.href : String(url);
        if (!urlStr.startsWith(extOrigin) && !urlStr.startsWith('blob:')) {
          urlStr = extOrigin + (urlStr.startsWith('/') ? urlStr.slice(1) : urlStr);
        }
        super(urlStr, options);
      }
    };
    // Regression guard: rayon silently degrades to one thread if the realm
    // loses cross-origin isolation / SharedArrayBuffer. No COOP/COEP is set
    // anywhere - this rides on current Chrome policy for extension workers.
    // initThreadPool would NOT throw in that case, so surface it into
    // scanParallelism (the UI degradation channel) as well as a loud log.
    const isolation = assessAmbientRayonIsolation();
    if (!isolation.ok) {
      console.error(`${RAYON_ISOLATION_WARNING} (zcash scan worker: ${isolation.reason})`);
    } else if (isolation.note) {
      // ok, but worth a quiet note (e.g. no cross-origin isolation - normal in
      // an extension worker; the pool below is still real).
      console.debug(`[perf] zcash scan worker: ${isolation.note}`);
    }
    // leave a core for the UI thread; scanning runs while the popup renders
    const numThreads = Math.max(1, (navigator.hardwareConcurrency || 4) - 1);
    await wasm.initThreadPool(numThreads);
    // ok covers the SharedArrayBuffer-present case (real multi-thread pool)
    // whether or not cross-origin isolation is set.
    scanParallelism = isolation.ok
      ? { threads: numThreads }
      : { threads: numThreads, reason: `SharedArrayBuffer unavailable: ${isolation.reason}` };
    console.log(`[zcash-worker] rayon: ${numThreads} threads`);
  } catch (e) {
    // error, not warn: this is a several-fold slowdown, not a curiosity, and
    // it is recorded in scanParallelism so it reaches the UI instead of
    // living only in a console nobody opens.
    const reason = e instanceof Error ? e.message : String(e);
    scanParallelism = { threads: 1, reason };
    console.error(
      '[zcash-worker] rayon pool unavailable - scanning on ONE core, sync will be several times slower:',
      e,
    );
  } finally {
    globalThis.Worker = OriginalWorker;
  }

  wasmModule = wasm;
  console.log('[zcash-worker] wasm ready');
});

/**
 * Resolve the txid of a just-broadcast transaction.
 *
 * zidecar echoes the txid in its SendResponse, so we trust it there. Public
 * lightwalletd's standard SendResponse has no txid field, so we derive the
 * canonical ZIP-244 txid locally from the signed tx bytes - the same value
 * zidecar computes server-side and the same bytes that appear as
 * `CompactTx.hash` during sync, so the optimistic outgoing record reconciles.
 */
const resolveBroadcastTxid = async (
  result: { txid: Uint8Array },
  txHex: string,
  serverUrl: string,
): Promise<string> => {
  if (ZCASH_BACKENDS[lookupBackend(serverUrl)].echoesTxid) {
    return new TextDecoder().decode(result.txid);
  }
  await initWasm();
  if (!wasmModule) {
    throw new Error('wasm not initialized for txid computation');
  }
  // compute_txid returns INTERNAL (wire) byte order - the same bytes that
  // appear as CompactTx.hash during sync. zidecar's SendResponse, by
  // contrast, echoes the DISPLAY-order txid, so without this reversal the
  // same wallet reported two different conventions depending on backend and
  // the lightwalletd one could not be found in any explorer (it is the real
  // txid, just byte-reversed). Normalize to display order, which is what
  // users copy and what block explorers accept.
  const internal = wasmModule.compute_txid(txHex);
  return (internal.match(/../g) ?? []).reverse().join('');
};

// ── offscreen proving ──
// Halo 2 proving is CPU-intensive (~2min single-threaded). Route it through
// the offscreen document which has a persistent rayon thread pool, so MSM/FFT
// runs in parallel across all cores. The offscreen survives popup close.

// pending prove requests waiting for parent (network-worker) to relay response
const pendingProveRequests = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();
let proveRequestCounter = 0;

const proveViaOffscreen = async (req: ProveRequest): Promise<unknown> => {
  assertProveRequest(req);
  // web workers don't have chrome.runtime - relay through parent (network-worker/popup)
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

const computeFee = (
  nSpends: number,
  nZOutputs: number,
  nTOutputs: number,
  hasChange: boolean,
): bigint => {
  const nOrchardOutputs = nZOutputs + (hasChange ? 1 : 0);
  const nOrchardActions = Math.max(nSpends, nOrchardOutputs, MIN_ORCHARD_ACTIONS);
  const logicalActions = nOrchardActions + nTOutputs;
  return MARGINAL_FEE * BigInt(Math.max(logicalActions, GRACE_ACTIONS));
};

/**
 * ZIP-317 fee for the NU6.3 turnstile migration - the one transaction that
 * spans TWO shielded bundles: orchard (the spends) and ironwood (the output).
 *
 * ZIP-317 counts logical actions as the SUM over bundles, and each non-empty
 * shielded bundle is padded to MIN_ORCHARD_ACTIONS for privacy (the orchard
 * bundle gains a dummy output, the ironwood bundle a dummy spend - which is
 * why the output-only ironwood bundle still needs an anchor).
 *
 * computeFee() above models a SINGLE bundle: it collapses the ironwood output
 * into the orchard action count via max(), so a 1-note migration priced 2
 * actions (10,000 zat) for a transaction that really has 4 (20,000). zebra
 * rejected it with "Unpaid actions is higher than the limit". Overpaying is
 * safe under ZIP-317; underpaying is fatal, so the padding is applied
 * conservatively rather than guessed downward.
 */
/**
 * Is this recipient a TRANSPARENT address?
 *
 * Covers P2SH (`t3…` mainnet, `t2…` testnet) as well as P2PKH (`t1…`/`tm…`).
 * Many exchange deposit addresses are P2SH, and a `t3…` recipient that slipped
 * past a `t1`/`tm`-only check was priced as a shielded output and then handed to
 * the shielded address parser, which rejected it after note selection, fee
 * pricing and witness building. Mirrors the Rust
 * `parse_ironwood_recipient`, which decodes the base58 version bytes.
 */
const isTransparentRecipient = (addr: string): boolean => /^(t1|t3|tm|t2)/.test(addr.trim());

/**
 * Serialized size of one P2PKH `tx_in`: 32 (txid) + 4 (index) + 1 (script len)
 * + 107 (script_sig) + 4 (sequence).
 */
const P2PKH_TX_IN_SIZE = 148;
/** ZIP-317 divides the transparent byte total by this to get logical actions. */
const ZIP317_TX_BYTES_PER_ACTION = 150;

/**
 * ZIP-317 transparent-side logical actions for `n` P2PKH inputs:
 * `ceil(tx_in_total_size / 150)`.
 *
 * NOT `n`. `ceil(148n/150) === n` only while `2n < 150`; at n = 75 the byte
 * total is exactly 11_100 = 74 * 150, so the true count is 74 and every count
 * from 75 up is strictly below `n`. Using `n` overpaid one marginal fee per
 * ~75 inputs - safe for consensus (nodes only reject UNDER-payment) but a
 * wallet fingerprint on every large consolidation, since no ZIP-317-correct
 * wallet would pay it.
 *
 * Kept numerically identical to `zafu_wasm::zip317_transparent_actions` and to
 * zcli's `ops/shield.rs`; the wasm shielding builder RE-CHECKS the fee with the
 * same formula and refuses an under-payment, so these must not drift.
 */
const zip317TransparentActions = (nTInputs: number): number =>
  Math.ceil((nTInputs * P2PKH_TX_IN_SIZE) / ZIP317_TX_BYTES_PER_ACTION);

/**
 * ZIP-317 fee for a shielding transaction: one padded (2-action) shielded
 * bundle plus the transparent input side.
 *
 * Deliberately does NOT apply the user fee multiplier - the shielding paths
 * never did, and the wasm builder re-checks this exact number, so keeping it at
 * the conventional fee leaves the two in lockstep.
 */
const computeShieldFee = (nTInputs: number): bigint => {
  const logicalActions = MIN_ORCHARD_ACTIONS + zip317TransparentActions(nTInputs);
  return MARGINAL_FEE * BigInt(Math.max(logicalActions, GRACE_ACTIONS));
};

const computeTurnstileFee = (nOrchardSpends: number): bigint => {
  const orchardActions = Math.max(nOrchardSpends, MIN_ORCHARD_ACTIONS);
  const ironwoodActions = MIN_ORCHARD_ACTIONS; // single output, padded
  const logicalActions = orchardActions + ironwoodActions;
  return MARGINAL_FEE * BigInt(Math.max(logicalActions, GRACE_ACTIONS));
};

// ── note selection (largest first) ──

const selectNotes = (
  notes: DecryptedNote[],
  spentNullifiers: Set<string>,
  target: bigint,
  // a transaction spends from exactly one pool; pre-ironwood callers all
  // spend orchard, so notes without a pool tag (legacy records) qualify
  pool: NotePool = 'orchard',
  // notes the note tree already holds: when they cover the target, a send
  // never waits for the recovery of the others
  held?: (n: DecryptedNote) => boolean,
): DecryptedNote[] => {
  const unspent = notes.filter(n => !spentNullifiers.has(n.nullifier) && poolOf(n) === pool);
  if (held) {
    const ready = unspent.filter(held);
    const readyTotal = ready.reduce((sum, n) => sum + BigInt(n.value), 0n);
    if (ready.length < unspent.length && readyTotal >= target) {
      return selectNotes(ready, spentNullifiers, target, pool);
    }
  }
  unspent.sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
  const selected: DecryptedNote[] = [];
  let total = 0n;
  for (const note of unspent) {
    total += BigInt(note.value);
    selected.push(note);
    if (total >= target) {
      return selected;
    }
  }
  throw new Error(`insufficient funds: have ${total} zat, need ${target} zat`);
};

// ── blocks for the note trees ──

const TREE_FETCH_BATCH = 1000;

// Concurrent compact-block requests when a tree recovers notes (or a voting
// snapshot is replayed): bounded so a deep range never holds every payload or
// trips server stream limits.
const TREE_FETCH_CONCURRENCY = 12;

interface WitnessClient {
  getTreeState(
    h: number,
  ): Promise<{ height: number; orchardTree: string; ironwoodTree?: string; time: number }>;
  getCompactBlocks(
    start: number,
    end: number,
  ): Promise<
    {
      height: number;
      actions: { cmx: Uint8Array }[];
      ironwoodActions?: { cmx: Uint8Array }[];
    }[]
  >;
}

/** one pool's commitments for heights `start..=end`, in chain order */
const fetchPoolBlocks = async (
  client: WitnessClient,
  pool: NotePool,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<TreeBlock[]> => {
  const ranges: [number, number][] = [];
  // a short range (a dense shard: 65536 leaves in a few hundred spam-era
  // blocks) is split across the concurrent requests instead of one
  const batch = Math.max(
    1,
    Math.min(TREE_FETCH_BATCH, Math.ceil((end - start + 1) / TREE_FETCH_CONCURRENCY)),
  );
  for (let s = start; s <= end; s += batch) {
    ranges.push([s, Math.min(s + batch - 1, end)]);
  }
  const results = new Array<TreeBlock[]>(ranges.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      signal?.throwIfAborted();
      const i = next++;
      const range = ranges[i];
      if (!range) {
        return;
      }
      const bs = await client.getCompactBlocks(range[0], range[1]);
      results[i] = bs.map(b => ({
        height: b.height,
        cmxs: (pool === 'ironwood' ? (b.ironwoodActions ?? []) : b.actions).map(a => a.cmx),
      }));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(TREE_FETCH_CONCURRENCY, ranges.length) }, worker),
  );
  return results.flat();
};

/**
 * Paths at one exact past height the trees no longer retain (a voting
 * snapshot): a replay from a rounded tree state below the notes. Spends never
 * come here; they read the trees.
 */
const pathsAtSnapshot = async (
  client: WitnessClient,
  notes: DecryptedNote[],
  pool: NotePool,
  height: number,
): Promise<{ anchorHex: string; paths: unknown[] }> => {
  const lowest = Math.min(...notes.map(n => n.height));
  const from = Math.max(1, Math.floor((lowest - 1) / RECOVERY_ROUNDING) * RECOVERY_ROUNDING);
  const ts = await client.getTreeState(from);
  const frontier = pool === 'ironwood' ? (ts.ironwoodTree ?? '') : ts.orchardTree;
  const blocks = await fetchPoolBlocks(client, pool, from + 1, height);
  const json = JSON.stringify(
    blocks.map(b => ({ height: b.height, actions: b.cmxs.map(c => ({ cmx_hex: hexEncode(c) })) })),
  );
  const positions = JSON.stringify(notes.map(n => n.position));
  const wasm = wasmModule;
  const build = wasm?.build_merkle_paths_ironwood;
  if (!wasm || (pool === 'ironwood' && !build)) {
    throw new Error(`no ${pool} path builder in this wasm build`);
  }
  const raw =
    pool === 'ironwood'
      ? build!(frontier, json, positions, height)
      : wasm.build_merkle_paths(frontier, json, positions, height);
  const r = JSON.parse(raw as string) as {
    anchor_hex: string;
    paths: unknown[];
  };
  return { anchorHex: r.anchor_hex, paths: r.paths };
};

/** the zcash backend as the deposit service sees it */
const depositChain = (client: ZcashClient, serverUrl: string): DepositChain => ({
  utxos: address => client.getAddressUtxos(address),
  tip: async () => (await client.getTip()).height,
  branchId: async () => parseInt(await fetchBranchIdHex(client), 16),
  broadcast: async txHex => {
    const r = await client.sendTransaction(hexDecode(txHex));
    if (r.errorCode !== 0) {
      throw new Error(`broadcast failed (${r.errorCode}): ${r.errorMessage}`);
    }
    return resolveBroadcastTxid(r, txHex, serverUrl);
  },
});

/**
 * Record an outgoing transaction the moment it is broadcast.
 *
 * Deliberately best-effort: a failure here must never fail a send that the
 * network has already accepted. The chain remains the authority on whether it
 * confirmed - this only preserves the details the chain cannot give back.
 */
const recordSentTx = async (rec: SentTxRecord): Promise<void> => {
  try {
    const db = await getDb();
    const tx = db.transaction('sent', 'readwrite');
    tx.objectStore('sent').put(rec);
    await txComplete(tx);
  } catch (e) {
    console.warn(`[zcash-worker] could not record sent tx locally: ${errText(e)}`);
  }
};

/**
 * Persist what reconciliation learned: heights for sends the chain has now
 * confirmed, and the removal of sends that provably can no longer be mined.
 *
 * Best-effort like the write above. History has already been rendered from the
 * reconciled view by the time this runs; failing to persist only means the
 * same conclusion gets recomputed on the next pass.
 */
const applyReconciliation = async (
  walletId: string,
  confirm: { txid: string; height: number }[],
  prune: string[],
): Promise<void> => {
  if (confirm.length === 0 && prune.length === 0) {
    return;
  }
  try {
    const db = await getDb();
    const tx = db.transaction('sent', 'readwrite');
    const store = tx.objectStore('sent');
    for (const { txid, height } of confirm) {
      const req = store.get([walletId, txid]);
      req.onsuccess = () => {
        const existing = req.result as SentTxRecord | undefined;
        if (existing) {
          store.put({ ...existing, confirmedHeight: height });
        }
      };
    }
    for (const txid of prune) {
      store.delete([walletId, txid]);
    }
    await txComplete(tx);
  } catch (e) {
    console.warn(`[zcash-worker] could not persist sent-tx reconciliation: ${errText(e)}`);
  }
};

/**
 * ── cold-send continuity ──────────────────────────────────────────────────
 *
 * A hot send is one worker message: it selects the notes, builds, signs,
 * broadcasts, and - because everything it needs is still in scope - marks the
 * inputs spent and writes the local `sent` record on the way out.
 *
 * A cold send (zigner / Keystone / Ledger / watch-only) is TWO messages with a
 * human and a signing device in between. The BUILD message knows the inputs,
 * the amount, the fee, the recipient and the memo; the COMPLETE message that
 * eventually broadcasts knows only the signed bytes. So the completion sites
 * could not have called markNotesSpentLocally / recordSentTx even if they had
 * wanted to: the facts were not there.
 *
 * They are now. The build stashes what it knows against a generated id, the
 * unsigned result carries that id out to the UI, and the completion hands it
 * back. Persisted in the `meta` store rather than a module variable because the
 * worker is owned by the popup document: it does not survive the popup being
 * closed while the user walks to their signing device, and neither would an
 * in-memory map.
 *
 * Consequences of getting this wrong are asymmetric, so the resolution is
 * deliberately conservative - see takeColdSend.
 */
interface ColdSendContext {
  id: string;
  /** nullifiers of the notes this transaction spends */
  nullifiers: string[];
  /** zatoshi leaving the wallet, excluding fee */
  amount: string;
  fee: string;
  recipient: string;
  pool: SentPool;
  kind: SentKind;
  memo?: string;
  createdAt: number;
}

const COLD_SEND_META_KEY = 'pendingColdSends';
/**
 * A stash older than this is not a cold send waiting to be signed, it is one
 * that was abandoned. Expiring them keeps a stale entry from ever being
 * attached to an unrelated transaction.
 */
const COLD_SEND_TTL_MS = 24 * 60 * 60 * 1000;
/** Cap the stash so an abandoned-build loop cannot grow the meta record forever. */
const COLD_SEND_MAX = 8;

const readColdSends = async (walletId: string): Promise<ColdSendContext[]> => {
  const r = await idbGet<{ value: ColdSendContext[] }>('meta', [walletId, COLD_SEND_META_KEY]);
  const list = Array.isArray(r?.value) ? r.value : [];
  const cutoff = Date.now() - COLD_SEND_TTL_MS;
  return list.filter(c => c.createdAt >= cutoff);
};

const writeColdSends = async (walletId: string, list: ColdSendContext[]): Promise<void> => {
  const db = await getDb();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ walletId, key: COLD_SEND_META_KEY, value: list });
  await txComplete(tx);
};

/**
 * Record what a cold build knows, and return the id the completion needs to
 * find it again. Best-effort: failing to stash must never fail a build the user
 * can still sign and broadcast - it only costs the bookkeeping below.
 */
const stashColdSend = async (
  walletId: string,
  ctx: Omit<ColdSendContext, 'id' | 'createdAt'>,
): Promise<string | undefined> => {
  try {
    const id = crypto.randomUUID();
    const list = await readColdSends(walletId);
    list.push({ ...ctx, id, createdAt: Date.now() });
    await writeColdSends(walletId, list.slice(-COLD_SEND_MAX));
    return id;
  } catch (e) {
    console.warn(`[zcash-worker] could not stash cold-send context: ${errText(e)}`);
    return undefined;
  }
};

/**
 * Consume the context for a completing cold send.
 *
 * Requires the id the build handed out. There is deliberately NO "just use the
 * most recent one" fallback: attaching the wrong context marks notes this
 * transaction did not spend, which is how a wallet loses access to its own
 * money. An unmatched completion is logged and left to the block scan, which is
 * slower but cannot be wrong.
 */
const takeColdSend = async (
  walletId: string,
  id: string | undefined,
): Promise<ColdSendContext | undefined> => {
  if (!id) {
    return undefined;
  }
  try {
    const list = await readColdSends(walletId);
    const found = list.find(c => c.id === id);
    await writeColdSends(
      walletId,
      list.filter(c => c.id !== id),
    );
    return found;
  } catch (e) {
    console.warn(`[zcash-worker] could not read cold-send context: ${errText(e)}`);
    return undefined;
  }
};

/**
 * The tail of a cold broadcast: mark the inputs spent and write the local
 * record, exactly as the hot paths do at the same point.
 *
 * Without this the flagship configuration - every cold signer - kept counting
 * spent notes toward its balance until a rescan, re-offered them to the next
 * send, and lost the recipient / memo / fee for good, none of which the chain
 * can give back.
 *
 * Best-effort throughout: the network has already accepted the transaction by
 * the time we get here, so nothing in this function may throw its way out.
 */
const finalizeColdBroadcast = async (
  walletId: string,
  coldSendId: string | undefined,
  txid: string,
  txHex: string,
): Promise<void> => {
  try {
    const ctx = await takeColdSend(walletId, coldSendId);
    if (!ctx) {
      console.warn(
        `[zcash-worker] cold broadcast ${txid.slice(0, 16)} has no build context ` +
          `(id=${coldSendId ?? 'absent'}); spend marks and the local send record are ` +
          'left to the block scan',
      );
      return;
    }
    const state = await loadState(walletId);
    const wanted = new Set(ctx.nullifiers);
    const notes = state.notes.filter(n => wanted.has(n.nullifier));
    if (notes.length !== ctx.nullifiers.length) {
      // A rescan between build and broadcast can empty the note store. Say so
      // rather than silently marking a subset.
      console.warn(
        `[zcash-worker] cold broadcast ${txid.slice(0, 16)}: ${notes.length}/${ctx.nullifiers.length} ` +
          'input notes still present locally',
      );
    }
    await markNotesSpentLocally(walletId, state, notes, txid);
    await recordSentTx({
      walletId,
      txid,
      amount: ctx.amount,
      fee: ctx.fee,
      recipient: ctx.recipient,
      pool: ctx.pool,
      kind: ctx.kind,
      memo: ctx.memo,
      sentAt: Date.now(),
      // read from the bytes the network actually saw, so the record cannot
      // disagree with the transaction about when it dies
      expiryHeight: parseExpiryHeight(txHex),
    });
  } catch (e) {
    console.error(`[zcash-worker] cold broadcast bookkeeping failed: ${errText(e)}`);
  }
};

/**
 * Spend paths for `notes`, read from the pool's note tree at its newest
 * checkpoint at or below `anchorHeight`. Never fetches a block: notes the tree
 * does not hold yet are the sync loop's to recover, and a send waits only for a
 * recovery already running. The tree's root must equal the server's at the
 * anchor, which is returned with the paths.
 */
const buildWitnesses = async (
  client: WitnessClient,
  walletId: string,
  notes: DecryptedNote[],
  anchorHeight: number,
  pool: NotePool = 'orchard',
): Promise<{ anchorHex: string; anchorHeight: number; paths: unknown[] }> => {
  const Ctor = wasmModule?.NoteTree;
  if (!wasmModule || !Ctor) {
    throw new Error('wasm not initialized');
  }
  if (notes.length === 0) {
    throw new Error('buildWitnesses called with no notes');
  }
  const t0 = performance.now();
  const loop = walletStates.get(walletId);
  const live = loop?.stop && !loop.stop.signal.aborted ? loop : undefined;
  // a send of notes the tree holds never waits for a recovery; one that needs
  // a lost note waits for the pass in progress (one shard step, bounded)
  const liveTree = live?.noteTrees?.get(pool);
  if (!liveTree || notes.some(n => !liveTree.is_marked(n.position))) {
    await live?.treeRecovery?.catch(() => undefined);
  }
  let tree = live?.noteTrees?.get(pool);
  let owned: NoteTree | undefined;
  if (!tree) {
    owned = loadTree(await readTreeRows(walletId), pool, () => new Ctor(MAX_CHECKPOINTS));
    tree = owned;
  }
  try {
    // read in one synchronous step: a live sync cannot move the tree in between
    const r = tree
      ? treePaths(
          tree,
          notes.map(n => n.position),
          anchorHeight,
        )
      : 'no note tree yet';
    if (typeof r === 'string') {
      console.warn(`[zcash-timing] ${pool} witnesses: ${r}`);
      throw syncError('chain-recovery', `${pool} notes are still being prepared: ${r}`);
    }
    const ts = await client.getTreeState(r.anchorHeight);
    const frontier = pool === 'ironwood' ? ts.ironwoodTree : ts.orchardTree;
    const serverRoot =
      frontier === undefined
        ? undefined
        : pool === 'ironwood'
          ? wasmModule.tree_root_hex_ironwood?.(frontier)
          : wasmModule.tree_root_hex(frontier);
    if (serverRoot !== r.rootHex) {
      // the sync loop compares the tree with the server and reseeds it
      throw syncError(
        'chain-recovery',
        `${pool} note tree root at ${r.anchorHeight} differs from the server's`,
      );
    }
    console.log(
      `[zcash-timing] ${pool} witnesses: notes=${notes.length} anchor=${r.anchorHeight} ` +
        `ms=${Math.round(performance.now() - t0)}`,
    );
    return { anchorHex: r.rootHex, anchorHeight: r.anchorHeight, paths: r.paths };
  } finally {
    owned?.free();
  }
};

const walletKeysFor = (mnemonic: string, account: number): WalletKeys => {
  if (!wasmModule) {
    throw new Error('wasm not initialized');
  }
  return pocketWalletKeys(wasmModule.WalletKeys, mnemonic, account);
};

const deriveAddress = (
  mnemonic: string,
  accountIndex: number,
  diversifierHex?: string,
  pocket = 0,
): string => {
  const keys = walletKeysFor(mnemonic, pocket);
  try {
    // accountIndex is really a u32 diversifier index; receive passes the full
    // 11-byte random one instead
    const raw = diversifierHex
      ? keys.get_receiving_address_at_index(diversifierHex, true)
      : keys.get_receiving_address_at(accountIndex, true);
    return fixOrchardAddress(raw, true);
  } finally {
    keys.free();
  }
};

// ── mempool snapshot decode (shared between watcher task and any future caller) ──

/**
 * Decode one mempool snapshot against the wallet's IVK + spend nullifier set,
 * post a `mempool-update` message if anything matched. Pure: doesn't touch
 * wallet state, doesn't talk to network.
 *
 * Wire-compatible with the previous inline implementation so the UI doesn't
 * need to change.
 */
/**
 * Cap on the number of actions we'll ever pack into a single trial-decrypt
 * call. A single mempool tx is bounded by the consensus action limit
 * (≪ 1000 in practice); a whole mempool snapshot stays well under 100k
 * unless the server is hostile. Mirrors the DoS-hardening cap added for
 * ur_decode_frames (staging 686d174).
 */
const MAX_MEMPOOL_ACTIONS = 100_000;

/** Per-action wire layout the WASM trial-decrypt expects. */
const ACTION_NULLIFIER_LEN = 32;
const ACTION_CMX_LEN = 32;
const ACTION_EPHEMERAL_KEY_LEN = 32;
/**
 * 52 bytes = the start of the ENCRYPTED note (ZIP-225 compact ciphertext). Its
 * plaintext begins version (0x02 orchard / 0x03 ironwood) || d || v || rseed,
 * but that is only readable after trial decryption, which checks the version.
 */
const ACTION_COMPACT_CT_LEN = 52;
const ACTION_SIZE =
  ACTION_NULLIFIER_LEN + ACTION_CMX_LEN + ACTION_EPHEMERAL_KEY_LEN + ACTION_COMPACT_CT_LEN;

function handleMempoolSnapshot(
  walletId: string,
  state: WalletState,
  snap: {
    entries: readonly {
      hash: Uint8Array;
      actions: readonly {
        nullifier: Uint8Array;
        cmx: Uint8Array;
        ephemeralKey: Uint8Array;
        ciphertext: Uint8Array;
      }[];
    }[];
  },
): void {
  if (!state.keys) {
    return;
  }

  // Defensive: walk entries once to (a) bound work, (b) reject malformed
  // actions explicitly rather than silently zero-padding a slot (which the
  // WASM parser would happily accept as a garbage action). A hostile
  // server can't get us to mis-align the buffer or run a multi-GB alloc.
  interface ValidAction {
    nullifier: Uint8Array;
    cmx: Uint8Array;
    ephemeralKey: Uint8Array;
    ciphertext: Uint8Array; // first ACTION_COMPACT_CT_LEN bytes
    txidHex: string;
  }
  const valid: ValidAction[] = [];
  let rejected = 0;

  for (const entry of snap.entries) {
    const txidHex = hexEncode(entry.hash);
    for (const a of entry.actions) {
      const ok =
        a.nullifier.length === ACTION_NULLIFIER_LEN &&
        a.cmx.length === ACTION_CMX_LEN &&
        a.ephemeralKey.length === ACTION_EPHEMERAL_KEY_LEN &&
        // No note-version check here: these bytes are the start of the
        // ENCRYPTED note, so a version byte is not readable before trial
        // decryption, which checks it per domain (orchard 0x02, ironwood 0x03).
        a.ciphertext.length >= ACTION_COMPACT_CT_LEN;

      if (!ok) {
        rejected += 1;
        continue;
      }
      if (valid.length >= MAX_MEMPOOL_ACTIONS) {
        // Hard stop - log once per snapshot, don't continue inspecting.
        console.warn(
          `[zcash-worker] mempool snapshot exceeded ${MAX_MEMPOOL_ACTIONS} actions; truncating`,
        );
        break;
      }
      valid.push({
        nullifier: a.nullifier,
        cmx: a.cmx,
        ephemeralKey: a.ephemeralKey,
        ciphertext: a.ciphertext.subarray(0, ACTION_COMPACT_CT_LEN),
        txidHex,
      });
    }
    if (valid.length >= MAX_MEMPOOL_ACTIONS) {
      break;
    }
  }

  if (rejected > 0) {
    console.warn(`[zcash-worker] mempool: rejected ${rejected} malformed action(s)`);
  }
  if (valid.length === 0) {
    return;
  }

  // Pack the validated actions into the binary layout the WASM parser
  // consumes. Every slice write is guaranteed-sized; the offset advances
  // by a constant per action, so a corrupted snapshot can't desync the
  // stream.
  const mbuf = new Uint8Array(4 + valid.length * ACTION_SIZE);
  const mview = new DataView(mbuf.buffer);
  mview.setUint32(0, valid.length, true);
  let moff = 4;

  // map from nullifier-hex back to the txid that contains it
  const mempoolNullifiers = new Map<string, string>();

  for (const v of valid) {
    mbuf.set(v.nullifier, moff);
    moff += ACTION_NULLIFIER_LEN;
    mbuf.set(v.cmx, moff);
    moff += ACTION_CMX_LEN;
    mbuf.set(v.ephemeralKey, moff);
    moff += ACTION_EPHEMERAL_KEY_LEN;
    mbuf.set(v.ciphertext, moff);
    moff += ACTION_COMPACT_CT_LEN;
    mempoolNullifiers.set(hexEncode(v.nullifier), v.txidHex);
  }

  // `txid` on pendingIncoming is misleading - pre-confirmation we only have
  // the note's cmx. The field carries that until the block scan can replace
  // it with a real txid. UI consumers must treat it as an opaque identifier,
  // not a transaction hash.
  const pendingIncoming: { value: string; cmx: string; isChange: boolean }[] = [];
  const pendingSpends: { nullifier: string; txid: string }[] = [];

  try {
    const found = state.keys.scan_actions_parallel(mbuf);
    for (const note of found) {
      pendingIncoming.push({
        value: note.value,
        cmx: note.cmx,
        isChange: note.is_change ?? false,
      });
    }
  } catch (err) {
    console.log(`[zcash-worker] mempool scan decrypt error: ${errText(err)}`);
  }

  for (const note of state.notes) {
    if (!state.spentNullifiers.has(note.nullifier) && mempoolNullifiers.has(note.nullifier)) {
      pendingSpends.push({
        nullifier: note.nullifier,
        txid: mempoolNullifiers.get(note.nullifier)!,
      });
    }
  }

  if (pendingIncoming.length > 0 || pendingSpends.length > 0) {
    console.log(
      `[zcash-worker] mempool: ${pendingIncoming.length} incoming, ${pendingSpends.length} pending spends`,
    );
    workerSelf.postMessage({
      type: 'mempool-update',
      id: '',
      network: 'zcash',
      walletId,
      payload: { pendingIncoming, pendingSpends },
    });
  }
}

// ── sync ──

type SyncArgs = [
  walletId: string,
  mnemonic: string,
  serverUrl: string,
  startHeight?: number,
  ufvk?: string,
  backend?: ZcashBackend,
  mempoolWatch?: 'off' | 'on',
];

/** start (or restart) a wallet's sync; it resumes from what the run before it saved */
const runSync = (...args: SyncArgs): Promise<void> => {
  const walletId = args[0];
  const state = getOrCreateWalletState(walletId);
  return startRun(
    state,
    async signal => {
      try {
        // a store wiped under the run restarts it from what is stored
        while ((await syncLoop(state, signal, ...args)) === 'restart' && !signal.aborted) {
          console.warn(`[zcash-worker] restarting sync wallet=${walletId} from the stored height`);
        }
      } catch (err) {
        // everything outside the batch loop's own retries: opening the store,
        // deriving keys, sizing the stored frontier. The window offers to try
        // again, which resumes from the stored height.
        console.error(`[zcash-worker] runSync fatal: ${errText(err)}`, err);
        if (!signal.aborted) {
          workerSelf.postMessage({
            type: 'sync-error',
            id: '',
            network: 'zcash',
            walletId,
            payload: {
              message: err instanceof Error ? err.message : String(err),
              stalled: true,
              ...(syncErrorCodeOf(err) ? { code: syncErrorCodeOf(err) } : {}),
            },
          });
        }
      }
      console.log(`[zcash-worker] sync stopped wallet=${walletId}`);
    },
    () => workerSelf.postMessage({ type: 'sync-stopped', id: '', network: 'zcash', walletId }),
  );
};

const syncLoop = async (
  state: WalletState,
  signal: AbortSignal,
  walletId: string,
  mnemonic: string,
  serverUrl: string,
  startHeight?: number,
  ufvk?: string,
  backend: ZcashBackend = lookupBackend(serverUrl),
  mempoolWatch: 'off' | 'on' = 'off',
): Promise<'restart' | undefined> => {
  if (!wasmModule) {
    throw new Error('wasm not initialized');
  }
  // the previous run's trees are not this run's; they are opened below
  state.noteTrees?.free();
  state.noteTrees = undefined;

  // free old keys if re-syncing
  if (state.keys) {
    state.keys.free();
    state.keys = null;
  }

  await registerWallet(walletId);
  // use WatchOnlyWallet for UFVK (zigner), WalletKeys for mnemonic
  if (ufvk) {
    state.keys = wasmModule.WatchOnlyWallet.from_ufvk(ufvk);
    console.log(`[zcash-worker] created WatchOnlyWallet from UFVK for wallet=${walletId}`);
  } else {
    state.keys = walletKeysFor(mnemonic, parsePocketStoreId(walletId).account);
  }
  await loadState(walletId);

  const syncedHeight = await getSyncHeight(walletId);
  // use whichever is higher - prevents re-scanning if chrome.storage was stale
  let currentHeight = Math.max(startHeight ?? 0, syncedHeight);

  // The store under this run: the last height it saved, and the lost
  // connections it has checked. After a reconnect, a store that no longer
  // holds what this run saved was wiped (see store-reset.ts): the run stops
  // and starts again from what is stored, never from its in-memory height.
  let lastSaved = syncedHeight;
  let lostSeen = dbLost;
  const storeWasReset = async (): Promise<boolean> => {
    if (lostSeen === dbLost) {
      return false;
    }
    lostSeen = dbLost;
    const [stored, wallets] = await Promise.all([getSyncHeight(walletId), listWallets()]);
    const behind = storeFellBehind({ stored, walletKnown: wallets.includes(walletId), lastSaved });
    if (behind) {
      console.warn(
        `[zcash-worker] the store was reset under sync (stored=${stored}, last saved=${lastSaved}); not scanning on from ${currentHeight}`,
      );
    }
    return behind;
  };
  let restart = false;

  const client = makeZcashClient(serverUrl, backend);
  // proofs, the actions commitment and mempool watch are
  // zidecar's; on a standard lightwalletd this is undefined and none of them run
  const zidecar = zidecarExtras(serverUrl, backend);

  // Tree sizes give each found note its position. The note trees end at the
  // same sizes and the same height: both are written with every batch.
  let orchardTreeSize = await getTreeSize(walletId);
  let ironwoodTreeSize = await getIronwoodTreeSize(walletId);
  const iwSupported = !!wasmModule.tree_root_hex_ironwood;
  const TreeCtor = wasmModule.NoteTree;
  if (!TreeCtor) {
    throw new Error('this wasm build has no note trees');
  }
  // a stop that lands while the store opens must not be followed by a fetch
  if (signal.aborted) {
    return;
  }
  // load the trees, or seed them from the server at this height, taking the
  // per-note witnesses an older version stored (then those are dropped)
  const legacy = await readLegacyWitnesses(walletId, state.spentNullifiers);
  const mainnet = (state.keys as { is_mainnet?: () => boolean } | null)?.is_mainnet?.() ?? true;
  const trees = await openTrees(
    () => new TreeCtor(MAX_CHECKPOINTS),
    treeChain(client, mainnet),
    await readTreeRows(walletId),
    [
      {
        pool: 'orchard',
        height: currentHeight,
        size: orchardTreeSize,
        legacy: legacy.byPool.orchard,
      },
      ...(iwSupported
        ? [
            {
              pool: 'ironwood' as const,
              height: currentHeight,
              size: ironwoodTreeSize,
              legacy: legacy.byPool.ironwood,
            },
          ]
        : []),
    ],
  );
  orchardTreeSize = trees.size('orchard') ?? orchardTreeSize;
  ironwoodTreeSize = trees.size('ironwood') ?? ironwoodTreeSize;
  await saveTreeStart(
    walletId,
    legacy.stale,
    trees.takeWrites(),
    { orchardTreeSize, ironwoodTreeSize },
    { orchard: !!trees.get('orchard'), ironwood: !!trees.get('ironwood') },
  );
  state.noteTrees = trees;
  // notes the trees do not hold are recovered once the loop is caught up, a
  // shard at a time for at most RECOVERY_BUDGET_MS per pass, so the loop keeps
  // scanning in between; a shard that fails waits (with backoff) while the
  // others go on. Returns true while notes are left to recover.
  let recoverDue = true;
  const unspentOf = (pool: TreePool) =>
    state.notes.filter(n => poolOf(n) === pool && !state.spentNullifiers.has(n.nullifier));
  const recoverLost = async (): Promise<boolean> => {
    let pending = false;
    const job = (async () => {
      const progress: Record<string, RecoveryProgress> = {};
      for (const pool of ['orchard', 'ironwood'] as const) {
        const p = await trees.recover(pool, unspentOf(pool), signal);
        // each finished shard is written at once: a stop resumes from here
        await writeTreeRows(walletId, trees.takeWrites());
        progress[pool] = p;
        // notes in a shard that failed wait for its retry, not for this loop
        pending ||= p.left > p.waiting;
      }
      const left = progress['orchard']!.left + progress['ironwood']!.left;
      const recovered = progress['orchard']!.recovered + progress['ironwood']!.recovered;
      if (left > 0 || recovered > 0) {
        const waiting = progress['orchard']!.waiting + progress['ironwood']!.waiting;
        console.log(
          `[zcash-worker] note recovery: ${recovered} marked, ${left} left (${waiting} waiting for a retry)`,
        );
        // the sync strip says how many notes are still being prepared
        workerSelf.postMessage({
          type: 'sync-progress',
          id: '',
          network: 'zcash',
          walletId,
          payload: { preparing: left },
        });
      }
      return left > 0;
    })();
    state.treeRecovery = job.then(() => undefined);
    try {
      const left = await job;
      recoverDue = left;
    } catch (e) {
      recoverDue = true;
      if (!signal.aborted) {
        console.warn(`[zcash-worker] note recovery failed, retrying later: ${errText(e)}`);
      }
    } finally {
      state.treeRecovery = undefined;
    }
    return pending;
  };

  console.log(
    `[zcash-worker] sync start wallet=${walletId} height=${currentHeight} treeSize=${orchardTreeSize} (idb=${syncedHeight}, requested=${startHeight ?? 'none'})`,
  );

  // emit initial sync-progress so UI gets persisted height + can fetch balance immediately
  workerSelf.postMessage({
    type: 'sync-progress',
    id: '',
    network: 'zcash',
    walletId,
    payload: {
      currentHeight,
      chainHeight: currentHeight,
      notesFound: state.notes.length,
      blocksScanned: 0,
    },
  });

  let consecutiveErrors = 0;
  /** the last failure logged: a node that stays down prints one line, not one per try */
  let lastErrLine: string | undefined;

  // ── chain-continuity recovery ──
  //
  // A commitment-tree root disagreement between our stored tree and the one
  // the endpoint serves is NOT a user-facing failure: it is the expected
  // consequence of scanning a chain whose tip moves under us, and the wallet
  // recovers from it by rewinding its scan cursor and reading the range
  // again. Ported from vizor's sync engine (rust/src/wallet/sync_engine):
  // rewind with an escalating distance (10 → 100 → 1000 blocks, because a
  // stale local tree can disagree over a far wider range than a one-block
  // reorg), at most MAX_REWINDS_PER_RUN times per run, logged at warn. Only
  // once that budget is spent does the failure become visible - as
  // `chainRecovery`, never as the raw "tree root mismatch at height N".
  let rewindsThisRun = 0;
  // Never rewind below what this wallet was asked to scan from; there is
  // nothing to re-read there and it would only re-walk the birthday gap.
  const rewindFloor = Math.max(0, startHeight ?? 0);

  /** rewind toward `target`; returns the height the trees and the store now stand at */
  const rewindScanCursor = async (target: number): Promise<number> => {
    // Land on a checkpoint every tree retains, so they roll back in place; a
    // rewind deeper than that reseeds them from the server's tree state there
    // and the notes below are recovered once the loop is caught up.
    const landed = await trees.rewind(target, rewindFloor);
    orchardTreeSize = trees.size('orchard') ?? orchardTreeSize;
    ironwoodTreeSize = trees.size('ironwood') ?? ironwoodTreeSize;
    recoverDue = true;
    // What the range above `landed` taught the wallet goes with it: its notes
    // and the spends seen in it (rewind-purge.ts). After a reorg they may no
    // longer exist; the ones that do come back as the range is read again.
    const stored = await idbGetAllByIndex<DecryptedNote>('notes', 'byWallet', walletId);
    const known = new Map(stored.map(n => [n.nullifier, n]));
    for (const n of state.notes) {
      known.set(n.nullifier, n);
    }
    const { drop, unspend } = rewindPurge([...known.values()], landed);
    await saveBatch(
      walletId,
      [],
      [],
      landed,
      orchardTreeSize,
      unspend.map(n => ({ ...n, spent_by_txid: undefined, spent_at_height: undefined })),
      iwSupported ? ironwoodTreeSize : undefined,
      trees.takeWrites(),
      {
        notes: drop.map(n => n.nullifier),
        spent: [...drop, ...unspend].map(n => n.nullifier),
      },
    );
    target = landed;
    // a read of the store that began before this rewind reads again
    state.rewinds = (state.rewinds ?? 0) + 1;

    // Re-scanning a range re-pushes the notes it finds onto `state.notes`,
    // which is a plain array - leaving the already-known ones in place would
    // double-count them in the balance.
    state.notes = state.notes.filter(n => n.height <= target);
    for (const n of state.notes) {
      if ((n.spent_at_height ?? 0) > target) {
        n.spent_by_txid = undefined;
        n.spent_at_height = undefined;
      }
    }
    for (const n of [...drop, ...unspend]) {
      state.spentNullifiers.delete(n.nullifier);
    }
    if (drop.length || unspend.length) {
      console.warn(
        `[zcash-worker] rewound to ${landed}: ${drop.length} notes and ${unspend.length} spends above it are read again`,
      );
    }
    return landed;
  };

  const serverTree = (pool: TreePool, ts: { orchardTree: string; ironwoodTree?: string }) => {
    if (pool === 'orchard') {
      return { frontier: ts.orchardTree, root: wasmModule!.tree_root_hex(ts.orchardTree) };
    }
    const iwRoot = wasmModule!.tree_root_hex_ironwood;
    return ts.ironwoodTree && iwRoot
      ? { frontier: ts.ironwoodTree, root: iwRoot(ts.ironwoodTree) }
      : undefined;
  };
  /**
   * A second answer before a tree that differs is replaced: the same node a
   * moment later (a node behind a balancer that answered from a lagging
   * backend, most often). FlyClient chain verification is to replace this.
   */
  const secondAnswer = (pool: TreePool, height: number) => async () => {
    await sleepUnlessAborted(signal, SECOND_ANSWER_DELAY_MS);
    signal.throwIfAborted();
    return serverTree(pool, await client.getTreeState(height));
  };
  /** compare both trees with the server's tree state at `height`; true when one was reseeded */
  const checkTrees = async (
    height: number,
    ts: { orchardTree: string; ironwoodTree?: string },
  ): Promise<boolean> => {
    // a proven chain is the authority on the trees: the server's tree state
    // then only seeds a dropped tree, it never replaces one that differs
    const again = (pool: TreePool) => (proofThisRun ? undefined : secondAnswer(pool, height));
    const reseeded = await trees.check(
      'orchard',
      height,
      serverTree('orchard', ts),
      again('orchard'),
    );
    const iwServer = serverTree('ironwood', ts);
    const iw = iwServer
      ? await trees.check('ironwood', height, iwServer, again('ironwood'))
      : false;
    orchardTreeSize = trees.size('orchard') ?? orchardTreeSize;
    ironwoodTreeSize = trees.size('ironwood') ?? ironwoodTreeSize;
    return reseeded || iw;
  };

  /**
   * Trees whose root at `height` is not the chain's read blocks the chain no
   * longer has: a reorg, or a node serving blocks its proof does not back.
   * The scan cursor is rewound and the range read again, which takes back the
   * notes and spends found in it, once `confirmed` (a proven root needs no
   * second answer; the server's tree state does). Bounded twice over, so a
   * server cannot make the wallet re-read at will: the run's rewind budget,
   * and MISMATCH_REWINDS_PER_WINDOW per wallet per hour (stored). Past
   * either, the reseed rule of `check` applies. True when the cursor moved.
   */
  const rewindOnMismatch = async (
    height: number,
    pools: readonly TreePool[],
    confirmed: () => Promise<boolean>,
  ): Promise<boolean> => {
    if (pools.length === 0 || rewindsThisRun >= MAX_REWINDS_PER_RUN) {
      return false;
    }
    const target = Math.max(rewindFloor, height - rewindDistanceForAttempt(rewindsThisRun));
    if (target >= height || !(await confirmed())) {
      return false;
    }
    const earlier = (await idbGet<{ value: number[] }>('meta', [walletId, 'mismatchRewinds']))
      ?.value;
    const history = allowMismatchRewind(Array.isArray(earlier) ? earlier : [], Date.now());
    if (!history) {
      console.warn(
        `[zcash-worker] ${pools.join(' and ')} note tree root at ${height} differs, rewind refused: ` +
          'enough were taken this hour',
      );
      return false;
    }
    await idbPutMeta(walletId, 'mismatchRewinds', history);
    rewindsThisRun++;
    console.warn(
      `[zcash-worker] ${pools.join(' and ')} note tree root at ${height} differs from the chain's; ` +
        `rewinding to ${target} (attempt ${rewindsThisRun}/${MAX_REWINDS_PER_RUN})`,
    );
    currentHeight = await rewindScanCursor(target);
    lastSaved = currentHeight;
    workerSelf.postMessage({
      type: 'sync-progress',
      id: '',
      network: 'zcash',
      walletId,
      payload: {
        currentHeight,
        chainHeight: currentHeight,
        notesFound: state.notes.length,
        blocksScanned: 0,
      },
    });
    return true;
  };

  /** rewind when the server's tree state at `height` differs, twice (the same node a moment later) */
  const rewindOnServerMismatch = (
    height: number,
    ts: { orchardTree: string; ironwoodTree?: string },
  ) => {
    const pools = (['orchard', 'ironwood'] as const).filter(pool =>
      trees.differs(pool, height, serverTree(pool, ts)?.root),
    );
    return rewindOnMismatch(height, pools, async () => {
      let agreed = false;
      for (const pool of pools) {
        const second = await secondAnswer(pool, height)().catch(() => undefined);
        agreed ||= !!second && second.root === serverTree(pool, ts)?.root;
      }
      return agreed && trees.differs(pools[0]!, height, serverTree(pools[0]!, ts)?.root);
    });
  };

  // ── chain check (FlyClient, see fly-verify.ts) ──
  // At the start of the run and once more when it first catches up after
  // reading blocks; never on every new block (a proof is ~1.5 MB).
  const flyTipKey = [`chain:${mainnet ? 'main' : 'test'}`, 'flyTip'];
  let proofThisRun = false;
  /** the run's last chain check, as the page stores it */
  let chainRecord: ZcashChainCheck | undefined;
  /** what the node said it is in this run's GetLightdInfo, shown beside the chain check */
  let nodeInfo: NodeInfo | undefined;
  /** proven roots not yet compared with the trees */
  let proven: ProvenChain | undefined;
  let readBlocks = false;
  let checkedAtCatchUp = false;
  const checkNodeChain = async (): Promise<void> => {
    const lastTip = (await idbGet<{ value: number }>('meta', flyTipKey))?.value ?? 0;
    // a node that proved its chain once must keep proving it (no quiet downgrade)
    const provedKey = `proved:${backendKey(serverUrl)}`;
    const provedBefore = !!(await idbGet<{ value: boolean }>('meta', [flyTipKey[0]!, provedKey]))
      ?.value;
    const check = await checkChain({
      mainnet,
      fetchProof: zidecar && (() => zidecar.getFlyClientProof(FLY_BURIAL, FLY_PROOF_MAX_BYTES)),
      verify: (...a) => wasmModule!.verify_flyclient(...a),
      lastTip,
      provedBefore,
    });
    chainRecord = {
      serverUrl,
      status: check.status,
      ...(nodeInfo && { node: nodeInfo }),
      ...(check.status === 'unverified' && { reason: check.reason }),
      ...(check.status === 'checked' && {
        tip: check.chain.tip_height,
        depth: check.chain.tip_height - check.chain.roots_height,
        ms: Math.round(check.ms),
      }),
    };
    workerSelf.postMessage({
      type: 'sync-progress',
      id: '',
      network: 'zcash',
      walletId,
      payload: { chain: chainRecord },
    });
    if (check.status === 'failed') {
      throw syncError(
        'chain-unproven',
        `the node's chain proof did not check out: ${check.detail}`,
      );
    }
    if (check.status === 'unverified') {
      console.log(
        `[zcash-worker] chain not verified (${check.reason}${check.detail ? `: ${check.detail}` : ''})`,
      );
      return;
    }
    proofThisRun = true;
    proven = check.chain;
    if (!provedBefore) {
      await idbPutMeta(flyTipKey[0]!, provedKey, true);
    }
    if (check.chain.tip_height > lastTip) {
      await idbPutMeta(flyTipKey[0]!, flyTipKey[1]!, check.chain.tip_height);
    }
    const { tip_height: tip, roots_height: at } = check.chain;
    console.log(
      `[zcash-worker] flyclient: tip ${tip}, roots at ${at} (depth ${tip - at}), ` +
        `verified in ${Math.round(check.ms)} ms`,
    );
  };
  /** compare the trees with proven roots the scan has reached; true when the cursor moved */
  const checkProvenRoots = async (): Promise<boolean> => {
    if (!proven || proven.roots_height > currentHeight) {
      return false;
    }
    const chain = proven;
    const off = poolsOffProof(chain, (pool, h) => trees.get(pool)?.root_at(h));
    if (off.length === 0) {
      proven = undefined;
      return false;
    }
    if (await rewindOnMismatch(chain.roots_height, off, async () => true)) {
      return true;
    }
    throw syncError(
      'chain-unproven',
      `the ${off.join(' and ')} note tree at ${chain.roots_height} is not the proven one, and no rewind is left`,
    );
  };

  // mempool watcher: only spawned when explicitly opted in AND on a zidecar
  // endpoint (lightwalletd has no compact-action mempool RPC, so the watcher
  // would yield nothing). Lifecycle is owned by `state.mempoolAbort`/
  // `state.mempoolTask` so stop-sync / reset-sync can abort the watcher
  // directly, and stopSync can await the task before declaring the
  // wallet idle. This avoids a class of races where a fresh runSync raced
  // a still-alive watcher attached to the previous client.
  state.mempoolAbort?.abort();
  state.mempoolAbort = undefined;
  state.mempoolTask = undefined;
  if (zidecar && mempoolWatch === 'on') {
    const [mempoolMod, strategyMod] = await Promise.all([
      import(/* webpackMode: "eager" */ '../services/mempool-watch/zidecar-mempool-fetcher'),
      import(/* webpackMode: "eager" */ '../services/mempool-watch/strategy'),
    ]);
    const base = mempoolMod.zidecarMempoolFetcher(zidecar);
    const fetcher = strategyMod.buildStrategy('on', { base });
    const localAbort = new AbortController();
    state.mempoolAbort = localAbort;

    state.mempoolTask = (async () => {
      try {
        for await (const snap of fetcher(walletId, {
          signal: localAbort.signal,
          onStatus: st => {
            workerSelf.postMessage({
              type: 'mempool-status',
              id: '',
              network: 'zcash',
              walletId,
              payload: st,
            });
          },
        })) {
          // Recheck state.keys per-iteration: reset-sync can free keys
          // while we're between yields. Without this, handleMempoolSnapshot
          // would run scan_actions_parallel on a freed WASM object.
          if (localAbort.signal.aborted || !state.keys) {
            break;
          }
          handleMempoolSnapshot(walletId, state, snap);
        }
      } catch (err) {
        console.warn(`[zcash-worker] mempool watcher exited: ${errText(err)}`);
        // Surface terminal error to UI so the toggle/status badge stops
        // claiming "connected" / "reconnecting" when the watcher is dead.
        workerSelf.postMessage({
          type: 'mempool-status',
          id: '',
          network: 'zcash',
          walletId,
          payload: { kind: 'error', error: err instanceof Error ? err.message : String(err) },
        });
      } finally {
        // Disconnect state on natural exit so a follow-up runSync starts clean.
        if (state.mempoolAbort === localAbort) {
          state.mempoolAbort = undefined;
        }
      }
    })();
  }

  // ── fetch pipeline ──
  //
  // Look-ahead compact-block fetch. Hands batches back in strict ascending
  // order, so notes and nullifiers are still applied in chain order; every
  // path that can invalidate the height cursor (rewind, error, empty batch,
  // abort) discards what is in flight rather than applying it.
  const prefetcher = new BlockPrefetcher({
    fetch: (start, end) => client.getCompactBlocks(start, end),
    batchSize: SYNC_BATCH_SIZE,
    depth: SYNC_PREFETCH_DEPTH,
    isAborted: () => signal.aborted,
  });

  // Cached chain tip; see TIP_CACHE_MS. Invalidated by setting cachedTipAt to
  // 0, which every recovery path below does.
  let cachedTipHeight = 0;
  let cachedTipAt = 0;
  const getChainTip = async (): Promise<number> => {
    const now = Date.now();
    // Always re-ask once the cursor has reached the cached tip: "caught up"
    // must never be decided on a stale number.
    if (cachedTipAt !== 0 && now - cachedTipAt < TIP_CACHE_MS && currentHeight < cachedTipHeight) {
      return cachedTipHeight;
    }
    const tip = await client.getTip();
    cachedTipHeight = tip.height;
    cachedTipAt = now;
    return tip.height;
  };
  /** Drop both the look-ahead and the cached tip after anything unexpected. */
  const dropPipeline = (): void => {
    prefetcher.reset();
    cachedTipAt = 0;
  };

  // the node's network, asked once per run before any block is read
  let networkChecked = false;
  while (!signal.aborted) {
    try {
      if (await storeWasReset()) {
        restart = true;
        break;
      }
      if (!networkChecked) {
        const info = await client.getLightdInfo();
        if (isWrongNetwork(info.chainName, walletIsMainnet(ufvk))) {
          throw syncError(
            'wrong-network',
            `the node serves the ${info.chainName} network, not this wallet's`,
          );
        }
        networkChecked = true;
        // the answer above, plus the protocol this worker's own requests used
        nodeInfo = describeNode(info, measuredProtocol(serverUrl));
        await checkNodeChain();
      }
      const chainHeight = await getChainTip();

      if (currentHeight >= chainHeight) {
        if (readBlocks && !checkedAtCatchUp) {
          checkedAtCatchUp = true;
          await checkNodeChain();
        }
        // proven roots first: they decide whether the blocks read are the chain
        if (await checkProvenRoots()) {
          dropPipeline();
          continue;
        }
        // caught up: compare the note trees with the server's tree state here
        // (a tree that differs is reseeded), then recover any notes the trees
        // do not hold - in the background of a send, never inside one
        try {
          const syncTs = await client.getTreeState(currentHeight);
          if (await rewindOnServerMismatch(currentHeight, syncTs)) {
            dropPipeline();
            continue;
          }
          if (await checkTrees(currentHeight, syncTs)) {
            recoverDue = true;
            // a reseeded tree moves the sizes: store them with its rows
            await saveBatch(
              walletId,
              [],
              [],
              currentHeight,
              orchardTreeSize,
              undefined,
              iwSupported ? ironwoodTreeSize : undefined,
              trees.takeWrites(),
            );
          }
        } catch (e) {
          console.warn(`[zcash-worker] note tree check failed: ${errText(e)}`);
        }

        // mempool scanning lives in the separate watcher task spawned above
        // when mempoolWatch === 'on'. when off (default), no mempool calls.

        workerSelf.postMessage({
          type: 'sync-progress',
          id: '',
          network: 'zcash',
          walletId,
          payload: {
            currentHeight,
            chainHeight,
            notesFound: state.notes.length,
            blocksScanned: 0,
            ...(chainRecord && { chain: chainRecord }),
          },
        });
        // a pass with notes still to recover goes straight on (after the tip
        // check above), so recovery never holds the scan for more than a pass
        if (recoverDue && (await recoverLost())) {
          continue;
        }
        await sleepUnlessAborted(signal, 10000);
        continue;
      }

      const batchSize = SYNC_BATCH_SIZE;

      // Top the look-ahead up and take the next in-order range. `prime` also
      // re-anchors the pipeline if `currentHeight` moved for any reason other
      // than a normal advance (rewind, retry), discarding anything queued
      // against the old cursor. A rejected fetch is rethrown here so the
      // existing continuity/backoff classifier below still sees it.
      prefetcher.prime(currentHeight, chainHeight);
      const batch = await prefetcher.next();
      if (!batch) {
        // aborted, or nothing left below the tip - the loop condition and the
        // caught-up branch above handle both on the next pass
        continue;
      }
      const { blocks, end: endHeight } = batch;
      console.log(`[zcash-worker] blocks ${batch.start}..${endHeight}`);

      // Guard: lightwalletd may race between getTip() and block indexing - if the
      // server reported a height but returned zero blocks, don't advance currentHeight.
      // The next iteration will retry once the server catches up. The prefetcher
      // has already dropped its look-ahead (it was aimed past a range the server
      // just said it cannot serve), so this can never turn into a skipped range.
      if (blocks.length === 0) {
        consecutiveErrors++;
        console.warn(
          `[zcash-worker] getCompactBlocks(${batch.start}..${endHeight}) returned 0 blocks, retrying`,
        );
        dropPipeline();
        await sleepUnlessAborted(signal, syncRetryDelayMs(consecutiveErrors));
        continue;
      }

      // single-pass: count actions, build lookups, pack binary buffer, and compute
      // actions commitment all in one iteration over blocks
      const cmxToTxid = new Map<string, string>();
      const cmxToHeight = new Map<string, number>();
      const nfToTxid = new Map<string, string>();
      const nfToHeight = new Map<string, number>();
      const actionNullifiers = new Set<string>();
      let actionCount = 0;
      for (const block of blocks) {
        actionCount += block.actions.length;
      }

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

        for (const block of blocks) {
          for (const a of block.actions) {
            // pack binary for WASM scan
            if (a.nullifier.length === 32) {
              buf.set(a.nullifier, off);
            }
            off += 32;
            if (a.cmx.length === 32) {
              buf.set(a.cmx, off);
            }
            off += 32;
            if (a.ephemeralKey.length === 32) {
              buf.set(a.ephemeralKey, off);
            }
            off += 32;
            if (a.ciphertext.length >= 52) {
              buf.set(a.ciphertext.subarray(0, 52), off);
            }
            off += 52;
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
          console.error(`[zcash-worker] scan_actions_parallel crashed: ${errText(err)}`, err);
          currentHeight = endHeight;
          continue;
        }

        console.log(
          `[zcash-worker] scanned in ${(performance.now() - t0).toFixed(0)}ms, found ${foundNotes.length}`,
        );

        for (const note of foundNotes) {
          // compute absolute tree position: batch start + index within batch
          const position = orchardTreeSize + (note as unknown as { index: number }).index;
          const full: DecryptedNote = {
            ...note,
            position,
            txid: cmxToTxid.get(note.cmx) ?? '',
            height: cmxToHeight.get(note.cmx) ?? 0,
          };
          console.log(
            `[zcash-worker] found note: value=${note.value}, pos=${position}, hasRseed=${!!note.rseed}, hasRho=${!!note.rho}, hasRecipient=${!!(note as unknown as { recipient?: string }).recipient}`,
          );
          newNotes.push(full);
          state.notes.push(full);
        }

        // detect spent notes: a nullifier in this block matches an owned note.
        // Two cases, handled in one pass:
        //  1. a spend seen for the first time here;
        //  2. a spend we already marked locally at broadcast (its nullifier is
        //     already in spentNullifiers) whose CONFIRMATION HEIGHT we never
        //     recorded - because this loop used to skip already-marked notes.
        //     markNotesSpentLocally sets spent_by_txid but has no height to give,
        //     so without backfilling it here spent_at_height stays 0, the send's
        //     chain-derived entry gets height 0, and reconcile (which confirms
        //     only on a real height) shows the payment pending forever even
        //     after its block is scanned. So always backfill height/txid when the
        //     nullifier appears on chain, marked or not.
        spentUpdatedNotes = [];
        for (const note of state.notes) {
          if (!actionNullifiers.has(note.nullifier)) {
            continue;
          }
          const firstSeen = !state.spentNullifiers.has(note.nullifier);
          if (firstSeen) {
            state.spentNullifiers.add(note.nullifier);
            newSpent.push(note.nullifier);
          }
          // Only overwrite spent_by_txid when the scan actually carries a txid
          // (lightwalletd often does not populate per-action txids); never clobber
          // the value markNotesSpentLocally wrote at broadcast with ''.
          const spentTxid = nfToTxid.get(note.nullifier);
          if (spentTxid) {
            note.spent_by_txid = spentTxid;
          }
          const spentHeight = nfToHeight.get(note.nullifier);
          const heightChanged = !!spentHeight && note.spent_at_height !== spentHeight;
          if (heightChanged) {
            note.spent_at_height = spentHeight;
          }
          if (firstSeen || heightChanged || spentTxid) {
            spentUpdatedNotes.push(note);
          }
        }
      }

      trees.append(
        'orchard',
        orchardTreeSize,
        blocks.map(b => ({ height: b.height, cmxs: b.actions.map(a => a.cmx) })),
        newNotes.map(n => n.position),
        chainHeight - MAX_CHECKPOINTS,
      );
      // advance tree size by total actions in this batch
      orchardTreeSize += actionCount;

      // ── NU6.3 ironwood pool: mirror of the orchard scan + witness path
      // above. Dormant until (a) the wasm blob exports the ironwood fns and
      // (b) the server serves ironwood actions in compact blocks - with a
      // current blob/server both are absent, so this whole section no-ops
      // and the orchard behavior is unchanged. ──
      let ironwoodActionCount = 0;
      for (const block of blocks) {
        ironwoodActionCount += block.ironwoodActions?.length ?? 0;
      }
      const newIronwoodNotes: DecryptedNote[] = [];
      const ironwoodUpdatedNotes = new Map<string, DecryptedNote>();

      if (ironwoodActionCount > 0 && iwSupported && state.keys?.scan_actions_ironwood_parallel) {
        const iwCmxToTxid = new Map<string, string>();
        const iwCmxToHeight = new Map<string, number>();
        const iwNfToTxid = new Map<string, string>();
        const iwNfToHeight = new Map<string, number>();
        const iwActionNullifiers = new Set<string>();

        // pack the ironwood actions into the same binary layout the orchard
        // scan uses (nullifier|cmx|epk|compact-ct per action)
        const iwBuf = new Uint8Array(4 + ironwoodActionCount * ACTION_SIZE);
        const iwView = new DataView(iwBuf.buffer);
        iwView.setUint32(0, ironwoodActionCount, true);
        let iwOff = 4;
        for (const block of blocks) {
          for (const a of block.ironwoodActions ?? []) {
            if (a.nullifier.length === 32) {
              iwBuf.set(a.nullifier, iwOff);
            }
            iwOff += 32;
            if (a.cmx.length === 32) {
              iwBuf.set(a.cmx, iwOff);
            }
            iwOff += 32;
            if (a.ephemeralKey.length === 32) {
              iwBuf.set(a.ephemeralKey, iwOff);
            }
            iwOff += 32;
            if (a.ciphertext.length >= 52) {
              iwBuf.set(a.ciphertext.subarray(0, 52), iwOff);
            }
            iwOff += 52;
            const cmxHex = hexEncode(a.cmx);
            const nfHex = hexEncode(a.nullifier);
            const txidHex = hexEncode(a.txid);
            iwCmxToTxid.set(cmxHex, txidHex);
            iwCmxToHeight.set(cmxHex, block.height);
            iwNfToTxid.set(nfHex, txidHex);
            iwNfToHeight.set(nfHex, block.height);
            iwActionNullifiers.add(nfHex);
          }
        }

        console.log(`[zcash-worker] scanning ${ironwoodActionCount} ironwood actions (binary)`);
        try {
          const foundIronwood = state.keys.scan_actions_ironwood_parallel(iwBuf);
          for (const note of foundIronwood) {
            const position = ironwoodTreeSize + (note as unknown as { index: number }).index;
            const full: DecryptedNote = {
              ...note,
              pool: 'ironwood',
              position,
              txid: iwCmxToTxid.get(note.cmx) ?? '',
              height: iwCmxToHeight.get(note.cmx) ?? 0,
            };
            // Diagnostic (mirrors the orchard scan log): build_signed_ironwood_send
            // reconstructs each spend from recipient_hex/rho/rseed. If
            // hasRecipient is false here the wasm ironwood scanner is not
            // capturing the diversified recipient and reconstruction falls back
            // to diversifier 0 - a real gap to fix in scan_actions_ironwood_parallel.
            console.log(
              `[zcash-worker] found ironwood note: value=${note.value}, pos=${position}, ` +
                `hasRseed=${!!note.rseed}, hasRho=${!!note.rho}, ` +
                `hasRecipient=${!!(note as unknown as { recipient?: string }).recipient}`,
            );
            newIronwoodNotes.push(full);
            state.notes.push(full);
          }
        } catch (err) {
          console.error(
            `[zcash-worker] scan_actions_ironwood_parallel crashed: ${errText(err)}`,
            err,
          );
        }

        // spent detection: ironwood nullifiers spend ironwood notes. Same
        // two-case handling as the orchard branch above - backfill the
        // confirmation height/txid for notes already marked spent at broadcast,
        // or the send stays pending forever once its own block is scanned.
        for (const note of state.notes) {
          if (poolOf(note) !== 'ironwood') {
            continue;
          }
          if (!iwActionNullifiers.has(note.nullifier)) {
            continue;
          }
          const firstSeen = !state.spentNullifiers.has(note.nullifier);
          if (firstSeen) {
            state.spentNullifiers.add(note.nullifier);
            newSpent.push(note.nullifier);
          }
          // never clobber the broadcast-time spent_by_txid with an empty scan
          // txid (lightwalletd often serves no per-action txid).
          const iwSpentTxid = iwNfToTxid.get(note.nullifier);
          if (iwSpentTxid) {
            note.spent_by_txid = iwSpentTxid;
          }
          const iwSpentHeight = iwNfToHeight.get(note.nullifier);
          const iwHeightChanged = !!iwSpentHeight && note.spent_at_height !== iwSpentHeight;
          if (iwHeightChanged) {
            note.spent_at_height = iwSpentHeight;
          }
          if (firstSeen || iwHeightChanged || iwSpentTxid) {
            ironwoodUpdatedNotes.set(note.nullifier, note);
          }
        }
      }

      if (iwSupported) {
        trees.append(
          'ironwood',
          ironwoodTreeSize,
          blocks.map(b => ({ height: b.height, cmxs: (b.ironwoodActions ?? []).map(a => a.cmx) })),
          newIronwoodNotes.map(n => n.position),
          chainHeight - MAX_CHECKPOINTS,
        );
      }
      // advance ironwood tree size by this batch's ironwood actions (kept
      // even when the blob can't scan them, so the count stays monotonic)
      ironwoodTreeSize += ironwoodActionCount;

      // spent-updated notes of both pools (dedupe by nullifier)
      const updatedDedup = new Map<string, DecryptedNote>();
      for (const n of spentUpdatedNotes) {
        updatedDedup.set(n.nullifier, n);
      }
      for (const [k, n] of ironwoodUpdatedNotes) {
        if (!updatedDedup.has(k)) {
          updatedDedup.set(k, n);
        }
      }
      const combinedUpdated = Array.from(updatedDedup.values());

      // single batched db write for entire batch, into the store this run
      // has been writing: never into one wiped under it
      if (await storeWasReset()) {
        restart = true;
        break;
      }
      currentHeight = endHeight;
      readBlocks = true;
      await saveBatch(
        walletId,
        newIronwoodNotes.length > 0 ? [...newNotes, ...newIronwoodNotes] : newNotes,
        newSpent,
        currentHeight,
        orchardTreeSize,
        combinedUpdated.length > 0 ? combinedUpdated : undefined,
        iwSupported ? ironwoodTreeSize : undefined,
        trees.takeWrites(),
      );
      lastSaved = currentHeight;

      // now and then, compare the trees with the server's tree state (a
      // reorg or a bad batch shows here); a tree that differs is reseeded
      if (currentHeight % TREE_CHECK_INTERVAL < batchSize) {
        try {
          const batchTs = await client.getTreeState(currentHeight);
          if (await rewindOnServerMismatch(currentHeight, batchTs)) {
            dropPipeline();
            continue;
          }
          if (await checkTrees(currentHeight, batchTs)) {
            recoverDue = true;
            await saveBatch(
              walletId,
              [],
              [],
              currentHeight,
              orchardTreeSize,
              undefined,
              iwSupported ? ironwoodTreeSize : undefined,
              trees.takeWrites(),
            );
          }
        } catch {
          /* best-effort: the caught-up check runs again */
        }
      }

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
          // How many cores the scan is really using. Carried on every progress
          // message so a degraded pool is visible from the wallet rather than
          // only from a worker console.
          scanThreads: scanParallelism.threads,
          scanDegradedReason: scanParallelism.reason,
        },
      });

      consecutiveErrors = 0;
      lastErrLine = undefined;
    } catch (err) {
      // Intentional stop (wallet switch, endpoint change, shutdown): in-flight
      // RPCs can fail once teardown begins. That's not a sync failure - no
      // error count, no sync-error to the UI. Mirrors the abort handling in
      // packages/query block-processor retry.
      if (signal.aborted) {
        dropPipeline();
        break;
      }

      // Anything that lands here invalidates the look-ahead: the cursor is
      // about to move (rewind) or the endpoint is unhealthy. Re-fetching a few
      // batches is free; applying a batch fetched before a rewind is not.
      dropPipeline();

      // a chain that did not check out: nothing more is read from this node
      // until the person chooses (or the node proves itself on the next run)
      if (syncErrorCodeOf(err) === 'chain-unproven') {
        console.error(`[zcash-worker] sync paused: ${errText(err)}`);
        workerSelf.postMessage({
          type: 'sync-error',
          id: '',
          network: 'zcash',
          walletId,
          payload: { message: errText(err), stalled: true, code: 'chain-unproven' },
        });
        break;
      }

      // Chain continuity broken: recover silently rather than telling the
      // user about a tree root. Rewind the scan cursor by an escalating
      // distance and read the range again. The user only ever learns about
      // this if the budget runs out, and then only as "the chain changed".
      if (isChainContinuityError(err) && rewindsThisRun < MAX_REWINDS_PER_RUN) {
        const target = Math.max(
          rewindFloor,
          currentHeight - rewindDistanceForAttempt(rewindsThisRun),
        );
        if (target < currentHeight) {
          rewindsThisRun++;
          console.warn(
            `[zcash-worker] chain continuity broken near ${currentHeight}; rewinding to ${target} ` +
              `(attempt ${rewindsThisRun}/${MAX_REWINDS_PER_RUN}):`,
            err,
          );
          try {
            currentHeight = await rewindScanCursor(target);
            lastSaved = currentHeight;
            workerSelf.postMessage({
              type: 'sync-progress',
              id: '',
              network: 'zcash',
              walletId,
              payload: {
                currentHeight,
                chainHeight: currentHeight,
                notesFound: state.notes.length,
                blocksScanned: 0,
              },
            });
            continue;
          } catch (rewindErr) {
            // The rewind itself failed (endpoint down mid-recovery, storage
            // unavailable). Fall through and treat it as an ordinary failure
            // so the real reason is the one that gets classified.
            console.warn(`[zcash-worker] rewind failed: ${errText(rewindErr)}`);
          }
        }
      }

      consecutiveErrors++;
      const errLine = errText(err);
      // Storage, not the node. A closed connection is dropped so the next try
      // opens a fresh one (retrying over it only counted: "sync error (240)").
      // A full disk or a database newer than this build cannot be retried
      // away: say so once, honestly, and stop until the person acts.
      const storage = storageFailure(err);
      if (storage) {
        // the next try opens a fresh connection, and checks it is the same store
        closeDb();
        dbLost++;
      }
      if (storage === 'fatal') {
        console.error(`[zcash-worker] sync stopped, local data unusable: ${errLine}`);
        workerSelf.postMessage({
          type: 'sync-error',
          id: '',
          network: 'zcash',
          walletId,
          payload: { message: errLine, stalled: true, code: 'storage-fatal' },
        });
        break;
      }
      // on a zidecar the sync itself runs on zidecar's own calls (GetTip,
      // whole blocks); failing twice may mean the node is not one (a local
      // storage failure never blames the node)
      if (consecutiveErrors === 2 && zidecar && !storage) {
        suspectBackend(serverUrl);
      }
      // Retrying is the policy, so a flapping endpoint would otherwise produce
      // one of these per backoff interval indefinitely. One line when the
      // failure starts or changes, then every tenth; the UI sync-error message
      // below is unaffected, so the user still sees the wallet struggling.
      if (errLine !== lastErrLine || consecutiveErrors % 10 === 0) {
        console.warn(
          `[zcash-worker] sync error (${consecutiveErrors}): ${errLine}; next try in ${Math.round(syncRetryDelayMs(consecutiveErrors) / 1000)}s`,
        );
      }
      lastErrLine = errLine;
      // surface to UI from the second consecutive failure (skip transient
      // single hiccups, but don't make the user stare at "syncing 0%" while
      // we silently retry forever)
      if (consecutiveErrors >= 2) {
        // A continuity error only reaches here once the rewind budget is
        // spent, so it is reported as chain recovery rather than as whatever
        // tree-shaped text it happened to carry.
        const code =
          syncErrorCodeOf(err) ?? (isChainContinuityError(err) ? 'chain-recovery' : undefined);
        workerSelf.postMessage({
          type: 'sync-error',
          id: '',
          network: 'zcash',
          walletId,
          payload: {
            message: errLine,
            stalled: consecutiveErrors >= SYNC_STALL_ERRORS,
            ...(code ? { code } : {}),
          },
        });
      }
      // never give up: only the last window closing stops the loop, so a node
      // that comes back is picked up from the stored height. Once stalled,
      // every slow retry is a fresh run's worth of rewinds.
      if (consecutiveErrors >= SYNC_STALL_ERRORS) {
        rewindsThisRun = 0;
      }
      await sleepUnlessAborted(signal, syncRetryDelayMs(consecutiveErrors));
    }
  }

  // Nothing in flight may be applied after the loop ends, however it ended.
  prefetcher.reset();
  state.mempoolAbort?.abort();
  return restart ? 'restart' : undefined;
};

const getBalance = async (walletId: string): Promise<bigint> => {
  // always load from IDB - in-memory state may be stale after rescan
  const state = await loadState(walletId);
  let balance = 0n;
  for (const note of state.notes) {
    if (!state.spentNullifiers.has(note.nullifier)) {
      balance += BigInt(note.value);
    }
  }
  return balance;
};

/** Spendable balance per shielded pool (zatoshi). NU6.3 dual-pool. */
interface PoolBalances {
  orchard: bigint;
  ironwood: bigint;
  /** orchard + ironwood - the same total getBalance() returns */
  total: bigint;
  /**
   * Pending shielded change: value our own broadcast-but-unconfirmed sends will
   * return to us once they mine (upstream change_pending_confirmation). The
   * input notes are marked spent locally at broadcast, which drops `total` to
   * zero while the change note has not mined yet - correct, but it made the
   * wallet read as empty (all pools 0, "get your first zec") with money in
   * flight. These figures keep that value visible and are NOT spendable.
   * pendingIronwood additionally carries a pending turnstile migration's
   * in-flight value: its orchard inputs are spent at broadcast, but the value
   * returns to the wallet's own ironwood pool once mined.
   */
  pendingOrchard: bigint;
  pendingIronwood: bigint;
  /** pendingOrchard + pendingIronwood */
  pendingTotal: bigint;
}

/**
 * Per-pool spendable balances. Same unspent-note summation as getBalance()
 * (single source of truth), split by poolOf(note) so records persisted before
 * the ironwood rollout (no pool field) count as orchard. `total` equals the
 * legacy single balance, so existing callers can keep reading it unchanged.
 * Also computes pending shielded change (see PoolBalances.pending*).
 */
const getPoolBalances = async (walletId: string): Promise<PoolBalances> => {
  const state = await loadState(walletId);
  let orchard = 0n;
  let ironwood = 0n;
  for (const note of state.notes) {
    if (state.spentNullifiers.has(note.nullifier)) {
      continue;
    }
    if (poolOf(note) === 'ironwood') {
      ironwood += BigInt(note.value);
    } else {
      orchard += BigInt(note.value);
    }
  }

  // Pending shielded change from our in-flight sends. The change that returns
  // to us is inputs − recipient − fee. Watch the type: HistoryTx.amount (the
  // display row built in reconcile) already folds the fee in, but the record
  // read here is a SentTxRecord, whose `amount` is the RECIPIENT amount ONLY,
  // with the fee stored separately in `rec.fee` (see the recordSentTx call
  // sites). So change = inp.value − rec.amount − rec.fee; subtracting only
  // rec.amount overstated every pending send by exactly one fee. A confirmed
  // send (reconcile wrote confirmedHeight) or one whose spend has already been
  // seen on chain produces no pending change here. NU6.3 makes ironwood the
  // active pool, so this is where a pending ironwood send inappropriately
  // zeroed the figure.
  //
  // A turnstile migration (kind === 'migrate') is special: its orchard inputs
  // are marked spent at broadcast (orchard → 0) but nothing actually leaves the
  // wallet except the fee - the value moves to the wallet's OWN ironwood pool
  // and returns as an ironwood output once mined. Attribute its whole in-flight
  // value (rec.amount, already inputs − fee) to pendingIronwood so the hero
  // total stays whole through the confirmation window instead of reading ~0.
  let pendingOrchard = 0n;
  let pendingIronwood = 0n;
  try {
    const sent = await idbGetAllByIndex<SentTxRecord>('sent', 'byWallet', walletId);
    if (sent.length > 0) {
      const inputByTx = new Map<string, { value: bigint; ironwood: boolean }>();
      for (const note of state.notes) {
        if (note.spent_by_txid && !(note.spent_at_height ?? 0)) {
          const cur = inputByTx.get(note.spent_by_txid) ?? { value: 0n, ironwood: false };
          cur.value += BigInt(note.value);
          if (poolOf(note) === 'ironwood') {
            cur.ironwood = true;
          }
          inputByTx.set(note.spent_by_txid, cur);
        }
      }
      for (const rec of sent) {
        if (rec.confirmedHeight) {
          continue;
        }
        const inp = inputByTx.get(rec.txid);
        if (!inp) {
          continue;
        }
        // A pending migrate's value is not leaving the wallet - it is moving
        // orchard → the wallet's own ironwood pool. rec.amount is the ironwood
        // output (inputs − fee); count it as arriving ironwood so the hero total
        // stays whole. The kind check must precede the generic send math: that
        // math would compute inputs − amount − fee = 0 for a migrate and drop it.
        if (rec.kind === 'migrate') {
          const arriving = BigInt(rec.amount);
          if (arriving > 0n) {
            pendingIronwood += arriving;
          }
          continue;
        }
        // rec.amount is the recipient amount only; the fee is separate, so the
        // change returning to us is inputs − recipient − fee.
        const change = inp.value - BigInt(rec.amount) - BigInt(rec.fee);
        if (change <= 0n) {
          continue;
        }
        if (inp.ironwood) {
          pendingIronwood += change;
        } else {
          pendingOrchard += change;
        }
      }
    }
  } catch (e) {
    console.warn(`[zcash-worker] failed to compute pending change: ${errText(e)}`);
  }

  return {
    orchard,
    ironwood,
    total: orchard + ironwood,
    pendingOrchard,
    pendingIronwood,
    pendingTotal: pendingOrchard + pendingIronwood,
  };
};

/**
 * A FROST call that carries secrets: its arguments open only with the key
 * this worker issued for it, and its reply is sealed back under the same
 * key, so neither crosses the extension message bus in the clear.
 */
const sealedFrost = async (id: string, payload: unknown, run: (args: unknown) => unknown) => {
  await initWasm();
  const call = await openCall((payload as { sealed?: SealedCall } | undefined)?.sealed);
  if (!call) {
    throw new Error('this key step did not open in the worker. please try again.');
  }
  workerSelf.postMessage({
    type: 'frost-result',
    id,
    network: 'zcash',
    payload: await call.reply(run(call.args)),
  });
};

// ── message handler ──

workerSelf.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const { type, id, walletId, payload } = e.data;
  // a build that can be stopped carries the key its page chose
  const cancelKey = (payload as { cancelKey?: unknown } | undefined)?.cancelKey;

  try {
    switch (type) {
      case 'build-stop': {
        const { key } = payload as { key: string };
        workerSelf.postMessage({ type: 'result', id, network: 'zcash', payload: builds.stop(key) });
        return;
      }

      case 'init':
        await initWasm();
        workerSelf.postMessage({ type: 'ready', id, network: 'zcash' });
        return;

      case 'vault-key':
        // a single-use key the page wraps the session key to for the next call
        workerSelf.postMessage({
          type: 'vault-key',
          id,
          network: 'zcash',
          payload: await issueWorkerKey(),
        });
        return;

      case 'derive-address': {
        await initWasm();
        const { vault, accountIndex, diversifierHex, pocket } = payload as {
          /** the sealed vault this worker opens itself; the phrase never rides the bus */
          vault?: SealedVault;
          accountIndex: number;
          diversifierHex?: string;
          /** zip32 account; accountIndex above is a diversifier index */
          pocket?: number;
        };
        const address = deriveAddress(
          await unsealVault(vault),
          accountIndex,
          diversifierHex,
          pocket,
        );
        workerSelf.postMessage({
          type: 'address',
          id,
          network: 'zcash',
          walletId,
          payload: address,
        });
        return;
      }

      // lp.html's rune account, only after the person opted in there (workers/thor-sign.ts)
      case 'thor-address': {
        const { vault, index, source, fvk } = payload as {
          vault?: SealedVault;
          index: number;
          source: ThorKeySource;
          fvk?: string;
        };
        // a viewing-key account needs no sealed secret; seed and random open theirs here
        const secret = source === 'fvk' ? (fvk ?? '') : await unsealVault(vault);
        workerSelf.postMessage({
          type: 'address',
          id,
          network: 'zcash',
          payload: thorAddressFrom(source, secret, index),
        });
        return;
      }

      case 'thor-sign-deposit': {
        const { vault, ...req } = payload as ThorDepositRequest & { vault?: SealedVault };
        checkThorRequest(req);
        const secret = req.source === 'fvk' ? (req.fvk ?? '') : await unsealVault(vault);
        workerSelf.postMessage({
          type: 'tx-result',
          id,
          network: 'zcash',
          payload: signThorDeposit(secret, req),
        });
        return;
      }

      case 'sync': {
        if (!walletId) {
          throw new Error('walletId required');
        }
        await initWasm();
        const { vault, serverUrl, startHeight, ufvk, backend, detectBackend, mempoolWatch } =
          payload as {
            /** hot wallet: the sealed vault this worker opens itself; watch-only sends ufvk */
            vault?: SealedVault;
            serverUrl: string;
            startHeight?: number;
            ufvk?: string;
            backend?: ZcashBackend;
            /** the page has no answer from this node yet: ask it first */
            detectBackend?: boolean;
            mempoolWatch?: 'off' | 'on';
          };
        // Defensive: validate enum values from cross-context payload.
        // Silent coercion of an unknown backend to 'zidecar' is a privacy
        // regression - a user configured to talk to a third-party
        // lightwalletd would end up hitting the zidecar code path (with
        // its zidecar-only RPCs) and either fail loudly OR, worse, succeed
        // against a server that happens to implement those endpoints with
        // a different trust model. Reject unknown explicitly.
        if (backend !== undefined && !isZcashBackend(backend)) {
          throw new Error(`unknown zcash backend in sync payload: ${String(backend)}`);
        }
        if (mempoolWatch !== undefined && mempoolWatch !== 'off' && mempoolWatch !== 'on') {
          throw new Error(`unknown mempoolWatch in sync payload: ${String(mempoolWatch)}`);
        }
        let effectiveBackend: ZcashBackend = backend ?? backendOfEndpoint(serverUrl);
        if (detectBackend === true) {
          // the node says what it is, through the call every light wallet
          // makes first; a node that does not answer keeps the guess, and
          // the sync's own errors tell the user it is unreachable
          try {
            effectiveBackend = await detectZcashBackend(serverUrl);
            announceBackend(serverUrl, effectiveBackend);
          } catch (e) {
            console.warn(`[zcash-worker] node did not say what it is: ${errText(e)}`);
          }
        }
        // Seed the registry so subsequent operations (send, history, memo
        // fetch) construct the right client without re-receiving backend.
        registerBackend(serverUrl, effectiveBackend);
        void runSync(
          walletId,
          ufvk ? '' : await unsealVault(vault),
          serverUrl,
          startHeight,
          ufvk,
          effectiveBackend,
          mempoolWatch,
        );
        workerSelf.postMessage({ type: 'sync-started', id, network: 'zcash', walletId });
        return;
      }

      case 'stop-sync': {
        if (!walletId) {
          throw new Error('walletId required');
        }
        // answered once the loop has ended, so a start after it resumes from
        // what the stopped run saved instead of racing it
        const state = walletStates.get(walletId);
        const stopped = state?.stop;
        if (state) {
          await stopSync(state);
        }
        // a sync asked for while this stop waited owns the wallet now: answer
        // the call without marking the wallet idle under it
        const superseded = state?.stop !== stopped;
        workerSelf.postMessage({
          type: 'sync-stopped',
          id,
          network: 'zcash',
          walletId: superseded ? undefined : walletId,
        });
        return;
      }

      case 'reset-sync': {
        if (!walletId) {
          throw new Error('walletId required');
        }
        const resetState = getOrCreateWalletState(walletId);
        await stopSync(resetState);
        resetState.keys?.free();
        resetState.keys = null;
        // clear IDB data for this wallet
        await deleteWallet(walletId);
        // re-register so future sync can start clean
        await registerWallet(walletId);
        resetState.notes = [];
        resetState.spentNullifiers = new Set();
        workerSelf.postMessage({ type: 'sync-reset', id, network: 'zcash', walletId });
        return;
      }

      case 'get-balance': {
        if (!walletId) {
          throw new Error('walletId required');
        }
        const balance = await getBalance(walletId);
        workerSelf.postMessage({
          type: 'balance',
          id,
          network: 'zcash',
          walletId,
          payload: balance.toString(),
        });
        return;
      }

      case 'get-pool-balances': {
        if (!walletId) {
          throw new Error('walletId required');
        }
        // NU6.3 dual-pool: orchard vs ironwood spendable balance. Additive to
        // get-balance (which still returns the single total for back-compat);
        // bigint isn't structured-clone-safe across postMessage, so serialize
        // to decimal strings and let the caller re-hydrate.
        const pools = await getPoolBalances(walletId);
        workerSelf.postMessage({
          type: 'pool-balances',
          id,
          network: 'zcash',
          walletId,
          payload: {
            orchard: pools.orchard.toString(),
            ironwood: pools.ironwood.toString(),
            total: pools.total.toString(),
            pendingOrchard: pools.pendingOrchard.toString(),
            pendingIronwood: pools.pendingIronwood.toString(),
            pendingTotal: pools.pendingTotal.toString(),
          },
        });
        return;
      }

      case 'get-pending-sends': {
        if (!walletId) {
          throw new Error('walletId required');
        }
        // The balance panel needs to know what is in flight, and it needs to
        // know cheaply - get-history fetches transparent history over the
        // network, which is far too heavy to run on every sync tick. This
        // answers the same question from local state only: which of our
        // recorded sends has the chain not confirmed yet.
        //
        // Deliberately read-only. get-history owns writing confirmations back
        // and pruning; two writers racing over the same records buys nothing.
        const pendState = await loadState(walletId);
        const pendChainTxs: Omit<HistoryTx, 'status'>[] = [];
        for (const n of pendState.notes) {
          if (n.txid && (n.height ?? 0) > 0) {
            pendChainTxs.push({
              id: n.txid,
              height: n.height ?? 0,
              type: 'receive',
              amount: '0',
              asset: 'ZEC',
            });
          }
          // a spend only counts as seen once scanning has given it a height;
          // markNotesSpentLocally sets spent_by_txid at broadcast with none
          if (n.spent_by_txid && (n.spent_at_height ?? 0) > 0) {
            pendChainTxs.push({
              id: n.spent_by_txid,
              height: n.spent_at_height ?? 0,
              type: 'send',
              amount: '0',
              asset: 'ZEC',
            });
          }
        }
        const pendSent = await idbGetAllByIndex<SentTxRecord>('sent', 'byWallet', walletId);
        const pendResult = reconcileSentTxs({
          chainTxs: pendChainTxs,
          // the scan never sees a transparent-only tx, so from local state one
          // is never failed; get-history asks the node and decides
          sent: pendSent.map(s => (s.pool === 'transparent' ? { ...s, expiryHeight: 0 } : s)),
          scannedHeight: await getSyncHeight(walletId),
        });
        workerSelf.postMessage({
          type: 'pending-sends',
          id,
          network: 'zcash',
          walletId,
          payload: pendResult.txs.filter(t => t.status !== 'confirmed'),
        });
        return;
      }

      case 'list-wallets': {
        const wallets = await listWallets();
        workerSelf.postMessage({ type: 'wallets', id, network: 'zcash', payload: wallets });
        return;
      }

      case 'delete-wallet': {
        if (!walletId) {
          throw new Error('walletId required');
        }
        // a wallet's pockets go with it (account 0 is walletId itself)
        const ownStores = new Set([walletId]);
        for (const storeId of [...(await listWallets()), ...walletStates.keys()]) {
          if (isStoreOfWallet(storeId, walletId)) {
            ownStores.add(storeId);
          }
        }
        for (const storeId of ownStores) {
          const state = walletStates.get(storeId);
          if (state) {
            await stopSync(state);
          }
          if (state?.keys) {
            state.keys.free();
            state.keys = null;
          }
          await deleteWallet(storeId);
        }
        workerSelf.postMessage({ type: 'wallet-deleted', id, network: 'zcash', walletId });
        return;
      }

      case 'get-notes': {
        if (!walletId) {
          throw new Error('walletId required');
        }
        const noteState = await loadState(walletId);
        const notesWithSpent = noteState.notes.map(n => ({
          ...n,
          spent: noteState.spentNullifiers.has(n.nullifier),
        }));
        workerSelf.postMessage({
          type: 'notes',
          id,
          network: 'zcash',
          walletId,
          payload: notesWithSpent,
        });
        return;
      }

      case 'note-sync-encode': {
        // Build CBOR notes bundle with merkle paths, encode as UR frames
        if (!walletId) {
          throw new Error('walletId required');
        }
        if (!wasmModule) {
          throw new Error('wasm not initialized');
        }
        const { mainnet: isMainnet, serverUrl: syncServerUrl } = payload as {
          mainnet: boolean;
          serverUrl: string;
        };
        const syncState = await loadState(walletId);
        const allUnspent = syncState.notes.filter(n => !syncState.spentNullifiers.has(n.nullifier));
        if (allUnspent.length === 0) {
          workerSelf.postMessage({
            type: 'note-sync-encoded',
            id,
            network: 'zcash',
            walletId,
            payload: { frames: [], noteCount: 0, balance: '0', cborBytes: 0 },
          });
          return;
        }

        // NU6.3 keeps orchard and ironwood in SEPARATE commitment trees, but the
        // note-sync CBOR bundle carries a single tree + anchor. A note's
        // `position` indexes its OWN pool's tree, so replaying an ironwood note
        // against the orchard tree fails ("note at position N not found in tree
        // replay"). Split by pool and export one pool per bundle; when both hold
        // value (mid-migration), export the larger and disclose the remainder
        // rather than silently dropping it (a single-anchor bundle cannot verify
        // two trees - dual-pool export needs a v2 bundle format).
        const orchardNotes = allUnspent.filter(n => poolOf(n) === 'orchard');
        const ironwoodNotes = allUnspent.filter(n => poolOf(n) === 'ironwood');
        const sumBalance = (ns: DecryptedNote[]) =>
          ns.reduce((acc, n) => acc + BigInt(n.value), 0n);
        const orchardBalance = sumBalance(orchardNotes);
        const ironwoodBalance = sumBalance(ironwoodNotes);

        const exportPool: NotePool =
          ironwoodNotes.length === 0
            ? 'orchard'
            : orchardNotes.length === 0
              ? 'ironwood'
              : ironwoodBalance >= orchardBalance
                ? 'ironwood'
                : 'orchard';
        const unspent = exportPool === 'ironwood' ? ironwoodNotes : orchardNotes;
        const excludedNotes = exportPool === 'ironwood' ? orchardNotes : ironwoodNotes;
        const excludedPool: NotePool = exportPool === 'ironwood' ? 'orchard' : 'ironwood';
        const excludedBalance = exportPool === 'ironwood' ? orchardBalance : ironwoodBalance;

        // the pool's note tree anchors at its newest checkpoint (returned with the paths)
        const syncedAt = await getSyncHeight(walletId);

        // build merkle witnesses - use the backend-aware client (zidecar/
        // lightwalletd) instead of a hardcoded zidecar REST shape, so export
        // works on any backend the wallet synced against.
        const client = makeZcashClient(syncServerUrl);
        const witnessResult = await buildWitnesses(client, walletId, unspent, syncedAt, exportPool);
        const anchorHeight = witnessResult.anchorHeight;

        // prepare notes JSON for WASM encoder
        const notesJson = JSON.stringify(
          unspent.map(n => ({
            value: Number(n.value),
            nullifier: n.nullifier,
            cmx: n.cmx,
            position: n.position,
            block_height: n.height,
          })),
        );

        // buildWitnesses returns { anchorHex, paths } but WASM expects { anchor_hex, paths }
        const merkleJson = JSON.stringify({
          anchor_hex: witnessResult.anchorHex,
          paths: witnessResult.paths,
        });

        // fetch an ed25519 anchor attestation from zidecar's verifier so a
        // FROST cold device (which requires attested anchors) accepts the
        // bundle. Best-effort: on lightwalletd, server error, or signing
        // disabled we emit an unattested bundle (still imports on non-FROST
        // devices). The anchor was already compared with the same node's
        // tree state during witness building, and the attestation comes from
        // that same operator: it says the node stands behind the anchor, not
        // that the anchor is proven. The node is trusted for chain data.
        // Attestation is orchard-only for now: zidecar's SignAnchor verifies the
        // anchor against its orchard tree-state, so an ironwood anchor would not
        // match and returns unavailable. Ironwood bundles ship unattested - fine
        // for the non-FROST devices this flow targets. (A FROST device syncing
        // ironwood notes would need a zidecar ironwood-tree verifier - future.)
        let attestationHex: string | null = null;
        const attester = zidecarExtras(syncServerUrl, lookupBackend(syncServerUrl));
        if (exportPool === 'orchard' && attester) {
          try {
            const att = await attester.signAnchor(
              hexDecode(witnessResult.anchorHex),
              anchorHeight,
              isMainnet,
            );
            if (att.available && att.signatureHex.length === 128) {
              attestationHex = att.signatureHex;
            } else {
              console.warn(
                '[zcash-worker] anchor attestation unavailable (signing disabled); emitting unattested bundle',
              );
            }
          } catch (e) {
            console.warn(
              '[zcash-worker] anchor attestation failed; emitting unattested bundle:',
              e,
            );
            suspectBackend(syncServerUrl);
          }
        }

        // encode to CBOR via WASM
        const cborBundle = wasmModule.encode_notes_bundle(
          notesJson,
          merkleJson,
          anchorHeight,
          isMainnet,
          attestationHex,
        );

        // stamp the anchor block's own header time into the bundle (chain truth,
        // not the device clock) so the cold device can show the anchor as a real
        // date toggleable with its height. getTreeState carries `time`; on the
        // odd chance the fetch fails we ship without it (older behavior).
        let anchorTime = 0;
        try {
          anchorTime = (await client.getTreeState(anchorHeight)).time;
        } catch (e) {
          console.warn(
            `[zcash-worker] anchor block time unavailable; bundle omits it: ${errText(e)}`,
          );
        }
        const cborBytes = appendCborAnchorTime(cborBundle, anchorTime);

        // encode to QR frames via zoda transport (verified erasure coding).
        // auto-size k/n to the payload so each hex-encoded `zt:` frame fits a
        // scannable QR - a fixed 12-of-16 overflows the QR for large note sets
        // (each shard ~payload/k, hex-doubled). 300 raw bytes/frame ≈ 0.6KB QR
        // string (~v15 at ECC-L) keeps each frame light enough to lock fast on
        // the zigner camera (denser frames scan slowly); 30% parity so the
        // scanner can miss frames in the cycling display.
        const framesJson = wasmModule.zt_encode_frames_auto(cborBytes, 'zcash-notes', 300, 30);
        const urFrames = JSON.parse(framesJson) as string[];

        // balance of the exported pool (what the zigner will verify)
        const balance = sumBalance(unspent);

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
            pool: exportPool,
            // when the wallet straddles both pools, the zigner bundle can only
            // carry one - tell the UI what was left out so it doesn't imply the
            // synced balance is the wallet's whole spendable balance.
            excludedPool: excludedNotes.length > 0 ? excludedPool : undefined,
            excludedNoteCount: excludedNotes.length,
            excludedBalance: excludedBalance.toString(),
          },
        });
        return;
      }

      case 'decrypt-memos': {
        if (!walletId) {
          throw new Error('walletId required');
        }
        const memoState = walletStates.get(walletId);
        if (!memoState?.keys) {
          throw new Error('wallet keys not loaded');
        }
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

      case 'get-history': {
        if (!walletId) {
          throw new Error('walletId required');
        }
        const { serverUrl: histServerUrl, tAddresses: histTAddresses } = payload as {
          serverUrl: string;
          tAddresses: string[];
        };

        // load shielded notes from IDB
        const histState = await loadState(walletId);
        const histNotes = histState.notes.map(n => ({
          ...n,
          spent: histState.spentNullifiers.has(n.nullifier),
        }));

        // fetch transparent history
        const tHistory: { txid: string; height: number; received: string }[] = [];
        if (histTAddresses?.length) {
          try {
            const tClient = makeZcashClient(histServerUrl);

            const ourScripts = new Set<string>();
            for (const addr of histTAddresses) {
              const decoded = base58checkDecode(addr);
              if (decoded) {
                ourScripts.add('76a914' + hexEncode(decoded) + '88ac');
              }
            }

            // one address per request; a tx touching two of them comes back twice
            const txids = [
              ...new Map(
                (await eachAddress(histTAddresses, a => tClient.getTaddressTxids(a))).map(t => [
                  hexEncode(t),
                  t,
                ]),
              ).values(),
            ];
            const CONCURRENCY = 5;
            for (let i = 0; i < txids.length; i += CONCURRENCY) {
              const batch = txids.slice(i, i + CONCURRENCY);
              const results = await Promise.allSettled(
                batch.map(async txidBytes => {
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
                if (r.status === 'fulfilled') {
                  tHistory.push(r.value);
                }
              }
            }
          } catch (e) {
            console.warn(`[zcash-worker] get-history: transparent history failed: ${errText(e)}`);
          }
        }

        // build maps for sent amount calculation
        const histTxMap = new Map<
          string,
          {
            height: number;
            position: number;
            changeValue: bigint;
            receiveValue: bigint;
            isChange: boolean;
          }
        >();
        // value + height (spent_at_height) so no-change sends still get a correct height
        const histSpentByMap = new Map<string, { value: bigint; height: number }>();

        for (const note of histNotes) {
          if (note.spent && note.spent_by_txid) {
            const prev = histSpentByMap.get(note.spent_by_txid) ?? { value: 0n, height: 0 };
            histSpentByMap.set(note.spent_by_txid, {
              value: prev.value + BigInt(note.value),
              height: Math.max(prev.height, note.spent_at_height ?? 0),
            });
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
        const histTxs: Omit<HistoryTx, 'status'>[] = [];
        for (const [txid, info] of histTxMap) {
          const isSend = info.isChange;
          let amount: bigint;
          // When the input total is unknown we do NOT know what left the wallet.
          let amountIsUpperBound = false;
          if (isSend) {
            const spent = histSpentByMap.get(txid);
            const inputTotal = spent?.value ?? 0n;
            if (inputTotal > 0n) {
              // what actually left = inputs - change (this includes the fee)
              amount = inputTotal - info.changeValue;
            } else {
              // No input total. histSpentByMap is keyed on note.spent_by_txid,
              // which only a spend this wallet recorded itself sets; a spend
              // known only as a nullifier (older wallets marked spends from
              // server proofs, with no txid) lands here.
              //
              // This used to display info.changeValue as the amount sent, which
              // is not merely imprecise, it is the wrong number entirely: pay
              // 0.10 out of a 10.00 note and the 9.90 that came BACK to you is
              // rendered as "sent 9.90 ZEC".
              //
              // We genuinely cannot compute what left without the input total,
              // so report the change as an explicit upper bound rather than
              // asserting it. A number the UI marks provisional is honest; a
              // confident wrong number is not.
              amount = info.changeValue;
              amountIsUpperBound = true;
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
            ...(amountIsUpperBound ? { amountUpperBound: true } : {}),
          });
        }

        // Sends whose change note we have not found: histSpentByMap has an entry
        // but histTxMap does not.
        //
        // The input total is NOT the amount sent. Spending a 355,000 zat note to
        // pay 50,000 returns 290,000 as change, and the wallet is 65,000 poorer.
        // This branch used to publish the gross input total as the amount, which
        // is only correct when there genuinely was no change - and we cannot tell
        // the two apart until the block holding the change has been scanned.
        // (Worse for a turnstile migration, where orchard inputs produce ironwood
        // change that a separate scan pass discovers later still.)
        //
        // So: report it as an upper bound unless we have actually walked the
        // block that spent it and found no change coming back. Where a local
        // record exists, reconciliation replaces this figure with the exact one
        // anyway - this is the honest fallback for sends we did not record.
        const histScannedHeight = await getSyncHeight(walletId);
        for (const [txid, { value: inputTotal, height: spentHeight }] of histSpentByMap) {
          if (!histTxMap.has(txid)) {
            const changeIsSettled = spentHeight > 0 && histScannedHeight >= spentHeight;
            histTxs.push({
              id: txid,
              height: spentHeight,
              type: 'send',
              amount: inputTotal.toString(),
              asset: 'ZEC',
              ...(changeIsSettled ? {} : { amountUpperBound: true }),
            });
          }
        }

        // merge transparent history
        const seenTxids = new Map(histTxs.map((tx, i) => [tx.id, i]));
        // Transactions WE sent, so a transparent output of ours is change
        // coming back - not income.
        //
        // parseTransparentTx only sums outputs matching our scripts; the
        // comment there concedes inputs carry no value, so a t->t or z->t
        // payment with change to ourselves was rendered as
        // "received +<change> ZEC", and one with no change back never appeared
        // at all. Telling a user they RECEIVED money they actually spent is
        // the worst direction for this error to point.
        //
        // We cannot recover transparent input ownership from what the server
        // returns, but we do know what we broadcast: the local `sent` store
        // records every txid we sent. That is enough to stop inventing income.
        let ownSentTxids = new Set<string>();
        try {
          const ownSent = await idbGetAllByIndex<SentTxRecord>('sent', 'byWallet', walletId);
          ownSentTxids = new Set(ownSent.map(s => s.txid));
        } catch {
          // best effort - a missing record must not break history
        }

        for (const tTx of tHistory) {
          const existingIdx = seenTxids.get(tTx.txid);
          if (existingIdx !== undefined) {
            histTxs[existingIdx]!.type = 'shield';
            continue;
          }
          if (ownSentTxids.has(tTx.txid)) {
            // ours: the reconciliation pass below supplies the real amount,
            // recipient and fee from the record we wrote at broadcast.
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

        // Reconcile with what WE recorded at broadcast. The chain cannot give
        // those details back: an outgoing note is encrypted to the recipient,
        // so scanning recovers a send only via OVK decryption and never
        // recovers the recipient/memo the user actually chose.
        //
        // Reconciliation - not a naive merge. The earlier merge skipped any
        // txid already present in the chain-derived list, but that list gets an
        // entry for our own send the moment we broadcast, because
        // markNotesSpentLocally records the inputs we spent. That entry has no
        // height and an amount computed from input totals rather than what the
        // user sent, and it was suppressing the accurate local record behind
        // it: the send looked like it had never left, then surfaced as a wrong
        // partial row. Only a real block height counts as confirmation now.
        let reconciled: HistoryTx[];
        try {
          const sent = await idbGetAllByIndex<SentTxRecord>('sent', 'byWallet', walletId);

          // Direct confirmation lookup. Reconcile confirms a send only on a real
          // block height, and until now that height came exclusively from the
          // scan tagging our spent input note. That path is fragile: a block
          // scanned before the spend was recorded, or a backend that serves
          // incomplete ironwood actions for a block, leaves our own mined tx with
          // no height, so it shows "pending" forever even though the explorer has
          // it confirmed. So for any still-pending send with no height yet, ask
          // the node outright which block the txid is in - it is OUR broadcast
          // txid on the SAME node, so this reveals nothing the node did not
          // already see. Bounded to pending, height-less records; once confirmed,
          // confirmedHeight is persisted and the lookup never runs for it again.
          const haveRealHeight = new Set(histTxs.filter(t => t.height > 0).map(t => t.id));
          const needLookup = sent.filter(
            s =>
              !(typeof s.confirmedHeight === 'number' && s.confirmedHeight > 0) &&
              !haveRealHeight.has(s.txid),
          );
          if (needLookup.length > 0) {
            try {
              const lookupClient = makeZcashClient(histServerUrl);
              const found = await Promise.all(
                needLookup.map(async s => {
                  try {
                    const raw = await lookupClient.getTransaction(hexDecode(s.txid));
                    return raw.height && raw.height > 0 ? { s, height: raw.height } : null;
                  } catch {
                    return null; // a failed lookup just leaves it pending
                  }
                }),
              );
              for (const hit of found) {
                if (!hit) {
                  continue;
                }
                histTxs.push({
                  id: hit.s.txid,
                  height: hit.height,
                  type: hit.s.kind === 'shield' ? 'shield' : 'send',
                  amount: (BigInt(hit.s.amount) + BigInt(hit.s.fee)).toString(),
                  asset: 'ZEC',
                });
              }
            } catch (e) {
              console.warn(
                `[zcash-worker] get-history: pending-send height lookup failed: ${errText(e)}`,
              );
            }
          }

          const result = reconcileSentTxs({
            chainTxs: histTxs,
            sent,
            scannedHeight: histScannedHeight,
          });
          reconciled = result.txs;
          // fire-and-forget: display must not wait on (or fail with) a write
          void applyReconciliation(walletId, result.confirm, result.prune);
        } catch (e) {
          console.warn(`[zcash-worker] could not read local sent records: ${errText(e)}`);
          reconciled = reconcileSentTxs({ chainTxs: histTxs, sent: [], scannedHeight: 0 }).txs;
        }

        workerSelf.postMessage({
          type: 'history',
          id,
          network: 'zcash',
          walletId,
          payload: reconciled,
        });
        return;
      }

      case 'sync-memos': {
        if (!walletId) {
          throw new Error('walletId required');
        }
        const {
          serverUrl: memoServerUrl,
          existingTxIds,
          forceResync,
        } = payload as {
          serverUrl: string;
          existingTxIds: string[];
          forceResync: boolean;
        };

        // Opening the inbox again with no note found or spent since the last
        // read has nothing new to read: answer from two counts, without
        // loading every note (and its witness) out of the store.
        const db = await getDb();
        const fpKey = `${walletId}:memo-fp`;
        const count = (store: 'notes' | 'spent') =>
          new Promise<number>((resolve, reject) => {
            const req = db
              .transaction(store, 'readonly')
              .objectStore(store)
              .index('byWallet')
              .count(walletId);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
        const fingerprint = `${await count('notes')}:${await count('spent')}`;
        const lastFingerprint = await new Promise<unknown>(resolve => {
          const req = db.transaction('memo-cache', 'readonly').objectStore('memo-cache').get(fpKey);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(undefined);
        });
        const remember = () =>
          new Promise<void>((resolve, reject) => {
            const req = db
              .transaction('memo-cache', 'readwrite')
              .objectStore('memo-cache')
              .put(fingerprint, fpKey);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
          });
        if (!forceResync && lastFingerprint === fingerprint) {
          workerSelf.postMessage({
            type: 'memos-result',
            id,
            network: 'zcash',
            walletId,
            payload: [],
          });
          return;
        }

        const memoState = await loadState(walletId);
        const memoKeys = walletStates.get(walletId)?.keys;
        if (!memoKeys) {
          throw new Error('wallet keys not loaded');
        }

        const memoNotes = memoState.notes.map(n => ({
          ...n,
          spent: memoState.spentNullifiers.has(n.nullifier),
        }));

        if (memoNotes.length === 0) {
          workerSelf.postMessage({
            type: 'memos-result',
            id,
            network: 'zcash',
            walletId,
            payload: [],
          });
          return;
        }

        // load persisted set of note txids already scanned (no memo found)
        const scannedKey = `${walletId}:scanned-txids`;
        const scannedTxids: Set<string> = await new Promise(resolve => {
          const tx = db.transaction('memo-cache', 'readonly');
          const req = tx.objectStore('memo-cache').get(scannedKey);
          req.onsuccess = () => resolve(new Set((req.result as string[]) ?? []));
          req.onerror = () => resolve(new Set());
        });

        // filter notes not yet processed
        const processedTxids = new Set([...existingTxIds, ...scannedTxids]);
        const notesToProcess = memoNotes.filter(n => n.txid && !processedTxids.has(n.txid));
        // also check spent_by_txids that haven't been processed
        const unprocessedSpent = memoNotes.some(
          n => n.spent_by_txid && !processedTxids.has(n.spent_by_txid),
        );
        if (notesToProcess.length === 0 && !unprocessedSpent) {
          await remember();
          workerSelf.postMessage({
            type: 'memos-result',
            id,
            network: 'zcash',
            walletId,
            payload: [],
          });
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
          if (note.txid) {
            txidToHeight.set(note.txid, note.height);
          }
        }

        const spentHeights = new Set<number>();
        const spentTxIds = new Map<number, Set<string>>(); // height → spent_by_txids
        // spends broadcast but not yet mined: no block to read their memo from
        // yet, so they stay unscanned and are read once their height is known
        const unmined = new Set<string>();
        for (const note of memoNotes) {
          if (!note.spent_by_txid || processedTxids.has(note.spent_by_txid)) {
            continue;
          }
          const h = note.spent_at_height || txidToHeight.get(note.spent_by_txid);
          if (!h) {
            unmined.add(note.spent_by_txid);
          }
          if (h) {
            spentHeights.add(h);
            let set = spentTxIds.get(h);
            if (!set) {
              set = new Set();
              spentTxIds.set(h, set);
            }
            set.add(note.spent_by_txid);
          }
        }

        // ── compute the input set: buckets containing real owned/spent notes ──
        const ORCHARD_ACTIVATION_HEIGHT = 1687104;

        const ownedBucketSet = new Set<MemoBucketStart>();
        for (const height of notesByHeight.keys()) {
          ownedBucketSet.add(bucketOf(height));
        }
        for (const height of spentHeights) {
          ownedBucketSet.add(bucketOf(height));
        }

        // ── clear per-bucket cache on force resync (preserves the scanned-txids set) ──
        if (forceResync) {
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('memo-cache', 'readwrite');
            const store = tx.objectStore('memo-cache');
            const req = store.openCursor();
            req.onsuccess = () => {
              const cursor = req.result;
              if (cursor) {
                const key = cursor.key as string;
                // wipe per-bucket entries (numeric suffix), keep scanned-txids
                if (key.startsWith(`${walletId}:`) && key !== scannedKey) {
                  cursor.delete();
                }
                cursor.continue();
              } else {
                resolve();
              }
            };
            req.onerror = () => reject(req.error);
          });
        }

        // ── build the memo-sync strategy ──
        // spent buckets must always be fetched (OVK path), so we pass that
        // info to the cache filter via alwaysFetch.
        const spentBuckets = new Set<MemoBucketStart>();
        for (const h of spentHeights) {
          spentBuckets.add(bucketOf(h));
        }

        const memoClient = makeZcashClient(memoServerUrl);
        const memoZidecar = zidecarExtras(memoServerUrl, lookupBackend(memoServerUrl));
        const { height: currentTip } = await memoClient.getTip();

        // estimate block time from tip (no per-height GetBlock calls - preserves bucket privacy)
        const tipTimeMs = Date.now();
        const estimateBlockTimeMs = (h: number): number => tipTimeMs + (h - currentTip) * 75000;

        // zidecar serves whole blocks, so memos are read by bucket with decoys
        // around them. A standard lightwalletd has no such rpc: there the
        // wallet's own transactions are fetched by id, as lightwalletd wallets do.
        // Any non-'fast' value (including legacy 'paranoid' from older
        // storage) falls back to 'private'.
        const rawStrategy = (payload as { strategy?: string }).strategy;
        const strategyName: MemoSyncStrategy = rawStrategy === 'fast' ? 'fast' : 'private';
        const ownTxids = new Map(spentTxIds);
        for (const n of notesToProcess) {
          ownTxids.set(n.height, new Set([...(ownTxids.get(n.height) ?? []), n.txid]));
        }
        const fetcher = memoZidecar
          ? buildStrategy(strategyName, {
              base: blockRangeFetcher(memoZidecar, {
                maxHeight: currentTip,
                bucketSize: MEMO_BUCKET_SIZE,
              }),
              store: idbBucketStore({ open: () => Promise.resolve(db) }),
              alwaysFetch: b => spentBuckets.has(b),
            })
          : txidMemoFetcher(memoClient, ownTxids);

        // ── consume the async iterable; decode memos from each yielded bucket ──
        // progress: the base fetcher knows the post-cache, post-decoy total and
        // calls ctx.onProgress with accurate (completed, total) - we just
        // forward those values to the UI.
        const results: {
          txId: string;
          blockHeight: number;
          timestamp: number;
          content: string;
          direction: string;
          amount: string;
          memoBytes?: string;
          diversifierIndex?: number;
          /** incoming: the raw orchard address of ours the note was paid to (hex) */
          receiver?: string;
        }[] = [];
        const abortCtrl = new AbortController();

        for await (const { blocks } of fetcher(walletId, ownedBucketSet, {
          signal: abortCtrl.signal,
          tip: currentTip,
          activation: ORCHARD_ACTIVATION_HEIGHT,
          onProgress: (current, total) => {
            workerSelf.postMessage({
              type: 'sync-memos-progress',
              id: '',
              network: 'zcash',
              walletId,
              payload: { current, total },
            });
          },
        })) {
          for (const { height, txs } of blocks) {
            const heightNotes = notesByHeight.get(height);
            const isSpentHeight = spentHeights.has(height);
            if ((!heightNotes || heightNotes.length === 0) && !isSpentHeight) {
              continue;
            }

            const cmxSet = new Set(heightNotes?.map(n => n.cmx) ?? []);

            for (const { data: txBytes } of txs) {
              if (txBytes.length < 200) {
                continue;
              }

              const txBuf = new Uint8Array(txBytes);
              patchBranchId(txBuf);
              const foundMemos = memoKeys.decrypt_transaction_memos(txBuf);

              for (const memo of foundMemos) {
                // structured binary memos (0xF6 prefix) are handled separately
                // check if this is a zafu structured binary memo (0xFF 0x5A magic)
                const memoRawHex = memo.memo_bytes || '';
                const isStructured = memoRawHex.length === 1024 && memoRawHex.startsWith('ff5a');
                if (!isStructured && (!memo.memo_is_text || !memo.memo.trim())) {
                  continue;
                }

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
                  if (!cmxSet.has(memo.cmx)) {
                    continue;
                  }
                  const matchingNote = heightNotes?.find(n => n.cmx === memo.cmx);
                  if (!matchingNote) {
                    continue;
                  }
                  if (processedTxids.has(matchingNote.txid)) {
                    continue;
                  }

                  results.push({
                    txId: matchingNote.txid,
                    blockHeight: height,
                    timestamp: estimateBlockTimeMs(height),
                    content: memo.memo,
                    direction: 'received',
                    amount: (memo.value / 100_000_000).toFixed(8),
                    memoBytes: isStructured ? memoRawHex : undefined,
                    receiver: matchingNote.recipient,
                  });
                  processedTxids.add(matchingNote.txid);
                }
              }
            }
          }
        }

        // persist all scanned note txids + spent_by_txids so we don't re-scan next time
        const allScanned = new Set(scannedTxids);
        for (const n of notesToProcess) {
          if (n.txid) {
            allScanned.add(n.txid);
          }
        }
        for (const n of memoNotes) {
          if (n.spent_by_txid && !unmined.has(n.spent_by_txid)) {
            allScanned.add(n.spent_by_txid);
          }
        }
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('memo-cache', 'readwrite');
          const req = tx.objectStore('memo-cache').put([...allScanned], scannedKey);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
        // a spend's height can arrive without any note being found or spent,
        // so the counts cannot tell; read again on the next open until it does
        if (unmined.size === 0) {
          await remember();
        }

        workerSelf.postMessage({
          type: 'memos-result',
          id,
          network: 'zcash',
          walletId,
          payload: results,
        });
        return;
      }

      case 'send-tx': {
        if (!walletId) {
          throw new Error('walletId required');
        }
        await initWasm();
        if (!wasmModule) {
          throw new Error('wasm not initialized');
        }

        const sendPayload = payload as {
          serverUrl: string;
          recipient: string;
          amount: string;
          memo: string;
          accountIndex: number;
          mainnet: boolean;
          /** hot wallet: the sealed vault this worker opens itself */
          vault?: SealedVault;
          ufvk?: string;
          /** the page's key for stopping this build before it broadcasts */
          cancelKey?: string;
        };
        const build = builds.begin(sendPayload.cancelKey);
        // a hot build signs with the account of the store its notes come from
        const spendAccount = sendPayload.vault
          ? hotSpendAccount(walletId, sendPayload.accountIndex)
          : sendPayload.accountIndex;

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
            memoHex = Array.from(bytes)
              .map(b => b.toString(16).padStart(2, '0'))
              .join('');
          }
        }

        const sendStart = performance.now();
        const emitProgress = (step: string, detail?: string) => {
          const elapsed = ((performance.now() - sendStart) / 1000).toFixed(1);
          console.log(`[zcash-worker] send [${elapsed}s] ${step}${detail ? ': ' + detail : ''}`);
          workerSelf.postMessage({
            type: 'send-progress',
            id: '',
            network: 'zcash',
            walletId,
            payload: { step, detail, elapsedMs: Math.round(performance.now() - sendStart) },
          });
        };

        emitProgress('loading wallet state');

        // load wallet state from IDB
        const sendState = await loadState(walletId);
        const amountZat = BigInt(sendPayload.amount);

        // determine recipient type for fee calc
        const isTransparent = isTransparentRecipient(sendPayload.recipient);
        const nZOutputs = isTransparent ? 0 : 1;
        const nTOutputs = isTransparent ? 1 : 0;

        emitProgress('selecting notes', `${sendState.notes.length} notes available`);

        // witness/tip client - also reads the chain tip that decides the spend
        // pool and the endpoint consensus branch id.
        const sendClient = makeZcashClient(sendPayload.serverUrl);

        emitProgress('fetching chain tip');
        const sendTip = await build.race(sendClient.getTip());

        // ── NU6.3 spend-pool selection ──────────────────────────────────────
        // Post-NU6.3 (synced tip >= activation height) orchard-to-orchard sends
        // are consensus-disabled, so the active shielded spend pool is ironwood.
        // Pre-activation we keep spending orchard (legacy path).
        const sendActivePool: NotePool =
          sendTip.height >= nu63ActivationHeight(sendPayload.mainnet) ? 'ironwood' : 'orchard';

        // FAIL-CLOSED: never build an orchard tx the network rejects post-NU6.3.
        // If the active pool is ironwood but the wallet holds no ironwood notes
        // while it DOES hold orchard funds, refuse and point the user at the
        // turnstile migration rather than silently building a dead orchard tx.
        if (sendActivePool === 'ironwood') {
          const unspentIronwood = sendState.notes.filter(
            n => !sendState.spentNullifiers.has(n.nullifier) && poolOf(n) === 'ironwood',
          );
          const unspentOrchard = sendState.notes.filter(
            n => !sendState.spentNullifiers.has(n.nullifier) && poolOf(n) === 'orchard',
          );
          if (unspentIronwood.length === 0 && unspentOrchard.length > 0) {
            throw new Error(
              // Names the CONSEQUENCE, not the consensus rule. The old string
              // ("orchard sends are disabled at NU6.3") was a developer's note:
              // it cited a rule, used two pool names as though the reader knows
              // them, and gave an imperative with no affordance. vizor-wallet,
              // which has already shipped this exact migration, frames it as
              // "your balance is frozen, one move fixes it, funds stay yours".
              'your shielded funds are in the older orchard format. zcash replaced ' +
                'it with ironwood, so they cannot be spent directly. moving them ' +
                'once makes them spendable again - the funds stay yours the whole ' +
                'time, and nothing leaves your wallet.',
            );
          }
        }

        // estimate fee and select notes from the active pool
        const estFee = computeFee(1, nZOutputs, nTOutputs, true);
        const selected = selectNotes(
          sendState.notes,
          sendState.spentNullifiers,
          amountZat + estFee,
          sendActivePool,
          heldBy(walletId, sendActivePool),
        );

        // compute exact fee (n active-pool spends + 1 output + change?)
        const totalIn = selected.reduce((sum, n) => sum + BigInt(n.value), 0n);
        const hasChange =
          totalIn > amountZat + computeFee(selected.length, nZOutputs, nTOutputs, true);
        const fee = computeFee(selected.length, nZOutputs, nTOutputs, hasChange);
        if (totalIn < amountZat + fee) {
          throw new Error(`insufficient funds: have ${totalIn} zat, need ${amountZat + fee} zat`);
        }

        emitProgress('notes selected', `${selected.length} ${sendActivePool} notes, fee=${fee}`);

        // paths from the active pool's note tree, at its newest checkpoint
        emitProgress('building merkle witnesses', `tip=${sendTip.height}`);
        const witnessStart = performance.now();

        const witnessing = buildWitnesses(
          sendClient,
          walletId,
          selected,
          sendTip.height,
          sendActivePool,
        );
        const { anchorHex, anchorHeight, paths } = await build.race(witnessing);

        const witnessDuration = ((performance.now() - witnessStart) / 1000).toFixed(1);
        // how fresh the witnesses were: a gap beyond a few blocks means sync was behind
        console.log(
          `[zcash-timing] witnesses ${witnessDuration}s: pool=${sendActivePool} anchor=${anchorHeight} ` +
            `synced=${await getSyncHeight(walletId)} tip=${sendTip.height} gap=${sendTip.height - anchorHeight}`,
        );
        emitProgress('witnesses built', `${witnessDuration}s`);

        if (sendPayload.vault) {
          // ── NU6.3 IRONWOOD hot send ─────────────────────────────────────
          // Post-activation shielded spend path. Fail-closed branch-id guard
          // (copied verbatim from send-turnstile-migration), then the prover
          // builds + proves from this account's UFVK and the PCZT is signed
          // here, in this worker, and broadcast.
          if (sendActivePool === 'ironwood') {
            emitProgress('checking NU6.3 activation');
            const iwLightdInfo = await build.race(sendClient.getLightdInfo());
            const iwReportedBranchHex = (iwLightdInfo.consensusBranchId || '')
              .trim()
              .toLowerCase()
              .replace(/^0x/, '');
            if (!iwReportedBranchHex || iwReportedBranchHex === PLACEHOLDER_BRANCH_ID_HEX) {
              throw new Error(
                'NU6.3 is not active at this endpoint yet (placeholder consensus branch id) - ' +
                  'ironwood send is unavailable until NU6.3 activates',
              );
            }
            const iwRefusal = ironwoodBranchRefusal(
              iwReportedBranchHex,
              sendPayload.mainnet,
              'ironwood send',
            );
            if (iwRefusal) {
              throw new Error(iwRefusal);
            }
            emitProgress('NU6.3 active', `branch id 0x${iwReportedBranchHex}`);

            // z->t is supported (the ironwood builder adds a real transparent
            // output), but a transparent output has no memo field. Refuse here
            // rather than let the user believe a payment reference was
            // delivered - and rather than burn a ~2 minute halo2 prove first.
            if (isTransparent && memoHex) {
              throw new Error(
                'a memo cannot be delivered to a transparent address - transparent outputs ' +
                  'have no memo field. Send to a shielded (unified) address to include a memo.',
              );
            }

            const iwNotesJson = selected.map(n => ({
              value: Number(n.value),
              nullifier: n.nullifier,
              cmx: n.cmx,
              position: n.position,
              rseed_hex: n.rseed ?? '',
              rho_hex: n.rho ?? '',
              recipient_hex: n.recipient ?? '',
            }));
            const iwPathsForWasm = (paths as { position: number; path: { hash: string }[] }[]).map(
              p => ({ path: p.path.map(e => e.hash), position: p.position }),
            );

            emitProgress(
              'building, proving & signing ironwood tx (halo2)',
              `${selected.length} ironwood spends`,
            );
            const iwProveStart = performance.now();
            const iwProvingTicker = setInterval(() => {
              const elapsed = ((performance.now() - iwProveStart) / 1000).toFixed(0);
              emitProgress('proving (halo2)', `${elapsed}s elapsed`);
            }, 2000);
            let iwTxHex: string;
            try {
              // expected_branch_id is the live value validated above; the
              // producer refuses to build unless the branch id it binds equals it.
              const iwSigning = withSpendKeys(
                wasmModule.SpendKeys,
                sendPayload.vault,
                spendAccount,
                sendPayload.mainnet,
                async keys => {
                  const built = (await proveViaOffscreen({
                    fn: 'build_ironwood_send_pczt',
                    args: [
                      keys.ufvk(),
                      JSON.stringify(iwNotesJson),
                      sendPayload.recipient,
                      amountZat.toString(),
                      fee.toString(),
                      anchorHex,
                      JSON.stringify(iwPathsForWasm),
                      spendAccount,
                      sendTip.height,
                      parseInt(iwReportedBranchHex, 16),
                      sendPayload.mainnet,
                      memoHex,
                    ],
                  })) as { retained_pczt_hex: string };
                  return keys.sign_pczt(built.retained_pczt_hex);
                },
              );
              iwTxHex = await build.race(iwSigning);
            } catch (e) {
              // message only, never the caught args
              console.error(
                '[zcash-worker] ironwood hot send failed:',
                e instanceof Error ? e.message : String(e),
              );
              throw e;
            } finally {
              clearInterval(iwProvingTicker);
            }

            emitProgress('ironwood tx signed', `${iwTxHex.length / 2} bytes`);
            // the point of no return: a stop from here on is refused
            build.commit();
            emitProgress('broadcasting transaction');
            const iwTxData = hexDecode(iwTxHex);
            const iwBroadcastClient = makeZcashClient(sendPayload.serverUrl);
            const iwResult = await iwBroadcastClient.sendTransaction(iwTxData);
            if (iwResult.errorCode !== 0) {
              throw new Error(`broadcast failed (${iwResult.errorCode}): ${iwResult.errorMessage}`);
            }
            const iwTxid = await resolveBroadcastTxid(iwResult, iwTxHex, sendPayload.serverUrl);
            await markNotesSpentLocally(walletId, sendState, selected, iwTxid);
            await recordSentTx({
              walletId,
              txid: iwTxid,
              amount: amountZat.toString(),
              fee: fee.toString(),
              recipient: sendPayload.recipient,
              pool: 'ironwood',
              kind: 'send',
              memo: sendPayload.memo,
              sentAt: Date.now(),
              // taken from the bytes the network actually saw, so the record
              // cannot disagree with the transaction about when it dies
              expiryHeight: parseExpiryHeight(iwTxHex),
            });
            const iwTotalDuration = ((performance.now() - sendStart) / 1000).toFixed(1);
            emitProgress('complete', `txid=${iwTxid}, total=${iwTotalDuration}s`);
            workerSelf.postMessage({
              type: 'tx-result',
              id,
              network: 'zcash',
              walletId,
              payload: { txid: iwTxid, fee: fee.toString() },
            });
            return;
          }

          // hot wallet before NU6.3: the orchard PCZT the cold path builds, signed here
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
          const pathsResult = paths as { position: number; path: { hash: string }[] }[];
          const merklePathsForWasm = pathsResult.map(p => ({
            path: p.path.map(e => e.hash),
            position: p.position,
          }));

          emitProgress(
            'building & proving transaction (halo2, parallel)',
            `${selected.length} spends`,
          );
          const proveStart = performance.now();
          // keep the clock ticking during proving so the UI doesn't look frozen
          const provingTicker = setInterval(() => {
            const elapsed = ((performance.now() - proveStart) / 1000).toFixed(0);
            emitProgress('proving (halo2)', `${elapsed}s elapsed`);
          }, 2000);

          let txHex: string;
          try {
            const signing = withSpendKeys(
              wasmModule.SpendKeys,
              sendPayload.vault,
              spendAccount,
              sendPayload.mainnet,
              async keys => {
                const built = (await proveViaOffscreen({
                  fn: 'build_unsigned_pczt',
                  args: [
                    keys.ufvk(),
                    notesJson,
                    sendPayload.recipient,
                    amountZat.toString(),
                    fee.toString(),
                    anchorHex,
                    merklePathsForWasm,
                    sendTip.height,
                    sendPayload.mainnet,
                    memoHex,
                  ],
                })) as { pczt_hex: string };
                return keys.sign_pczt(built.pczt_hex);
              },
            );
            txHex = await build.race(signing);
          } catch (e) {
            console.error(
              '[zcash-worker] orchard hot send failed:',
              e instanceof Error ? e.message : String(e),
            );
            throw e;
          } finally {
            clearInterval(provingTicker);
          }

          const proveDuration = ((performance.now() - proveStart) / 1000).toFixed(1);
          emitProgress('transaction proved', `${proveDuration}s, ${txHex.length / 2} bytes`);

          // broadcast; the point of no return: a stop from here on is refused
          build.commit();
          emitProgress('broadcasting transaction');
          const txData = hexDecode(txHex);
          const broadcastClient = makeZcashClient(sendPayload.serverUrl);
          let result: { errorCode: number; errorMessage: string; txid: Uint8Array };
          try {
            result = await broadcastClient.sendTransaction(txData);
          } catch (e) {
            console.error(`[zcash-worker] broadcast RPC failed: ${errText(e)}`);
            throw e;
          }
          if (result.errorCode !== 0) {
            throw new Error(`broadcast failed (${result.errorCode}): ${result.errorMessage}`);
          }

          const txid = await resolveBroadcastTxid(result, txHex, sendPayload.serverUrl);
          await markNotesSpentLocally(walletId, sendState, selected, txid);
          await recordSentTx({
            walletId,
            txid,
            amount: amountZat.toString(),
            fee: fee.toString(),
            recipient: sendPayload.recipient,
            pool: sendActivePool,
            kind: 'send',
            memo: sendPayload.memo,
            sentAt: Date.now(),
            expiryHeight: parseExpiryHeight(txHex),
          });
          const totalDuration = ((performance.now() - sendStart) / 1000).toFixed(1);
          emitProgress('complete', `txid=${txid}, total=${totalDuration}s`);

          workerSelf.postMessage({
            type: 'tx-result',
            id,
            network: 'zcash',
            walletId,
            payload: { txid, fee: fee.toString() },
          });
          return;
        }

        // zigner wallet: build unsigned transaction for cold signing (real v5 tx bytes)
        if (!sendPayload.ufvk) {
          throw new Error('UFVK required for zigner wallet send');
        }

        // FAIL-CLOSED (NU6.3): this legacy simple-format (sighash+alphas) cold
        // path only builds orchard txs, which are consensus-disabled
        // post-activation. The reachable zigner cold-sign path is the PCZT
        // machine (`send-tx-pczt`, driven by the send UI's
        // buildSendTxPcztInWorker), which routes ironwood through
        // build_ironwood_send_pczt. Refuse here rather than build an invalid
        // orchard tx or duplicate the ironwood path in an unreachable branch.
        if (sendActivePool === 'ironwood') {
          throw new Error(
            'cold (zigner) ironwood send runs through the PCZT cold-sign path, not this ' +
              'legacy simple-format path - orchard sends are disabled at NU6.3',
          );
        }

        emitProgress(
          'building & proving unsigned transaction (halo2)',
          `${selected.length} spends`,
        );
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

        const pathsForWasm = (paths as { position: number; path: { hash: string }[] }[]).map(p => ({
          path: p.path.map(e => e.hash),
          position: p.position,
        }));

        // live consensus branch id for the ZIP-244 sighash + v5 header (NU6.3-safe)
        const sendBranchIdHex = await build.race(fetchBranchIdHex(sendClient));

        // build unsigned transaction with real Halo 2 proofs (parallel via offscreen)
        const proving = proveViaOffscreen({
          fn: 'build_unsigned',
          args: [
            sendPayload.ufvk,
            notesForWasm,
            sendPayload.recipient,
            amountZat.toString(),
            fee.toString(),
            anchorHex,
            pathsForWasm,
            sendPayload.accountIndex,
            sendPayload.mainnet,
            memoHex,
            sendBranchIdHex,
          ],
        });
        const unsignedResult = await build.race(proving);

        const proveDurationZ = ((performance.now() - proveStartZ) / 1000).toFixed(1);
        emitProgress('unsigned transaction proved', `${proveDurationZ}s`);

        const parsed = unsignedResult as {
          sighash: string;
          alphas: string[];
          unsigned_tx: string;
          spend_indices: number[];
          summary: string;
        };

        const totalDuration = ((performance.now() - sendStart) / 1000).toFixed(1);
        emitProgress('unsigned tx ready', `total=${totalDuration}s`);

        // a stopped build leaves no stash behind
        build.check();
        // Everything send-tx-complete will need and cannot recover from the
        // signed bytes. See the ColdSendContext comment.
        const coldSendId = await stashColdSend(walletId, {
          nullifiers: selected.map(n => n.nullifier),
          amount: amountZat.toString(),
          fee: fee.toString(),
          recipient: sendPayload.recipient,
          pool: sendActivePool,
          kind: 'send',
          memo: sendPayload.memo,
        });

        workerSelf.postMessage({
          type: 'send-tx-unsigned',
          id,
          network: 'zcash',
          walletId,
          payload: {
            sighash: parsed.sighash,
            alphas: parsed.alphas,
            summary: parsed.summary,
            fee: fee.toString(),
            unsignedTx: parsed.unsigned_tx,
            spendIndices: parsed.spend_indices,
            coldSendId,
          },
        });
        return;
      }

      case 'send-tx-complete': {
        if (!walletId) {
          throw new Error('walletId required');
        }
        await initWasm();
        if (!wasmModule) {
          throw new Error('wasm not initialized');
        }

        const completePayload = payload as {
          serverUrl: string;
          unsignedTx: string;
          signatures: { orchardSigs: string[]; transparentSigs: string[] };
          spendIndices: number[];
          /** id returned by the send-tx build; see ColdSendContext */
          coldSendId?: string;
        };

        // pass orchard spend auth signatures and their action indices
        const txHex = wasmModule.complete_transaction(
          completePayload.unsignedTx,
          completePayload.signatures.orchardSigs,
          completePayload.spendIndices,
        );
        const txData = hexDecode(txHex);

        const completeClient = makeZcashClient(completePayload.serverUrl);
        const result = await completeClient.sendTransaction(txData);
        if (result.errorCode !== 0) {
          throw new Error(`broadcast failed (${result.errorCode}): ${result.errorMessage}`);
        }

        const txid = await resolveBroadcastTxid(result, txHex, completePayload.serverUrl);
        // Same bookkeeping the hot paths do at this exact point: the inputs are
        // spent as of this broadcast whether or not anything ever rescans.
        await finalizeColdBroadcast(walletId, completePayload.coldSendId, txid, txHex);
        workerSelf.postMessage({
          type: 'tx-result',
          id,
          network: 'zcash',
          walletId,
          payload: { txid },
        });
        return;
      }

      // ── PCZT signing flow (single-signer zigner) ──────────────────────
      // Mirrors `send-tx` for the unsigned-build phase, but emits a real
      // pczt::Pczt::serialize() byte stream instead of [sighash][alphas][summary].
      // The cold device verifies note inclusion + value consistency before
      // signing, and recomputes the sighash from the PCZT contents - so
      // display and signed bytes are bound by construction.

      case 'send-tx-pczt': {
        if (!walletId) {
          throw new Error('walletId required');
        }
        await initWasm();
        if (!wasmModule) {
          throw new Error('wasm not initialized');
        }

        const sendPayload = payload as {
          serverUrl: string;
          recipient: string;
          amount: string; // zatoshi
          memo: string;
          targetHeight: number;
          mainnet: boolean;
          ufvk: string;
          /** UR fragment-size override; falls back to 200 for back-compat */
          fragmentSize?: number;
          /**
           * The PCZT feeds a FROST multisig signing round, so the caller needs
           * the `sighash` / `alphas` / `spendIndices` fields below. Only the
           * orchard builder emits them; see the fail-closed guard after the
           * spend-pool resolution.
           */
          frost?: boolean;
          /** the page's key for stopping this build (see build-abort.ts) */
          cancelKey?: string;
          /**
           * Zigner signs this: an orchard PCZT rides the module envelope
           * (`ur:zigner-module`) as ironwood does, because zigner's native
           * `ur:zcash-pczt` path refuses a transparent output (a send to a
           * t-address, a tex, a swap's own address). Absent (keystone and the
           * FROST/ledger builders): the `ur:zcash-pczt` CBOR wrap, unchanged.
           */
          zigner?: boolean;
        };
        const build = builds.begin(sendPayload.cancelKey);
        if (!sendPayload.ufvk) {
          throw new Error('UFVK required for PCZT build');
        }

        // Mirror send-tx note selection / witness build. Inlined rather than
        // factored out because send-tx's variant has interleaved emitProgress
        // calls and a fee-recompute loop that we want to keep verbatim - and
        // because the pczt builder's only meaningful difference from
        // build_unsigned_transaction is the output format, not the inputs.
        let memoHex: string | null = null;
        if (sendPayload.memo) {
          if (/^[0-9a-f]+$/i.test(sendPayload.memo) && sendPayload.memo.startsWith('ff5a')) {
            memoHex = sendPayload.memo;
          } else {
            const bytes = new TextEncoder().encode(sendPayload.memo);
            memoHex = Array.from(bytes)
              .map(b => b.toString(16).padStart(2, '0'))
              .join('');
          }
        }

        const sendStart = performance.now();
        const emitProgress = (step: string, detail?: string) => {
          console.log(
            `[zcash-worker] send-pczt [${((performance.now() - sendStart) / 1000).toFixed(1)}s] ${step}${detail ? ': ' + detail : ''}`,
          );
          workerSelf.postMessage({
            type: 'send-progress',
            id: '',
            network: 'zcash',
            walletId,
            payload: { step, detail, elapsedMs: Math.round(performance.now() - sendStart) },
          });
        };

        emitProgress('loading wallet state');
        const sendState = await loadState(walletId);
        const amountZat = BigInt(sendPayload.amount);

        const isTransparent = isTransparentRecipient(sendPayload.recipient);
        const nZOutputs = isTransparent ? 0 : 1;
        const nTOutputs = isTransparent ? 1 : 0;

        emitProgress('selecting notes', `${sendState.notes.length} notes available`);

        // ── NU6.3 spend-pool selection (mirror of the hot send-tx path) ─────
        // The chain tip decides the active shielded spend pool, so fetch it
        // BEFORE note selection: post-activation orchard-to-orchard sends are
        // consensus-disabled, so the active pool is ironwood; pre-activation we
        // keep spending orchard (legacy cold PCZT path).
        const sendClient = makeZcashClient(sendPayload.serverUrl);
        emitProgress('fetching chain tip');
        const sendTip = await build.race(sendClient.getTip());
        const pcztPool: NotePool =
          sendTip.height >= nu63ActivationHeight(sendPayload.mainnet) ? 'ironwood' : 'orchard';

        // NU6.3 x FROST: multisig sends on ironwood used to be refused here.
        // The three gaps that forced it are closed: build_ironwood_send_pczt now
        // returns the ZIP-244 sighash, the per-spend alphas and the spend
        // indices; complete_ironwood_pczt applies the aggregated SpendAuth sigs
        // via pczt's Signer::apply_ironwood_signature and re-verifies them
        // against the sighash while extracting; and frost_inspect_pczt_outputs
        // derives the joiner's sighash from pczt's version-dispatching Signer
        // instead of v5_signature_hash, so a co-signer's display is bound to
        // the message it actually signs.
        //
        // FROST itself never needed changing: a RedPallas spend-auth signature
        // over the sighash is the same for an ironwood action as an orchard one.

        // FAIL-CLOSED: never build an orchard PCZT the network rejects
        // post-NU6.3. If the active pool is ironwood but the wallet holds no
        // ironwood notes while it DOES hold orchard funds, refuse and point at
        // the turnstile migration rather than silently building a dead tx.
        if (pcztPool === 'ironwood') {
          const unspentIronwood = sendState.notes.filter(
            n => !sendState.spentNullifiers.has(n.nullifier) && poolOf(n) === 'ironwood',
          );
          const unspentOrchard = sendState.notes.filter(
            n => !sendState.spentNullifiers.has(n.nullifier) && poolOf(n) === 'orchard',
          );
          if (unspentIronwood.length === 0 && unspentOrchard.length > 0) {
            throw new Error(
              // Names the CONSEQUENCE, not the consensus rule. The old string
              // ("orchard sends are disabled at NU6.3") was a developer's note:
              // it cited a rule, used two pool names as though the reader knows
              // them, and gave an imperative with no affordance. vizor-wallet,
              // which has already shipped this exact migration, frames it as
              // "your balance is frozen, one move fixes it, funds stay yours".
              'your shielded funds are in the older orchard format. zcash replaced ' +
                'it with ironwood, so they cannot be spent directly. moving them ' +
                'once makes them spendable again - the funds stay yours the whole ' +
                'time, and nothing leaves your wallet.',
            );
          }
        }

        const estFee = computeFee(1, nZOutputs, nTOutputs, true);
        const selected = selectNotes(
          sendState.notes,
          sendState.spentNullifiers,
          amountZat + estFee,
          pcztPool,
          heldBy(walletId, pcztPool),
        );
        const totalIn = selected.reduce((sum, n) => sum + BigInt(n.value), 0n);
        const hasChange =
          totalIn > amountZat + computeFee(selected.length, nZOutputs, nTOutputs, true);
        const fee = computeFee(selected.length, nZOutputs, nTOutputs, hasChange);
        if (totalIn < amountZat + fee) {
          throw new Error(`insufficient funds: have ${totalIn} zat, need ${amountZat + fee} zat`);
        }
        emitProgress('notes selected', `${selected.length} ${pcztPool} notes, fee=${fee}`);

        // paths from the active pool's note tree at its newest checkpoint;
        // target_height stays at the live tip for branch_id/expiry
        emitProgress('building merkle witnesses', `tip=${sendTip.height}`);
        const witnessing = buildWitnesses(sendClient, walletId, selected, sendTip.height, pcztPool);
        const { anchorHex, anchorHeight, paths } = await build.race(witnessing);
        console.log(
          `[zcash-timing] witnesses: pool=${pcztPool} anchor=${anchorHeight} ` +
            `synced=${await getSyncHeight(walletId)} tip=${sendTip.height} gap=${sendTip.height - anchorHeight}`,
        );

        const notesForWasm = selected.map(n => ({
          value: Number(n.value),
          nullifier: n.nullifier,
          cmx: n.cmx,
          position: n.position,
          rseed_hex: n.rseed ?? '',
          rho_hex: n.rho ?? '',
          recipient_hex: n.recipient ?? '',
        }));
        const pathsForWasm = (paths as { position: number; path: { hash: string }[] }[]).map(p => ({
          path: p.path.map(e => e.hash),
          position: p.position,
        }));

        // ── NU6.3 IRONWOOD cold (zigner / watch-only) PCZT ─────────────────
        // Post-activation: build the redacted-for-signer ironwood-send PCZT via
        // build_ironwood_send_pczt and transport it over the ironwood-AWARE
        // zigner prelude envelope (the plain ur:zcash-pczt CBOR used by the
        // orchard branch below reaches the ironwood-BLIND signer, which hides
        // the destination and shows a fee ~= the whole amount). Returns the
        // SAME send-tx-pczt-unsigned message shape the orchard branch posts, so
        // buildSendTxPcztInWorker + the UI PCZT sign step + send-tx-pczt-complete
        // consume it unchanged; the FROST fields are empty for the single-signer
        // zigner cold-sign.
        if (pcztPool === 'ironwood') {
          // Fail-closed branch-id guard, identical to the hot ironwood send:
          // refuse unless NU6.3 is really active (real 0x37a5165b, never the
          // 0xffffffff placeholder).
          emitProgress('checking NU6.3 activation');
          const iwLightdInfo = await build.race(sendClient.getLightdInfo());
          const iwReportedBranchHex = (iwLightdInfo.consensusBranchId || '')
            .trim()
            .toLowerCase()
            .replace(/^0x/, '');
          if (!iwReportedBranchHex || iwReportedBranchHex === PLACEHOLDER_BRANCH_ID_HEX) {
            throw new Error(
              'NU6.3 is not active at this endpoint yet (placeholder consensus branch id) - ' +
                'ironwood send is unavailable until NU6.3 activates',
            );
          }
          const iwRefusal = ironwoodBranchRefusal(
            iwReportedBranchHex,
            sendPayload.mainnet,
            'ironwood send',
          );
          if (iwRefusal) {
            throw new Error(iwRefusal);
          }
          emitProgress('NU6.3 active', `branch id 0x${iwReportedBranchHex}`);

          // z->t is supported (the ironwood builder adds a real transparent
          // output), but a transparent output has no memo field. Refuse here
          // rather than let the user believe a payment reference was
          // delivered - and rather than burn a ~2 minute halo2 prove first.
          if (isTransparent && memoHex) {
            throw new Error(
              'a memo cannot be delivered to a transparent address - transparent outputs ' +
                'have no memo field. Send to a shielded (unified) address to include a memo.',
            );
          }

          emitProgress(
            'building & proving ironwood PCZT (halo2)',
            `${selected.length} ironwood spends`,
          );
          const iwProveStart = performance.now();
          const iwProvingTicker = setInterval(() => {
            const elapsed = ((performance.now() - iwProveStart) / 1000).toFixed(0);
            emitProgress('proving (halo2)', `${elapsed}s elapsed`);
          }, 2000);
          let iwBuilt: unknown;
          try {
            // build_ironwood_send_pczt args:
            // [ufvk, ironwood_notes_json, recipient, amount, fee,
            //  ironwood_anchor_hex, ironwood_merkle_paths_json, account_index,
            //  target_height, expected_branch_id, mainnet, memo_hex].
            // account_index is unused by the builder (the UFVK is already
            // account-scoped) so pass 0; this payload carries no accountIndex.
            // target_height = live tip (selects TxVersion::V6). expected_branch_id
            // is the value validated above; the producer refuses to build unless
            // the branch id it binds equals it.
            const iwProving = proveViaOffscreen({
              fn: 'build_ironwood_send_pczt',
              args: [
                sendPayload.ufvk,
                JSON.stringify(notesForWasm),
                sendPayload.recipient,
                amountZat.toString(),
                fee.toString(),
                anchorHex,
                JSON.stringify(pathsForWasm),
                0,
                sendTip.height,
                parseInt(iwReportedBranchHex, 16),
                sendPayload.mainnet,
                memoHex,
              ],
            });
            iwBuilt = await build.race(iwProving);
          } catch (e) {
            console.error('[zcash-worker] build_ironwood_send_pczt failed');
            throw e;
          } finally {
            clearInterval(iwProvingTicker);
          }
          const iwParsed = iwBuilt as {
            /** REDACTED-for-signer copy: what goes to the cold device. */
            pczt_hex: string;
            /**
             * UNREDACTED base (WITH the fvk): the wallet's retained copy. The
             * compact-signing merge re-applies the device's signatures into THIS
             * copy - its `verify_nullifier` needs the fvk, so a redacted copy
             * fails with IronwoodVerify(MissingFullViewingKey). Never sent to the
             * device (the request below is built from the redacted `pczt_hex`).
             */
            retained_pczt_hex: string;
            summary: unknown;
            action_count: number;
            /** ZIP-244 sighash the FROST signers commit to. */
            sighash: string;
            /** Per-spend rerandomizers for the real ironwood spends, action order. */
            alphas: string[];
            /** Action indices those alphas correspond to. */
            spend_indices: number[];
          };

          // Ironwood-AWARE transport: zigner prelude envelope [0x53][0x04][0x03]
          // (single PCZT), NOT the ironwood-blind ur:zcash-pczt CBOR wrap. Built
          // from the REDACTED copy - the fvk never leaves the wallet.
          const {
            urFrames: iwUrFrames,
            envelope: iwEnvelope,
            compact: iwRequestCompact,
          } = zignerShieldedRequest(wasmModule, iwParsed.pczt_hex, sendPayload.fragmentSize);
          const iwTotalDuration = ((performance.now() - sendStart) / 1000).toFixed(1);
          emitProgress(
            'ironwood PCZT QR ready',
            `${iwUrFrames.length} frames, total=${iwTotalDuration}s`,
          );

          // What send-tx-pczt-complete / complete-orchard-pczt cannot recover
          // from the signed bytes. See the ColdSendContext comment.
          build.check();
          const iwColdSendId = await stashColdSend(walletId, {
            nullifiers: selected.map(n => n.nullifier),
            amount: amountZat.toString(),
            fee: fee.toString(),
            recipient: sendPayload.recipient,
            pool: 'ironwood',
            kind: 'send',
            memo: sendPayload.memo,
          });

          workerSelf.postMessage({
            type: 'send-tx-pczt-unsigned',
            id,
            network: 'zcash',
            walletId,
            payload: {
              // The wallet RETAINS the UNREDACTED base (with the fvk), not the
              // redacted device copy: the compact-signing merge re-applies the
              // device's signatures into this copy and its `verify_nullifier`
              // needs the fvk. The device only ever sees `urFrames` (built from
              // the redacted `pczt_hex`), so the fvk never leaves the wallet.
              pcztHex: iwParsed.retained_pczt_hex,
              // `summary` is a display string here (SendTxPcztUnsignedResult /
              // the zigner-signing store type it as `string`, and the UI renders
              // it as a React child). The authoritative per-output confirmation
              // (recipient/change/values) is recomputed ON the zigner from the
              // redacted PCZT, so a short label suffices for the extension side.
              summary: `ironwood send (${selected.length} spend${selected.length === 1 ? '' : 's'})`,
              actionCount: iwParsed.action_count,
              fee: fee.toString(),
              urFrames: iwUrFrames,
              /** raw envelope bytes so the UI can re-fountain at a chosen density */
              cborData: iwEnvelope,
              /** true when the request went out compact (tx_type 0x05) */
              compactRequest: iwRequestCompact,
              cborBytes: iwEnvelope.length,
              // Populated for a FROST caller; a single-signer zigner cold-sign
              // simply ignores them. Passing them through unconditionally keeps
              // this the same message shape the orchard branch posts.
              sighash: iwParsed.sighash,
              alphas: iwParsed.alphas,
              spendIndices: iwParsed.spend_indices,
              coldSendId: iwColdSendId,
            },
          });
          return;
        }

        // ── pre-NU6.3 ORCHARD cold PCZT (legacy path, unchanged) ───────────
        emitProgress('building & proving PCZT (halo2)', `${selected.length} spends`);
        const proveStart = performance.now();
        // Use the live chain tip we just fetched for the merkle anchor as
        // the builder's target_height. The popup may pass a hint via
        // `sendPayload.targetHeight` for offline / advanced flows but the
        // tip we have in hand is authoritative - branch_id derivation
        // depends on `(network, height)` and using a stale value (e.g.
        // hardcoded constant) risks producing txs the network rejects on
        // testnet where activation heights diverge from mainnet.
        const targetHeight = sendTip.height;
        const proving = proveViaOffscreen({
          fn: 'build_unsigned_pczt',
          args: [
            sendPayload.ufvk,
            notesForWasm,
            sendPayload.recipient,
            amountZat.toString(),
            fee.toString(),
            anchorHex,
            pathsForWasm,
            targetHeight,
            sendPayload.mainnet,
            memoHex,
          ],
        });
        const built = await build.race(proving);

        const parsed = built as {
          pczt_hex: string;
          summary: string;
          action_count: number;
          // FROST multisig fields (additive - zigner cold-sign ignores them)
          sighash: string;
          alphas: string[];
          spend_indices: number[];
        };

        const proveDuration = ((performance.now() - proveStart) / 1000).toFixed(1);
        emitProgress('PCZT ready', `${proveDuration}s prove`);

        // zigner: the module envelope (see `zigner` above). keystone: the
        // standard zashi/keystone-sdk `{1: bytes}` CBOR wrap under `ur:zcash-pczt`.
        // Full (0x03), not compact: only the UR type changes for a zigner
        // orchard send, so its answer is the whole signed PCZT exactly as
        // before. Compact orchard with a transparent output has not been run
        // on a device yet.
        const request = orchardSignRequest(wasmModule, parsed.pczt_hex, {
          zigner: sendPayload.zigner === true,
          compact: false,
          fragmentSize: fragOf(sendPayload.fragmentSize),
        });
        const { urFrames, envelope: cbor } = request;

        const totalDuration = ((performance.now() - sendStart) / 1000).toFixed(1);
        emitProgress('PCZT QR ready', `${urFrames.length} frames, total=${totalDuration}s`);

        // What send-tx-pczt-complete / complete-orchard-pczt cannot recover from
        // the signed bytes. See the ColdSendContext comment.
        build.check();
        const orchardColdSendId = await stashColdSend(walletId, {
          nullifiers: selected.map(n => n.nullifier),
          amount: amountZat.toString(),
          fee: fee.toString(),
          recipient: sendPayload.recipient,
          pool: 'orchard',
          kind: 'send',
          memo: sendPayload.memo,
        });

        workerSelf.postMessage({
          type: 'send-tx-pczt-unsigned',
          id,
          network: 'zcash',
          walletId,
          payload: {
            pcztHex: parsed.pczt_hex,
            summary: parsed.summary,
            actionCount: parsed.action_count,
            fee: fee.toString(),
            urFrames,
            /** raw envelope bytes so the UI can re-fountain at a chosen density */
            cborData: cbor,
            cborBytes: cbor.length,
            /** true when the request went out compact (tx_type 0x05) */
            compactRequest: request.compact,
            // FROST host needs these to drive the relay signing rounds (gh #17)
            sighash: parsed.sighash,
            alphas: parsed.alphas,
            spendIndices: parsed.spend_indices,
            coldSendId: orchardColdSendId,
          },
        });
        return;
      }

      // Merge a compact (signatures-only) device response into the PCZT the
      // wallet retained. The device returns ONLY the 64-byte spend-auth
      // signatures it produced; the wasm applies each to its (pool,
      // action_index) slot, verifying it against the action's randomized
      // verification key first - a contribution that is not a valid signature
      // for its action is REFUSED here rather than silently absorbed.
      case 'pczt-apply-contributions': {
        await initWasm();
        if (!wasmModule) {
          throw new Error('wasm not initialized');
        }
        const applyPayload = payload as {
          pcztHex: string;
          /** [{pool:'orchard'|'ironwood', action_index:number, signature_hex:string}] */
          contributionsJson: string;
        };
        const mergedHex = wasmModule.apply_signature_contributions(
          applyPayload.pcztHex,
          applyPayload.contributionsJson,
        );
        workerSelf.postMessage({
          type: 'pczt-apply-contributions-result',
          id,
          network: 'zcash',
          walletId,
          payload: { pcztHex: mergedHex },
        });
        break;
      }

      case 'send-tx-pczt-complete': {
        if (!walletId) {
          throw new Error('walletId required');
        }
        await initWasm();
        if (!wasmModule) {
          throw new Error('wasm not initialized');
        }

        const completePayload = payload as {
          serverUrl: string;
          signedPcztHex: string;
          /** id returned by the send-tx-pczt build; see ColdSendContext */
          coldSendId?: string;
        };

        // TransactionExtractor reconstructs the canonical v5 tx - collects all
        // spend auth sigs from the signed PCZT, validates the proof, and emits
        // a broadcast-ready transaction. No manual offset-patching as in the
        // legacy `complete_transaction` path.
        const txHex = wasmModule.extract_signed_tx_from_pczt(completePayload.signedPcztHex);
        const txData = hexDecode(txHex);

        const completeClient = makeZcashClient(completePayload.serverUrl);
        const result = await completeClient.sendTransaction(txData);
        if (result.errorCode !== 0) {
          throw new Error(`broadcast failed (${result.errorCode}): ${result.errorMessage}`);
        }

        const txid = await resolveBroadcastTxid(result, txHex, completePayload.serverUrl);
        // Same bookkeeping the hot paths do at this exact point. This is THE
        // cold path for zigner / Keystone / watch-only sends, so without it the
        // flagship configuration never marked a note spent.
        await finalizeColdBroadcast(walletId, completePayload.coldSendId, txid, txHex);
        workerSelf.postMessage({
          type: 'tx-result',
          id,
          network: 'zcash',
          walletId,
          payload: { txid },
        });
        return;
      }

      // ── NU6.3 turnstile migration (orchard -> ironwood) ──────────────
      // One V6 transaction: orchard spend(s) + ironwood output to the
      // wallet's OWN ironwood address (derived inside the wasm from the
      // UFVK; no user-supplied recipient by design). Reuses the PCZT
      // cold-sign machine verbatim: build -> CBOR-wrap -> UR frames ->
      // [zigner scans + signs] -> scan signed -> extract -> broadcast.
      case 'send-turnstile-migration': {
        if (!walletId) {
          throw new Error('walletId required');
        }
        await initWasm();
        if (!wasmModule) {
          throw new Error('wasm not initialized');
        }

        const migratePayload = payload as {
          serverUrl: string;
          accountIndex: number;
          mainnet: boolean;
          ufvk?: string;
          /** hot wallet: the sealed vault this worker opens itself */
          vault?: SealedVault;
          backend?: ZcashBackend;
          /** UR fragment-size override; falls back to 200 for back-compat */
          fragmentSize?: number;
          /** the page's key for stopping this build (see build-abort.ts) */
          cancelKey?: string;
        };
        const build = builds.begin(migratePayload.cancelKey);
        if (migratePayload.backend) {
          registerBackend(migratePayload.serverUrl, migratePayload.backend);
        }
        // HOT vs COLD turnstile: both build the same seed-free PCZT. A hot
        // wallet sends its sealed vault and this worker signs and broadcasts -
        // no QR round trip. A watch-only/zigner wallet supplies a UFVK and takes
        // the cold PCZT cold-sign machine.
        const isHotMigration = !!migratePayload.vault;
        if (!isHotMigration && !migratePayload.ufvk) {
          throw new Error('turnstile migration requires a hot wallet or a UFVK (cold) wallet');
        }

        const migrateStart = performance.now();
        const emitProgress = (step: string, detail?: string) => {
          console.log(
            `[zcash-worker] turnstile [${((performance.now() - migrateStart) / 1000).toFixed(1)}s] ${step}${detail ? ': ' + detail : ''}`,
          );
          workerSelf.postMessage({
            type: 'send-progress',
            id: '',
            network: 'zcash',
            walletId,
            payload: { step, detail, elapsedMs: Math.round(performance.now() - migrateStart) },
          });
        };

        emitProgress('loading wallet state');
        const migrateState = await loadState(walletId);

        // migrate the wallet's FULL orchard balance: every unspent orchard note
        const orchardNotes = migrateState.notes.filter(
          n => !migrateState.spentNullifiers.has(n.nullifier) && poolOf(n) === 'orchard',
        );
        if (orchardNotes.length === 0) {
          throw new Error('no orchard notes to migrate');
        }
        const totalIn = orchardNotes.reduce((sum, n) => sum + BigInt(n.value), 0n);
        // ZIP-317: n orchard spends + 1 ironwood output, no change (full sweep)
        const fee = computeTurnstileFee(orchardNotes.length);
        if (totalIn <= fee) {
          throw new Error(`orchard balance ${totalIn} zat does not cover migration fee ${fee} zat`);
        }
        const migrateAmount = totalIn - fee;
        emitProgress('notes selected', `${orchardNotes.length} orchard notes, fee=${fee}`);

        const migrateClient = makeZcashClient(migratePayload.serverUrl, migratePayload.backend);

        // ── FAIL-CLOSED branch-id guard (FIX-C item 2) ────────────────────
        // Before building anything, read the endpoint's reported consensus
        // branch id from GetLightdInfo. We refuse to build (and therefore to
        // broadcast) unless NU6.3 is actually active at this endpoint and the
        // branch id is the real value (0x37a5165b). A placeholder branch id
        // (0xffffffff) or any mismatch means NU6.3 has not activated here yet -
        // a migration built against it would be an invalid / unspendable tx.
        emitProgress('checking NU6.3 activation');
        const lightdInfo = await build.race(migrateClient.getLightdInfo());
        const reportedBranchHex = (lightdInfo.consensusBranchId || '')
          .trim()
          .toLowerCase()
          .replace(/^0x/, '');
        if (!reportedBranchHex || reportedBranchHex === PLACEHOLDER_BRANCH_ID_HEX) {
          throw new Error(
            'NU6.3 is not active at this endpoint yet (placeholder consensus branch id) - ' +
              'turnstile migration is unavailable until NU6.3 activates',
          );
        }
        const migrateRefusal = ironwoodBranchRefusal(
          reportedBranchHex,
          migratePayload.mainnet,
          'turnstile migration',
        );
        if (migrateRefusal) {
          throw new Error(migrateRefusal);
        }
        emitProgress('NU6.3 active', `branch id 0x${reportedBranchHex}`);

        emitProgress('fetching chain tip');
        const migrateTip = await build.race(migrateClient.getTip());
        emitProgress('building merkle witnesses', `tip=${migrateTip.height}`);
        // orchard spends -> orchard witnesses; the migration needs no
        // ironwood anchor (output-only on the ironwood side)
        const witnessing = buildWitnesses(
          migrateClient,
          walletId,
          orchardNotes,
          migrateTip.height,
          'orchard',
        );
        const { anchorHex, paths } = await build.race(witnessing);

        const notesForWasm = orchardNotes.map(n => ({
          value: Number(n.value),
          nullifier: n.nullifier,
          cmx: n.cmx,
          position: n.position,
          rseed_hex: n.rseed ?? '',
          rho_hex: n.rho ?? '',
          recipient_hex: n.recipient ?? '',
        }));
        const pathsForWasm = (paths as { position: number; path: { hash: string }[] }[]).map(p => ({
          path: p.path.map(e => e.hash),
          position: p.position,
        }));

        // ── HOT path ──────────────────────────────────────────────────────
        // Self-custody wallet: the prover builds + proves the same PCZT the
        // cold path does, from this account's UFVK; it is signed here and
        // broadcast. The PCZT is never persisted. Same params as the cold path
        // (notes, fee, anchor, merkle paths, target height, expected branch id,
        // mainnet), so the fail-closed branch-id guard matches bit for bit.
        if (isHotMigration) {
          const migrateAccount = hotSpendAccount(walletId, migratePayload.accountIndex);
          emitProgress(
            'building, proving & signing turnstile tx (halo2)',
            `${orchardNotes.length} orchard spends -> ironwood`,
          );
          const hotProveStart = performance.now();
          // keep the clock ticking during proving so the UI isn't frozen
          const hotProvingTicker = setInterval(() => {
            const elapsed = ((performance.now() - hotProveStart) / 1000).toFixed(0);
            emitProgress('proving (halo2)', `${elapsed}s elapsed`);
          }, 2000);
          let migrateTxHex: string;
          try {
            // target_height = live tip; at/after NU6.3 activation this selects
            // TxVersion::V6 (orchard spends + ironwood outputs) in the builder.
            // The keys MUST be the account the orchard notes were scanned under
            // or no spend accepts them. The branch id is the live value
            // validated from GetLightdInfo above (never the placeholder); the
            // producer refuses to build unless the branch id it binds equals it.
            const signing = withSpendKeys(
              wasmModule.SpendKeys,
              migratePayload.vault,
              migrateAccount,
              migratePayload.mainnet,
              async keys => {
                const built = (await proveViaOffscreen({
                  fn: 'build_turnstile_migration_pczt',
                  args: [
                    keys.ufvk(),
                    JSON.stringify(notesForWasm),
                    fee.toString(),
                    anchorHex,
                    JSON.stringify(pathsForWasm),
                    migrateAccount,
                    migrateTip.height,
                    parseInt(reportedBranchHex, 16),
                    migratePayload.mainnet,
                    null,
                  ],
                })) as { pczt_hex: string };
                return keys.sign_pczt(built.pczt_hex);
              },
            );
            migrateTxHex = await build.race(signing);
          } catch (e) {
            // message only, never the caught args
            console.error(
              '[zcash-worker] turnstile hot migration failed:',
              e instanceof Error ? e.message : String(e),
            );
            throw e;
          } finally {
            clearInterval(hotProvingTicker);
          }

          emitProgress('turnstile tx signed', `${migrateTxHex.length / 2} bytes`);
          // the point of no return: a stop from here on is refused
          build.commit();
          emitProgress('broadcasting migration');
          const migrateHotTxData = hexDecode(migrateTxHex);
          const migrateHotClient = makeZcashClient(
            migratePayload.serverUrl,
            migratePayload.backend,
          );
          const migrateHotResult = await migrateHotClient.sendTransaction(migrateHotTxData);
          if (migrateHotResult.errorCode !== 0) {
            throw new Error(
              `broadcast failed (${migrateHotResult.errorCode}): ${migrateHotResult.errorMessage}`,
            );
          }
          const migrateHotTxid = await resolveBroadcastTxid(
            migrateHotResult,
            migrateTxHex,
            migratePayload.serverUrl,
          );
          // The migration spends EVERY orchard note. Both send paths mark
          // their inputs spent at broadcast; this one did not, so for the
          // whole confirmation window the wallet still counted the migrated
          // orchard balance as spendable - and the fail-closed guard only
          // fires when ironwood notes are absent, so a second migration
          // launched in that window would build a conflicting spend of the
          // same notes.
          await markNotesSpentLocally(walletId, migrateState, orchardNotes, migrateHotTxid);
          await recordSentTx({
            walletId,
            txid: migrateHotTxid,
            amount: migrateAmount.toString(),
            fee: fee.toString(),
            recipient: 'your ironwood address',
            pool: 'ironwood',
            kind: 'migrate',
            sentAt: Date.now(),
            expiryHeight: parseExpiryHeight(migrateTxHex),
          });
          emitProgress('complete', `txid=${migrateHotTxid}`);
          workerSelf.postMessage({
            type: 'tx-result',
            id,
            network: 'zcash',
            walletId,
            payload: { txid: migrateHotTxid, fee: fee.toString() },
          });
          return;
        }

        emitProgress(
          'building & proving turnstile PCZT (halo2)',
          `${orchardNotes.length} orchard spends -> ironwood`,
        );
        // target_height = live tip; at/after NU6.3 activation this selects
        // TxVersion::V6 (orchard spends + ironwood outputs) in the builder.
        const proving = proveViaOffscreen({
          fn: 'build_turnstile_migration_pczt',
          args: [
            migratePayload.ufvk,
            JSON.stringify(notesForWasm),
            fee.toString(),
            anchorHex,
            JSON.stringify(pathsForWasm),
            migratePayload.accountIndex,
            migrateTip.height,
            // expected_branch_id is the 8th param (before mainnet), matching the
            // producer signature (FIX-A). It is the value validated from
            // GetLightdInfo; the producer's fail-closed guard refuses to build
            // unless the branch id it binds equals this.
            parseInt(reportedBranchHex, 16),
            migratePayload.mainnet,
            null,
          ],
        });
        const built = await build.race(proving);
        const migrateParsed = built as {
          pczt_hex: string;
          summary: unknown;
          action_count: number;
        };

        // FIX-C item 1: the migration MUST reach the ironwood-AWARE signer.
        // `ur:zcash-pczt` (CBOR {1: bytes}) reaches the production, ironwood-
        // BLIND signer which hides the destination and shows a fee ~= the whole
        // amount. Wrap the redacted PCZT in the zigner prelude envelope
        // [0x53][0x04][0x03] (single PCZT) instead - that reaches the
        // pczt_signing module built with --cfg zcash_unstable="nu6.3".
        const {
          urFrames: migrateUrFrames,
          envelope: migrateEnvelope,
          compact: migrateCompact,
        } = zignerShieldedRequest(wasmModule, migrateParsed.pczt_hex, migratePayload.fragmentSize);
        emitProgress('turnstile PCZT QR ready', `${migrateUrFrames.length} frames`);

        // The migration spends EVERY orchard note, so a completion that does
        // not mark them leaves the whole legacy balance looking spendable - and
        // a second migration launched in that window builds a conflicting
        // spend. The hot branch above already does this; see ColdSendContext.
        build.check();
        const migrateColdSendId = await stashColdSend(walletId, {
          nullifiers: orchardNotes.map(n => n.nullifier),
          amount: migrateAmount.toString(),
          fee: fee.toString(),
          recipient: 'your ironwood address',
          pool: 'ironwood',
          kind: 'migrate',
        });

        workerSelf.postMessage({
          type: 'send-turnstile-migration-unsigned',
          id,
          network: 'zcash',
          walletId,
          payload: {
            pcztHex: migrateParsed.pczt_hex,
            summary: migrateParsed.summary,
            actionCount: migrateParsed.action_count,
            fee: fee.toString(),
            amount: migrateAmount.toString(),
            urFrames: migrateUrFrames,
            /** true when the request went out compact (tx_type 0x05) */
            compactRequest: migrateCompact,
            cborBytes: migrateEnvelope.length,
            coldSendId: migrateColdSendId,
          },
        });
        return;
      }

      case 'send-turnstile-migration-complete': {
        // identical machine to send-tx-pczt-complete: the contract's
        // extract_signed_tx_from_pczt accepts V6 + ironwood bundles.
        if (!walletId) {
          throw new Error('walletId required');
        }
        await initWasm();
        if (!wasmModule) {
          throw new Error('wasm not initialized');
        }

        const migrateCompletePayload = payload as {
          serverUrl: string;
          signedPcztHex: string;
          backend?: ZcashBackend;
          /** id returned by the send-turnstile-migration build; see ColdSendContext */
          coldSendId?: string;
        };
        if (migrateCompletePayload.backend) {
          registerBackend(migrateCompletePayload.serverUrl, migrateCompletePayload.backend);
        }

        const migrateTxHex = wasmModule.extract_signed_tx_from_pczt(
          migrateCompletePayload.signedPcztHex,
        );
        const migrateTxData = hexDecode(migrateTxHex);

        const migrateCompleteClient = makeZcashClient(migrateCompletePayload.serverUrl);
        const migrateResult = await migrateCompleteClient.sendTransaction(migrateTxData);
        if (migrateResult.errorCode !== 0) {
          throw new Error(
            `broadcast failed (${migrateResult.errorCode}): ${migrateResult.errorMessage}`,
          );
        }

        const migrateTxid = await resolveBroadcastTxid(
          migrateResult,
          migrateTxHex,
          migrateCompletePayload.serverUrl,
        );
        // mirrors the hot migration branch, which marks its orchard inputs
        // spent and records the migration at broadcast
        await finalizeColdBroadcast(
          walletId,
          migrateCompletePayload.coldSendId,
          migrateTxid,
          migrateTxHex,
        );
        workerSelf.postMessage({
          type: 'tx-result',
          id,
          network: 'zcash',
          walletId,
          payload: { txid: migrateTxid },
        });
        return;
      }

      // ── multi-output send (sequential single-output txs) ──
      // Used by poker escrow: builds one tx per output, broadcasting each in sequence.
      // Each output gets its own note selection, witness build, prove, and broadcast cycle.
      // If any tx fails mid-way, previously broadcast txs are NOT rolled back.
      case 'send-tx-multi': {
        if (!walletId) {
          throw new Error('walletId required');
        }
        await initWasm();
        if (!wasmModule) {
          throw new Error('wasm not initialized');
        }

        const multiPayload = payload as {
          serverUrl: string;
          outputs: { address: string; amount: string; memo?: string }[];
          accountIndex: number;
          mainnet: boolean;
          vault: SealedVault;
          /** the page's key for stopping this build (see build-abort.ts) */
          cancelKey?: string;
        };
        const build = builds.begin(multiPayload.cancelKey);

        if (!multiPayload.outputs || multiPayload.outputs.length === 0) {
          throw new Error('outputs array required');
        }
        const multiAccount = hotSpendAccount(walletId, multiPayload.accountIndex);

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
          const validPrefix =
            addr.startsWith('u1') ||
            addr.startsWith('utest1') ||
            addr.startsWith('zs') ||
            addr.startsWith('t1') ||
            addr.startsWith('tm');
          if (!validPrefix) {
            throw new Error(`output ${i}: invalid zcash address prefix`);
          }
        }

        const multiStart = performance.now();
        const emitMultiProgress = (step: string, detail?: string) => {
          const elapsed = ((performance.now() - multiStart) / 1000).toFixed(1);
          console.log(
            `[zcash-worker] multi-send [${elapsed}s] ${step}${detail ? ': ' + detail : ''}`,
          );
          workerSelf.postMessage({
            type: 'send-progress',
            id: '',
            network: 'zcash',
            walletId,
            payload: { step, detail, elapsedMs: Math.round(performance.now() - multiStart) },
          });
        };

        const txids: string[] = [];
        const fees: string[] = [];

        // FAIL-CLOSED (NU6.3): multi-send only builds orchard txs today, which
        // are consensus-disabled post-activation, and there is no ironwood
        // multi-send path yet. Refuse up front rather than build invalid
        // orchard txs per output.
        // TODO(ironwood multi-send): route the ironwood pool through
        // build_ironwood_send_pczt per output.
        {
          const multiGuardClient = makeZcashClient(multiPayload.serverUrl);
          const multiGuardTip = await build.race(multiGuardClient.getTip());
          if (multiGuardTip.height >= nu63ActivationHeight(multiPayload.mainnet)) {
            throw new Error(
              'orchard sends are disabled at NU6.3 - multi-send does not support ironwood ' +
                'yet; send ironwood funds individually',
            );
          }
        }

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
              memoHex = Array.from(bytes)
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
            }
          }

          // reload state each iteration (previous tx spent notes)
          const multiState = await loadState(walletId);

          // determine recipient type for fee calc
          const isTransparent = isTransparentRecipient(recipient);
          const nZOutputs = isTransparent ? 0 : 1;
          const nTOutputs = isTransparent ? 1 : 0;

          // Estimate fee and select notes. The pool is pinned to orchard to
          // match the build_unsigned_pczt / buildWitnesses('orchard') calls
          // below; the NU6.3 guard above already refused post-activation, so
          // orchard is the only reachable pool here. Passed explicitly rather
          // than leaning on selectNotes' legacy default.
          const estFee = computeFee(1, nZOutputs, nTOutputs, true);
          const selected = selectNotes(
            multiState.notes,
            multiState.spentNullifiers,
            amountZat + estFee,
            'orchard',
            heldBy(walletId, 'orchard'),
          );

          // compute exact fee
          const totalIn = selected.reduce((sum, n) => sum + BigInt(n.value), 0n);
          const hasChange =
            totalIn > amountZat + computeFee(selected.length, nZOutputs, nTOutputs, true);
          const fee = computeFee(selected.length, nZOutputs, nTOutputs, hasChange);
          if (totalIn < amountZat + fee) {
            throw new Error(
              `output ${outputIdx}: insufficient funds: have ${totalIn} zat, need ${amountZat + fee} zat`,
            );
          }

          emitMultiProgress(
            `output ${outputIdx + 1}: notes selected`,
            `${selected.length} notes, fee=${fee}`,
          );

          // build merkle witnesses
          const multiClient = makeZcashClient(multiPayload.serverUrl);
          const multiTip = await build.race(multiClient.getTip());

          emitMultiProgress(
            `output ${outputIdx + 1}: building witnesses`,
            `tip=${multiTip.height}`,
          );
          const { anchorHex: multiAnchor, paths: multiPaths } = await buildWitnesses(
            multiClient,
            walletId,
            selected,
            multiTip.height,
            'orchard',
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
          const pathsResult = multiPaths as {
            position: number;
            path: { hash: string }[];
          }[];
          const merklePathsForWasm = pathsResult.map(p => ({
            path: p.path.map(e => e.hash),
            position: p.position,
          }));

          emitMultiProgress(
            `output ${outputIdx + 1}: proving (halo2)`,
            `${selected.length} spends`,
          );
          const proveStart = performance.now();
          const provingTicker = setInterval(() => {
            const elapsed = ((performance.now() - proveStart) / 1000).toFixed(0);
            emitMultiProgress(`output ${outputIdx + 1}: proving`, `${elapsed}s elapsed`);
          }, 2000);

          let txHex: string;
          try {
            const signing = withSpendKeys(
              wasmModule.SpendKeys,
              multiPayload.vault,
              multiAccount,
              multiPayload.mainnet,
              async keys => {
                const built = (await proveViaOffscreen({
                  fn: 'build_unsigned_pczt',
                  args: [
                    keys.ufvk(),
                    notesJson,
                    recipient,
                    amountZat.toString(),
                    fee.toString(),
                    multiAnchor,
                    merklePathsForWasm,
                    multiTip.height,
                    multiPayload.mainnet,
                    memoHex,
                  ],
                })) as { pczt_hex: string };
                return keys.sign_pczt(built.pczt_hex);
              },
            );
            txHex = await build.race(signing);
          } finally {
            clearInterval(provingTicker);
          }

          // broadcast; from the first one on, a stop is refused
          build.commit();
          emitMultiProgress(`output ${outputIdx + 1}: broadcasting`);
          const txData = hexDecode(txHex);
          const broadcastClient = makeZcashClient(multiPayload.serverUrl);
          const broadcastResult = await broadcastClient.sendTransaction(txData);
          if (broadcastResult.errorCode !== 0) {
            throw new Error(
              `output ${outputIdx}: broadcast failed (${broadcastResult.errorCode}): ${broadcastResult.errorMessage}`,
            );
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
          type: 'tx-multi-result',
          id,
          network: 'zcash',
          walletId,
          payload: { txids, fees },
        });
        return;
      }

      case 'shield': {
        if (!walletId) {
          throw new Error('walletId required');
        }
        await initWasm();
        if (!wasmModule) {
          throw new Error('wasm not initialized');
        }

        const { vault, serverUrl, tAddresses, mainnet, only } = payload as {
          /** the sealed vault this worker opens itself */
          vault: SealedVault;
          serverUrl: string;
          /** position is the t-branch index: legacy indices included */
          tAddresses: string[];
          mainnet: boolean;
          /** the page's key for stopping this build (see build-abort.ts) */
          cancelKey?: string;
          /** shield only these addresses' coins (the lp address), signed by their own index */
          only?: string[];
        };
        const build = builds.begin((payload as { cancelKey?: string }).cancelKey);
        const progress = buildProgress(walletId);

        const client = makeZcashClient(serverUrl);
        progress('fetching chain tip');
        const tip = await build.race(client.getTip());
        const allUtxos = await build.race(utxosEach(client, only ?? tAddresses));
        if (allUtxos.length === 0) {
          throw new Error('no transparent UTXOs to shield');
        }

        // one group per t-branch index: WASM signs all inputs with one key
        const byIndex = utxosByTIndex(allUtxos, tAddresses);

        // live consensus branch id for the ZIP-244 sighash + v5 header (NU6.3-safe)
        const shieldBranchIdHex = await build.race(fetchBranchIdHex(client));
        // the same unsigned builders the cold path uses: ironwood from NU6.3,
        // where an orchard output would strand the funds
        const shieldIntoIronwood = tip.height >= nu63ActivationHeight(mainnet);

        let totalShielded = 0n;
        let totalFee = 0n;
        let totalUtxos = 0;
        let lastTxid = '';

        // transparent funds shield only into the pocket they belong to, and
        // sign with that pocket's t-branch
        const shieldAccount = hotSpendAccount(walletId);
        await withSpendKeys(wasmModule.SpendKeys, vault, shieldAccount, mainnet, async keys => {
          const recipient = fixOrchardAddress(keys.receiving_address(), mainnet);

          // shield each group with its matching key
          for (const [addrIndex, utxos] of byIndex) {
            const groupZat = utxos.reduce((sum, u) => sum + u.valueZat, 0n);
            const fee = computeShieldFee(utxos.length);
            if (groupZat <= fee) {
              console.warn(
                `[zcash-worker] skipping index ${addrIndex}: ${groupZat} zat <= ${fee} fee`,
              );
              continue;
            }

            const shieldAmount = groupZat - fee;
            const pubkeyHex = keys.transparent_pubkey(addrIndex);
            // every input must be locked to this key: this pocket's own t-branch
            // at this index. Anything else is not this pocket's money.
            if (!utxos.every(u => isP2pkhOf(u.script, pubkeyHex))) {
              throw new Error(
                `transparent input is not on pocket ${shieldAccount} index ${addrIndex}`,
              );
            }

            const utxosJson = JSON.stringify(
              utxos.map(u => ({
                txid: hexEncode(u.txid),
                vout: u.outputIndex,
                value: Number(u.valueZat),
                script: hexEncode(u.script),
              })),
            );

            progress('building & proving transaction', `${utxos.length} inputs`);
            const proving = proveViaOffscreen(
              shieldIntoIronwood
                ? {
                    fn: 'build_unsigned_shielding_ironwood',
                    args: [
                      utxosJson,
                      pubkeyHex,
                      recipient,
                      shieldAmount.toString(),
                      fee.toString(),
                      tip.height,
                      parseInt(shieldBranchIdHex, 16),
                      mainnet,
                      null,
                    ],
                  }
                : {
                    fn: 'build_unsigned_shielding',
                    args: [
                      utxosJson,
                      recipient,
                      shieldAmount.toString(),
                      fee.toString(),
                      tip.height,
                      mainnet,
                      shieldBranchIdHex,
                    ],
                  },
            );
            const built = JSON.parse((await build.race(proving)) as string) as {
              sighashes: string[];
              unsigned_tx_hex: string;
            };
            const txHex = keys.sign_shielding(
              addrIndex,
              built.unsigned_tx_hex,
              JSON.stringify(built.sighashes),
            );
            // the point of no return: a stop from here on is refused
            build.commit();
            progress('broadcasting transaction');
            const result = await client.sendTransaction(hexDecode(txHex));
            if (result.errorCode !== 0) {
              throw new Error(`broadcast failed (${result.errorCode}): ${result.errorMessage}`);
            }

            lastTxid = await resolveBroadcastTxid(result, txHex, serverUrl);
            totalShielded += shieldAmount;
            totalFee += fee;
            totalUtxos += utxos.length;
          }
        });

        if (totalUtxos === 0) {
          throw new Error('all UTXO groups too small to cover fees');
        }

        workerSelf.postMessage({
          type: 'shield-result',
          id,
          network: 'zcash',
          walletId,
          payload: {
            txid: lastTxid,
            shieldedZat: totalShielded.toString(),
            feeZat: totalFee.toString(),
            utxoCount: totalUtxos,
          },
        });
        return;
      }

      case 'shield-unsigned': {
        if (!walletId) {
          throw new Error('walletId required');
        }
        await initWasm();
        if (!wasmModule) {
          throw new Error('wasm not initialized');
        }

        const shieldUnsignedPayload = payload as {
          serverUrl: string;
          tAddresses: string[];
          mainnet: boolean;
          ufvk: string;
          /** Ledger: one round of at most this many inputs (32 per approval) */
          maxInputs?: number;
          /** Ledger: the account's external ovk on the output, which the app
           *  needs to review it (it refuses an output it cannot decrypt) */
          ledgerOvk?: boolean;
          /** the page's key for stopping this build (see build-abort.ts) */
          cancelKey?: string;
        };
        const build = builds.begin(shieldUnsignedPayload.cancelKey);
        const progress = buildProgress(walletId);

        const shieldUClient = makeZcashClient(shieldUnsignedPayload.serverUrl);
        progress('fetching chain tip');
        const shieldUTip = await build.race(shieldUClient.getTip());
        // live consensus branch id for the ZIP-244 sighash + v5 header (NU6.3-safe)
        const shieldUBranchIdHex = await build.race(fetchBranchIdHex(shieldUClient));
        const shieldUAll = await build.race(
          utxosEach(shieldUClient, shieldUnsignedPayload.tAddresses),
        );
        const shieldUUtxos =
          shieldUnsignedPayload.maxInputs === undefined
            ? shieldUAll
            : shieldRoundUtxos(
                shieldUAll,
                shieldUnsignedPayload.tAddresses,
                shieldUnsignedPayload.maxInputs,
              );
        if (shieldUUtxos.length === 0) {
          throw new Error('no transparent UTXOs to shield');
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
        const shieldUFee = computeShieldFee(shieldUUtxos.length);
        if (shieldUTotal <= shieldUFee) {
          throw new Error('UTXOs too small to cover fee');
        }
        const shieldUAmount = shieldUTotal - shieldUFee;

        // collect address indices in UTXO order
        const shieldUAddrIndices = shieldUUtxos.map(tIndexOf(shieldUnsignedPayload.tAddresses));

        const shieldUUtxosJson = JSON.stringify(
          shieldUUtxos.map(u => ({
            txid: hexEncode(u.txid),
            vout: u.outputIndex,
            value: Number(u.valueZat),
            script: hexEncode(u.script),
          })),
        );

        // Post-NU6.3 the orchard unsigned builder is fail-closed (shielding into
        // orchard would strand the funds), so route cold shielding to the
        // ironwood unsigned builder. It signs a single transparent pubkey's
        // inputs, so a single-address-index shield only (the common case); a
        // mixed-index shield fails closed rather than mis-sign.
        const shieldUPostNu63 =
          shieldUTip.height >= nu63ActivationHeight(shieldUnsignedPayload.mainnet);
        let shieldUResult: string;
        let shieldUPubkeyHex: string | undefined;
        if (shieldUPostNu63) {
          const shieldUIdxSet = new Set(shieldUAddrIndices);
          if (shieldUIdxSet.size > 1) {
            throw new Error(
              'cold ironwood shielding supports one transparent address index per tx; ' +
                'shield from a single address at a time',
            );
          }
          const shieldUPubkey = wasmModule.transparent_pubkey_from_ufvk(
            shieldUnsignedPayload.ufvk,
            shieldUAddrIndices[0] ?? 0,
          );
          progress('building & proving transaction');
          const proving = proveViaOffscreen({
            fn: 'build_unsigned_shielding_ironwood',
            args: [
              shieldUUtxosJson,
              shieldUPubkey,
              shieldURecipient,
              shieldUAmount.toString(),
              shieldUFee.toString(),
              shieldUTip.height,
              parseInt(shieldUBranchIdHex, 16), // expected_branch_id (numeric)
              shieldUnsignedPayload.mainnet,
              null, // memo_hex
              shieldUnsignedPayload.ledgerOvk ? shieldUnsignedPayload.ufvk : null,
            ],
          });
          shieldUResult = (await build.race(proving)) as string;
          shieldUPubkeyHex = shieldUPubkey;
        } else {
          progress('building & proving transaction');
          const proving = proveViaOffscreen({
            fn: 'build_unsigned_shielding',
            args: [
              shieldUUtxosJson,
              shieldURecipient,
              shieldUAmount.toString(),
              shieldUFee.toString(),
              shieldUTip.height,
              shieldUnsignedPayload.mainnet,
              shieldUBranchIdHex,
            ],
          });
          shieldUResult = (await build.race(proving)) as string;
        }
        progress('unsigned tx ready');

        const shieldUParsed = JSON.parse(shieldUResult) as {
          sighashes: string[];
          unsigned_tx_hex: string;
          summary: string;
        };

        workerSelf.postMessage({
          type: 'shield-unsigned-result',
          id,
          network: 'zcash',
          walletId,
          payload: {
            sighashes: shieldUParsed.sighashes,
            unsignedTxHex: shieldUParsed.unsigned_tx_hex,
            summary: shieldUParsed.summary,
            fee: shieldUFee.toString(),
            addressIndices: shieldUAddrIndices,
            ...(shieldUPubkeyHex ? { transparentPubkeyHex: shieldUPubkeyHex } : {}),
          },
        });
        return;
      }

      case 'shield-complete': {
        if (!walletId) {
          throw new Error('walletId required');
        }
        await initWasm();
        if (!wasmModule) {
          throw new Error('wasm not initialized');
        }

        const shieldCompletePayload = payload as {
          serverUrl: string;
          unsignedTxHex: string;
          signatures: { sig_hex: string; pubkey_hex: string }[];
        };

        const signaturesJson = JSON.stringify(shieldCompletePayload.signatures);
        const shieldCompleteTxHex = wasmModule.complete_shielding_transaction(
          shieldCompletePayload.unsignedTxHex,
          signaturesJson,
        );
        const shieldCompleteTxData = hexDecode(shieldCompleteTxHex);

        const shieldCompleteClient = makeZcashClient(shieldCompletePayload.serverUrl);
        const shieldCompleteResult =
          await shieldCompleteClient.sendTransaction(shieldCompleteTxData);
        if (shieldCompleteResult.errorCode !== 0) {
          throw new Error(
            `broadcast failed (${shieldCompleteResult.errorCode}): ${shieldCompleteResult.errorMessage}`,
          );
        }

        const shieldCompleteTxid = new TextDecoder().decode(shieldCompleteResult.txid);
        workerSelf.postMessage({
          type: 'tx-result',
          id,
          network: 'zcash',
          walletId,
          payload: { txid: shieldCompleteTxid },
        });
        return;
      }

      case 'transparent-deposit-plan': {
        await initWasm();
        if (!wasmModule) {
          throw new Error('wasm not initialized');
        }
        const { serverUrl, ...req } = payload as DepositRequest & { serverUrl: string };
        const chain = depositChain(await makeZcashClient(serverUrl), serverUrl);
        workerSelf.postMessage({
          type: 'result',
          id,
          network: 'zcash',
          walletId,
          payload: await planDeposit(wasmModule, chain, req),
        });
        return;
      }

      case 'transparent-deposit': {
        if (!walletId) {
          throw new Error('walletId required');
        }
        await initWasm();
        const wasm = wasmModule;
        if (!wasm) {
          throw new Error('wasm not initialized');
        }
        const { vault, serverUrl, ...req } = payload as DepositRequest & {
          vault: SealedVault;
          serverUrl: string;
          reviewedFee: string;
        };
        const chain = depositChain(await makeZcashClient(serverUrl), serverUrl);
        // signs with this pocket's t-branch at the swap's own index: the address that funds it
        const sent = await withSpendKeys(
          wasm.SpendKeys,
          vault,
          hotSpendAccount(walletId),
          req.mainnet,
          keys => sendDeposit(wasm, chain, keys, req),
        );
        await recordSentTx({
          walletId,
          txid: sent.txid,
          amount: req.amountZat,
          fee: sent.fee,
          recipient: req.to,
          pool: 'transparent',
          kind: 'send',
          memo: req.memo,
          sentAt: Date.now(),
          expiryHeight: parseExpiryHeight(sent.txHex),
        });
        workerSelf.postMessage({
          type: 'tx-result',
          id,
          network: 'zcash',
          walletId,
          payload: { txid: sent.txid, fee: sent.fee },
        });
        return;
      }

      // A cold (zigner) deposit is two messages around the QR round: build the
      // reviewed PCZT from public data with the UFVK's key at the swap's own
      // index and hand back the FULL module request (a compact answer cannot
      // carry transparent signatures, and zigner refuses one); then finish
      // zafu's PCZT with the device's signatures, check, and broadcast.
      case 'transparent-deposit-unsigned': {
        await initWasm();
        const wasm = wasmModule;
        if (!wasm) {
          throw new Error('wasm not initialized');
        }
        const { serverUrl, ufvk, fragmentSize, coin, movePcztHex, ...req } =
          payload as DepositRequest & {
            serverUrl: string;
            ufvk: string;
            reviewedFee: string;
            fragmentSize?: number;
            /** the unsigned move's coin, spent before it is mined */
            coin?: MoveCoin;
            /** the move's device copy: both ride one batch */
            movePcztHex?: string;
          };
        const chain = withCoin(depositChain(await makeZcashClient(serverUrl), serverUrl), coin);
        // the external key at the swap's index: the one its address was derived from
        const pubkey = wasm.transparent_pubkey_from_ufvk(ufvk, req.tIndex);
        // a deposit held for its move must still land after a move mined in its last block
        const built = await buildDeposit(
          wasm,
          chain,
          pubkey,
          req,
          coin && coin.expiry + DEPOSIT_OUTLIVES_MOVE,
        );
        const request = movePcztHex
          ? zignerBatchRequest(wasm, [movePcztHex, built.pcztHex], fragOf(fragmentSize))
          : zignerSignRequest(wasm, built.pcztHex, {
              compact: false,
              fragmentSize: fragOf(fragmentSize),
            });
        workerSelf.postMessage({
          type: 'result',
          id,
          network: 'zcash',
          walletId,
          payload: {
            pcztHex: built.pcztHex,
            urFrames: request.urFrames,
            cborData: request.envelope,
            cborBytes: request.envelope.length,
            compactRequest: false,
            fee: req.reviewedFee,
          },
        });
        return;
      }

      // Finish the device's deposit, or take one held since it was signed;
      // check it against the review either way. `hold` returns the checked
      // bytes unsent, for a deposit whose coin is not mined yet.
      case 'transparent-deposit-complete': {
        if (!walletId) {
          throw new Error('walletId required');
        }
        await initWasm();
        const wasm = wasmModule;
        if (!wasm) {
          throw new Error('wasm not initialized');
        }
        const { serverUrl, ufvk, unsignedPcztHex, signedPcztHex, txHex, hold, ...req } =
          payload as DepositRequest & {
            serverUrl: string;
            ufvk: string;
            reviewedFee: string;
            unsignedPcztHex?: string;
            signedPcztHex?: string;
            txHex?: string;
            hold?: boolean;
          };
        const signed =
          txHex ??
          (await coldDepositTx(wasm, req, {
            unsignedPcztHex: unsignedPcztHex!,
            signedPczt: hexDecode(signedPcztHex!),
            pubkeyHex: wasm.transparent_pubkey_from_ufvk(ufvk, req.tIndex),
          }));
        if (hold) {
          workerSelf.postMessage({
            type: 'result',
            id,
            network: 'zcash',
            walletId,
            payload: { txHex: signed, expiry: parseExpiryHeight(signed) ?? 0 },
          });
          return;
        }
        const chain = depositChain(await makeZcashClient(serverUrl), serverUrl);
        const sent = await finishDeposit(chain, signed, await wantOf(req), req.reviewedFee);
        await recordSentTx({
          walletId,
          txid: sent.txid,
          amount: req.amountZat,
          fee: sent.fee,
          recipient: req.to,
          pool: 'transparent',
          kind: 'send',
          memo: req.memo,
          sentAt: Date.now(),
          expiryHeight: parseExpiryHeight(sent.txHex),
        });
        workerSelf.postMessage({
          type: 'tx-result',
          id,
          network: 'zcash',
          walletId,
          payload: { txid: sent.txid, fee: sent.fee },
        });
        return;
      }

      case 'chain-tip': {
        const { serverUrl } = payload as { serverUrl: string };
        workerSelf.postMessage({
          type: 'result',
          id,
          network: 'zcash',
          walletId,
          payload: (await (await makeZcashClient(serverUrl)).getTip()).height,
        });
        return;
      }

      // ── FROST multisig ──

      case 'frost-dkg-part1':
        await sealedFrost(id, payload, a => {
          const { maxSigners, minSigners } = a as { maxSigners: number; minSigners: number };
          return JSON.parse(wasmModule!.frost_dkg_part1(maxSigners, minSigners));
        });
        return;

      case 'frost-dkg-part2':
        await sealedFrost(id, payload, a => {
          const { secretHex, peerBroadcasts } = a as { secretHex: string; peerBroadcasts: string };
          return JSON.parse(wasmModule!.frost_dkg_part2(secretHex, peerBroadcasts));
        });
        return;

      case 'frost-dkg-part3':
        await sealedFrost(id, payload, a => {
          const { secretHex, round1Broadcasts, round2Packages } = a as {
            secretHex: string;
            round1Broadcasts: string;
            round2Packages: string;
          };
          return JSON.parse(
            wasmModule!.frost_dkg_part3(secretHex, round1Broadcasts, round2Packages),
          );
        });
        return;

      case 'frost-sign-round1':
        await sealedFrost(id, payload, a => {
          const { ephemeralSeedHex, keyPackageHex } = a as {
            ephemeralSeedHex: string;
            keyPackageHex: string;
          };
          return JSON.parse(wasmModule!.frost_sign_round1(ephemeralSeedHex, keyPackageHex));
        });
        return;

      case 'frost-spend-sign':
        await sealedFrost(id, payload, a => {
          const { ephemeralSeedHex, keyPackageHex, noncesHex, sighashHex, alphaHex, commitments } =
            a as {
              ephemeralSeedHex: string;
              keyPackageHex: string;
              noncesHex: string;
              sighashHex: string;
              alphaHex: string;
              commitments: string;
            };
          // signed variant - coordinator (zafu/poker-escrow) extracts signer identifier from VK
          return wasmModule!.frost_spend_sign_round2_signed(
            ephemeralSeedHex,
            keyPackageHex,
            noncesHex,
            sighashHex,
            alphaHex,
            commitments,
          );
        });
        return;

      case 'frost-spend-aggregate': {
        await initWasm();
        const { publicKeyPackageHex, sighashHex, alphaHex, commitments, shares } = payload as {
          publicKeyPackageHex: string;
          sighashHex: string;
          alphaHex: string;
          commitments: string;
          shares: string;
        };
        const result = wasmModule!.frost_spend_aggregate(
          publicKeyPackageHex,
          sighashHex,
          alphaHex,
          commitments,
          shares,
        );
        workerSelf.postMessage({ type: 'frost-result', id, network: 'zcash', payload: result });
        return;
      }

      case 'frost-derive-address': {
        await initWasm();
        const { publicKeyPackageHex, diversifierIndex } = payload as {
          publicKeyPackageHex: string;
          diversifierIndex: number;
        };
        const rawHex = wasmModule!.frost_derive_address_raw(publicKeyPackageHex, diversifierIndex);
        workerSelf.postMessage({ type: 'frost-result', id, network: 'zcash', payload: rawHex });
        return;
      }

      case 'frost-derive-address-from-sk':
        await sealedFrost(id, payload, a => {
          const { publicKeyPackageHex, skHex, diversifierIndex } = a as {
            publicKeyPackageHex: string;
            skHex: string;
            diversifierIndex: number;
          };
          return wasmModule!.frost_derive_address_from_sk(
            publicKeyPackageHex,
            skHex,
            diversifierIndex,
          );
        });
        return;

      case 'frost-sample-fvk-sk':
        await sealedFrost(id, payload, () => wasmModule!.frost_sample_fvk_sk());
        return;

      case 'frost-derive-ufvk':
        await sealedFrost(id, payload, a => {
          const { publicKeyPackageHex, skHex, mainnet } = a as {
            publicKeyPackageHex: string;
            skHex: string;
            mainnet: boolean;
          };
          return wasmModule!.frost_derive_ufvk(publicKeyPackageHex, skHex, mainnet);
        });
        return;

      case 'frost-parse-tx-outputs': {
        await initWasm();
        const { unsignedTxHex, orchardFvkUview } = payload as {
          unsignedTxHex: string;
          orchardFvkUview: string;
        };
        const json = wasmModule!.frost_parse_tx_outputs(unsignedTxHex, orchardFvkUview);
        workerSelf.postMessage({ type: 'frost-result', id, network: 'zcash', payload: json });
        return;
      }

      case 'frost-inspect-pczt-outputs': {
        await initWasm();
        const { pcztHex, orchardFvkUview } = payload as {
          pcztHex: string;
          orchardFvkUview: string;
        };
        const json = wasmModule!.frost_inspect_pczt_outputs(pcztHex, orchardFvkUview);
        workerSelf.postMessage({ type: 'frost-result', id, network: 'zcash', payload: json });
        return;
      }

      case 'broadcast-raw-tx': {
        // submit a fully-signed transparent tx hex (e.g. from a Ledger t->t
        // send). No building/signing here - the device produced the hex.
        const { serverUrl: bUrl, txHex: bTxHex } = payload as {
          serverUrl: string;
          txHex: string;
        };
        const bClient = makeZcashClient(bUrl);
        const bResult = await bClient.sendTransaction(hexDecode(bTxHex));
        if (bResult.errorCode !== 0) {
          throw new Error(`broadcast failed (${bResult.errorCode}): ${bResult.errorMessage}`);
        }
        const bTxid = await resolveBroadcastTxid(bResult, bTxHex, bUrl);
        workerSelf.postMessage({
          type: 'tx-result',
          id,
          network: 'zcash',
          walletId,
          payload: { txid: bTxid },
        });
        return;
      }
      case 'pczt-extract-tx': {
        // the broadcast-ready tx of a signed PCZT and its txid, without the
        // network: the Ledger flow checkpoints these before it broadcasts, so
        // an uncertain broadcast is settled by a lookup, never a second approval
        await initWasm();
        if (!wasmModule) {
          throw new Error('wasm not initialized');
        }
        const { signedPcztHex: xPczt } = payload as { signedPcztHex: string };
        const xTxHex = wasmModule.extract_signed_tx_from_pczt(xPczt);
        // compute_txid is wire order; report display order like resolveBroadcastTxid
        const xTxid = (wasmModule.compute_txid(xTxHex).match(/../g) ?? []).reverse().join('');
        workerSelf.postMessage({
          type: 'result',
          id,
          network: 'zcash',
          walletId,
          payload: { txHex: xTxHex, txid: xTxid },
        });
        return;
      }
      case 'broadcast-signed-tx': {
        // a checkpointed signed tx, with the same cold-broadcast bookkeeping as
        // send-tx-pczt-complete. A node rejection throws "broadcast failed
        // (code)"; any other throw leaves the outcome unknown.
        if (!walletId) {
          throw new Error('walletId required');
        }
        const {
          serverUrl: sUrl,
          txHex: sTxHex,
          coldSendId: sColdSendId,
        } = payload as { serverUrl: string; txHex: string; coldSendId?: string };
        const sResult = await makeZcashClient(sUrl).sendTransaction(hexDecode(sTxHex));
        if (sResult.errorCode !== 0) {
          throw new Error(`broadcast failed (${sResult.errorCode}): ${sResult.errorMessage}`);
        }
        const sTxid = await resolveBroadcastTxid(sResult, sTxHex, sUrl);
        await finalizeColdBroadcast(walletId, sColdSendId, sTxid, sTxHex);
        workerSelf.postMessage({
          type: 'tx-result',
          id,
          network: 'zcash',
          walletId,
          payload: { txid: sTxid },
        });
        return;
      }
      case 'lookup-tx': {
        // whether the server that was asked to broadcast our own tx has it; a
        // failure reads as "not seen", never "gone". Backends disagree on the
        // byte order of TxFilter.hash, so try display order, then wire order.
        const { serverUrl: lUrl, txid: lTxid } = payload as { serverUrl: string; txid: string };
        const lClient = makeZcashClient(lUrl);
        const lDisplay = hexDecode(lTxid);
        let lFound = false;
        let lHeight: number | undefined;
        for (const lHash of [lDisplay, lDisplay.slice().reverse()]) {
          try {
            const lRaw = await lClient.getTransaction(lHash);
            lFound = lRaw.data.length > 0;
            lHeight = lRaw.height > 0 ? lRaw.height : undefined;
          } catch {
            // not in this order, or unreachable
          }
          if (lFound) {
            break;
          }
        }
        workerSelf.postMessage({
          type: 'result',
          id,
          network: 'zcash',
          walletId,
          payload: { found: lFound, height: lHeight },
        });
        return;
      }
      case 'shield-eligible': {
        // what a Ledger shielding run has ahead of it (count + value, no prev-tx
        // fetch); a failed fetch throws so it never reads as "no funds"
        const {
          serverUrl: eUrl,
          tAddresses: eAddrs,
          maxInputs: eMax,
        } = payload as { serverUrl: string; tAddresses: string[]; maxInputs: number };
        const eUtxos = await utxosEach(makeZcashClient(eUrl), eAddrs);
        const eRound = shieldRoundUtxos(eUtxos, eAddrs, Math.max(1, eMax));
        const eRoundZat = eRound.reduce((sum, u) => sum + u.valueZat, 0n);
        workerSelf.postMessage({
          type: 'result',
          id,
          network: 'zcash',
          walletId,
          payload: {
            inputCount: eUtxos.length,
            totalZat: eUtxos.reduce((sum, u) => sum + u.valueZat, 0n).toString(),
            belowThreshold: eRound.length > 0 && eRoundZat <= computeShieldFee(eRound.length),
          },
        });
        return;
      }
      case 'get-transparent-utxos': {
        // spendable transparent UTXOs of one address (a Ledger t-addr, an lp
        // address), each with the full prev-tx bytes the Ledger legacy signer
        // needs as its trusted input.
        const { serverUrl: uUrl, address: uAddr } = payload as {
          serverUrl: string;
          address: string;
        };
        const uClient = makeZcashClient(uUrl);
        const uUtxos = await uClient.getAddressUtxos(uAddr);
        const uOut = [];
        for (const u of uUtxos) {
          const uPrevTx = await uClient.getTransaction(u.txid);
          uOut.push({
            txid: hexEncode(u.txid),
            vout: u.outputIndex,
            valueZat: Number(u.valueZat),
            scriptHex: hexEncode(u.script),
            prevTxHex: hexEncode(uPrevTx.data),
          });
        }
        workerSelf.postMessage({
          type: 'result',
          id,
          network: 'zcash',
          walletId,
          payload: uOut,
        });
        return;
      }
      case 'complete-orchard-pczt': {
        if (!walletId) {
          throw new Error('walletId required');
        }
        await initWasm();
        if (!wasmModule) {
          throw new Error('wasm not initialized');
        }
        const { serverUrl, pcztHex, orchardSigs, spendIndices, coldSendId } = payload as {
          serverUrl: string;
          pcztHex: string;
          orchardSigs: string[];
          spendIndices: number[];
          /** id returned by the send-tx-pczt build; see ColdSendContext */
          coldSendId?: string;
        };
        // Inject the aggregated FROST SpendAuth sigs, extract the tx, broadcast.
        // Which bundle the signatures belong to is a property of the PCZT, not
        // of the caller, so read it off the artifact rather than trusting a
        // flag the relay could omit.
        const cTxHex = wasmModule.pczt_has_ironwood_actions(pcztHex)
          ? wasmModule.complete_ironwood_pczt(pcztHex, orchardSigs, spendIndices)
          : wasmModule.complete_orchard_pczt(pcztHex, orchardSigs, spendIndices);
        const cTxData = hexDecode(cTxHex);
        const cClient = makeZcashClient(serverUrl);
        const cResult = await cClient.sendTransaction(cTxData);
        if (cResult.errorCode !== 0) {
          throw new Error(`broadcast failed (${cResult.errorCode}): ${cResult.errorMessage}`);
        }
        const cTxid = await resolveBroadcastTxid(cResult, cTxHex, serverUrl);
        // This is the ledger and FROST-multisig broadcast. It is a cold path
        // like the two above and had the same gap.
        await finalizeColdBroadcast(walletId, coldSendId, cTxid, cTxHex);
        workerSelf.postMessage({
          type: 'tx-result',
          id,
          network: 'zcash',
          walletId,
          payload: { txid: cTxid },
        });
        return;
      }

      // ── shielded voting ──
      //
      // These handlers call the STANDALONE `voting-wasm` module (see
      // `state/voting-wasm.ts`), NOT the core `wasmModule` (zafu-wasm).
      // zcash_voting + voting-circuits pull their own orchard/pczt graph
      // that must not co-version with the wallet scanner/spender, so the
      // module is lazily fetched here on first use rather than being part
      // of the worker's `initWasm()` startup path. `ur_encode_frames` /
      // `cborWrapPczt` (below) are plain CBOR/UR framing utilities from the
      // core module - not voting crypto - so reusing them here does not
      // reintroduce the coupling this split exists to avoid.

      case 'generate-voting-hotkey': {
        const votingWasm = await loadVotingWasm();
        const { network: vhNetwork } = payload as { network: string };
        const hk = JSON.parse(votingWasm.generate_voting_hotkey(vhNetwork)) as {
          hotkey_secret_hex: string;
          hotkey_pubkey_hex: string;
        };
        workerSelf.postMessage({
          type: 'result',
          id,
          network: 'zcash',
          walletId,
          payload: { hotkeySecretHex: hk.hotkey_secret_hex, hotkeyPubkeyHex: hk.hotkey_pubkey_hex },
        });
        return;
      }

      case 'build-delegation-pczt': {
        const bd = payload as {
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
        };
        const raw = JSON.parse(
          (await proveViaOffscreen({
            fn: 'build_delegation_pczt',
            args: [
              bd.fvkHex,
              bd.seedFingerprintHex,
              bd.accountIndex,
              bd.hotkeyPubkeyHex,
              bd.notesJson,
              bd.roundParamsJson,
              bd.consensusBranchId,
              bd.roundName,
              bd.network,
              bd.bundleIndex,
            ],
          })) as string,
        ) as {
          redacted_pczt_hex: string;
          pczt_sighash_hex: string;
          rk_hex: string;
          action_index: number;
          delegated_weight: number;
          display_memo: string;
          real_note_nullifiers_hex: string[];
          dummy_note_nullifiers_hex: string[];
          delegation_context_json: string;
          delegation_state_json: string;
        };

        // UR-encode the redacted PCZT for the animated-QR round-trip to
        // zigner. This is generic CBOR/UR framing on the CORE module (not
        // voting crypto) - see the block comment above.
        await initWasm();
        if (!wasmModule) {
          throw new Error('wasm not initialized');
        }
        const pcztBytes = hexDecode(raw.redacted_pczt_hex);
        const cbor = cborWrapPczt(pcztBytes);
        const framesJson = wasmModule.ur_encode_frames(cbor, 'zcash-pczt', 200);
        const urFrames = JSON.parse(framesJson) as string[];

        workerSelf.postMessage({
          type: 'result',
          id,
          network: 'zcash',
          walletId,
          payload: {
            redactedPcztHex: raw.redacted_pczt_hex,
            pcztSighashHex: raw.pczt_sighash_hex,
            rkHex: raw.rk_hex,
            actionIndex: raw.action_index,
            delegatedWeight: raw.delegated_weight,
            displayMemo: raw.display_memo,
            realNoteNullifiersHex: raw.real_note_nullifiers_hex,
            dummyNoteNullifiersHex: raw.dummy_note_nullifiers_hex,
            delegationContextJson: raw.delegation_context_json,
            delegationStateJson: raw.delegation_state_json,
            urFrames,
            cborBytes: cbor.length,
          },
        });
        return;
      }

      case 'finalize-delegation': {
        const fd = payload as {
          delegationContextJson: string;
          merkleWitnessesJson: string;
          imtProofsJson: string;
          spendAuthSigHex: string;
          sighashHex: string;
        };
        const raw = JSON.parse(
          (await proveViaOffscreen({
            fn: 'finalize_delegation',
            args: [
              fd.delegationContextJson,
              fd.merkleWitnessesJson,
              fd.imtProofsJson,
              fd.spendAuthSigHex,
              fd.sighashHex,
            ],
          })) as string,
        ) as { delegation_submission_wire_json: string };
        workerSelf.postMessage({
          type: 'result',
          id,
          network: 'zcash',
          walletId,
          payload: { delegationSubmissionWireJson: raw.delegation_submission_wire_json },
        });
        return;
      }

      case 'cast-vote-hot-wire': {
        const cv = payload as {
          network: string;
          hotkeySecretHex: string;
          roundParamsJson: string;
          delegationStateJson: string;
          vanWitnessJson: string;
          voteJson: string;
        };
        const raw = JSON.parse(
          (await proveViaOffscreen({
            fn: 'cast_vote_hot_wire',
            args: [
              cv.hotkeySecretHex,
              cv.roundParamsJson,
              cv.delegationStateJson,
              cv.vanWitnessJson,
              cv.voteJson,
              cv.network,
            ],
          })) as string,
        ) as {
          proposal_id: number;
          wire: unknown;
          commitment_bundle_json: string;
          next_delegation_state_json: string;
        };
        workerSelf.postMessage({
          type: 'result',
          id,
          network: 'zcash',
          walletId,
          payload: {
            proposalId: raw.proposal_id,
            // the cast-vote body; shares wait for the vote's tree position
            // (build-vote-shares-from-recovery)
            wire: JSON.stringify(raw.wire),
            commitmentBundleJson: raw.commitment_bundle_json,
            nextDelegationStateJson: raw.next_delegation_state_json,
          },
        });
        return;
      }

      case 'build-vote-shares-from-recovery': {
        // no proof: rebuilds the helper shares of a vote already on chain
        const votingWasm = await loadVotingWasm();
        const sr = payload as {
          commitmentBundleJson: string;
          vcTreePosition: number;
          submitAt: number;
        };
        const sharesJson = votingWasm.build_vote_shares_from_recovery(
          sr.commitmentBundleJson,
          BigInt(sr.vcTreePosition),
          BigInt(sr.submitAt),
        );
        workerSelf.postMessage({
          type: 'result',
          id,
          network: 'zcash',
          walletId,
          payload: { sharesJson },
        });
        return;
      }

      case 'pir-fetch-imt-proofs': {
        const votingWasm = await loadVotingWasm();
        const pf = payload as { pirBaseUrl: string; nullifiersJson: string };
        const imtProofsJson = await votingWasm.pir_fetch_imt_proofs(
          pf.pirBaseUrl,
          pf.nullifiersJson,
          (input: string, init?: unknown) => fetch(input, init as RequestInit),
        );
        workerSelf.postMessage({
          type: 'result',
          id,
          network: 'zcash',
          walletId,
          payload: { imtProofsJson },
        });
        return;
      }

      case 'get-consensus-branch-id': {
        const { serverUrl: branchServerUrl } = payload as { serverUrl: string };
        const branchClient = makeZcashClient(branchServerUrl);
        const branchIdHex = await fetchBranchIdHex(branchClient);
        workerSelf.postMessage({
          type: 'result',
          id,
          network: 'zcash',
          walletId,
          payload: { consensusBranchId: parseInt(branchIdHex, 16) },
        });
        return;
      }

      case 'get-merkle-witnesses': {
        if (!walletId) {
          throw new Error('walletId required');
        }
        const {
          nullifiers: witnessNullifiers,
          targetHeight,
          serverUrl: witnessServerUrl,
          pool: witnessPool,
        } = payload as {
          nullifiers: string[];
          targetHeight: number;
          serverUrl: string;
          pool?: NotePool;
        };
        const witnessState = await loadState(walletId);
        // preserve caller order - finalize_delegation zips merkle_witnesses_json
        // 1:1 against the notes_json array build_delegation_pczt was called with.
        const byNullifier = new Map(witnessState.notes.map(n => [n.nullifier, n]));
        const orderedNotes = witnessNullifiers.map(nf => {
          const note = byNullifier.get(nf);
          if (!note) {
            throw new Error(`get-merkle-witnesses: note for nullifier ${nf} not found`);
          }
          return note;
        });
        // The witness pool is the notes' own pool, never a default: a tree
        // path from the other pool's tree is a root the proof cannot match.
        // Voting notes are Ironwood (V3) only; the 0.12 delegation circuit
        // rejects others, so refuse here before any tree work.
        const notePools = [...new Set(orderedNotes.map(poolOf))];
        if (notePools.length !== 1) {
          throw new Error(
            `get-merkle-witnesses: notes from ${notePools.join(' and ') || 'no'} pools; ` +
              'a delegation bundle holds notes from one pool',
          );
        }
        const snapshotPool = notePools[0]!;
        if (snapshotPool !== 'ironwood') {
          throw new Error(
            `get-merkle-witnesses: ${snapshotPool} notes cannot be delegated; voting takes ironwood notes`,
          );
        }
        if (witnessPool && witnessPool !== snapshotPool) {
          throw new Error(
            `get-merkle-witnesses: asked for ${witnessPool} witnesses for ${snapshotPool} notes`,
          );
        }
        const witnessClient = makeZcashClient(witnessServerUrl);
        // the snapshot height exactly: from the tree when it still retains that
        // checkpoint, else by a replay to it (voting only; spends never replay)
        const fromTree = await buildWitnesses(
          witnessClient,
          walletId,
          orderedNotes,
          targetHeight,
          snapshotPool,
        ).catch(() => undefined);
        const witnessResult =
          fromTree?.anchorHeight === targetHeight
            ? fromTree
            : await pathsAtSnapshot(witnessClient, orderedNotes, snapshotPool, targetHeight);
        const witnessPaths = witnessResult.paths as {
          position: number;
          path: { hash: string }[];
        }[];
        const witnessDtos = orderedNotes.map((note, i) => ({
          note_commitment_hex: note.cmx,
          position: witnessPaths[i]!.position,
          root_hex: witnessResult.anchorHex,
          auth_path_hex: witnessPaths[i]!.path.map(p => p.hash),
        }));
        workerSelf.postMessage({
          type: 'result',
          id,
          network: 'zcash',
          walletId,
          payload: { merkleWitnessesJson: JSON.stringify(witnessDtos) },
        });
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
  } finally {
    if (typeof cancelKey === 'string') {
      builds.end(cancelKey);
    }
  }
};

initWasm()
  .then(() => {
    workerSelf.postMessage({ type: 'ready', id: '', network: 'zcash' });
  })
  .catch(err => {
    console.error(`[zcash-worker] wasm init failed: ${errText(err)}`);
  });
