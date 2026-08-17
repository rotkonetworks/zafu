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

import { fixOrchardAddress, encodeOrchardUfvk } from '@repo/wallet/networks/zcash/unified-address';
import { blockRangeFetcher } from '../services/memo-sync/block-range-fetcher';
import { buildStrategy } from '../services/memo-sync/strategy';
import { idbBucketStore } from '../services/memo-sync/filters/cache';
import { bucketOf, BUCKET_SIZE as MEMO_BUCKET_SIZE } from '../services/memo-sync/types';
import type { BucketStart as MemoBucketStart, MemoSyncStrategy } from '../services/memo-sync/types';
import type { ZcashBackend, ZcashClient } from '../state/keyring/zcash-backend';
import { COMPACT_SIGN_REQUEST } from '../config/feature-flags';
import {
  preludeWrapSinglePczt,
  ZIGNER_PCZT_SIGN_UR_TYPE,
} from '../routes/popup/send/zcash-send-cbor-helpers';
import { nu63ActivationHeight } from '../config/feature-flags';
import { crossCheckTip } from './cross-verify';
import { installGracefulNetworkErrorHandler } from '../utils/graceful-network-errors';
import {
  CommitmentReservoir,
  padCommitmentQuery,
  padNullifierQuery,
  type CommitmentItem,
} from './proof-decoys';
import { BlockPrefetcher } from './block-prefetcher';
import { once } from './once';
import { assessAmbientRayonIsolation, RAYON_ISOLATION_WARNING } from '../perf/rayon-isolation';
import { loadVotingWasm } from '../state/voting-wasm';
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
  MAX_REWINDS_PER_RUN,
  type SyncErrorCode,
} from '../state/sync-failure';

export type { SentTxRecord } from './sent-tx-reconcile';

const workerSelf = globalThis as any as DedicatedWorkerGlobalScope;

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
 * MEANS from its text is brittle — but we own both sides of this boundary, so
 * anything thrown here can simply say what it is. Only errors from wasm, from
 * `fetch`, and from IndexedDB fall back to substring sniffing in
 * `state/sync-failure.ts`.
 */
const syncError = (code: SyncErrorCode, message: string): Error =>
  Object.assign(new Error(message), { syncCode: code });

/**
 * Worker-local endpoint→backend registry. Populated only via the explicit
 * `backend` field on the 'sync' payload (the popup classifies endpoints
 * declaratively via isZidecarEndpoint() and forwards). We deliberately do
 * NOT auto-probe — probing zidecar-only RPCs is a unique-to-zafu request
 * signature that fingerprints the wallet.
 *
 * Unknown endpoints default to 'zidecar' (the rotko-shipped baseline);
 * users on a third-party lightwalletd must hit 'sync' first to seed this
 * map before any other RPC, which is the natural call order anyway.
 */
const backendRegistry = new Map<string, ZcashBackend>();

function registerBackend(serverUrl: string, backend: ZcashBackend): void {
  if (backend !== 'zidecar' && backend !== 'lightwalletd') {
    throw new Error(`unknown zcash backend: ${String(backend)}`);
  }
  backendRegistry.set(serverUrl.replace(/\/$/, ''), backend);
}

function lookupBackend(serverUrl: string): ZcashBackend {
  return backendRegistry.get(serverUrl.replace(/\/$/, '')) ?? 'zidecar';
}

/**
 * Factory: construct the appropriate sync client for an endpoint+backend.
 *
 * Two-arg form is the canonical (defensive) one — pass backend explicitly
 * when you have it in scope. The one-arg form is for call sites deep in
 * the worker that don't carry backend through their payload; they fall
 * back to the registry. Throws on unknown backend, never silently coerces.
 */
const makeZcashClient = async (serverUrl: string, backend?: ZcashBackend): Promise<ZcashClient> => {
  const effective = backend ?? lookupBackend(serverUrl);
  if (effective === 'lightwalletd') {
    const { LightwalletdClient } = await import(
      /* webpackMode: "eager" */ '../state/keyring/lightwalletd-client'
    );
    return new LightwalletdClient(serverUrl);
  }
  if (effective === 'zidecar') {
    const { ZidecarClient } = await import(
      /* webpackMode: "eager" */ '../state/keyring/zidecar-client'
    );
    return new ZidecarClient(serverUrl);
  }
  throw new Error(`unknown zcash backend: ${String(effective)}`);
};

interface WorkerMessage {
  type:
    | 'init'
    | 'derive-address'
    | 'sync'
    | 'stop-sync'
    | 'reset-sync'
    | 'get-balance'
    | 'get-pool-balances'
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
  scan_actions(actionsJson: unknown): DecryptedNote[];
  calculate_balance(notes: unknown, spent: unknown): bigint;
  /** Raw 96-byte Orchard FVK as hex (not a bech32m UFVK string). */
  get_fvk_hex(): string;
}

interface WatchOnlyWallet extends ScannerKeys {
  get_address(): string;
  get_address_at(diversifierIndex: number): string;
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
  /** serialized IncrementalWitness (hex), advanced to witnessTreeSize leaves */
  witness_hex?: string;
  /** tree size at which witness was last advanced — used to detect drift */
  witness_tree_size?: number;
}

/** Pool of a note; records persisted pre-ironwood default to orchard. */
const poolOf = (note: DecryptedNote): NotePool => note.pool ?? 'orchard';

interface WalletState {
  keys: ScannerKeys | null;
  syncing: boolean;
  syncAbort: boolean;
  notes: DecryptedNote[];
  spentNullifiers: Set<string>;
  /**
   * Abort controller for the mempool watcher task, when one is running.
   * Lifted out of runSync's scope so stop-sync / reset-sync can abort the
   * watcher directly without waiting for runSync's backoff to drain.
   */
  mempoolAbort?: AbortController;
  /**
   * Promise of the watcher's IIFE. waitForSyncStop awaits this alongside
   * `syncing` so a follow-up runSync can't race a still-alive watcher.
   */
  mempoolTask?: Promise<void>;
}

interface WasmModule {
  WalletKeys: new (seed: string) => WalletKeys;
  WatchOnlyWallet: {
    from_ufvk(ufvk: string): WatchOnlyWallet;
    from_qr_hex(qrHex: string): WatchOnlyWallet;
    new (fvkBytes: Uint8Array, accountIndex: number, mainnet: boolean): WatchOnlyWallet;
  };
  build_shielding_transaction(
    utxos_json: string,
    privkey_hex: string,
    recipient: string,
    amount: bigint,
    fee: bigint,
    anchor_height: number,
    mainnet: boolean,
    // live consensus branch id (hex, e.g. "37a5165b"); null/'' -> WASM NU6.2 fallback
    branch_id_hex?: string | null,
  ): string;
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
  build_signed_spend_transaction(
    seed_phrase: string,
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
  ): string;
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
  derive_transparent_privkey(seed_phrase: string, account: number, index: number): string;
  /** 33-byte compressed secp256k1 pubkey for a UFVK's transparent address index */
  transparent_pubkey_from_ufvk(ufvk_str: string, address_index: number): string;
  build_merkle_paths(
    tree_state_hex: string,
    compact_blocks_json: string,
    note_positions_json: string,
    anchor_height: number,
  ): unknown;
  build_witnesses_and_paths(
    tree_state_hex: string,
    compact_blocks_json: string,
    note_positions_json: string,
  ): unknown;
  witness_sync_update(
    start_frontier_hex: string,
    compact_blocks_json: string,
    existing_witnesses_json: string,
    new_notes_json: string,
  ): unknown;
  witness_extract_path(witness_hex: string): unknown;
  frontier_tree_size(tree_state_hex: string): bigint;
  tree_root_hex(tree_state_hex: string): string;

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
  witness_sync_update_ironwood?: (
    start_frontier_hex: string,
    compact_blocks_json: string,
    existing_witnesses_json: string,
    new_notes_json: string,
  ) => unknown;
  witness_extract_path_ironwood?: (witness_hex: string) => unknown;
  frontier_tree_size_ironwood?: (tree_state_hex: string) => bigint;
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

  /**
   * NU6.3 turnstile migration HOT (mnemonic) path: same as
   * build_turnstile_migration_pczt but takes the SEED PHRASE and returns the
   * final SIGNED V6 tx hex directly - no intermediate PCZT is produced. The
   * account_index MUST be the account the orchard notes were scanned under, and
   * expected_branch_id MUST be the live GetLightdInfo branch id (never the
   * 0xffffffff placeholder); the producer refuses to build otherwise. Invoked
   * via the offscreen prover (proveViaOffscreen), declared here for completeness.
   */
  build_signed_turnstile_migration?: (
    seed_phrase: string,
    orchard_notes_json: string,
    fee: bigint,
    orchard_anchor_hex: string,
    orchard_merkle_paths_json: string,
    account_index: number,
    target_height: number,
    expected_branch_id: number,
    mainnet: boolean,
    memo_hex?: string | null,
  ) => string;

  /**
   * NU6.3 general IRONWOOD hot send: spends the given IRONWOOD notes to an
   * arbitrary recipient and returns the final SIGNED V6 tx hex directly (no
   * intermediate PCZT). Post-NU6.3 this is the only shielded spend path, since
   * orchard-to-orchard sends are consensus-disabled. Same fail-closed contract
   * as build_signed_turnstile_migration: account_index MUST be the account the
   * ironwood notes were scanned under and expected_branch_id MUST be the live
   * GetLightdInfo branch id (never the 0xffffffff placeholder); the producer
   * refuses to build otherwise. Invoked via the offscreen prover
   * (proveViaOffscreen), declared here (optional) for feature detection - the
   * export lands with the NU6.3 blob.
   */
  build_signed_ironwood_send?: (
    seed_phrase: string,
    ironwood_notes_json: string,
    recipient: string,
    amount: bigint,
    fee: bigint,
    ironwood_anchor_hex: string,
    ironwood_merkle_paths_json: string,
    account_index: number,
    target_height: number,
    expected_branch_id: number,
    mainnet: boolean,
    memo_hex?: string | null,
  ) => string;

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
 * Build the request envelope for an airgapped signing leg.
 *
 * With COMPACT_SIGN_REQUEST on we further-redact the PCZT (drop cv_net, the v6
 * anchors and output cmx; collapse each output ciphertext to its trimmed memo)
 * and mark the envelope tx_type 0x05, which the device answers with a
 * signatures-only response. If the redaction throws for any reason we fall
 * back to the legacy 0x03 envelope rather than failing the send - a bigger QR
 * beats a broken one.
 *
 * Returns the envelope and whether it actually went out compact, so the UI can
 * bind the response type to what was requested.
 */
function buildSignRequestEnvelope(
  wasm: WasmModule,
  pcztHex: string,
): { envelope: Uint8Array; compact: boolean } {
  if (COMPACT_SIGN_REQUEST) {
    try {
      const compactHex = wasm.redact_pczt_compact(pcztHex);
      return { envelope: preludeWrapSinglePczt(hexDecode(compactHex), true), compact: true };
    } catch (e) {
      console.warn('[zcash-worker] compact redaction failed, sending legacy 0x03:', e);
    }
  }
  return { envelope: preludeWrapSinglePczt(hexDecode(pcztHex), false), compact: false };
}

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
 * Wrap raw PCZT bytes in the CBOR envelope `{1: bytes}` that the
 * `zcash-pczt` UR type expects (matches zashi/keystone-sdk format).
 * This is the inverse of `encode_pczt_to_cbor` in zigner's signer.
 */
const cborWrapPczt = (pczt: Uint8Array): Uint8Array => {
  const len = pczt.length;
  // map(1) + key 1 + bytes(len) header
  const header: number[] = [0xa1, 0x01];
  if (len <= 23) {
    header.push(0x40 | len);
  } else if (len <= 0xff) {
    header.push(0x58, len);
  } else if (len <= 0xffff) {
    header.push(0x59, (len >> 8) & 0xff, len & 0xff);
  } else {
    header.push(0x5a, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff);
  }
  const out = new Uint8Array(header.length + len);
  out.set(header, 0);
  out.set(pczt, header.length);
  return out;
};

/**
 * patch consensus branch ID in a v5 tx to NU5 (0xC2D6D0B4)
 * allows older zcash_primitives to parse NU6+ transactions
 * v5 layout: [4B header][4B versionGroupId][4B consensusBranchId]...
 * NU5 branch ID in LE: B4 D0 D6 C2
 */
/**
 * NU6.3 consensus branch id (from the live zebra: 0x37a5165b). The turnstile
 * migration builder binds this into the transaction; we fail closed unless the
 * endpoint's GetLightdInfo reports exactly this. `GetLightdInfo` returns it as
 * a lowercase hex string with no `0x` prefix.
 */
const NU63_CONSENSUS_BRANCH_ID = 0x37a5165b;
const NU63_CONSENSUS_BRANCH_ID_HEX = '37a5165b';
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

/**
 * Wait for both the sync loop AND the mempool watcher to stop after the
 * caller has set syncAbort=true (or otherwise signaled shutdown). Polls
 * state.syncing every 50ms up to timeoutMs, then explicitly awaits the
 * watcher task if one was running — this matters because a freshly-spawned
 * runSync race can otherwise have two watchers contending against the same
 * walletId.
 */
const waitForSyncStop = async (state: WalletState, timeoutMs = 2000): Promise<void> => {
  // Abort the watcher (idempotent) so any in-flight fetch / sleep wakes up.
  state.mempoolAbort?.abort();

  if (state.syncing) {
    await new Promise<void>(resolve => {
      const start = Date.now();
      const check = () => {
        if (!state.syncing || Date.now() - start > timeoutMs) {
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
  }
  // Wait for the watcher's promise to settle so we know the IIFE finished.
  // Bounded by the same timeout — if the watcher is wedged inside a fetch
  // that ignored the signal, we still return after timeoutMs.
  if (state.mempoolTask) {
    await Promise.race([
      state.mempoolTask.catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, timeoutMs)),
    ]);
    state.mempoolTask = undefined;
    state.mempoolAbort = undefined;
  }
};

/**
 * Sleep that wakes early when the sync loop is asked to stop. The loop's
 * idle wait (10s at tip) and error backoff (up to 30s) are much longer than
 * waitForSyncStop's 2s budget - a plain setTimeout sleep would let a stale
 * loop outlive the teardown and race a freshly-started sync (e.g. after an
 * endpoint switch, the old loop keeps its old client).
 */
const sleepUnlessAborted = async (state: WalletState, ms: number): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!state.syncAbort) {
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
  // 0xff — 8 byte, unlikely for tx counts
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
// v4: NU6.3 ironwood - adds the 'witnesses-ironwood' store and the
// ironwoodTreeSize / ironwoodTreeFrontier / ironwoodTreeFrontierHeight meta
// keys (meta needs no schema change; the store is generic key/value).
// Strictly additive: orchard stores and keys are untouched, so v3 databases
// upgrade cleanly with no data migration.
const DB_VERSION = 5;

let sharedDb: IDBDatabase | null = null;

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
    // in the log. Fail loudly instead — the caller surfaces it and a reload
    // (which drops the other connection) fixes it.
    req.onblocked = () =>
      reject(
        new Error(
          `IndexedDB upgrade to v${DB_VERSION} blocked by another open connection to ${DB_NAME} — reload the extension`,
        ),
      );
    req.onsuccess = () => {
      sharedDb = req.result;
      resolve(sharedDb);
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

/** close shared db connection — called when worker is idle */
export const closeDb = () => {
  if (sharedDb) {
    sharedDb.close();
    sharedDb = null;
  }
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
  walletStates.delete(walletId);
};

/** Per-note ironwood witness record persisted in the 'witnesses-ironwood' store. */
interface IronwoodWitnessRecord {
  walletId: string;
  nullifier: string;
  witness_hex: string;
  witness_tree_size: number;
}

const loadState = async (walletId: string): Promise<WalletState> => {
  const state = getOrCreateWalletState(walletId);
  state.notes = await idbGetAllByIndex<DecryptedNote>('notes', 'byWallet', walletId);
  const spentRecords = await idbGetAllByIndex<{ nullifier: string }>('spent', 'byWallet', walletId);
  state.spentNullifiers = new Set(spentRecords.map(r => r.nullifier));

  // attach ironwood witnesses from their dedicated store (orchard witnesses
  // live on the note record itself; ironwood ones are stored separately per
  // the v4 schema so orchard paths stay untouched)
  const iwWitnesses = await idbGetAllByIndex<IronwoodWitnessRecord>(
    'witnesses-ironwood',
    'byWallet',
    walletId,
  );
  if (iwWitnesses.length > 0) {
    const byNullifier = new Map(iwWitnesses.map(w => [w.nullifier, w]));
    for (const note of state.notes) {
      if (poolOf(note) !== 'ironwood') {
        continue;
      }
      const w = byNullifier.get(note.nullifier);
      if (w) {
        note.witness_hex = w.witness_hex;
        note.witness_tree_size = w.witness_tree_size;
      }
    }
  }
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

/**
 * Per-wallet secret that keys the proof-query decoys (see proof-decoys.ts).
 *
 * It must be STABLE. Decoys re-rolled on every sync would be worse than no
 * decoys at all: real items recur in every query and fresh decoys do not, so
 * intersecting a few sessions hands the server the real set. Persisting the
 * seed makes a repeated query byte-identical.
 *
 * Caveat, stated plainly: this lives in the wallet database, so clearing the
 * cache re-rolls it. A clear-and-resync therefore presents the server with a
 * second, differently-padded query over the same real notes, and the
 * intersection of the two narrows the anonymity set. There is no fix for
 * that short of deriving the seed from the wallet key material, which the
 * worker does not hold in a form stable across a wipe.
 */
const getDecoySeed = async (walletId: string): Promise<Uint8Array> => {
  const r = await idbGet<{ value: string }>('meta', [walletId, 'decoySeed']);
  if (r?.value) {
    return hexDecode(r.value);
  }
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const db = await getDb();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ walletId, key: 'decoySeed', value: hexEncode(seed) });
  await txComplete(tx);
  return seed;
};

const saveActionsCommitment = async (walletId: string, commitment: string): Promise<void> => {
  const db = await getDb();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ walletId, key: 'actionsCommitment', value: commitment });
  await txComplete(tx);
};

/** verify header proof + commitment proofs + nullifier proofs after sync catches up */
const verifySyncProofs = async (
  client: ZcashClient,
  tip: number,
  mainnet: boolean,
  pendingCmxs: Uint8Array[],
  pendingPositions: number[],
  state: WalletState,
  actionsCommitment: string,
  /** whether this wallet's running actions commitment was folded from genesis
   *  (start block 0). If it was started at a birthday/import height, the fold
   *  is seeded from a non-genesis value and can NEVER equal the server's
   *  genesis-anchored proven commitment, so verifying it is meaningless. */
  genesisAnchoredActions: boolean,
  /** secret keying the decoy padding; null disables padding (see below). */
  decoySeed: Uint8Array | null,
  /** observed on-chain (cmx, position) pairs to draw commitment decoys from. */
  decoyPool: readonly CommitmentItem[],
): Promise<void> => {
  if (!zyncModule) {
    return;
  }
  console.log(`[zcash-worker] verifying proofs: ${pendingCmxs.length} notes`);
  const t0 = performance.now();

  // 1. verify header proof
  const proven = await verifyHeaderProof(client, tip, mainnet);
  console.log(`[zcash-worker] header proof valid, roots: tree=${proven.tree_root.slice(0, 16)}...`);

  // 2. verify commitment proofs for found notes
  // proven.tree_root is the canonical orchard tree root (from zebrad's frontier);
  // NOMT-served commitment-proof tree_root is NOMT's sparse-merkle blake3 root.
  // The two are different tree structures and never agree by construction, so
  // we don't bind them. We still verify the per-cmx Merkle path against the
  // returned root (catches NOMT corruption) and confirm cmx existence; the
  // canonical orchard membership is enforced locally during scan.
  //
  // PRIVACY: a (cmx, position) pair is a direct index into the block holding
  // that output, so an unpadded request is a complete, unambiguous inventory
  // of the wallet's notes handed to the server in the clear. The query is
  // padded with decoys drawn from commitments the scanner actually observed
  // in the same block range (see proof-decoys.ts) — fabricated cmxs would
  // have no proof and identify themselves. Only proofs for OUR cmxs are
  // verified; decoy responses are dropped unread.
  if (pendingCmxs.length > 0) {
    // Two independent properties, both required:
    //   privacy — the query is padded with decoys so the server does not learn
    //             the wallet's exact note set from the cmx+position pairs;
    //   integrity — every proof is bound to the batch root and to something we
    //             actually asked about, and every REAL cmx must come back.
    // Neither subsumes the other: padding without binding still lets a server
    // forge paths, and binding without padding still hands over the note set.
    const realItems: CommitmentItem[] = pendingCmxs.map((cmx, i) => ({
      cmx,
      position: pendingPositions[i] ?? 0,
    }));
    const padded = padCommitmentQuery(realItems, decoyPool, decoySeed);
    const { proofs: commitmentProofs, treeRoot } = await client.getCommitmentProofs(
      padded.cmxs,
      padded.positions,
      tip,
    );

    const treeRootHex = hexEncode(treeRoot);
    const askedCmxs = new Set(padded.cmxs.map(c => hexEncode(c)));
    if (commitmentProofs.length !== padded.cmxs.length) {
      throw new Error(
        `commitment proof count mismatch: asked ${padded.cmxs.length}, got ${commitmentProofs.length}`,
      );
    }

    const seenCmxs = new Set<string>();
    let verified = 0;
    for (const proof of commitmentProofs) {
      const cmxHex = hexEncode(proof.cmx);
      const proofRootHex = hexEncode(proof.treeRoot);
      // Root- and request-binding apply to EVERY proof, decoy or not: a server
      // that answers off a tree it invented is misbehaving regardless of which
      // cmx it is answering about.
      if (proofRootHex !== treeRootHex) {
        throw new Error(
          `commitment proof root mismatch: proof=${proofRootHex.slice(0, 16)} batch=${treeRootHex.slice(0, 16)}`,
        );
      }
      if (!askedCmxs.has(cmxHex)) {
        throw new Error(`commitment proof for unrequested cmx ${cmxHex.slice(0, 16)}`);
      }
      if (seenCmxs.has(cmxHex)) {
        throw new Error(`duplicate commitment proof for cmx ${cmxHex.slice(0, 16)}`);
      }
      seenCmxs.add(cmxHex);

      // Only OWN items are verified or acted on. A decoy cmx is not a real
      // commitment, so a failing path for one proves nothing and must never
      // fail the sync.
      if (!padded.realHex.has(cmxHex)) {
        continue;
      }
      const valid = zyncModule['verify_commitment_proof'](
        cmxHex,
        proofRootHex,
        proof.pathProofRaw,
        hexEncode(proof.valueHash),
      ) as boolean;
      if (!valid) {
        throw new Error(`commitment proof invalid for cmx ${cmxHex.slice(0, 16)}`);
      }
      verified++;
    }

    // Omission check: padding must not become a place for the server to hide a
    // missing answer about one of OUR notes.
    if (verified !== realItems.length) {
      throw new Error(
        `commitment proofs missing for own notes: verified ${verified} of ${realItems.length}`,
      );
    }
    console.log(
      `[zcash-worker] ${verified}/${realItems.length} own commitment proofs verified ` +
        `(root-bound, request-bound); sent ${padded.cmxs.length} incl. ` +
        `${padded.cmxs.length - realItems.length} decoys`,
    );
  }

  // 3. verify nullifier proofs for unspent notes.
  //
  // Ironwood used to be excluded here on the belief that the NOMT nullifier
  // set was orchard-only. It never was — the set is existence-keyed and
  // pool-agnostic, and zidecar indexes sapling, orchard and ironwood
  // nullifiers into it from the same block walk. What actually bounds an
  // answer is not the pool but the index's height, and the two pools have
  // different horizons: ironwood is indexed from NU6.3 activation and is
  // current, while the full-chain backfill trails far behind it.
  //
  // That distinction matters because absence is not proof. Above a pool's
  // horizon "no entry" means "not indexed yet", which is byte-identical to
  // "not spent" — trusting it would mark a spent note as spendable. So each
  // note is only queried once its own pool's index reaches the tip; the rest
  // fall back to scan-time detection.
  const unspentAll = state.notes.filter(n => !state.spentNullifiers.has(n.nullifier));

  // There used to be a single-nullifier "probe" call here, issued immediately
  // before the batch, purely to read the index horizons off its response.
  //
  // It was the worst request in the wallet. One bare nullifier, unpadded, no
  // possible ambiguity about whose it was — and because it was always
  // `unspentAll[0]`, it was the same stable value every session, which
  // re-identified the wallet to the server across sessions on its own. Being
  // adjacent to the batch also joined the two: the server could attribute the
  // whole batch to whoever sent the probe.
  //
  // The horizons are carried on the batch response anyway, so the probe
  // bought nothing that the request we were about to send did not already
  // return. It is gone; the horizons are read below, after the batch.
  //
  // The horizon is ONE-DIRECTIONAL, and treating it as a filter was wrong.
  //
  // `is_spent = true` is a Merkle INCLUSION proof against nullifier_root,
  // verified locally below and root-bound before use — it is sound at any
  // horizon. Only `is_spent = false` is uninformative above the horizon,
  // because the NOMT set is existence-keyed and "not indexed yet" and "not
  // spent" are the same bytes.
  //
  // Filtering the QUERY by horizon therefore discarded sound positives along
  // with the unsound negatives. Worse: the orchard backfill trails the tip by
  // design, so `orchardHorizon >= tip` is essentially never true in
  // production — which meant this disabled orchard spend detection outright
  // rather than merely narrowing it. Always ask; gate only what we believe.
  const unspentNotes = unspentAll;
  const unspentNfs = unspentNotes.map(n => hexDecode(n.nullifier));

  // PRIVACY: these are nullifiers of UNSPENT notes — values that are not yet
  // on chain and that only this wallet can know. Sent bare, the server can
  // record them and fire the moment one appears in a block, deanonymising a
  // spend before the user has made it. The query is padded with decoys drawn
  // uniformly from the Pallas base field (where real nullifiers live) and
  // shuffled, so the request alone no longer says which are ours.
  //
  // Be clear about the size of this win: the anonymity set is 3, and it is
  // retrospective-only — when the user actually spends, the real nullifier
  // hits the chain and the decoys never do, so the server can work backwards
  // and identify it then. What the padding removes is the PROSPECTIVE
  // watchlist. See proof-decoys.ts for the full accounting.
  const padded = padNullifierQuery(unspentNfs, decoySeed);
  const queryNfs = padded.query;

  if (unspentNfs.length > 0) {
    const {
      proofs: nfProofs,
      nullifierRoot,
      syncedHeight,
      ironwoodSyncedHeight,
    } = await client.getNullifierProofs(queryNfs, tip);
    const nfRootHex = hexEncode(nullifierRoot);

    // Horizons come off the batch itself — this is what the deleted probe
    // call was for. No absence gate is needed at the consumption site below:
    // the loop acts ONLY on `proof.isSpent === true`, and never infers
    // "unspent" from a missing entry. They are logged so the record states
    // what coverage the answers carry.
    console.log(
      `[zcash-worker] queried ${queryNfs.length} nullifier proofs ` +
        `(${unspentNfs.length} real + ${queryNfs.length - unspentNfs.length} decoy) ` +
        `(orchard index @${syncedHeight}, ironwood @${ironwoodSyncedHeight}, tip ${tip}); ` +
        `spent-proofs always trusted, unspent trusted only at/above the horizon`,
    );

    // NOT a tampering signal, and it must not fail the sync.
    //
    // These two roots are taken at DIFFERENT INSTANTS from a MUTABLE tree.
    // zidecar's NOMT is a single live tree: proofs are generated against
    // nomt.root() at request time, and `at_height` is accepted but ignored —
    // there is no versioned or pinned historical root. Meanwhile the ligerito
    // header proof carries a snapshot of that root from whenever the proof was
    // last generated. The server writes continuously (the ironwood cursor
    // follows the chain tip), so between the proof and this query the root has
    // simply moved on.
    //
    // Treating that as "the server tampered" was my error earlier today: it
    // converted a benign race into a hard sync failure that users hit within
    // minutes, and it teaches people to ignore an integrity warning — the
    // worst possible outcome for a check that is supposed to mean something.
    //
    // What IS sound is verified below and stays fatal: every proof must bind
    // to the batch root we actually checked, must be for a nullifier we asked
    // about, and the count must match. Those are internally consistent
    // comparisons taken at one instant, so a mismatch there really is the
    // server contradicting itself.
    //
    // Making this meaningful needs a server that can prove against a pinned
    // historical root. Until then a divergence here is unremarkable.
    if (nfRootHex !== proven.nullifier_root) {
      console.warn(
        `[zcash-worker] nullifier root moved since the header proof ` +
          `(live=${nfRootHex.slice(0, 16)} proven=${proven.nullifier_root.slice(0, 16)}); ` +
          `expected while the server is indexing - proofs are still bound to the live root below`,
      );
    }

    // Bind every proof to the root we actually checked, and to a nullifier we
    // actually asked about. Verifying each path against the PER-PROOF root the
    // server supplied made the whole pass forgeable: a malicious server could
    // return the real root in the batch field, then serve paths valid against
    // a tree it built itself. With is_spent=true that permanently marks a live
    // note spent (funds vanish from the balance and become unspendable); with
    // is_spent=false it hides a real spend.
    const requested = new Set(queryNfs.map(nf => hexEncode(nf)));
    let newlySpent = 0;
    for (const proof of nfProofs) {
      const proofRootHex = hexEncode(proof.nullifierRoot);
      if (proofRootHex !== nfRootHex) {
        throw new Error(
          `nullifier proof root mismatch: proof=${proofRootHex.slice(0, 16)} batch=${nfRootHex.slice(0, 16)}`,
        );
      }
      const nfHexForProof = hexEncode(proof.nullifier);
      if (!requested.has(nfHexForProof)) {
        throw new Error(`nullifier proof for unrequested nullifier ${nfHexForProof.slice(0, 16)}`);
      }
      // Decoys are asked about but never believed. A decoy proof carries no
      // information about this wallet, so verifying it would only hand the
      // server a way to fail the sync at will — and acting on its `isSpent`
      // would let it mark a note spent that was never ours to begin with.
      if (!padded.realHex.has(nfHexForProof)) {
        continue;
      }
      const valid = zyncModule['verify_nullifier_proof'](
        hexEncode(proof.nullifier),
        proofRootHex,
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
    console.log(
      `[zcash-worker] ${nfProofs.length} nullifier proofs returned, own-note proofs verified ` +
        `(${newlySpent} newly spent)`,
    );
  }

  // 4. verify actions commitment chain
  //
  // Only meaningful when the wallet's fold is genesis-anchored. The actions
  // commitment is a positional hash chain seeded from the previously-folded
  // value, so a wallet whose sync begins at a birthday/import block (nearly
  // all wallets — the default start is near tip, not genesis) folds from a
  // seed that can never equal the server's genesis-anchored proven value. For
  // those wallets any "mismatch" here is guaranteed by construction and was
  // spamming the retry loop under a misleading "server tampered" label. See
  // zcore crates/zync-core sync.rs verify_actions_commitment. We keep it for
  // genuine genesis wallets, where it is sound and actually checks something.
  const hasSaved = actionsCommitment !== '0'.repeat(64);
  if (genesisAnchoredActions) {
    zyncModule['verify_actions_commitment'](actionsCommitment, proven.actions_commitment, hasSaved);
    console.log(`[zcash-worker] actions commitment verified`);
  } else {
    console.warn(
      '[zcash-worker] actions commitment check skipped: wallet started at a non-genesis ' +
        'height, so the fold is not genesis-anchored (verifying would always mismatch)',
    );
  }

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`[zcash-worker] all proofs verified in ${elapsed}s`);
};

/** get cached orchard tree frontier from IDB */
const getTreeFrontier = async (walletId: string): Promise<string | null> => {
  const r = await idbGet<{ value: string }>('meta', [walletId, 'orchardTreeFrontier']);
  return r?.value ?? null;
};

/** height the cached frontier (and thus every stored note witness) is rooted at */
const getTreeFrontierHeight = async (walletId: string): Promise<number> => {
  const r = await idbGet<{ value: number }>('meta', [walletId, 'orchardTreeFrontierHeight']);
  return r?.value ?? 0;
};

// ── NU6.3 ironwood pool meta (mirrors the orchard keys above) ──

const getIronwoodTreeSize = async (walletId: string): Promise<number> => {
  const r = await idbGet<{ value: number }>('meta', [walletId, 'ironwoodTreeSize']);
  return r?.value ?? 0;
};

const getIronwoodTreeFrontier = async (walletId: string): Promise<string | null> => {
  const r = await idbGet<{ value: string }>('meta', [walletId, 'ironwoodTreeFrontier']);
  return r?.value ?? null;
};

const getIronwoodTreeFrontierHeight = async (walletId: string): Promise<number> => {
  const r = await idbGet<{ value: number }>('meta', [walletId, 'ironwoodTreeFrontierHeight']);
  return r?.value ?? 0;
};

/**
 * Orchard anchor height for a spend: the cached sync frontier height — the
 * exact height our note witnesses are rooted at. The witness machinery only
 * fast-forwards, never rewinds, so anchoring anywhere else (the live tip, or
 * tip−N) leaves the witness root pinned at the frontier while the cross-check
 * fetches the network root at the anchor, and the two disagree — the "tree
 * root mismatch at height N" failure. A frontier we've synced past is a valid
 * historical Orchard anchor regardless of how far behind the tip it sits.
 * Falls back to the tip only for a fresh wallet with no cached frontier.
 */
const resolveAnchorHeight = async (walletId: string, tipHeight: number): Promise<number> => {
  const frontierHeight = await getTreeFrontierHeight(walletId);
  return frontierHeight > 0 ? frontierHeight : tipHeight;
};

/** periodic frontier snapshots for privacy-safe witness building.
 *  stored as array of {height, frontier} in IDB, one per SNAPSHOT_INTERVAL blocks. */
const FRONTIER_SNAPSHOT_INTERVAL = 5_000;

/**
 * Heights per `GetCompactBlocks` request on the catch-up path.
 *
 * Left at 200 deliberately. Measured against zcash.rotko.net, serial
 * throughput barely moves with batch size (205 blocks/s at 200, 265 at 1000)
 * and at the depths we actually use it is a wash — the server is per-request
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
 * but that ran under node's undici, which pools HTTP/1.1 connections — so it
 * measured multi-connection fan-out, not depth. Unlocking that region needs
 * batches sharded across 2-3 hostnames onto the same anycast edge, NOT a
 * bigger number here.
 *
 * Cost at 6: ~675KB of undecoded blocks held, and a reorg or abort throws
 * away a few hundred milliseconds of fetch.
 *
 * The real ceiling is upstream of all of this: zidecar spends ~7.5ms per
 * block serving a range (1.6s for 200 blocks, 88ms TTFB), so the client is
 * pipelining around server-side work. See docs — the fix there is an
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

interface FrontierSnapshot {
  height: number;
  frontier: string;
}

const getFrontierSnapshots = async (walletId: string): Promise<FrontierSnapshot[]> => {
  const r = await idbGet<{ value: FrontierSnapshot[] }>('meta', [walletId, 'frontierSnapshots']);
  return r?.value ?? [];
};

const saveFrontierSnapshot = async (
  walletId: string,
  height: number,
  frontier: string,
): Promise<void> => {
  const existing = await getFrontierSnapshots(walletId);
  // avoid duplicates, keep sorted
  if (existing.some(s => s.height === height)) {
    return;
  }
  existing.push({ height, frontier });
  existing.sort((a, b) => a.height - b.height);
  const db = await getDb();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ walletId, key: 'frontierSnapshots', value: existing });
  await txComplete(tx);
};

/** ironwood pool state persisted alongside a batch (mirrors the orchard args) */
interface IronwoodBatchMeta {
  treeSize?: number;
  frontier?: string;
  frontierHeight?: number;
}

/**
 * Mark the notes we just spent as spent, immediately, without waiting for a rescan.
 *
 * Orchard does not need this: sync step 3 asks zidecar's NOMT nullifier tree
 * "is this spent?" for every unspent orchard note, so an orchard spend is
 * noticed on the next tick regardless of which blocks get scanned.
 *
 * Ironwood has no such oracle — the NOMT nullifier tree is orchard-only — so
 * its only spend signal is the scan-time nullifier match in runSync, which
 * fires only while walking the block that contains the spend. A wallet that
 * was already synced when it sent is *past* that block and never revisits it,
 * so the note stayed "unspent" forever and its value kept counting toward the
 * balance.
 *
 * We know exactly which notes we spent, so record it at broadcast. Worst case
 * the transaction never mines and the note is wrongly held back, which the
 * mempool/reorg path already has to handle — strictly safer than the reverse,
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
      // mirror saveBatch: ironwood witnesses live in their own store, so
      // strip them rather than writing them onto the note record.
      if (poolOf(note) === 'ironwood') {
        const { witness_hex, witness_tree_size, ...rest } = note;
        void witness_hex;
        void witness_tree_size;
        notesStore.put({ ...rest, walletId });
      } else {
        notesStore.put({ ...note, walletId });
      }
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
    // store does not have — better to re-detect the spend on the next scan
    // than to believe a write that never landed.
    for (const nf of nullifiers) {
      state.spentNullifiers.delete(nf);
    }
    for (const note of updated) {
      note.spent_by_txid = undefined;
    }
    console.error('[zcash-worker] failed to persist local spend marks:', e);
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

/** batch-save notes + spent + sync height + tree size in one transaction */
const saveBatch = async (
  walletId: string,
  notes: DecryptedNote[],
  spent: string[],
  syncHeight: number,
  orchardTreeSize?: number,
  updatedNotes?: DecryptedNote[],
  orchardTreeFrontier?: string,
  orchardTreeFrontierHeight?: number,
  ironwood?: IronwoodBatchMeta,
): Promise<void> => {
  const db = await getDb();
  const tx = db.transaction(['notes', 'spent', 'meta', 'witnesses-ironwood'], 'readwrite');
  const notesStore = tx.objectStore('notes');
  const spentStore = tx.objectStore('spent');
  const metaStore = tx.objectStore('meta');
  const iwWitnessStore = tx.objectStore('witnesses-ironwood');
  // orchard notes carry their witness on the record; ironwood witnesses go
  // to the dedicated v4 store so the orchard note shape stays untouched.
  const putNote = (note: DecryptedNote) => {
    if (poolOf(note) === 'ironwood') {
      const { witness_hex, witness_tree_size, ...rest } = note;
      notesStore.put({ ...rest, walletId });
      if (witness_hex !== undefined && witness_tree_size !== undefined) {
        iwWitnessStore.put({
          walletId,
          nullifier: note.nullifier,
          witness_hex,
          witness_tree_size,
        } satisfies IronwoodWitnessRecord);
      }
    } else {
      notesStore.put({ ...note, walletId });
    }
  };
  for (const note of notes) {
    putNote(note);
  }
  // re-save notes that were updated (e.g. spent_by_txid added, witness advanced)
  if (updatedNotes) {
    for (const note of updatedNotes) {
      putNote(note);
    }
  }
  for (const nf of spent) {
    spentStore.put({ walletId, nullifier: nf });
  }
  metaStore.put({ walletId, key: 'syncHeight', value: syncHeight });
  if (orchardTreeSize !== undefined) {
    metaStore.put({ walletId, key: 'orchardTreeSize', value: orchardTreeSize });
  }
  if (orchardTreeFrontier) {
    metaStore.put({ walletId, key: 'orchardTreeFrontier', value: orchardTreeFrontier });
  }
  if (orchardTreeFrontierHeight !== undefined) {
    metaStore.put({ walletId, key: 'orchardTreeFrontierHeight', value: orchardTreeFrontierHeight });
  }
  if (ironwood?.treeSize !== undefined) {
    metaStore.put({ walletId, key: 'ironwoodTreeSize', value: ironwood.treeSize });
  }
  if (ironwood?.frontier) {
    metaStore.put({ walletId, key: 'ironwoodTreeFrontier', value: ironwood.frontier });
  }
  if (ironwood?.frontierHeight !== undefined) {
    metaStore.put({
      walletId,
      key: 'ironwoodTreeFrontierHeight',
      value: ironwood.frontierHeight,
    });
  }
  await txComplete(tx);
};

// ── wasm ──

// Every message handler starts with `await initWasm()`, and the handlers run
// concurrently — network-worker sends `init` and the first real command back to
// back. A bare `if (wasmModule) return` guard does not survive that: both calls
// see `null` and both initialize the SAME wasm instance. The second
// `initThreadPool` then throws, gets swallowed by the fallback below, and
// scanning drops to one core for the life of the worker. `once` shares the
// in-flight promise so the initializer runs exactly once.
const initWasm = once(async (): Promise<void> => {
  // @ts-expect-error — dynamic import in worker
  const wasm = await import(/* webpackIgnore: true */ '/zafu-wasm/zafu_wasm.js');
  await wasm.default({ module_or_path: '/zafu-wasm/zafu_wasm_bg.wasm' });
  wasm.init();

  // Rayon thread pool. scan_actions_parallel is only actually parallel once a
  // pool exists — without it rayon runs sequentially, so trial decryption was
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
    }
    // leave a core for the UI thread; scanning runs while the popup renders
    const numThreads = Math.max(1, (navigator.hardwareConcurrency || 4) - 1);
    await wasm.initThreadPool(numThreads);
    scanParallelism = isolation.ok
      ? { threads: numThreads }
      : { threads: numThreads, reason: `cross-origin isolation lost: ${isolation.reason}` };
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
 * canonical ZIP-244 txid locally from the signed tx bytes — the same value
 * zidecar computes server-side and the same bytes that appear as
 * `CompactTx.hash` during sync, so the optimistic outgoing record reconciles.
 */
const resolveBroadcastTxid = async (
  result: { txid: Uint8Array },
  txHex: string,
  serverUrl: string,
): Promise<string> => {
  if (lookupBackend(serverUrl) === 'zidecar') {
    return new TextDecoder().decode(result.txid);
  }
  await initWasm();
  if (!wasmModule) {
    throw new Error('wasm not initialized for txid computation');
  }
  // compute_txid returns INTERNAL (wire) byte order — the same bytes that
  // appear as CompactTx.hash during sync. zidecar's SendResponse, by
  // contrast, echoes the DISPLAY-order txid, so without this reversal the
  // same wallet reported two different conventions depending on backend and
  // the lightwalletd one could not be found in any explorer (it is the real
  // txid, just byte-reversed). Normalize to display order, which is what
  // users copy and what block explorers accept.
  const internal = wasmModule.compute_txid(txHex);
  return (internal.match(/../g) ?? []).reverse().join('');
};

// ── zync-core (verification) ──

let zyncModule: Record<string, any> | null = null;

// Same concurrency hazard as initWasm: a second `zync.default()` on the same
// instance re-runs the module's start section and detaches the live views.
const initZync = once(async (): Promise<void> => {
  // @ts-expect-error dynamic import in worker
  const zync = await import(/* webpackIgnore: true */ '/zync-core/zync_core.js');
  await zync.default({ module_or_path: '/zync-core/zync_core_bg.wasm' });
  zync.wasm_init();
  zyncModule = zync;
  console.log('[zcash-worker] zync-core ready');
});

interface ProvenRoots {
  tree_root: string;
  nullifier_root: string;
  actions_commitment: string;
}

/** fetch and verify header proof from zidecar, returns proven NOMT roots */
const verifyHeaderProof = async (
  client: ZcashClient,
  tip: number,
  mainnet: boolean,
): Promise<ProvenRoots> => {
  if (!zyncModule) {
    throw new Error('zync-core not initialized');
  }
  const { proofBytes } = await client.getHeaderProof();
  const json = zyncModule['verify_header_proof'](proofBytes, tip, mainnet) as string;
  return JSON.parse(json) as ProvenRoots;
};

// ── offscreen proving ──
// Halo 2 proving is CPU-intensive (~2min single-threaded). Route it through
// the offscreen document which has a persistent rayon thread pool, so MSM/FFT
// runs in parallel across all cores. The offscreen survives popup close.

interface ZcashBuildRequest {
  fn:
    | 'build_signed_spend'
    | 'build_unsigned'
    | 'build_unsigned_pczt'
    | 'build_turnstile_migration_pczt'
    | 'build_signed_turnstile_migration'
    | 'build_signed_ironwood_send'
    | 'build_ironwood_send_pczt'
    | 'build_shielding'
    | 'build_unsigned_shielding'
    | 'build_unsigned_shielding_ironwood'
    // shielded-voting proving fns - routed to the standalone voting-wasm
    // module + its own rayon pool in the offscreen document. See
    // zcash-build-parallel.ts's VOTING_FNS / initParallelVotingWasm.
    | 'build_delegation_pczt'
    | 'finalize_delegation'
    | 'cast_vote_hot_wire';
  args: unknown[];
}

// pending prove requests waiting for parent (network-worker) to relay response
const pendingProveRequests = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();
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

/**
 * User fee multiplier (settings → fees), injected per-operation by the caller
 * because this is a dedicated web worker with no chrome.storage access.
 *
 * Clamped to >= 1: ZIP-317 is a consensus floor, not a fee market. Paying
 * below it means zebra rejects the tx outright ("Unpaid actions is higher
 * than the limit"), so a sub-standard multiplier can only break sends.
 */
let feeMultiplier = 1;
const setFeeMultiplier = (m: unknown) => {
  const n = typeof m === 'number' && Number.isFinite(m) ? m : 1;
  feeMultiplier = Math.max(1, n);
};
const applyFeeMultiplier = (fee: bigint): bigint =>
  feeMultiplier === 1 ? fee : (fee * BigInt(Math.round(feeMultiplier * 100))) / 100n;
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
  return applyFeeMultiplier(MARGINAL_FEE * BigInt(Math.max(logicalActions, GRACE_ACTIONS)));
};

/**
 * ZIP-317 fee for the NU6.3 turnstile migration — the one transaction that
 * spans TWO shielded bundles: orchard (the spends) and ironwood (the output).
 *
 * ZIP-317 counts logical actions as the SUM over bundles, and each non-empty
 * shielded bundle is padded to MIN_ORCHARD_ACTIONS for privacy (the orchard
 * bundle gains a dummy output, the ironwood bundle a dummy spend — which is
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
 * ~75 inputs — safe for consensus (nodes only reject UNDER-payment) but a
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
 * Deliberately does NOT apply the user fee multiplier — the shielding paths
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
  return applyFeeMultiplier(MARGINAL_FEE * BigInt(Math.max(logicalActions, GRACE_ACTIONS)));
};

// ── note selection (largest first) ──

const selectNotes = (
  notes: DecryptedNote[],
  spentNullifiers: Set<string>,
  target: bigint,
  // a transaction spends from exactly one pool; pre-ironwood callers all
  // spend orchard, so notes without a pool tag (legacy records) qualify
  pool: NotePool = 'orchard',
): DecryptedNote[] => {
  const unspent = notes.filter(n => !spentNullifiers.has(n.nullifier) && poolOf(n) === pool);
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

// ── witness building helpers ──

const WITNESS_BATCH_SIZE = 1000;

// Cap concurrent compact-block fetches. A from-corruption witness rebuild can
// span ~150k blocks (150 batches); firing them all at once spikes worker memory
// (every decoded payload held until .flat()) and can trip server stream limits —
// and this runs on the witness-recovery path *during a send*, where a thrown
// fetch leaves the user unable to broadcast. Bounded fan-out keeps the speed win
// without the failure mode.
const WITNESS_FETCH_CONCURRENCY = 12;

interface WitnessClient {
  getTreeState(h: number): Promise<{ height: number; orchardTree: string; ironwoodTree?: string }>;
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

/**
 * Replay blocks for a range and fold them into a compact-blocks JSON payload.
 * Used for both witness seeding (backfill) and witness fast-forwarding.
 * `pool` selects which action list feeds the commitment tree: orchard
 * actions (default) or NU6.3 ironwood actions.
 */
const fetchCompactBlocksRange = async (
  client: WitnessClient,
  start: number,
  end: number,
  pool: NotePool = 'orchard',
): Promise<{
  blocks: { height: number; actions: { cmx_hex: string }[] }[];
  actions: number;
}> => {
  if (start > end) {
    return { blocks: [], actions: 0 };
  }

  // build all batch ranges, then fetch them through a bounded pool.
  // gRPC/HTTP2 multiplexes over a single connection, but a deep rebuild can
  // produce ~150 batches — capping in-flight requests keeps peak memory and
  // server-side stream count in check.
  const ranges: [number, number][] = [];
  for (let s = start; s <= end; s += WITNESS_BATCH_SIZE) {
    ranges.push([s, Math.min(s + WITNESS_BATCH_SIZE - 1, end)]);
  }

  // write results by index to preserve ascending-height order for the WASM replay
  const results = new Array<{ height: number; actions: { cmx_hex: string }[] }[]>(ranges.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      const range = ranges[i];
      if (!range) {
        return;
      }
      const [s, e] = range;
      const bs = await client.getCompactBlocks(s, e);
      // `pool` selects which action list feeds the commitment tree: orchard
      // actions (default) or NU6.3 ironwood actions.
      results[i] = bs.map(b => {
        const poolActions = pool === 'ironwood' ? (b.ironwoodActions ?? []) : b.actions;
        return {
          height: b.height,
          actions: poolActions.map(a => ({ cmx_hex: hexEncode(a.cmx) })),
        };
      });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(WITNESS_FETCH_CONCURRENCY, ranges.length) }, worker),
  );

  const blocks = results.flat();
  const actions = blocks.reduce((sum, b) => sum + b.actions.length, 0);
  return { blocks, actions };
};

/**
 * Seed witnesses from scratch for notes that predate the per-note witness
 * rollout (no witness_hex in IDB). Writes witnesses back to the notes store
 * so future spends hit the fast path. Returns the witness_hex by nullifier.
 */
const backfillWitnesses = async (
  client: WitnessClient,
  walletId: string,
  notes: DecryptedNote[],
  anchorHeight: number,
  onProgress?: (step: string, detail?: string) => void,
): Promise<{
  byNullifier: Map<string, { witness_hex: string; tree_size: number }>;
  endFrontier: string;
}> => {
  if (!wasmModule) {
    throw new Error('wasm not initialized');
  }
  if (notes.length === 0) {
    return { byNullifier: new Map(), endFrontier: '' };
  }

  const earliestNoteHeight = Math.min(...notes.map(n => n.height));
  const earliestPosition = Math.min(...notes.map(n => n.position));

  // Pick a pre-note frontier to replay from. Prefer locally-cached snapshots
  // (no RPC = no privacy leak); fall back to fetching a rounded height.
  let frontierHex: string | null = null;
  let frontierHeight = 0;

  const snapshots = await getFrontierSnapshots(walletId);
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const snap = snapshots[i]!;
    if (snap.height >= earliestNoteHeight) {
      continue;
    }
    const snapSize = Number(wasmModule.frontier_tree_size(snap.frontier));
    if (snapSize <= earliestPosition) {
      frontierHex = snap.frontier;
      frontierHeight = snap.height;
      break;
    }
  }

  if (!frontierHex) {
    const roundedHeight = Math.max(
      1,
      Math.floor((earliestNoteHeight - 1) / FRONTIER_SNAPSHOT_INTERVAL) *
        FRONTIER_SNAPSHOT_INTERVAL,
    );
    console.log(`[zcash-worker] backfill: fetching frontier at rounded height ${roundedHeight}`);
    const ts = await client.getTreeState(roundedHeight);
    frontierHex = ts.orchardTree;
    frontierHeight = roundedHeight;
    await saveFrontierSnapshot(walletId, roundedHeight, frontierHex);
  }

  const fetchStart = performance.now();
  console.log(
    `[zcash-worker] backfill: fetching ${Math.ceil((anchorHeight - frontierHeight) / WITNESS_BATCH_SIZE)} batches in parallel (${frontierHeight + 1}..${anchorHeight})`,
  );
  const { blocks: compactBlocks, actions: totalActions } = await fetchCompactBlocksRange(
    client,
    frontierHeight + 1,
    anchorHeight,
  );
  const fetchSecs = ((performance.now() - fetchStart) / 1000).toFixed(1);
  console.log(
    `[zcash-worker] backfill: fetch done in ${fetchSecs}s — ${compactBlocks.length} blocks, ${totalActions} actions`,
  );
  onProgress?.('backfill: blocks downloaded', `${compactBlocks.length} blocks in ${fetchSecs}s`);

  const positions = notes.map(n => n.position);
  console.log(
    `[zcash-worker] backfill: wasm replay starting (${totalActions} actions, ${positions.length} notes)`,
  );
  onProgress?.('backfill: replaying tree', `${totalActions} actions`);
  const wasmStart = performance.now();
  const raw = wasmModule.build_witnesses_and_paths(
    frontierHex,
    JSON.stringify(compactBlocks),
    JSON.stringify(positions),
  );
  const wasmSecs = ((performance.now() - wasmStart) / 1000).toFixed(1);
  console.log(`[zcash-worker] backfill: wasm done in ${wasmSecs}s`);
  onProgress?.('backfill: witness rebuilt', `took ${wasmSecs}s`);
  const result = JSON.parse(raw as string) as {
    anchor_hex: string;
    end_frontier_hex: string;
    entries: { position: number; witness_hex: string; path: { hash: string }[] }[];
  };

  const checkpointSize = Number(wasmModule.frontier_tree_size(frontierHex));
  const endTreeSize = checkpointSize + totalActions;

  // DEBUG (tree-root-mismatch investigation): does the replay reconstruct the
  // same tree the network reports at anchorHeight? If replayRoot !== network,
  // the snapshot-seed → compact-block replay is the culprit, not the anchor.
  const byPosition = new Map(result.entries.map(e => [e.position, e]));
  const byNullifier = new Map<string, { witness_hex: string; tree_size: number }>();
  const updatedNotes: DecryptedNote[] = [];
  for (const note of notes) {
    const entry = byPosition.get(note.position);
    if (!entry) {
      continue;
    }
    byNullifier.set(note.nullifier, {
      witness_hex: entry.witness_hex,
      tree_size: endTreeSize,
    });
    note.witness_hex = entry.witness_hex;
    note.witness_tree_size = endTreeSize;
    updatedNotes.push(note);
  }

  // saveBatch before any further await: the sync loop can run at the next yield and update
  // witness_tree_size to a higher value; saveBatch after that would stomp it back down.
  if (updatedNotes.length > 0) {
    await saveBatch(
      walletId,
      [],
      [],
      anchorHeight,
      endTreeSize,
      updatedNotes,
      result.end_frontier_hex,
      anchorHeight,
    );
    console.log(`[zcash-worker] backfill: cached witnesses for ${updatedNotes.length} notes`);
  }

  try {
    const netRoot = wasmModule.tree_root_hex((await client.getTreeState(anchorHeight)).orchardTree);
    const match = result.anchor_hex === netRoot ? 'OK' : 'MISMATCH';
    console.log(
      `[zcash-worker] backfill replay check [${match}]: seed=${frontierHeight}(size ${checkpointSize}) → anchor=${anchorHeight}(size ${endTreeSize}, +${totalActions} actions) replayRoot=${result.anchor_hex} network=${netRoot}`,
    );
  } catch (e) {
    console.warn('[zcash-worker] backfill replay check skipped:', e);
  }

  return { byNullifier, endFrontier: result.end_frontier_hex };
};

/**
 * NU6.3 ironwood pool witness/path building (mirror of the orchard path in
 * buildWitnesses below, via the pool-specific wasm fns).
 *
 * Fast path: every selected note has a cached ironwood witness aligned with
 *            the cached ironwood frontier - fast-forward over the gap with
 *            witness_sync_update_ironwood and extract paths.
 * Slow path: replay from a pre-note ironwood tree state with
 *            build_merkle_paths_ironwood (one-shot; the contract has no
 *            ironwood equivalent of build_witnesses_and_paths, so nothing
 *            is persisted on this path - sync repopulates witnesses).
 */
/**
 * Record an outgoing transaction the moment it is broadcast.
 *
 * Deliberately best-effort: a failure here must never fail a send that the
 * network has already accepted. The chain remains the authority on whether it
 * confirmed — this only preserves the details the chain cannot give back.
 */
const recordSentTx = async (rec: SentTxRecord): Promise<void> => {
  try {
    const db = await getDb();
    const tx = db.transaction('sent', 'readwrite');
    tx.objectStore('sent').put(rec);
    await txComplete(tx);
  } catch (e) {
    console.warn('[zcash-worker] could not record sent tx locally:', e);
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
    console.warn('[zcash-worker] could not persist sent-tx reconciliation:', e);
  }
};

/**
 * ── cold-send continuity ──────────────────────────────────────────────────
 *
 * A hot send is one worker message: it selects the notes, builds, signs,
 * broadcasts, and — because everything it needs is still in scope — marks the
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
 * deliberately conservative — see takeColdSend.
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
 * can still sign and broadcast — it only costs the bookkeeping below.
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
    console.warn('[zcash-worker] could not stash cold-send context:', e);
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
    console.warn('[zcash-worker] could not read cold-send context:', e);
    return undefined;
  }
};

/**
 * The tail of a cold broadcast: mark the inputs spent and write the local
 * record, exactly as the hot paths do at the same point.
 *
 * Without this the flagship configuration — every cold signer — kept counting
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
    console.error('[zcash-worker] cold broadcast bookkeeping failed:', e);
  }
};

/** Stored ironwood witness no longer matches the network tree — recoverable. */
class IronwoodWitnessDrift extends Error {
  constructor(height: number) {
    super(`ironwood witness drift at height ${height}`);
    this.name = 'IronwoodWitnessDrift';
  }
}

const buildWitnessesIronwood = async (
  client: WitnessClient,
  walletId: string,
  notes: DecryptedNote[],
  anchorHeight: number,
  emitProgress?: (stage: string, detail?: string) => void,
): Promise<{ anchorHex: string; paths: unknown[] }> => {
  if (!wasmModule) {
    throw new Error('wasm not initialized');
  }
  const {
    witness_sync_update_ironwood: iwSync,
    witness_extract_path_ironwood: iwExtract,
    frontier_tree_size_ironwood: iwSize,
    tree_root_hex_ironwood: iwRoot,
    build_merkle_paths_ironwood: iwBuildPaths,
  } = wasmModule;
  if (!iwSync || !iwExtract || !iwSize || !iwRoot || !iwBuildPaths) {
    throw new Error('ironwood not supported by this wasm build');
  }

  // network root at the anchor - cross-checked against whatever we build
  const anchorTs = await client.getTreeState(anchorHeight);
  if (!anchorTs.ironwoodTree) {
    throw syncError(
      'chain-recovery',
      `server has no ironwood tree state at height ${anchorHeight}`,
    );
  }
  const networkRoot = iwRoot(anchorTs.ironwoodTree);

  const extractPaths = (
    witnessed: { nullifier: string; witness_hex: string }[],
  ): { position: number; path: { hash: string }[] }[] => {
    const paths: { position: number; path: { hash: string }[] }[] = [];
    for (const note of witnessed) {
      const parsed = JSON.parse(iwExtract(note.witness_hex) as string) as {
        position: number;
        root_hex: string;
        path: { hash: string }[];
      };
      if (parsed.root_hex !== networkRoot) {
        // Recoverable: the stored witness has drifted from the network tree.
        // Signalled rather than thrown so the caller can fall back to the slow
        // replay below, which rebuilds from a network checkpoint.
        throw new IronwoodWitnessDrift(anchorHeight);
      }
      paths.push({ position: parsed.position, path: parsed.path });
    }
    return paths;
  };

  // Fast path: cached frontier + aligned witnesses -> fast-forward.
  const frontier = await getIronwoodTreeFrontier(walletId);
  const frontierHeight = await getIronwoodTreeFrontierHeight(walletId);
  const frontierSize = frontier ? Number(iwSize(frontier)) : -1;
  const witnessTreeSize = notes[0]?.witness_tree_size ?? -1;
  const aligned =
    !!frontier &&
    frontierSize === witnessTreeSize &&
    notes.every(n => n.witness_hex && n.witness_tree_size === witnessTreeSize);

  // Say WHY the fast path was skipped. Falling back costs ~40s of block
  // replay on a real send, and until now the only signal was the wall clock -
  // "witnesses built 41.8s" with no way to tell a missing frontier from a
  // drifted one from a note that never got a witness. Each cause has a
  // different fix, so guessing between them is the expensive part.
  if (!aligned) {
    const missingWitness = notes.filter(n => !n.witness_hex).length;
    const wrongSize = notes.filter(
      n => n.witness_hex && n.witness_tree_size !== witnessTreeSize,
    ).length;
    const why = !frontier
      ? 'no cached frontier (never synced, or the frontier was wiped/rebootstrapped)'
      : frontierSize !== witnessTreeSize
        ? `frontier size ${frontierSize} != witness tree size ${witnessTreeSize} (sync ran on without updating witnesses)`
        : missingWitness > 0
          ? `${missingWitness}/${notes.length} selected notes have no stored witness`
          : `${wrongSize}/${notes.length} selected notes carry a witness at a different tree size`;
    console.warn(`[zcash-worker] ironwood witness fast path unavailable: ${why}`);
    emitProgress?.('witness fast path unavailable', why);
  }

  // The fast path is an OPTIMISATION, so a drifted witness must not fail the
  // send — it must fall back to the slow replay. Ironwood witnesses live in
  // their own IDB store which the reorg wipes never touch, so drift is not
  // exotic: a reorg leaves stale witnesses attached to real notes, and before
  // this the wallet showed a spendable balance it could never spend.
  if (aligned && frontier) {
    try {
      const { blocks: gapBlocks } = await fetchCompactBlocksRange(
        client,
        frontierHeight + 1,
        anchorHeight,
        'ironwood',
      );
      const existingInput = notes.map(n => ({ id: n.nullifier, witness_hex: n.witness_hex! }));
      const result = JSON.parse(
        iwSync(frontier, JSON.stringify(gapBlocks), JSON.stringify(existingInput), '[]') as string,
      ) as { end_frontier_hex: string; witnesses: { id: string; witness_hex: string }[] };
      const byId = new Map(result.witnesses.map(w => [w.id, w.witness_hex]));
      const witnessed = notes.map(n => {
        const w = byId.get(n.nullifier);
        if (!w) {
          throw new Error(`ironwood witness update missing note ${n.nullifier}`);
        }
        return { nullifier: n.nullifier, witness_hex: w };
      });
      const paths = extractPaths(witnessed);
      console.log(`[zcash-worker] ironwood paths (fast) for ${paths.length} notes`);
      return { anchorHex: networkRoot, paths };
    } catch (e) {
      if (!(e instanceof IronwoodWitnessDrift)) {
        throw e;
      }
      console.warn(
        `[zcash-worker] ironwood witness drifted from the network tree at height ` +
          `${anchorHeight}; rebuilding from a checkpoint instead of failing the send`,
      );
      // fall through to the slow replay
    }
  }

  // Slow path: replay from a rounded pre-note checkpoint (mirrors the
  // orchard backfill's privacy-preserving rounded-height fetch).
  const earliestNoteHeight = Math.min(...notes.map(n => n.height));
  const roundedHeight = Math.max(
    1,
    Math.floor((earliestNoteHeight - 1) / FRONTIER_SNAPSHOT_INTERVAL) * FRONTIER_SNAPSHOT_INTERVAL,
  );
  const checkpointTs = await client.getTreeState(roundedHeight);
  if (!checkpointTs.ironwoodTree) {
    throw syncError(
      'chain-recovery',
      `server has no ironwood tree state at height ${roundedHeight}`,
    );
  }
  const { blocks } = await fetchCompactBlocksRange(
    client,
    roundedHeight + 1,
    anchorHeight,
    'ironwood',
  );
  const positions = notes.map(n => n.position);
  const result = JSON.parse(
    iwBuildPaths(
      checkpointTs.ironwoodTree,
      JSON.stringify(blocks),
      JSON.stringify(positions),
      anchorHeight,
    ) as string,
  ) as { anchor_hex: string; paths: { position: number; path: { hash: string }[] }[] };
  if (result.anchor_hex !== networkRoot) {
    throw syncError('chain-recovery', `ironwood tree root mismatch at height ${anchorHeight}`);
  }
  console.log(`[zcash-worker] ironwood paths (replay) for ${result.paths.length} notes`);

  // Seed witnesses from the same replay and persist them, so this cost is paid
  // ONCE rather than on every send.
  //
  // This is the half of the orchard fix (17833dd2, "persist per-note
  // witnesses, eliminate spend-time replay") that ironwood never got. The doc
  // comment on buildWitnesses has always promised it - "replay from a pre-note
  // snapshot once, persist witnesses, then fast-forward" - but the ironwood
  // path returned the paths and wrote nothing back, so a note that missed the
  // fast path missed it forever. Every send replayed the chain from a
  // checkpoint: ~42s on a real wallet, indefinitely.
  //
  // Notes reach that state routinely, not exceptionally: any note that predates
  // ironwood witness maintenance, and every note after a rebootstrap or reorg
  // wipes the witness store.
  //
  // Failures here are logged and swallowed. The send already has its paths; a
  // witness that could not be cached costs another replay next time, which is
  // exactly the status quo, and is not worth failing a send over.
  try {
    const seeded = JSON.parse(
      iwSync(
        checkpointTs.ironwoodTree,
        JSON.stringify(blocks),
        '[]',
        JSON.stringify(notes.map(n => ({ id: n.nullifier, position: n.position }))),
      ) as string,
    ) as {
      end_frontier_hex: string;
      witnesses: { id: string; witness_hex: string }[];
    };
    const endTreeSize = Number(iwSize(seeded.end_frontier_hex));
    const db = await getDb();
    const tx = db.transaction(['witnesses-ironwood', 'meta'], 'readwrite');
    const wstore = tx.objectStore('witnesses-ironwood');
    for (const w of seeded.witnesses) {
      wstore.put({
        walletId,
        nullifier: w.id,
        witness_hex: w.witness_hex,
        witness_tree_size: endTreeSize,
      } satisfies IronwoodWitnessRecord);
    }
    // The frontier has to advance with them. Witnesses at a tree size the
    // stored frontier does not match fail the `aligned` check just as surely
    // as no witnesses at all.
    const metaStore = tx.objectStore('meta');
    metaStore.put({ walletId, key: 'ironwoodTreeFrontier', value: seeded.end_frontier_hex });
    metaStore.put({ walletId, key: 'ironwoodTreeFrontierHeight', value: anchorHeight });
    // Persist the tree size for this exact frontier too. Without it the stored
    // `ironwoodTreeSize` stays at its pre-send value while the frontier moves to
    // `endTreeSize`, so the next sync-start validity check
    // (iwSize(frontier) === ironwoodTreeSize) fails, the wallet rebootstraps,
    // and it wipes the very witnesses we just cached - putting every send back
    // on the full-replay slow path. Writing endTreeSize keeps the
    // (frontier, size) pair self-consistent so the fast path survives.
    metaStore.put({ walletId, key: 'ironwoodTreeSize', value: endTreeSize });
    await txComplete(tx);
    console.log(
      `[zcash-worker] ironwood: cached ${seeded.witnesses.length} witnesses at tree size ` +
        `${endTreeSize} (height ${anchorHeight}) - the next send should take the fast path`,
    );
  } catch (e) {
    console.warn('[zcash-worker] ironwood: could not cache witnesses after replay:', e);
  }

  return { anchorHex: networkRoot, paths: result.paths };
};

/**
 * Build merkle paths for spending notes.
 *
 * Fast path: every selected note has a stored witness at the sync frontier.
 *            Fast-forward witnesses over any remaining gap (sync frontier →
 *            anchor height), extract paths, done.
 * Slow path: some notes lack a witness (pre-upgrade notes). Replay from a
 *            pre-note snapshot once, persist witnesses, then fast-forward.
 *
 * `pool` routes to the pool-specific wasm witness fns; 'ironwood' delegates
 * to buildWitnessesIronwood, keeping the orchard path byte-identical.
 */
const buildWitnesses = async (
  client: WitnessClient,
  walletId: string,
  notes: DecryptedNote[],
  anchorHeight: number,
  pool: NotePool = 'orchard',
  onProgress?: (step: string, detail?: string) => void,
): Promise<{ anchorHex: string; paths: unknown[] }> => {
  if (!wasmModule) {
    throw new Error('wasm not initialized');
  }
  if (notes.length === 0) {
    throw new Error('buildWitnesses called with no notes');
  }
  if (pool === 'ironwood') {
    return buildWitnessesIronwood(client, walletId, notes, anchorHeight, onProgress);
  }

  const positions = notes.map(n => n.position);
  console.log(
    `[zcash-worker] witness build: positions=${JSON.stringify(positions)}, anchor=${anchorHeight}`,
  );

  // Step 1: any notes missing a witness? Back-fill them first (one-time cost
  // per upgraded wallet). Back-fill writes witnesses + frontier to IDB,
  // updating the in-memory notes in place.
  const missing = notes.filter(n => !n.witness_hex);
  if (missing.length > 0) {
    await backfillWitnesses(client, walletId, missing, anchorHeight, onProgress);
  }

  // Step 2: gather all note witnesses (now all populated). Use the running
  // frontier from IDB as the starting point for the fast-forward; if that
  // frontier is at a different tree size than our witnesses were advanced to,
  // rebootstrap.
  let runningFrontier = (await getTreeFrontier(walletId)) ?? '';
  let runningFrontierHeight =
    (await idbGet<{ value: number }>('meta', [walletId, 'orchardTreeFrontierHeight']))?.value ?? 0;

  const frontierSize = runningFrontier
    ? Number(wasmModule.frontier_tree_size(runningFrontier))
    : -1;
  // every selected note's witness must have been advanced to the same tree
  // size (i.e. frontierSize). If any lag, rebootstrap from network.
  const witnessTreeSize = notes[0]!.witness_tree_size ?? -1;
  const witnessesAligned = notes.every(n => n.witness_tree_size === witnessTreeSize);
  let rebootstrapped = false;
  if (!runningFrontier || frontierSize !== witnessTreeSize || !witnessesAligned) {
    rebootstrapped = true;
    console.log(
      `[zcash-worker] frontier mismatch (frontierSize=${frontierSize}, witnessTreeSize=${witnessTreeSize}, aligned=${witnessesAligned}); rebootstrapping via full backfill`,
    );
    // force a full backfill for all selected notes
    for (const n of notes) {
      n.witness_hex = undefined;
      n.witness_tree_size = undefined;
    }
    await backfillWitnesses(client, walletId, notes, anchorHeight, onProgress);
    runningFrontier = (await getTreeFrontier(walletId)) ?? '';
    runningFrontierHeight =
      (await idbGet<{ value: number }>('meta', [walletId, 'orchardTreeFrontierHeight']))?.value ??
      0;
  }

  // Step 3: fast-forward witnesses over (runningFrontierHeight, anchorHeight].
  if (runningFrontierHeight < anchorHeight) {
    const { blocks: gapBlocks, actions: gapActions } = await fetchCompactBlocksRange(
      client,
      runningFrontierHeight + 1,
      anchorHeight,
    );
    console.log(
      `[zcash-worker] witness ff: ${gapBlocks.length} blocks, ${gapActions} actions (${runningFrontierHeight + 1}..${anchorHeight})`,
    );

    const existingInput = notes.map(n => ({ id: n.nullifier, witness_hex: n.witness_hex! }));
    const raw = wasmModule.witness_sync_update(
      runningFrontier,
      JSON.stringify(gapBlocks),
      JSON.stringify(existingInput),
      JSON.stringify([]),
    );
    const result = JSON.parse(raw as string) as {
      end_frontier_hex: string;
      anchor_hex: string;
      witnesses: { id: string; position: number; witness_hex: string }[];
    };

    const byId = new Map(result.witnesses.map(w => [w.id, w]));
    const newTreeSize = Number(wasmModule.frontier_tree_size(result.end_frontier_hex));
    const updated: DecryptedNote[] = [];
    for (const note of notes) {
      const upd = byId.get(note.nullifier);
      if (!upd) {
        throw new Error(`witness update missing note ${note.nullifier}`);
      }
      note.witness_hex = upd.witness_hex;
      note.witness_tree_size = newTreeSize;
      updated.push(note);
    }
    runningFrontier = result.end_frontier_hex;
    runningFrontierHeight = anchorHeight;
    await saveBatch(
      walletId,
      [],
      [],
      // don't rewind syncHeight — this is a spend-time update
      Math.max(anchorHeight, await getSyncHeight(walletId)),
      newTreeSize,
      updated,
      runningFrontier,
      anchorHeight,
    );
  }

  // Step 4: extract paths; cross-check witness root against network anchor.
  // Snapshot witness bytes BEFORE the network call — the sync loop can advance note.witness_hex
  // past anchorHeight during any await, yielding a root that mismatches the historical anchor.
  const witnessSnap = new Map(notes.map(n => [n.nullifier, n.witness_hex]));
  const anchorTs = await client.getTreeState(anchorHeight);
  const networkRoot = wasmModule.tree_root_hex(anchorTs.orchardTree);

  interface ExtractedPath {
    position: number;
    path: { hash: string }[];
  }
  const extractFrom = (
    snap: Map<string, string | undefined>,
  ): { paths: ExtractedPath[]; mismatchNote: string | null } => {
    const paths: ExtractedPath[] = [];
    for (const note of notes) {
      const witnessHex = snap.get(note.nullifier);
      if (!witnessHex) {
        return { paths: [], mismatchNote: note.nullifier };
      }
      const rawPath = wasmModule!.witness_extract_path(witnessHex);
      const parsed = JSON.parse(rawPath as string) as {
        position: number;
        root_hex: string;
        path: { hash: string }[];
      };
      if (parsed.root_hex !== networkRoot) {
        return { paths: [], mismatchNote: note.nullifier };
      }
      paths.push({ position: parsed.position, path: parsed.path });
    }
    return { paths, mismatchNote: null };
  };

  let { paths, mismatchNote } = extractFrom(witnessSnap);

  if (mismatchNote !== null) {
    console.warn(
      `[zcash-worker] witness root mismatch (recovering via backfill): note=${mismatchNote.slice(0, 8)} ` +
        `(anchor=${anchorHeight}, frontierHeight=${runningFrontierHeight}, rebootstrapped=${rebootstrapped})`,
    );
    onProgress?.('witness corrupt — rebuilding', 'this takes ~3 min');
    for (const n of notes) {
      n.witness_hex = undefined;
      n.witness_tree_size = undefined;
    }
    // Persist the wipe before backfill so a reload mid-backfill doesn't re-expose the corrupt witness.
    await saveBatch(walletId, [], [], await getSyncHeight(walletId), undefined, notes);
    const { byNullifier } = await backfillWitnesses(
      client,
      walletId,
      notes,
      anchorHeight,
      onProgress,
    );
    // Use byNullifier (set from WASM result before any await inside backfillWitnesses) — note.witness_hex
    // may have been fast-forwarded past anchorHeight by the sync loop by the time backfill returns.
    const backfillSnap = new Map(
      [...byNullifier.entries()].map(
        ([nf, e]) => [nf, e.witness_hex] as [string, string | undefined],
      ),
    );
    ({ paths, mismatchNote } = extractFrom(backfillSnap));
    if (mismatchNote !== null) {
      console.error(
        `[zcash-worker] witness root mismatch after backfill: note=${mismatchNote.slice(0, 8)} ` +
          `(anchor=${anchorHeight})`,
      );
      throw syncError(
        'chain-recovery',
        `tree root mismatch after backfill at height ${anchorHeight}`,
      );
    }
  }

  console.log(`[zcash-worker] paths extracted for ${paths.length} notes, anchor=${networkRoot}`);
  return { anchorHex: networkRoot, paths };
};

const deriveAddress = (mnemonic: string, accountIndex: number): string => {
  if (!wasmModule) {
    throw new Error('wasm not initialized');
  }
  const keys = new wasmModule.WalletKeys(mnemonic);
  try {
    const raw = keys.get_receiving_address_at(accountIndex, true);
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
 * 52 bytes = compact note plaintext (ZIP-225 / NU5 Orchard):
 *   0x02 (version) || d (11) || v (8) || rseed (32)
 * The version byte is checked below — only 0x02 is supported until the
 * wallet learns about future variants (e.g. Orchard-ZSA at NU7).
 */
const ACTION_COMPACT_CT_LEN = 52;
const ORCHARD_NOTE_VERSION = 0x02;
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
        a.ciphertext.length >= ACTION_COMPACT_CT_LEN &&
        // Orchard compact-note version byte — refuse forward-compat plaintexts
        // (e.g. NU7/ZSA) until explicit support lands. Refusing is the safe
        // default; misinterpreting a different format would silently produce
        // bogus matches.
        a.ciphertext[0] === ORCHARD_NOTE_VERSION;

      if (!ok) {
        rejected += 1;
        continue;
      }
      if (valid.length >= MAX_MEMPOOL_ACTIONS) {
        // Hard stop — log once per snapshot, don't continue inspecting.
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

  // `txid` on pendingIncoming is misleading — pre-confirmation we only have
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
    console.log('[zcash-worker] mempool scan decrypt error:', err);
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

const runSync = async (
  walletId: string,
  mnemonic: string,
  serverUrl: string,
  startHeight?: number,
  ufvk?: string,
  backend: ZcashBackend = 'zidecar',
  mempoolWatch: 'off' | 'on' = 'off',
): Promise<void> => {
  // Single-source-of-truth gate (services/mempool-watch/strategy). Replaces
  // the four scattered re-implementations of the same `setting === 'on' &&
  // backend === 'zidecar'` check.
  const { isMempoolWatchEnabled } = await import(
    /* webpackMode: "eager" */ '../services/mempool-watch/strategy'
  );
  const watcherEnabled = isMempoolWatchEnabled(mempoolWatch, backend);
  if (!wasmModule) {
    throw new Error('wasm not initialized');
  }

  const state = getOrCreateWalletState(walletId);

  // abort existing sync if running — prevents concurrent loops
  if (state.syncing) {
    state.syncAbort = true;
    await waitForSyncStop(state);
  }

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
    state.keys = new wasmModule.WalletKeys(mnemonic);
  }
  await loadState(walletId);

  const syncedHeight = await getSyncHeight(walletId);
  // use whichever is higher — prevents re-scanning if chrome.storage was stale
  let currentHeight = Math.max(startHeight ?? 0, syncedHeight);

  const client = await makeZcashClient(serverUrl, backend);
  // Trustless proofs (Ligerito header proofs, NOMT nullifier proofs) only
  // exist on zidecar. On lightwalletd we accept the indexer's word — the
  // UI surfaces this trust delta via the "trusted" badge.
  const trustless = backend === 'zidecar';

  // track orchard commitment tree size for note position computation
  let orchardTreeSize = await getTreeSize(walletId);

  // running frontier for incremental per-note witness maintenance.
  // Invariant: frontier_tree_size(runningFrontier) === orchardTreeSize at start of batch.
  let runningFrontier: string = (await getTreeFrontier(walletId)) ?? '';
  let runningFrontierHeight =
    (await idbGet<{ value: number }>('meta', [walletId, 'orchardTreeFrontierHeight']))?.value ?? 0;

  // Bootstrap / repair the frontier if missing or stale relative to orchardTreeSize/currentHeight.
  // frontier_tree_size THROWS on a frontier it cannot parse, and this call sits
  // before the first sync-progress emit — an unparseable stored frontier (or a
  // wasm instance left poisoned by an earlier panic) therefore killed runSync
  // outright and the wallet never reported a height again. An unreadable
  // frontier is exactly the "stale" case the rebootstrap below already handles.
  let frontierSize = 0;
  if (runningFrontier) {
    try {
      frontierSize = Number(wasmModule.frontier_tree_size(runningFrontier));
    } catch (e) {
      console.warn('[zcash-worker] stored orchard frontier unreadable, rebootstrapping:', e);
      runningFrontier = '';
    }
  }
  const frontierValid =
    !!runningFrontier &&
    frontierSize === orchardTreeSize &&
    runningFrontierHeight === currentHeight;
  if (!frontierValid && currentHeight > 0) {
    try {
      const ts = await client.getTreeState(currentHeight);
      runningFrontier = ts.orchardTree;
      runningFrontierHeight = currentHeight;
      orchardTreeSize = Number(wasmModule.frontier_tree_size(runningFrontier));
      // frontier refetched => any in-memory ORCHARD witness may be stale
      // relative to the new orchard tree size. Drop orchard witnesses so spend
      // time triggers a clean backfill rather than silently advancing a gapped
      // witness. Only the orchard frontier was refetched here - the ironwood
      // frontier is validated separately just below - so ironwood witnesses
      // must be left intact (clearing them would strand the ironwood fast path
      // and force a full replay on the next ironwood send).
      for (const note of state.notes) {
        if (poolOf(note) === 'ironwood') {
          continue;
        }
        note.witness_hex = undefined;
        note.witness_tree_size = undefined;
      }
      console.log(
        `[zcash-worker] bootstrap frontier: height=${currentHeight} size=${orchardTreeSize} (dropped ${state.notes.length} stale witnesses)`,
      );
    } catch (e) {
      console.warn('[zcash-worker] failed to bootstrap frontier:', e);
    }
  }

  // ── NU6.3 ironwood pool tracking (mirrors the orchard tree/frontier
  // state above). Everything is guarded on the wasm blob exporting the
  // ironwood fns: on a pre-ironwood blob iwSupported is false, no extra
  // RPCs fire, and the whole section is inert. ──
  const iwSizeFn = wasmModule.frontier_tree_size_ironwood;
  const iwSupported = !!iwSizeFn && !!wasmModule.witness_sync_update_ironwood;
  let ironwoodTreeSize = await getIronwoodTreeSize(walletId);
  let ironwoodFrontier: string = (await getIronwoodTreeFrontier(walletId)) ?? '';
  let ironwoodFrontierHeight = await getIronwoodTreeFrontierHeight(walletId);
  if (iwSupported && iwSizeFn) {
    // Same unguarded-throw hazard as the orchard frontier above: this runs
    // before the first sync-progress emit, so a frontier the blob cannot read
    // silently ended the sync loop instead of triggering a rebootstrap.
    let iwFrontierSize = 0;
    if (ironwoodFrontier) {
      try {
        iwFrontierSize = Number(iwSizeFn(ironwoodFrontier));
      } catch (e) {
        console.warn('[zcash-worker] stored ironwood frontier unreadable, rebootstrapping:', e);
        ironwoodFrontier = '';
      }
    }
    const iwFrontierValid =
      !!ironwoodFrontier &&
      iwFrontierSize === ironwoodTreeSize &&
      ironwoodFrontierHeight === currentHeight;
    if (!iwFrontierValid && currentHeight > 0) {
      try {
        const ts = await client.getTreeState(currentHeight);
        // pre-NU6.3 servers/heights don't serve an ironwood tree; leave the
        // frontier empty so the batch loop skips ironwood witness work.
        if (ts.ironwoodTree) {
          ironwoodFrontier = ts.ironwoodTree;
          ironwoodFrontierHeight = currentHeight;
          ironwoodTreeSize = Number(iwSizeFn(ironwoodFrontier));
          // mirror orchard: refetched frontier invalidates stored witnesses
          for (const note of state.notes) {
            if (poolOf(note) === 'ironwood') {
              note.witness_hex = undefined;
              note.witness_tree_size = undefined;
            }
          }
          console.log(
            `[zcash-worker] bootstrap ironwood frontier: height=${currentHeight} size=${ironwoodTreeSize}`,
          );
        }
      } catch (e) {
        console.warn('[zcash-worker] failed to bootstrap ironwood frontier:', e);
      }
    }
  }

  console.log(
    `[zcash-worker] sync start wallet=${walletId} height=${currentHeight} treeSize=${orchardTreeSize} (idb=${syncedHeight}, requested=${startHeight ?? 'none'})`,
  );

  // initialize zync-core for verification
  try {
    await initZync();
  } catch (e) {
    console.warn('[zcash-worker] zync-core init failed, syncing without verification:', e);
  }

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

  state.syncing = true;
  state.syncAbort = false;
  let consecutiveErrors = 0;

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
  // once that budget is spent does the failure become visible — as
  // `chainRecovery`, never as the raw "tree root mismatch at height N".
  let rewindsThisRun = 0;
  // Never rewind below what this wallet was asked to scan from; there is
  // nothing to re-read there and it would only re-walk the birthday gap.
  const rewindFloor = Math.max(0, startHeight ?? 0);

  const rewindScanCursor = async (target: number): Promise<void> => {
    // Re-anchor both frontiers on the server's tree at the rewound height.
    // Witnesses built past that point are, by assumption, the thing that is
    // wrong, so they are dropped and rebuilt as the range is re-scanned.
    const ts = await client.getTreeState(target);
    runningFrontier = ts.orchardTree;
    runningFrontierHeight = target;
    orchardTreeSize = Number(wasmModule!.frontier_tree_size(runningFrontier));
    if (iwSupported && iwSizeFn) {
      if (ts.ironwoodTree) {
        ironwoodFrontier = ts.ironwoodTree;
        ironwoodFrontierHeight = target;
        ironwoodTreeSize = Number(iwSizeFn(ironwoodFrontier));
      } else {
        // pre-NU6.3 height: leave the pool inert until the loop reaches it
        ironwoodFrontier = '';
        ironwoodFrontierHeight = 0;
      }
    }

    const persisted = await loadState(walletId);
    for (const note of persisted.notes) {
      note.witness_hex = undefined;
      note.witness_tree_size = undefined;
    }
    await saveBatch(
      walletId,
      [],
      [],
      target,
      orchardTreeSize,
      persisted.notes,
      runningFrontier || undefined,
      runningFrontier ? runningFrontierHeight : undefined,
      iwSupported
        ? {
            treeSize: ironwoodTreeSize,
            frontier: ironwoodFrontier || undefined,
            frontierHeight: ironwoodFrontier ? ironwoodFrontierHeight : undefined,
          }
        : undefined,
    );

    // Ironwood witnesses live in their own store, so clearing the field on
    // the note record does not remove them — loadState() would re-attach the
    // stale witness we just decided not to trust. Drop the rows outright;
    // they are rebuilt from the re-anchored frontier as the range re-scans.
    try {
      const wdb = await getDb();
      const wtx = wdb.transaction('witnesses-ironwood', 'readwrite');
      const wstore = wtx.objectStore('witnesses-ironwood');
      const keys: IDBValidKey[] = await new Promise((resolve, reject) => {
        const req = wstore.index('byWallet').getAllKeys(walletId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      for (const key of keys) {
        wstore.delete(key);
      }
      await txComplete(wtx);
    } catch (e) {
      console.warn('[zcash-worker] rewind: could not clear ironwood witnesses:', e);
    }
    for (const note of state.notes) {
      note.witness_hex = undefined;
      note.witness_tree_size = undefined;
    }

    // Re-scanning a range re-pushes the notes it finds onto `state.notes`,
    // which is a plain array — leaving the already-known ones in place would
    // double-count them in the balance. Notes at or below the rewind point
    // are untouched; the ones above come back as the range is read again
    // (IndexedDB keeps its copy either way, keyed by nullifier).
    state.notes = state.notes.filter(n => n.height <= target);
  };

  // running actions commitment for integrity verification
  let actionsCommitment = await getActionsCommitment(walletId);
  // The actions commitment fold is only sound (and only equal to the server's
  // proven value) when this wallet's sync has covered the chain from genesis.
  // A birthday/import start (startHeight > 0) folds from a non-genesis seed,
  // so the verify step must be skipped for those wallets — see verifySyncProofs.
  const actionsGenesisAnchored = (startHeight ?? 0) === 0;
  // notes found since last header proof verification
  const pendingCmxs: Uint8Array[] = [];
  const pendingPositions: number[] = [];
  // Pool of real, on-chain (cmx, position) pairs observed while scanning, used
  // to pad the commitment-proof query with decoys that are indistinguishable
  // from our own notes. Drawn from the same block range we just walked, which
  // is where the real notes are — decoys sampled uniformly over all of chain
  // history would cluster in the wrong era and be separable on that alone.
  const decoyPool = new CommitmentReservoir();

  // mempool watcher: only spawned when explicitly opted in AND on a zidecar
  // endpoint (lightwalletd has no compact-action mempool RPC, so the watcher
  // would yield nothing). Lifecycle is owned by `state.mempoolAbort`/
  // `state.mempoolTask` so stop-sync / reset-sync can abort the watcher
  // directly, and waitForSyncStop can await the task before declaring the
  // wallet idle. This avoids a class of races where a fresh runSync raced
  // a still-alive watcher attached to the previous client.
  state.mempoolAbort?.abort();
  state.mempoolAbort = undefined;
  state.mempoolTask = undefined;
  if (watcherEnabled) {
    const [{ ZidecarClient: MempoolZidecarClient }, mempoolMod, strategyMod] = await Promise.all([
      import(/* webpackMode: "eager" */ '../state/keyring/zidecar-client'),
      import(/* webpackMode: "eager" */ '../services/mempool-watch/zidecar-mempool-fetcher'),
      import(/* webpackMode: "eager" */ '../services/mempool-watch/strategy'),
    ]);
    const mempoolClient = new MempoolZidecarClient(serverUrl);
    const base = mempoolMod.zidecarMempoolFetcher(mempoolClient);
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
        console.warn('[zcash-worker] mempool watcher exited:', err);
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

  // one cross-endpoint check per sync run - it is a sanity check, not a poll
  let crossCheckedThisRun = false;

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
    isAborted: () => state.syncAbort,
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

  while (!state.syncAbort) {
    try {
      const chainHeight = await getChainTip();

      // Cross-check the tip against an INDEPENDENT operator, once per
      // catch-up. The Ligerito header proof has no constraint system, so the
      // chain state this endpoint reports is not bound to consensus by
      // anything we can verify locally; cross-verification is the design's
      // own stated mitigation and had zero call sites. Advisory, not fatal:
      // a lagging or unreachable peer is far more common than an attack.
      if (currentHeight >= chainHeight && !crossCheckedThisRun) {
        crossCheckedThisRun = true;
        void crossCheckTip(serverUrl, chainHeight, async (peerUrl, timeoutMs) => {
          const peer = await makeZcashClient(peerUrl);
          return await Promise.race([
            peer.getTip(),
            new Promise<never>((_, rej) =>
              setTimeout(() => rej(new Error('peer tip timeout')), timeoutMs),
            ),
          ]);
        })
          .then(res => {
            if (res.disagreed) {
              console.error(`[zcash-worker] CROSS-CHECK DISAGREEMENT: ${res.detail}`);
              workerSelf.postMessage({
                type: 'cross-check-warning',
                network: 'zcash',
                walletId,
                payload: { detail: res.detail, peerUrl: res.peerUrl },
              });
            } else {
              console.log(`[zcash-worker] cross-check: ${res.detail}`);
            }
          })
          .catch(e => console.warn('[zcash-worker] cross-check failed:', e));
      }

      if (currentHeight >= chainHeight) {
        // caught up: cache the tree frontier at sync height for fast witness building.
        // Also cross-check local frontier vs network to detect reorg-induced corruption.
        try {
          const syncTs = await client.getTreeState(currentHeight);

          if (wasmModule && runningFrontier) {
            const localRoot = wasmModule.tree_root_hex(runningFrontier);
            const netRoot = wasmModule.tree_root_hex(syncTs.orchardTree);
            if (localRoot !== netRoot) {
              console.warn(
                `[zcash-worker] local frontier diverged from network at catch-up ${currentHeight} ` +
                  `(local=${localRoot.slice(0, 16)} net=${netRoot.slice(0, 16)}) — wiping witnesses`,
              );
              runningFrontier = syncTs.orchardTree;
              runningFrontierHeight = currentHeight;
              // Only the ORCHARD frontier diverged here (localRoot/netRoot are
              // orchard roots), so wipe only orchard witnesses. Ironwood rides a
              // separate frontier and is reconciled by its own cross-check just
              // below - clearing it here would spuriously drop good ironwood
              // witnesses on an orchard-only reorg (or on transient indexer lag)
              // and force the next send back onto the full replay.
              const wipeState = await loadState(walletId);
              for (const note of wipeState.notes) {
                if (poolOf(note) === 'ironwood') {
                  continue;
                }
                note.witness_hex = undefined;
                note.witness_tree_size = undefined;
              }
              for (const note of state.notes) {
                if (poolOf(note) === 'ironwood') {
                  continue;
                }
                note.witness_hex = undefined;
                note.witness_tree_size = undefined;
              }
              const wipeDb = await getDb();
              const wipeTx = wipeDb.transaction('notes', 'readwrite');
              const notesStore = wipeTx.objectStore('notes');
              for (const note of wipeState.notes) {
                // Only orchard witnesses were cleared above; ironwood notes are
                // unmodified. Skip them - writing an ironwood note through this
                // raw put (no witness-store split) would stamp its witness_hex
                // onto the orchard-style note record, which loadState would then
                // trust if the witnesses-ironwood row were ever deleted.
                if (poolOf(note) === 'ironwood') {
                  continue;
                }
                notesStore.put({ ...note, walletId });
              }
              await txComplete(wipeTx);
            }
          }

          // ── ironwood catch-up cross-check ──
          //
          // The batch loop keeps `ironwoodFrontier` in lockstep with the
          // per-note witnesses (each batch advances both through one
          // witness_sync_update_ironwood) and saveBatch already persisted that
          // aligned frontier. Blindly overwriting it here with the server's
          // tree - as this block used to - desyncs the frontier from the
          // witnesses: `ironwoodTreeSize` still reflects the maintained lineage,
          // so on the next sync-start the validity check (iwSize(frontier) ===
          // ironwoodTreeSize) fails, the wallet rebootstraps, and every stored
          // ironwood witness is wiped. The spend path then has to replay the
          // whole range to rebuild witnesses (~80s+ per send). Instead we mirror
          // the orchard cross-check: keep the maintained frontier when its root
          // matches the network (fast path stays available → ~instant witness
          // build), and only on a genuine divergence wipe witnesses and
          // re-anchor on the server tree. Runs before metaTx opens so the
          // optional wipe's own transaction can't race the meta write.
          let iwPersistFrontier = '';
          let iwPersistSize: number | undefined;
          if (iwSupported && syncTs.ironwoodTree && iwSizeFn) {
            const iwRootFn = wasmModule?.tree_root_hex_ironwood;
            let aligned = false;
            if (ironwoodFrontier && iwRootFn) {
              try {
                aligned = iwRootFn(ironwoodFrontier) === iwRootFn(syncTs.ironwoodTree);
              } catch (e) {
                console.warn(
                  '[zcash-worker] ironwood root cross-check threw, re-anchoring on server tree:',
                  e,
                );
              }
            }
            if (aligned) {
              // Maintained frontier is correct and aligned with the witnesses.
              // Advance the in-memory height to match what we persist here, so a
              // subsequent zero-ironwood-action batch's saveBatch re-persists a
              // consistent (frontier, height) pair rather than a stale height
              // that would fail the next sync-start validity check and force a
              // needless rebootstrap + witness wipe.
              ironwoodFrontierHeight = currentHeight;
              iwPersistFrontier = ironwoodFrontier;
              iwPersistSize = ironwoodTreeSize;
            } else if (ironwoodFrontier) {
              // diverged (reorg / drift): drop ironwood witnesses and re-anchor
              console.warn(
                `[zcash-worker] ironwood frontier diverged from network at catch-up ${currentHeight} — wiping witnesses`,
              );
              ironwoodFrontier = syncTs.ironwoodTree;
              ironwoodFrontierHeight = currentHeight;
              try {
                ironwoodTreeSize = Number(iwSizeFn(syncTs.ironwoodTree));
              } catch {
                /* keep prior size if the server tree is unreadable */
              }
              iwPersistFrontier = ironwoodFrontier;
              iwPersistSize = ironwoodTreeSize;
              // Ironwood witnesses live in the 'witnesses-ironwood' store, not on
              // the note record - clearing the note field alone is a no-op
              // because loadState() re-attaches the stale rows by nullifier on
              // the next run. Delete the rows outright, mirroring
              // rewindScanCursor; they are rebuilt from the re-anchored frontier.
              try {
                const wdb = await getDb();
                const wtx = wdb.transaction('witnesses-ironwood', 'readwrite');
                const wstore = wtx.objectStore('witnesses-ironwood');
                const keys: IDBValidKey[] = await new Promise((resolve, reject) => {
                  const req = wstore.index('byWallet').getAllKeys(walletId);
                  req.onsuccess = () => resolve(req.result);
                  req.onerror = () => reject(req.error);
                });
                for (const key of keys) {
                  wstore.delete(key);
                }
                await txComplete(wtx);
              } catch (e) {
                console.warn('[zcash-worker] catch-up: could not clear ironwood witnesses:', e);
              }
              for (const note of state.notes) {
                if (poolOf(note) === 'ironwood') {
                  note.witness_hex = undefined;
                  note.witness_tree_size = undefined;
                }
              }
            } else {
              // No maintained frontier yet (fresh wallet, or server only now
              // serves the NU6.3 tree): bootstrap from the server tree, and
              // adopt it in memory too so the rest of this run maintains
              // witnesses against it and saveBatch persists a consistent
              // (frontier, size, height) triple rather than a size with no
              // matching frontier.
              ironwoodFrontier = syncTs.ironwoodTree;
              ironwoodFrontierHeight = currentHeight;
              try {
                ironwoodTreeSize = Number(iwSizeFn(syncTs.ironwoodTree));
              } catch {
                /* leave size to the next bootstrap */
              }
              iwPersistFrontier = ironwoodFrontier;
              iwPersistSize = ironwoodTreeSize;
            }
          }

          const db = await getDb();
          const metaTx = db.transaction('meta', 'readwrite');
          metaTx
            .objectStore('meta')
            .put({ walletId, key: 'orchardTreeFrontier', value: syncTs.orchardTree });
          metaTx
            .objectStore('meta')
            .put({ walletId, key: 'orchardTreeFrontierHeight', value: currentHeight });
          // ironwood mirror - persist the frontier chosen by the cross-check
          // above, keeping frontier + size + witnesses mutually consistent so
          // the spend-time fast path stays available
          if (iwSupported && iwPersistFrontier) {
            metaTx
              .objectStore('meta')
              .put({ walletId, key: 'ironwoodTreeFrontier', value: iwPersistFrontier });
            metaTx
              .objectStore('meta')
              .put({ walletId, key: 'ironwoodTreeFrontierHeight', value: currentHeight });
            if (iwPersistSize !== undefined) {
              metaTx
                .objectStore('meta')
                .put({ walletId, key: 'ironwoodTreeSize', value: iwPersistSize });
            }
          }
          await txComplete(metaTx);
          console.log(`[zcash-worker] cached tree frontier at height ${currentHeight}`);
        } catch (e) {
          console.warn('[zcash-worker] failed to cache tree frontier:', e);
        }

        // Verify proofs whenever the backend supports it — NOT only when this
        // batch happened to discover a new orchard note.
        //
        // pendingCmxs is appended to only by the orchard discovery loop, so
        // gating on it meant the nullifier pass (all server-side spend
        // detection, both pools) ran only in a cycle right after an incoming
        // orchard note. A steady-state wallet never ran it; an ironwood-only
        // wallet never ran it at all. That is precisely the wallet that needs
        // it, since ironwood has no other spent oracle.
        //
        // The commitment-proof step inside still no-ops on an empty
        // pendingCmxs, so this only widens what was already conditional.
        if (trustless && zyncModule) {
          try {
            // seed failure must not silently drop the padding — if we cannot
            // load it we would send bare queries, which is the leak this is
            // here to close. skip the verification round instead.
            const decoySeed = await getDecoySeed(walletId);
            await verifySyncProofs(
              client,
              chainHeight,
              true,
              pendingCmxs,
              pendingPositions,
              state,
              actionsCommitment,
              actionsGenesisAnchored,
              decoySeed,
              decoyPool.snapshot(),
            );
          } catch (e) {
            // Fail CLOSED only on checks that are actually sound.
            //
            // Two different kinds of failure land here and they are NOT the
            // same thing:
            //
            //   SOUND — comparisons taken at ONE instant, where a mismatch
            //   means the server contradicted itself: a proof that does not
            //   bind to the batch root we checked, a proof for something we
            //   never asked about, a duplicate, or a wrong count. These are
            //   real evidence and must refuse.
            //
            //   RACY — comparisons between a SNAPSHOT and a LIVE value. The
            //   NOMT tree is mutable and single-versioned: proofs are made
            //   against nomt.root() at request time while the ligerito header
            //   proof carries a root from whenever it was last generated, and
            //   the server writes continuously. The same applies to the
            //   actions commitment, which folds stored per-block roots the
            //   indexer is still filling in. A divergence there is expected.
            //
            // My earlier classifier matched /mismatch|tampered/ and escalated
            // BOTH, which bricked sync within minutes of a healthy server
            // doing ordinary work, under a message accusing it of tampering.
            // A false alarm on an integrity check is worse than none: it
            // teaches users to click past the one warning that should stop
            // them.
            const detail = e instanceof Error ? e.message : String(e);
            const tampering =
              /proof root mismatch|unrequested|duplicate|count mismatch|proof invalid/i.test(
                detail,
              );
            if (tampering) {
              console.error('[zcash-worker] INTEGRITY FAILURE, refusing batch:', e);
              pendingCmxs.length = 0;
              pendingPositions.length = 0;
              throw syncError(
                'consensus',
                `server integrity check failed: ${detail}. ` +
                  `refusing to trust this endpoint's data - switch node or retry`,
              );
            }
            console.warn('[zcash-worker] proof verification unavailable, will retry:', e);
          }
          pendingCmxs.length = 0;
          pendingPositions.length = 0;
        }

        // mempool scanning lives in the separate watcher task spawned above
        // when mempoolWatch === 'on'. when off (default), no mempool calls.

        workerSelf.postMessage({
          type: 'sync-progress',
          id: '',
          network: 'zcash',
          walletId,
          payload: { currentHeight, chainHeight, notesFound: state.notes.length, blocksScanned: 0 },
        });
        await sleepUnlessAborted(state, 10000);
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
        // aborted, or nothing left below the tip — the loop condition and the
        // caught-up branch above handle both on the next pass
        continue;
      }
      const { blocks, end: endHeight } = batch;
      console.log(`[zcash-worker] blocks ${batch.start}..${endHeight}`);

      // Guard: lightwalletd may race between getTip() and block indexing — if the
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
        const backoff = Math.min(30000, 1000 * Math.pow(2, consecutiveErrors - 1));
        await sleepUnlessAborted(state, backoff);
        if (consecutiveErrors >= 10) {
          console.error('[zcash-worker] too many errors, stopping sync');
          break;
        }
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
                commitBuf.set(a.cmx, aoff);
                aoff += 32;
                commitBuf.set(a.nullifier, aoff);
                aoff += 32;
                commitBuf.set(a.ephemeralKey, aoff);
                aoff += 32;
              }
              const actionsRoot = zyncModule['compute_actions_root'](
                commitBuf.subarray(0, needed),
              ) as string;
              actionsCommitment = zyncModule['update_actions_commitment'](
                actionsCommitment,
                actionsRoot,
                block.height,
              ) as string;
            } else {
              actionsCommitment = zyncModule['update_actions_commitment'](
                actionsCommitment,
                '0'.repeat(64),
                block.height,
              ) as string;
            }
          }

          for (const a of block.actions) {
            // absolute commitment-tree position of this action, computed the
            // same way as for our own notes below (batch base + index within
            // the batch). offering every observed action to the reservoir is
            // what gives the commitment-proof query a supply of decoys that
            // are genuine tree entries.
            if (a.cmx.length === 32) {
              decoyPool.offer(new Uint8Array(a.cmx), orchardTreeSize + (off - 4) / ACTION_SIZE);
            }
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
          console.error('[zcash-worker] scan_actions_parallel crashed:', err);
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

          // track for verification
          pendingCmxs.push(hexDecode(note.cmx));
          pendingPositions.push(position);
        }

        // detect spent notes: a nullifier in this block matches an owned note.
        // Two cases, handled in one pass:
        //  1. a spend seen for the first time here;
        //  2. a spend we already marked locally at broadcast (its nullifier is
        //     already in spentNullifiers) whose CONFIRMATION HEIGHT we never
        //     recorded — because this loop used to skip already-marked notes.
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

      // advance per-note witnesses over this batch's actions. Runs *before*
      // orchardTreeSize is advanced so positions align with the pre-batch
      // frontier. Best-effort: on failure we keep the batch but leave
      // runningFrontier unchanged, forcing rebootstrap next batch.
      const witnessUpdatedNotes = new Map<string, DecryptedNote>();
      if (wasmModule && runningFrontier && actionCount > 0) {
        const compact: { height: number; actions: { cmx_hex: string }[] }[] = [];
        for (const block of blocks) {
          compact.push({
            height: block.height,
            actions: block.actions.map(a => ({ cmx_hex: hexEncode(a.cmx) })),
          });
        }

        const newNullifiers = new Set(newNotes.map(n => n.nullifier));
        const existingInput: { id: string; witness_hex: string }[] = [];
        for (const note of state.notes) {
          // ORCHARD maintenance only. Without this guard, ironwood notes (which
          // now carry a persisted witness_hex) leak into witness_sync_update: the
          // orchard tree advances them over orchard actions - corrupting the
          // witness - and the update loop below stamps them with the orchard
          // newTreeSize (~50M), which then fails the ironwood fast-path size
          // check (frontier ~62k) and forces a full replay every send. The
          // ironwood pool has its own maintenance pass with the mirror filter.
          if (poolOf(note) === 'ironwood') {
            continue;
          }
          if (state.spentNullifiers.has(note.nullifier)) {
            continue;
          }
          if (newNullifiers.has(note.nullifier)) {
            continue;
          }
          if (!note.witness_hex) {
            continue;
          }
          existingInput.push({ id: note.nullifier, witness_hex: note.witness_hex });
        }
        const seedInput = newNotes.map(n => ({ id: n.nullifier, position: n.position }));

        try {
          const raw = wasmModule.witness_sync_update(
            runningFrontier,
            JSON.stringify(compact),
            JSON.stringify(existingInput),
            JSON.stringify(seedInput),
          );
          const result = JSON.parse(raw as string) as {
            end_frontier_hex: string;
            anchor_hex: string;
            witnesses: { id: string; position: number; witness_hex: string }[];
          };

          const witnessById = new Map(result.witnesses.map(w => [w.id, w]));
          const newTreeSize = orchardTreeSize + actionCount;
          for (const note of state.notes) {
            if (state.spentNullifiers.has(note.nullifier)) {
              continue;
            }
            const upd = witnessById.get(note.nullifier);
            if (!upd) {
              continue;
            }
            note.witness_hex = upd.witness_hex;
            note.witness_tree_size = newTreeSize;
            if (!newNullifiers.has(note.nullifier)) {
              witnessUpdatedNotes.set(note.nullifier, note);
            }
          }
          for (const note of newNotes) {
            const upd = witnessById.get(note.nullifier);
            if (upd) {
              note.witness_hex = upd.witness_hex;
              note.witness_tree_size = newTreeSize;
            }
          }

          runningFrontier = result.end_frontier_hex;
          runningFrontierHeight = endHeight;
        } catch (e) {
          console.error('[zcash-worker] witness_sync_update failed:', e);
          // invalidate frontier so next batch rebootstraps
          runningFrontier = '';
        }
      }

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
          console.error('[zcash-worker] scan_actions_ironwood_parallel crashed:', err);
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

        // advance ironwood witnesses over this batch (mirror of the orchard
        // witness_sync_update block; runs against the pre-batch frontier)
        const iwSync = wasmModule.witness_sync_update_ironwood;
        if (iwSync && ironwoodFrontier) {
          const iwCompact = blocks.map(b => ({
            height: b.height,
            actions: (b.ironwoodActions ?? []).map(a => ({ cmx_hex: hexEncode(a.cmx) })),
          }));
          const iwNewNullifiers = new Set(newIronwoodNotes.map(n => n.nullifier));
          const iwExisting: { id: string; witness_hex: string }[] = [];
          for (const note of state.notes) {
            if (poolOf(note) !== 'ironwood') {
              continue;
            }
            if (state.spentNullifiers.has(note.nullifier)) {
              continue;
            }
            if (iwNewNullifiers.has(note.nullifier)) {
              continue;
            }
            if (!note.witness_hex) {
              continue;
            }
            iwExisting.push({ id: note.nullifier, witness_hex: note.witness_hex });
          }
          const iwSeed = newIronwoodNotes.map(n => ({ id: n.nullifier, position: n.position }));
          try {
            const raw = iwSync(
              ironwoodFrontier,
              JSON.stringify(iwCompact),
              JSON.stringify(iwExisting),
              JSON.stringify(iwSeed),
            );
            const result = JSON.parse(raw as string) as {
              end_frontier_hex: string;
              witnesses: { id: string; position: number; witness_hex: string }[];
            };
            const iwById = new Map(result.witnesses.map(w => [w.id, w]));
            const newIwTreeSize = ironwoodTreeSize + ironwoodActionCount;
            for (const note of state.notes) {
              if (poolOf(note) !== 'ironwood' || state.spentNullifiers.has(note.nullifier)) {
                continue;
              }
              const upd = iwById.get(note.nullifier);
              if (!upd) {
                continue;
              }
              note.witness_hex = upd.witness_hex;
              note.witness_tree_size = newIwTreeSize;
              if (!iwNewNullifiers.has(note.nullifier)) {
                ironwoodUpdatedNotes.set(note.nullifier, note);
              }
            }
            ironwoodFrontier = result.end_frontier_hex;
            ironwoodFrontierHeight = endHeight;
          } catch (e) {
            console.error('[zcash-worker] witness_sync_update_ironwood failed:', e);
            // invalidate frontier so the next runSync rebootstraps
            ironwoodFrontier = '';
          }
        }
      }

      // advance ironwood tree size by this batch's ironwood actions (kept
      // even when the blob can't scan them, so the count stays monotonic)
      ironwoodTreeSize += ironwoodActionCount;

      // merge witness-updated notes with spent-updated notes (dedupe by nullifier)
      const updatedDedup = new Map<string, DecryptedNote>();
      for (const n of spentUpdatedNotes) {
        updatedDedup.set(n.nullifier, n);
      }
      for (const [k, n] of witnessUpdatedNotes) {
        if (!updatedDedup.has(k)) {
          updatedDedup.set(k, n);
        }
      }
      for (const [k, n] of ironwoodUpdatedNotes) {
        if (!updatedDedup.has(k)) {
          updatedDedup.set(k, n);
        }
      }
      const combinedUpdated = Array.from(updatedDedup.values());

      // single batched db write for entire batch
      currentHeight = endHeight;
      await saveBatch(
        walletId,
        newIronwoodNotes.length > 0 ? [...newNotes, ...newIronwoodNotes] : newNotes,
        newSpent,
        currentHeight,
        orchardTreeSize,
        combinedUpdated.length > 0 ? combinedUpdated : undefined,
        runningFrontier || undefined,
        runningFrontier ? runningFrontierHeight : undefined,
        // ironwood meta only once the blob supports the pool - keeps the
        // pre-ironwood write pattern byte-identical
        iwSupported
          ? {
              treeSize: ironwoodTreeSize,
              frontier: ironwoodFrontier || undefined,
              frontierHeight: ironwoodFrontier ? ironwoodFrontierHeight : undefined,
            }
          : undefined,
      );

      // periodic frontier snapshot for privacy-safe witness building.
      // Also cross-check local frontier vs network to detect reorg-induced corruption.
      if (currentHeight % FRONTIER_SNAPSHOT_INTERVAL < batchSize) {
        try {
          const snapshotTs = await client.getTreeState(currentHeight);
          await saveFrontierSnapshot(walletId, currentHeight, snapshotTs.orchardTree);

          if (wasmModule && runningFrontier) {
            const localRoot = wasmModule.tree_root_hex(runningFrontier);
            const netRoot = wasmModule.tree_root_hex(snapshotTs.orchardTree);
            if (localRoot !== netRoot) {
              console.warn(
                `[zcash-worker] local frontier diverged from network at snapshot ${currentHeight} ` +
                  `(local=${localRoot.slice(0, 16)} net=${netRoot.slice(0, 16)}) — likely reorg; resetting witnesses`,
              );
              runningFrontier = snapshotTs.orchardTree;
              runningFrontierHeight = currentHeight;
              // Orchard-only divergence (see catch-up block): preserve ironwood
              // witnesses, which ride a separate frontier and are reconciled by
              // the ironwood catch-up cross-check / spend-time drift check.
              const wipeState = await loadState(walletId);
              for (const note of wipeState.notes) {
                if (poolOf(note) === 'ironwood') {
                  continue;
                }
                note.witness_hex = undefined;
                note.witness_tree_size = undefined;
              }
              for (const note of state.notes) {
                if (poolOf(note) === 'ironwood') {
                  continue;
                }
                note.witness_hex = undefined;
                note.witness_tree_size = undefined;
              }
              const wipeDb = await getDb();
              const wipeTx = wipeDb.transaction('notes', 'readwrite');
              const notesStore = wipeTx.objectStore('notes');
              for (const note of wipeState.notes) {
                // orchard-only wipe: skip ironwood so its witness_hex is not
                // written onto the note record (see the catch-up wipe note).
                if (poolOf(note) === 'ironwood') {
                  continue;
                }
                notesStore.put({ ...note, walletId });
              }
              await txComplete(wipeTx);
            }
          }
        } catch {
          /* best-effort */
        }
      }

      // persist actions commitment
      if (zyncModule) {
        await saveActionsCommitment(walletId, actionsCommitment);
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
    } catch (err) {
      // Intentional stop (wallet switch, endpoint change, shutdown): in-flight
      // RPCs can fail once teardown begins. That's not a sync failure - no
      // error count, no sync-error to the UI. Mirrors the abort handling in
      // packages/query block-processor retry.
      if (state.syncAbort) {
        dropPipeline();
        break;
      }

      // Anything that lands here invalidates the look-ahead: the cursor is
      // about to move (rewind) or the endpoint is unhealthy. Re-fetching a few
      // batches is free; applying a batch fetched before a rewind is not.
      dropPipeline();

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
            await rewindScanCursor(target);
            currentHeight = target;
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
            console.warn('[zcash-worker] rewind failed:', rewindErr);
          }
        }
      }

      consecutiveErrors++;
      console.error(`[zcash-worker] sync error (${consecutiveErrors}):`, err);
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
            message: err instanceof Error ? err.message : String(err),
            ...(code ? { code } : {}),
          },
        });
      }
      // back off exponentially, max 30s
      const backoff = Math.min(30000, 2000 * Math.pow(2, consecutiveErrors - 1));
      await sleepUnlessAborted(state, backoff);
      // after 10 consecutive errors, give up
      if (consecutiveErrors >= 10) {
        console.error('[zcash-worker] too many errors, stopping sync');
        break;
      }
    }
  }

  // Nothing in flight may be applied after the loop ends, however it ended.
  prefetcher.reset();
  state.syncing = false;
  // mempool watcher lifecycle is owned by state.mempoolAbort; abort here
  // so the watcher tears down even if the sync loop exits via a path that
  // skips waitForSyncStop. Safe to call repeatedly.
  state.mempoolAbort?.abort();
  console.log(`[zcash-worker] sync stopped wallet=${walletId}`);
  // The loop can exit on its own (10 consecutive errors) with nobody having
  // sent 'stop-sync'. Without this the main thread's syncingWallets set keeps
  // the wallet listed as syncing forever and the auto-sync hook never
  // restarts it — a wallet that has silently stopped scanning looks exactly
  // like one that is up to date.
  workerSelf.postMessage({ type: 'sync-stopped', id: '', network: 'zcash', walletId });
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

/** Spendable balance per shielded pool (zatoshi). NU6.3 dual-pool. */
interface PoolBalances {
  orchard: bigint;
  ironwood: bigint;
  /** orchard + ironwood — the same total getBalance() returns */
  total: bigint;
  /**
   * Pending shielded change: value our own broadcast-but-unconfirmed sends will
   * return to us once they mine (upstream change_pending_confirmation). The
   * input notes are marked spent locally at broadcast, which drops `total` to
   * zero while the change note has not mined yet — correct, but it made the
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
  // wallet except the fee — the value moves to the wallet's OWN ironwood pool
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
        // A pending migrate's value is not leaving the wallet — it is moving
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
    console.warn('[zcash-worker] failed to compute pending change:', e);
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

// ── message handler ──

workerSelf.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const { type, id, walletId, payload } = e.data;

  // Every fee-bearing operation carries the user's multiplier (settings →
  // fees); no chrome.storage in a dedicated worker, so the caller injects it.
  if (payload && typeof payload === 'object' && 'feeMultiplier' in payload) {
    setFeeMultiplier((payload as { feeMultiplier?: unknown }).feeMultiplier);
  }

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
        workerSelf.postMessage({
          type: 'address',
          id,
          network: 'zcash',
          walletId,
          payload: address,
        });
        return;
      }

      case 'sync': {
        if (!walletId) {
          throw new Error('walletId required');
        }
        await initWasm();
        const { mnemonic, serverUrl, startHeight, ufvk, backend, mempoolWatch } = payload as {
          mnemonic: string;
          serverUrl: string;
          startHeight?: number;
          ufvk?: string;
          backend?: ZcashBackend;
          mempoolWatch?: 'off' | 'on';
        };
        // Defensive: validate enum values from cross-context payload.
        // Silent coercion of an unknown backend to 'zidecar' is a privacy
        // regression — a user configured to talk to a third-party
        // lightwalletd would end up hitting the trustless code path (with
        // its zidecar-only RPCs) and either fail loudly OR, worse, succeed
        // against a server that happens to implement those endpoints with
        // a different trust model. Reject unknown explicitly.
        if (backend !== undefined && backend !== 'zidecar' && backend !== 'lightwalletd') {
          throw new Error(`unknown zcash backend in sync payload: ${String(backend)}`);
        }
        if (mempoolWatch !== undefined && mempoolWatch !== 'off' && mempoolWatch !== 'on') {
          throw new Error(`unknown mempoolWatch in sync payload: ${String(mempoolWatch)}`);
        }
        const effectiveBackend: ZcashBackend = backend ?? 'zidecar';
        // Gate goes through the single helper so all layers see the same answer.
        const { isMempoolWatchEnabled } = await import(
          /* webpackMode: "eager" */ '../services/mempool-watch/strategy'
        );
        const effectiveMempoolWatch: 'off' | 'on' = isMempoolWatchEnabled(
          mempoolWatch,
          effectiveBackend,
        )
          ? 'on'
          : 'off';
        // Seed the registry so subsequent operations (send, history, memo
        // fetch) construct the right client without re-receiving backend.
        registerBackend(serverUrl, effectiveBackend);
        runSync(
          walletId,
          mnemonic,
          serverUrl,
          startHeight,
          ufvk,
          effectiveBackend,
          effectiveMempoolWatch,
        ).catch(err => {
          // A rejection here is everything that happens OUTSIDE the batch
          // loop's own try/catch: opening IndexedDB, loading state, deriving
          // keys, sizing the stored frontier. Those all run BEFORE the first
          // sync-progress is emitted, so the popup never learns a height and
          // renders "scanning notes 0%" forever.
          //
          // 'sync-started' has already been posted by the time we get here, so
          // network-worker has this wallet in syncingWallets and the auto-sync
          // hook's isWalletSyncing() guard will refuse to ever start it again.
          // Logging to a console nobody has open made that permanent and
          // invisible. Report the failure and retract the started claim so the
          // UI can surface it and a retry is possible.
          console.error('[zcash-worker] runSync fatal:', err);
          workerSelf.postMessage({
            type: 'sync-error',
            id: '',
            network: 'zcash',
            walletId,
            payload: {
              message: err instanceof Error ? err.message : String(err),
              ...(syncErrorCodeOf(err) ? { code: syncErrorCodeOf(err) } : {}),
            },
          });
          workerSelf.postMessage({ type: 'sync-stopped', id: '', network: 'zcash', walletId });
        });
        workerSelf.postMessage({ type: 'sync-started', id, network: 'zcash', walletId });
        return;
      }

      case 'stop-sync': {
        if (!walletId) {
          throw new Error('walletId required');
        }
        const state = walletStates.get(walletId);
        if (state) {
          state.syncAbort = true;
          // Abort the mempool watcher directly. Without this, the watcher
          // keeps polling for up to one full sync-loop backoff (≈30s) after
          // stop-sync returns.
          state.mempoolAbort?.abort();
        }
        workerSelf.postMessage({ type: 'sync-stopped', id, network: 'zcash', walletId });
        return;
      }

      case 'reset-sync': {
        if (!walletId) {
          throw new Error('walletId required');
        }
        const resetState = walletStates.get(walletId);
        if (resetState) {
          resetState.syncAbort = true;
          resetState.mempoolAbort?.abort();
          if (resetState.keys) {
            resetState.keys.free();
            resetState.keys = null;
          }
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
        // know cheaply — get-history fetches transparent history over the
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
          sent: pendSent,
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
        const state = walletStates.get(walletId);
        if (state?.syncing) {
          state.syncAbort = true;
          await waitForSyncStop(state);
        }
        if (state?.keys) {
          state.keys.free();
          state.keys = null;
        }
        await deleteWallet(walletId);
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
        const unspent = syncState.notes.filter(n => !syncState.spentNullifiers.has(n.nullifier));
        if (unspent.length === 0) {
          workerSelf.postMessage({
            type: 'note-sync-encoded',
            id,
            network: 'zcash',
            walletId,
            payload: { frames: [], noteCount: 0, balance: '0', cborBytes: 0 },
          });
          return;
        }

        // anchor where the witnesses are rooted (cached frontier), not at the
        // newest note's height — otherwise the cross-check root won't match.
        const anchorHeight = await resolveAnchorHeight(
          walletId,
          Math.max(...unspent.map(n => n.height)),
        );

        // build merkle witnesses — use the backend-aware client (zidecar/
        // lightwalletd) instead of a hardcoded zidecar REST shape, so export
        // works on any backend the wallet synced against.
        const client = await makeZcashClient(syncServerUrl);
        const witnessResult = await buildWitnesses(client, walletId, unspent, anchorHeight);

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
        // devices). The anchor was already cross-checked against zidecar's
        // tree-state during witness building, so it isn't arbitrary.
        let attestationHex: string | null = null;
        if (lookupBackend(syncServerUrl) === 'zidecar') {
          try {
            const { ZidecarClient } = await import(
              /* webpackMode: "eager" */ '../state/keyring/zidecar-client'
            );
            const att = await new ZidecarClient(syncServerUrl).signAnchor(
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
          }
        }

        // encode to CBOR via WASM
        const cborBytes = wasmModule.encode_notes_bundle(
          notesJson,
          merkleJson,
          anchorHeight,
          isMainnet,
          attestationHex,
        );

        // encode to QR frames via zoda transport (verified erasure coding).
        // auto-size k/n to the payload so each hex-encoded `zt:` frame fits a
        // scannable QR — a fixed 12-of-16 overflows the QR for large note sets
        // (each shard ~payload/k, hex-doubled). 300 raw bytes/frame ≈ 0.6KB QR
        // string (~v15 at ECC-L) keeps each frame light enough to lock fast on
        // the zigner camera (denser frames scan slowly); 30% parity so the
        // scanner can miss frames in the cycling display.
        const framesJson = wasmModule.zt_encode_frames_auto(cborBytes, 'zcash-notes', 300, 30);
        const urFrames = JSON.parse(framesJson) as string[];

        // compute balance
        let balance = 0n;
        for (const n of unspent) {
          balance += BigInt(n.value);
        }

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

      case 'get-transparent-history': {
        const { serverUrl, tAddresses } = payload as { serverUrl: string; tAddresses: string[] };
        if (!tAddresses?.length) {
          workerSelf.postMessage({
            type: 'transparent-history',
            id,
            network: 'zcash',
            payload: [],
          });
          return;
        }

        const tClient = await makeZcashClient(serverUrl);

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
        const history: { txid: string; height: number; received: string }[] = [];

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
              history.push(r.value);
            }
          }
        }

        workerSelf.postMessage({
          type: 'transparent-history',
          id,
          network: 'zcash',
          payload: history,
        });
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
            const tClient = await makeZcashClient(histServerUrl);

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
            console.warn('[zcash-worker] get-history: transparent history failed:', e);
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
              // which the NOMT nullifier ORACLE never sets — it adds the
              // nullifier to spentNullifiers with no txid. So any spend
              // detected by proof rather than by a scan-time nullifier match
              // lands here (classic case: the same seed used on another device,
              // then restored).
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
        // is only correct when there genuinely was no change — and we cannot tell
        // the two apart until the block holding the change has been scanned.
        // (Worse for a turnstile migration, where orchard inputs produce ironwood
        // change that a separate scan pass discovers later still.)
        //
        // So: report it as an upper bound unless we have actually walked the
        // block that spent it and found no change coming back. Where a local
        // record exists, reconciliation replaces this figure with the exact one
        // anyway — this is the honest fallback for sends we did not record.
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
        // coming back — not income.
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
          // best effort — a missing record must not break history
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
        // Reconciliation — not a naive merge. The earlier merge skipped any
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
              const lookupClient = await makeZcashClient(histServerUrl);
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
              console.warn('[zcash-worker] get-history: pending-send height lookup failed:', e);
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
          console.warn('[zcash-worker] could not read local sent records:', e);
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
        const db = await getDb();
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
        for (const note of memoNotes) {
          if (!note.spent_by_txid || processedTxids.has(note.spent_by_txid)) {
            continue;
          }
          const h = note.spent_at_height || txidToHeight.get(note.spent_by_txid);
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

        const memoClient = await makeZcashClient(memoServerUrl);
        const { height: currentTip } = await memoClient.getTip();

        // estimate block time from tip (no per-height GetBlock calls — preserves bucket privacy)
        const tipTimeMs = Date.now();
        const estimateBlockTimeMs = (h: number): number => tipTimeMs + (h - currentTip) * 75000;

        // Any non-'fast' value (including legacy 'paranoid' from older
        // storage) falls back to 'private'. 'paranoid' was removed for
        // decision-surface simplification; users get the strong default.
        const rawStrategy = (payload as { strategy?: string }).strategy;
        const strategyName: MemoSyncStrategy = rawStrategy === 'fast' ? 'fast' : 'private';
        const base = blockRangeFetcher(memoClient, {
          maxHeight: currentTip,
          bucketSize: MEMO_BUCKET_SIZE,
        });
        const bucketStore = idbBucketStore({ open: () => Promise.resolve(db) });
        const fetcher = buildStrategy(strategyName, {
          base,
          store: bucketStore,
          alwaysFetch: b => spentBuckets.has(b),
        });

        // ── consume the async iterable; decode memos from each yielded bucket ──
        // progress: the base fetcher knows the post-cache, post-decoy total and
        // calls ctx.onProgress with accurate (completed, total) — we just
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
          if (n.spent_by_txid) {
            allScanned.add(n.spent_by_txid);
          }
        }
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('memo-cache', 'readwrite');
          const req = tx.objectStore('memo-cache').put([...allScanned], scannedKey);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });

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
          mnemonic?: string;
          ufvk?: string;
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
        const sendClient = await makeZcashClient(sendPayload.serverUrl);

        emitProgress('fetching chain tip');
        const sendTip = await sendClient.getTip();

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

        // build merkle witnesses in the active pool (ironwood delegates to the
        // ironwood witness/anchor path inside buildWitnesses)
        const anchorHeight = await resolveAnchorHeight(walletId, sendTip.height);
        emitProgress('building merkle witnesses', `anchor=${anchorHeight} (tip=${sendTip.height})`);
        const witnessStart = performance.now();

        const { anchorHex, paths } = await buildWitnesses(
          sendClient,
          walletId,
          selected,
          anchorHeight,
          sendActivePool,
          emitProgress,
        );

        const witnessDuration = ((performance.now() - witnessStart) / 1000).toFixed(1);
        emitProgress('witnesses built', `${witnessDuration}s`);

        // live consensus branch id for the ZIP-244 sighash + v5 header (NU6.3-safe).
        // Shared by both the mnemonic (signed) and zigner (unsigned) build paths below.
        const sendBranchIdHex = await fetchBranchIdHex(sendClient);

        if (sendPayload.mnemonic) {
          // ── NU6.3 IRONWOOD hot send ─────────────────────────────────────
          // Post-activation shielded spend path. Fail-closed branch-id guard
          // (copied verbatim from send-turnstile-migration), then build + prove
          // + SIGN the V6 ironwood tx inside the wasm with the seed phrase and
          // broadcast the returned tx hex directly. No PCZT is produced.
          if (sendActivePool === 'ironwood') {
            emitProgress('checking NU6.3 activation');
            const iwLightdInfo = await sendClient.getLightdInfo();
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
            if (iwReportedBranchHex !== NU63_CONSENSUS_BRANCH_ID_HEX) {
              throw new Error(
                `endpoint consensus branch id 0x${iwReportedBranchHex} does not match NU6.3 ` +
                  `(0x${NU63_CONSENSUS_BRANCH_ID_HEX}); refusing to build ironwood send`,
              );
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
              // arg order matches the build_signed_ironwood_send producer:
              // [seed, ironwood_notes_json, recipient, amount, fee,
              //  ironwood_anchor_hex, ironwood_merkle_paths_json, account_index,
              //  target_height, expected_branch_id, mainnet, memo_hex].
              // expected_branch_id is the live value validated above; the
              // producer refuses to build unless the branch id it binds equals it.
              iwTxHex = (await proveViaOffscreen({
                fn: 'build_signed_ironwood_send',
                args: [
                  sendPayload.mnemonic,
                  JSON.stringify(iwNotesJson),
                  sendPayload.recipient,
                  amountZat.toString(),
                  fee.toString(),
                  anchorHex,
                  JSON.stringify(iwPathsForWasm),
                  sendPayload.accountIndex,
                  sendTip.height,
                  NU63_CONSENSUS_BRANCH_ID,
                  sendPayload.mainnet,
                  memoHex,
                ],
              })) as string;
            } catch (e) {
              // do NOT log the seed or the caught args; message only. The
              // message is what tells us WHY the build failed (bad anchor,
              // path/position mismatch, diversifier reconstruction, an offscreen
              // RPC drop) - logging it without a reason was undebuggable.
              console.error(
                '[zcash-worker] build_signed_ironwood_send failed:',
                e instanceof Error ? e.message : String(e),
              );
              throw e;
            } finally {
              clearInterval(iwProvingTicker);
            }

            emitProgress('ironwood tx signed', `${iwTxHex.length / 2} bytes`);
            emitProgress('broadcasting transaction');
            const iwTxData = hexDecode(iwTxHex);
            const iwBroadcastClient = await makeZcashClient(sendPayload.serverUrl);
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
            txHex = (await proveViaOffscreen({
              fn: 'build_signed_spend',
              args: [
                sendPayload.mnemonic,
                notesJson,
                sendPayload.recipient,
                amountZat.toString(),
                fee.toString(),
                anchorHex,
                merklePathsForWasm,
                sendPayload.accountIndex,
                sendPayload.mainnet,
                memoHex,
                sendBranchIdHex,
              ],
            })) as string;
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
          const broadcastClient = await makeZcashClient(sendPayload.serverUrl);
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

        // build unsigned transaction with real Halo 2 proofs (parallel via offscreen)
        const unsignedResult = await proveViaOffscreen({
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

        const completeClient = await makeZcashClient(completePayload.serverUrl);
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
      // signing, and recomputes the sighash from the PCZT contents — so
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
        };
        if (!sendPayload.ufvk) {
          throw new Error('UFVK required for PCZT build');
        }

        // Mirror send-tx note selection / witness build. Inlined rather than
        // factored out because send-tx's variant has interleaved emitProgress
        // calls and a fee-recompute loop that we want to keep verbatim — and
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
        const sendClient = await makeZcashClient(sendPayload.serverUrl);
        emitProgress('fetching chain tip');
        const sendTip = await sendClient.getTip();
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
        );
        const totalIn = selected.reduce((sum, n) => sum + BigInt(n.value), 0n);
        const hasChange =
          totalIn > amountZat + computeFee(selected.length, nZOutputs, nTOutputs, true);
        const fee = computeFee(selected.length, nZOutputs, nTOutputs, hasChange);
        if (totalIn < amountZat + fee) {
          throw new Error(`insufficient funds: have ${totalIn} zat, need ${amountZat + fee} zat`);
        }
        emitProgress('notes selected', `${selected.length} ${pcztPool} notes, fee=${fee}`);

        // Anchor at the cached frontier height (where our witnesses are
        // rooted); target_height stays at the live tip for branch_id/expiry.
        // buildWitnesses delegates to the ironwood witness/anchor path when the
        // active pool is ironwood.
        const anchorHeight = await resolveAnchorHeight(walletId, sendTip.height);
        emitProgress('building merkle witnesses', `anchor=${anchorHeight} (tip=${sendTip.height})`);
        const { anchorHex, paths } = await buildWitnesses(
          sendClient,
          walletId,
          selected,
          anchorHeight,
          pcztPool,
          emitProgress,
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
          const iwLightdInfo = await sendClient.getLightdInfo();
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
          if (iwReportedBranchHex !== NU63_CONSENSUS_BRANCH_ID_HEX) {
            throw new Error(
              `endpoint consensus branch id 0x${iwReportedBranchHex} does not match NU6.3 ` +
                `(0x${NU63_CONSENSUS_BRANCH_ID_HEX}); refusing to build ironwood send`,
            );
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
            iwBuilt = await proveViaOffscreen({
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
                NU63_CONSENSUS_BRANCH_ID,
                sendPayload.mainnet,
                memoHex,
              ],
            });
          } catch (e) {
            console.error('[zcash-worker] build_ironwood_send_pczt failed');
            throw e;
          } finally {
            clearInterval(iwProvingTicker);
          }
          const iwParsed = iwBuilt as {
            pczt_hex: string;
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
          // (single PCZT), NOT the ironwood-blind ur:zcash-pczt CBOR wrap.
          const { envelope: iwEnvelope, compact: iwRequestCompact } = buildSignRequestEnvelope(
            wasmModule,
            iwParsed.pczt_hex,
          );
          const iwFragSize =
            sendPayload.fragmentSize && sendPayload.fragmentSize > 0
              ? sendPayload.fragmentSize
              : 200;
          const iwFramesJson = wasmModule.ur_encode_frames(
            iwEnvelope,
            ZIGNER_PCZT_SIGN_UR_TYPE,
            iwFragSize,
          );
          const iwUrFrames = JSON.parse(iwFramesJson) as string[];
          const iwTotalDuration = ((performance.now() - sendStart) / 1000).toFixed(1);
          emitProgress(
            'ironwood PCZT QR ready',
            `${iwUrFrames.length} frames, total=${iwTotalDuration}s`,
          );

          // What send-tx-pczt-complete / complete-orchard-pczt cannot recover
          // from the signed bytes. See the ColdSendContext comment.
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
              pcztHex: iwParsed.pczt_hex,
              // `summary` is a display string here (SendTxPcztUnsignedResult /
              // the zigner-signing store type it as `string`, and the UI renders
              // it as a React child). The authoritative per-output confirmation
              // (recipient/change/values) is recomputed ON the zigner from the
              // redacted PCZT, so a short label suffices for the extension side.
              summary: `ironwood send (${selected.length} spend${selected.length === 1 ? '' : 's'})`,
              actionCount: iwParsed.action_count,
              fee: fee.toString(),
              urFrames: iwUrFrames,
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
        // tip we have in hand is authoritative — branch_id derivation
        // depends on `(network, height)` and using a stale value (e.g.
        // hardcoded constant) risks producing txs the network rejects on
        // testnet where activation heights diverge from mainnet.
        const targetHeight = sendTip.height;
        const built = await proveViaOffscreen({
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

        const parsed = built as {
          pczt_hex: string;
          summary: string;
          action_count: number;
          // FROST multisig fields (additive — zigner cold-sign ignores them)
          sighash: string;
          alphas: string[];
          spend_indices: number[];
        };

        const proveDuration = ((performance.now() - proveStart) / 1000).toFixed(1);
        emitProgress('PCZT ready', `${proveDuration}s prove`);

        // CBOR-wrap PCZT bytes as `{1: bytes}` then UR-encode for animated QR.
        // CBOR-wrap the PCZT for the standard zashi/keystone-sdk envelope.
        const pcztBytes = hexDecode(parsed.pczt_hex);
        const cbor = cborWrapPczt(pcztBytes);
        const fragSize =
          sendPayload.fragmentSize && sendPayload.fragmentSize > 0 ? sendPayload.fragmentSize : 200;
        const framesJson = wasmModule.ur_encode_frames(cbor, 'zcash-pczt', fragSize);
        const urFrames = JSON.parse(framesJson) as string[];

        const totalDuration = ((performance.now() - sendStart) / 1000).toFixed(1);
        emitProgress('PCZT QR ready', `${urFrames.length} frames, total=${totalDuration}s`);

        // What send-tx-pczt-complete / complete-orchard-pczt cannot recover from
        // the signed bytes. See the ColdSendContext comment.
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
            cborBytes: cbor.length,
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

        // TransactionExtractor reconstructs the canonical v5 tx — collects all
        // spend auth sigs from the signed PCZT, validates the proof, and emits
        // a broadcast-ready transaction. No manual offset-patching as in the
        // legacy `complete_transaction` path.
        const txHex = wasmModule.extract_signed_tx_from_pczt(completePayload.signedPcztHex);
        const txData = hexDecode(txHex);

        const completeClient = await makeZcashClient(completePayload.serverUrl);
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
          mnemonic?: string;
          backend?: ZcashBackend;
          /** UR fragment-size override; falls back to 200 for back-compat */
          fragmentSize?: number;
        };
        if (migratePayload.backend) {
          registerBackend(migratePayload.serverUrl, migratePayload.backend);
        }
        // HOT (mnemonic) vs COLD (zigner/UFVK) turnstile. A hot/self-custody
        // wallet supplies the seed phrase in-worker and signs the V6 tx with
        // the NU6.3 signer wasm (build_signed_turnstile_migration), returning a
        // ready-to-broadcast tx - no PCZT/QR round trip. A watch-only/zigner
        // wallet supplies a UFVK and takes the cold PCZT cold-sign machine.
        // Prefer the seed when present; fall back to the UFVK cold path.
        const isHotMigration = !!migratePayload.mnemonic;
        if (!isHotMigration && !migratePayload.ufvk) {
          throw new Error('turnstile migration requires a mnemonic (hot) or UFVK (cold) wallet');
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

        const migrateClient = await makeZcashClient(
          migratePayload.serverUrl,
          migratePayload.backend,
        );

        // ── FAIL-CLOSED branch-id guard (FIX-C item 2) ────────────────────
        // Before building anything, read the endpoint's reported consensus
        // branch id from GetLightdInfo. We refuse to build (and therefore to
        // broadcast) unless NU6.3 is actually active at this endpoint and the
        // branch id is the real value (0x37a5165b). A placeholder branch id
        // (0xffffffff) or any mismatch means NU6.3 has not activated here yet -
        // a migration built against it would be an invalid / unspendable tx.
        emitProgress('checking NU6.3 activation');
        const lightdInfo = await migrateClient.getLightdInfo();
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
        if (reportedBranchHex !== NU63_CONSENSUS_BRANCH_ID_HEX) {
          throw new Error(
            `endpoint consensus branch id 0x${reportedBranchHex} does not match NU6.3 ` +
              `(0x${NU63_CONSENSUS_BRANCH_ID_HEX}); refusing to build turnstile migration`,
          );
        }
        emitProgress('NU6.3 active', `branch id 0x${reportedBranchHex}`);

        emitProgress('fetching chain tip');
        const migrateTip = await migrateClient.getTip();
        const migrateAnchorHeight = await resolveAnchorHeight(walletId, migrateTip.height);
        emitProgress(
          'building merkle witnesses',
          `anchor=${migrateAnchorHeight} (tip=${migrateTip.height})`,
        );
        // orchard spends -> orchard witnesses; the migration needs no
        // ironwood anchor (output-only on the ironwood side)
        const { anchorHex, paths } = await buildWitnesses(
          migrateClient,
          walletId,
          orchardNotes,
          migrateAnchorHeight,
          'orchard',
        );

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

        // ── HOT (mnemonic) path ───────────────────────────────────────────
        // Self-custody wallet: build + prove + SIGN the V6 turnstile tx inside
        // the wasm with the seed phrase, then broadcast the returned tx hex
        // directly. No PCZT is produced, persisted, or transmitted - the wasm
        // returns only the final signed tx. Reuses the EXACT same params the
        // cold path passes (notes, fee, anchor, merkle paths, accountIndex,
        // target height, expected branch id, mainnet), so nullifier derivation
        // and the fail-closed branch-id guard match the cold path bit for bit.
        if (isHotMigration) {
          const migrateSeed = migratePayload.mnemonic!;
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
            // account_index MUST be the account the orchard notes were scanned
            // under (same as the cold path) or the wasm's nullifier check
            // rejects every spend. NU63_CONSENSUS_BRANCH_ID is the live value
            // validated from GetLightdInfo above (never the placeholder); the
            // producer refuses to build unless the branch id it binds equals it.
            migrateTxHex = (await proveViaOffscreen({
              fn: 'build_signed_turnstile_migration',
              args: [
                migrateSeed,
                JSON.stringify(notesForWasm),
                fee.toString(),
                anchorHex,
                JSON.stringify(pathsForWasm),
                migratePayload.accountIndex,
                migrateTip.height,
                NU63_CONSENSUS_BRANCH_ID,
                migratePayload.mainnet,
                null,
              ],
            })) as string;
          } catch (e) {
            // do NOT log the seed or the caught args; message only
            console.error('[zcash-worker] build_signed_turnstile_migration failed');
            throw e;
          } finally {
            clearInterval(hotProvingTicker);
          }

          emitProgress('turnstile tx signed', `${migrateTxHex.length / 2} bytes`);
          emitProgress('broadcasting migration');
          const migrateHotTxData = hexDecode(migrateTxHex);
          const migrateHotClient = await makeZcashClient(
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
          // orchard balance as spendable — and the fail-closed guard only
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
        const built = await proveViaOffscreen({
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
            NU63_CONSENSUS_BRANCH_ID,
            migratePayload.mainnet,
            null,
          ],
        });
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
        const { envelope: migrateEnvelope, compact: migrateCompact } = buildSignRequestEnvelope(
          wasmModule,
          migrateParsed.pczt_hex,
        );
        const migrateFragSize =
          migratePayload.fragmentSize && migratePayload.fragmentSize > 0
            ? migratePayload.fragmentSize
            : 200;
        const migrateFramesJson = wasmModule.ur_encode_frames(
          migrateEnvelope,
          ZIGNER_PCZT_SIGN_UR_TYPE,
          migrateFragSize,
        );
        const migrateUrFrames = JSON.parse(migrateFramesJson) as string[];
        emitProgress('turnstile PCZT QR ready', `${migrateUrFrames.length} frames`);

        // The migration spends EVERY orchard note, so a completion that does
        // not mark them leaves the whole legacy balance looking spendable — and
        // a second migration launched in that window builds a conflicting
        // spend. The hot branch above already does this; see ColdSendContext.
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

        const migrateCompleteClient = await makeZcashClient(migrateCompletePayload.serverUrl);
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
        // live consensus branch id (NU6.3-safe); resolved once, reused for every output
        let multiBranchIdHex: string | null = null;

        // FAIL-CLOSED (NU6.3): multi-send only builds orchard txs today, which
        // are consensus-disabled post-activation, and there is no ironwood
        // multi-send path yet. Refuse up front rather than build invalid
        // orchard txs per output.
        // TODO(ironwood multi-send): route the ironwood pool through
        // build_signed_ironwood_send per output.
        {
          const multiGuardClient = await makeZcashClient(multiPayload.serverUrl);
          const multiGuardTip = await multiGuardClient.getTip();
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
          // match the build_signed_spend / buildWitnesses('orchard') calls
          // below; the NU6.3 guard above already refused post-activation, so
          // orchard is the only reachable pool here. Passed explicitly rather
          // than leaning on selectNotes' legacy default.
          const estFee = computeFee(1, nZOutputs, nTOutputs, true);
          const selected = selectNotes(
            multiState.notes,
            multiState.spentNullifiers,
            amountZat + estFee,
            'orchard',
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
          const multiClient = await makeZcashClient(multiPayload.serverUrl);
          const multiTip = await multiClient.getTip();
          if (multiBranchIdHex === null) {
            multiBranchIdHex = await fetchBranchIdHex(multiClient);
          }

          const multiAnchorHeight = await resolveAnchorHeight(walletId, multiTip.height);
          emitMultiProgress(
            `output ${outputIdx + 1}: building witnesses`,
            `anchor=${multiAnchorHeight} (tip=${multiTip.height})`,
          );
          const { anchorHex: multiAnchor, paths: multiPaths } = await buildWitnesses(
            multiClient,
            walletId,
            selected,
            multiAnchorHeight,
            'orchard',
            emitMultiProgress,
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
            txHex = (await proveViaOffscreen({
              fn: 'build_signed_spend',
              args: [
                multiPayload.mnemonic,
                notesJson,
                recipient,
                amountZat.toString(),
                fee.toString(),
                multiAnchor,
                merklePathsForWasm,
                multiPayload.accountIndex,
                multiPayload.mainnet,
                memoHex,
                multiBranchIdHex,
              ],
            })) as string;
          } finally {
            clearInterval(provingTicker);
          }

          // broadcast
          emitMultiProgress(`output ${outputIdx + 1}: broadcasting`);
          const txData = hexDecode(txHex);
          const broadcastClient = await makeZcashClient(multiPayload.serverUrl);
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

        const { mnemonic, serverUrl, tAddresses, mainnet, addressIndexMap } = payload as {
          mnemonic: string;
          serverUrl: string;
          tAddresses: string[];
          mainnet: boolean;
          addressIndexMap?: Record<string, number>;
        };

        const client = await makeZcashClient(serverUrl);
        const tip = await client.getTip();
        const allUtxos = await client.getAddressUtxos(tAddresses);
        if (allUtxos.length === 0) {
          throw new Error('no transparent UTXOs to shield');
        }

        // build address → derivation index lookup
        const addrToIndex = new Map<string, number>();
        if (addressIndexMap) {
          for (const [addr, idx] of Object.entries(addressIndexMap)) {
            addrToIndex.set(addr, idx);
          }
        } else {
          for (const addr of tAddresses) {
            addrToIndex.set(addr, 0);
          }
        }

        // group UTXOs by derivation index (WASM signs all inputs with one key)
        const byIndex = new Map<number, typeof allUtxos>();
        for (const utxo of allUtxos) {
          const idx = addrToIndex.get(utxo.address) ?? 0;
          let group = byIndex.get(idx);
          if (!group) {
            group = [];
            byIndex.set(idx, group);
          }
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

        // live consensus branch id for the ZIP-244 sighash + v5 header (NU6.3-safe)
        const shieldBranchIdHex = await fetchBranchIdHex(client);

        // shield each group with its matching privkey
        let totalShielded = 0n;
        let totalFee = 0n;
        let totalUtxos = 0;
        let lastTxid = '';

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
          const privkeyHex = wasmModule.derive_transparent_privkey(mnemonic, 0, addrIndex);

          const utxosJson = JSON.stringify(
            utxos.map(u => ({
              txid: hexEncode(u.txid),
              vout: u.outputIndex,
              value: Number(u.valueZat),
              script: hexEncode(u.script),
            })),
          );

          const txHex = (await proveViaOffscreen({
            fn: 'build_shielding',
            args: [
              utxosJson,
              privkeyHex,
              recipient,
              shieldAmount.toString(),
              fee.toString(),
              tip.height,
              mainnet,
              shieldBranchIdHex,
            ],
          })) as string;
          const txData = hexDecode(txHex);
          const result = await client.sendTransaction(txData);
          if (result.errorCode !== 0) {
            throw new Error(`broadcast failed (${result.errorCode}): ${result.errorMessage}`);
          }

          lastTxid = await resolveBroadcastTxid(result, txHex, serverUrl);
          totalShielded += shieldAmount;
          totalFee += fee;
          totalUtxos += utxos.length;
        }

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
          addressIndexMap?: Record<string, number>;
        };

        const shieldUClient = await makeZcashClient(shieldUnsignedPayload.serverUrl);
        const shieldUTip = await shieldUClient.getTip();
        // live consensus branch id for the ZIP-244 sighash + v5 header (NU6.3-safe)
        const shieldUBranchIdHex = await fetchBranchIdHex(shieldUClient);
        const shieldUUtxos = await shieldUClient.getAddressUtxos(shieldUnsignedPayload.tAddresses);
        if (shieldUUtxos.length === 0) {
          throw new Error('no transparent UTXOs to shield');
        }

        // build address → derivation index lookup
        const shieldUAddrToIndex = new Map<string, number>();
        if (shieldUnsignedPayload.addressIndexMap) {
          for (const [addr, idx] of Object.entries(shieldUnsignedPayload.addressIndexMap)) {
            shieldUAddrToIndex.set(addr, idx);
          }
        } else {
          for (const addr of shieldUnsignedPayload.tAddresses) {
            shieldUAddrToIndex.set(addr, 0);
          }
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
        const shieldUAddrIndices = shieldUUtxos.map(u => shieldUAddrToIndex.get(u.address) ?? 0);

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
          shieldUResult = (await proveViaOffscreen({
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
            ],
          })) as string;
        } else {
          shieldUResult = (await proveViaOffscreen({
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
          })) as string;
        }

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

        const shieldCompleteClient = await makeZcashClient(shieldCompletePayload.serverUrl);
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
        const { secretHex, peerBroadcasts } = payload as {
          secretHex: string;
          peerBroadcasts: string;
        };
        const result = JSON.parse(wasmModule!.frost_dkg_part2(secretHex, peerBroadcasts));
        workerSelf.postMessage({ type: 'frost-result', id, network: 'zcash', payload: result });
        return;
      }

      case 'frost-dkg-part3': {
        await initWasm();
        const { secretHex, round1Broadcasts, round2Packages } = payload as {
          secretHex: string;
          round1Broadcasts: string;
          round2Packages: string;
        };
        const result = JSON.parse(
          wasmModule!.frost_dkg_part3(secretHex, round1Broadcasts, round2Packages),
        );
        workerSelf.postMessage({ type: 'frost-result', id, network: 'zcash', payload: result });
        return;
      }

      case 'frost-sign-round1': {
        await initWasm();
        const { ephemeralSeedHex, keyPackageHex } = payload as {
          ephemeralSeedHex: string;
          keyPackageHex: string;
        };
        const result = JSON.parse(wasmModule!.frost_sign_round1(ephemeralSeedHex, keyPackageHex));
        workerSelf.postMessage({ type: 'frost-result', id, network: 'zcash', payload: result });
        return;
      }

      case 'frost-spend-sign': {
        await initWasm();
        const { ephemeralSeedHex, keyPackageHex, noncesHex, sighashHex, alphaHex, commitments } =
          payload as {
            ephemeralSeedHex: string;
            keyPackageHex: string;
            noncesHex: string;
            sighashHex: string;
            alphaHex: string;
            commitments: string;
          };
        // signed variant — coordinator (zafu/poker-escrow) extracts signer identifier from VK
        const result = wasmModule!.frost_spend_sign_round2_signed(
          ephemeralSeedHex,
          keyPackageHex,
          noncesHex,
          sighashHex,
          alphaHex,
          commitments,
        );
        workerSelf.postMessage({ type: 'frost-result', id, network: 'zcash', payload: result });
        return;
      }

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

      case 'frost-derive-address-from-sk': {
        await initWasm();
        const { publicKeyPackageHex, skHex, diversifierIndex } = payload as {
          publicKeyPackageHex: string;
          skHex: string;
          diversifierIndex: number;
        };
        const rawHex = wasmModule!.frost_derive_address_from_sk(
          publicKeyPackageHex,
          skHex,
          diversifierIndex,
        );
        workerSelf.postMessage({ type: 'frost-result', id, network: 'zcash', payload: rawHex });
        return;
      }

      case 'frost-sample-fvk-sk': {
        await initWasm();
        const skHex = wasmModule!.frost_sample_fvk_sk();
        workerSelf.postMessage({ type: 'frost-result', id, network: 'zcash', payload: skHex });
        return;
      }

      case 'frost-derive-ufvk': {
        await initWasm();
        const { publicKeyPackageHex, skHex, mainnet } = payload as {
          publicKeyPackageHex: string;
          skHex: string;
          mainnet: boolean;
        };
        const ufvk = wasmModule!.frost_derive_ufvk(publicKeyPackageHex, skHex, mainnet);
        workerSelf.postMessage({ type: 'frost-result', id, network: 'zcash', payload: ufvk });
        return;
      }

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
        const bClient = await makeZcashClient(bUrl);
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
      case 'get-transparent-utxos': {
        // spendable transparent UTXOs for the given addresses (e.g. a Ledger
        // t-addr), each with the full prev-tx bytes the Ledger legacy signer
        // needs as its trusted input.
        const { serverUrl: uUrl, addresses: uAddrs } = payload as {
          serverUrl: string;
          addresses: string[];
        };
        const uClient = await makeZcashClient(uUrl);
        const uUtxos = await uClient.getAddressUtxos(uAddrs);
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
        const cClient = await makeZcashClient(serverUrl);
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
          submitAt: number;
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
              // stringified bigint over postMessage, same convention as the
              // core send builders' amount/fee args.
              String(cv.submitAt),
            ],
          })) as string,
        ) as { proposal_id: number; wire: string; shares: string; commitment_bundle_json: string };
        workerSelf.postMessage({
          type: 'result',
          id,
          network: 'zcash',
          walletId,
          payload: {
            proposalId: raw.proposal_id,
            wire: raw.wire,
            shares: raw.shares,
            commitmentBundleJson: raw.commitment_bundle_json,
          },
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

      case 'get-orchard-account-info': {
        await initWasm();
        if (!wasmModule) {
          throw new Error('wasm not initialized');
        }
        const { mnemonic, mainnet: infoMainnet } = payload as {
          mnemonic: string;
          mainnet: boolean;
        };
        const infoKeys = new wasmModule.WalletKeys(mnemonic);
        let fvkHex: string;
        try {
          fvkHex = infoKeys.get_fvk_hex();
        } finally {
          infoKeys.free();
        }
        // WalletKeys has no ufvk-string export (only watch-only imports carry
        // one directly) - encode it ourselves (ZIP-316) and self-check with
        // the wasm module's own decoder so an encoder bug fails loudly here
        // instead of surfacing as an opaque proof-build error downstream.
        const ufvkStr = encodeOrchardUfvk(hexDecode(fvkHex), infoMainnet);
        if (!wasmModule.validate_ufvk(ufvkStr)) {
          throw new Error(
            'internal error: locally-encoded UFVK failed wasm validation (encoder bug)',
          );
        }
        workerSelf.postMessage({
          type: 'result',
          id,
          network: 'zcash',
          walletId,
          payload: { fvkHex, ufvkStr },
        });
        return;
      }

      case 'get-consensus-branch-id': {
        const { serverUrl: branchServerUrl } = payload as { serverUrl: string };
        const branchClient = await makeZcashClient(branchServerUrl);
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
        const witnessClient = await makeZcashClient(witnessServerUrl);
        const witnessResult = await buildWitnesses(
          witnessClient,
          walletId,
          orderedNotes,
          targetHeight,
          witnessPool ?? 'orchard',
        );
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
  }
};

initWasm()
  .then(() => {
    workerSelf.postMessage({ type: 'ready', id: '', network: 'zcash' });
  })
  .catch(err => {
    console.error('[zcash-worker] wasm init failed:', err);
  });
