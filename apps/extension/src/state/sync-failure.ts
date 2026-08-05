/**
 * Sync failure taxonomy.
 *
 * Ported from vizor-wallet (`lib/src/providers/sync_failure.dart` plus the
 * classification/recovery half of `rust/src/wallet/sync_engine/error.rs`).
 * The point is not the enum, it is the copy discipline behind it:
 *
 *   - a failure message says WHO ACTS (the wallet, or the person holding the
 *     money) and WHETHER IT SELF-HEALS,
 *   - it never contains a height, a hash, a hex string, or a type name —
 *     those live in `raw`, behind a "technical details" disclosure,
 *   - the failures the wallet can recover from on its own are never shown at
 *     all (see the rewind budget below).
 *
 * Deviations from vizor's set, and why:
 *   - `databaseBusy`/`databaseFatal` → `storageBusy`/`storageFatal`. zafu's
 *     local store is IndexedDB in an extension, not SQLite on a phone; the
 *     failure shapes ("blocked", "QuotaExceededError") are different even
 *     though the user-facing meaning is identical.
 *   - `parseFatal` → `consensus`. vizor talks to lightwalletd and can only
 *     fail to *parse* what it is handed. zafu additionally VERIFIES what the
 *     endpoint serves (Ligerito header proofs, NOMT nullifier proofs,
 *     commitment proofs), so its equivalent terminal, node-attributable
 *     failure is "this endpoint served data the wallet could not verify".
 *     That is a stronger claim than a parse error and deserves its own kind.
 *   - vizor defaults an unclassified error to *retry*; zafu defaults it to
 *     *visible* (`autoRetries: false`). This is a money path: a
 *     classification bug must never turn a real failure into a silent
 *     success, so anything we do not understand gets shown to the user.
 */

export type SyncFailureKind =
  | 'network'
  | 'endpoint'
  | 'consensus'
  | 'chainRecovery'
  | 'storageBusy'
  | 'storageFatal'
  | 'unknown';

/** What the offered action does. The view supplies the handler. */
export type SyncFailureActionKind = 'settings' | 'retry' | 'reload';

export interface SyncFailureAction {
  label: string;
  kind: SyncFailureActionKind;
}

export interface SyncFailure {
  kind: SyncFailureKind;
  /** verbatim error text — for diagnostics only, NEVER rendered as the message */
  raw: string;
  /** the only string a user is shown */
  message: string;
  action?: SyncFailureAction;
  /** true when the wallet retries on its own and the user need do nothing */
  autoRetries: boolean;
}

/**
 * Structured codes the worker attaches to its own throws. Preferred over
 * substring sniffing: zafu owns both sides of the worker boundary, so an
 * error we raise ourselves should say what it is rather than be guessed at.
 * Sniffing remains as the fallback for errors originating in wasm, in the
 * fetch stack, or in IndexedDB.
 */
export const SYNC_ERROR_CODES = [
  'network',
  'endpoint',
  'consensus',
  'chain-recovery',
  'storage-busy',
  'storage-fatal',
  'unknown',
] as const;

export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number];

export const isSyncErrorCode = (value: unknown): value is SyncErrorCode =>
  typeof value === 'string' && (SYNC_ERROR_CODES as readonly string[]).includes(value);

const KIND_BY_CODE: Record<SyncErrorCode, SyncFailureKind> = {
  network: 'network',
  endpoint: 'endpoint',
  consensus: 'consensus',
  'chain-recovery': 'chainRecovery',
  'storage-busy': 'storageBusy',
  'storage-fatal': 'storageFatal',
  unknown: 'unknown',
};

/**
 * The copy. Lowercase to match zafu's register (see
 * `components/zcash/sync-status.tsx`). Every line names who acts and whether
 * it self-heals. No heights, no hashes, no hex, no type names.
 */
const MESSAGES: Record<SyncFailureKind, string> = {
  network: "the network connection dropped. we'll keep trying automatically.",
  endpoint: "can't reach the zcash node you configured. check your endpoint settings.",
  consensus:
    'this node served data the wallet could not verify, so syncing stopped. switch nodes, or try again later.',
  chainRecovery: "the chain changed while syncing. we'll keep trying to recover.",
  storageBusy: "wallet data is busy. we'll try syncing again automatically.",
  storageFatal: 'wallet data could not be read. reload zafu and sync again.',
  unknown: 'sync stopped and we could not tell why. try again to continue.',
};

const ACTIONS: Partial<Record<SyncFailureKind, SyncFailureAction>> = {
  // Only failures the node is plausibly responsible for point at the node.
  endpoint: { label: 'switch node', kind: 'settings' },
  consensus: { label: 'switch node', kind: 'settings' },
  // A local problem must never make the wallet blame the node (vizor's rule).
  storageFatal: { label: 'reload zafu', kind: 'reload' },
  unknown: { label: 'try again', kind: 'retry' },
};

const AUTO_RETRIES: Record<SyncFailureKind, boolean> = {
  network: true,
  endpoint: false,
  consensus: false,
  // Surfaced only once the in-run rewind budget is spent; the next sync run
  // starts with a fresh budget, so recovery really does continue.
  chainRecovery: true,
  storageBusy: true,
  storageFatal: false,
  unknown: false,
};

/** Message for a kind. Exported for tests and for callers building their own. */
export const syncFailureMessage = (kind: SyncFailureKind): string => MESSAGES[kind];

const errorText = (error: unknown): string => {
  if (typeof error === 'string') {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    const { message } = error as { message?: unknown };
    if (typeof message === 'string') {
      return message;
    }
  }
  return String(error);
};

/** A worker-tagged error carries its own classification. */
export const syncErrorCodeOf = (error: unknown): SyncErrorCode | undefined => {
  if (error && typeof error === 'object' && 'syncCode' in error) {
    const { syncCode } = error as { syncCode?: unknown };
    if (isSyncErrorCode(syncCode)) {
      return syncCode;
    }
  }
  return undefined;
};

const has = (haystack: string, needles: readonly string[]): boolean =>
  needles.some(n => haystack.includes(n));

/**
 * Broadcast responses that mean "the node already has this transaction".
 * Not a failure at all — the node is telling us the work is done. Kept here
 * only so it can never be shown as an error; broadcast semantics themselves
 * are handled upstream (zcli `client.rs`) and are not touched.
 */
const ALREADY_ACCEPTED = [
  'already queued for download',
  'already in mempool',
  'already in the mempool',
  'already known',
  'already accepted',
  'txn-already-known',
  'txn-already-in-mempool',
] as const;

const ENDPOINT = [
  'invalid url',
  'invalid uri',
  'unsupported media type',
  // bare status numbers are never matched: block heights contain them
  'http 415',
  'status 415',
  'wrong network',
  'network mismatch',
  'endpoint is for',
  'chain name',
  'no endpoint',
  'select an endpoint',
  'use an https:// endpoint',
  'unknown zcash backend',
  'not found on this endpoint',
  'method not found',
  'unimplemented',
] as const;

const CONSENSUS = [
  'integrity check failed',
  'proof root mismatch',
  'proof invalid',
  'proof verification failed',
  'unrequested',
  'duplicate commitment proof',
  'duplicate nullifier proof',
  'count mismatch',
  'tampered',
  'refusing to trust',
] as const;

const CHAIN_RECOVERY = [
  'tree root mismatch',
  'chain continuity',
  'prevhashmismatch',
  'prev hash mismatch',
  'prev_hash mismatch',
  'blockheightdiscontinuity',
  'block height discontinuity',
  'reorg',
  'rewind budget exhausted',
  'witness root mismatch',
  'frontier diverged',
  'unreadable frontier',
  'no ironwood tree state',
  'anchor not found',
] as const;

const STORAGE_BUSY = [
  'database is locked',
  'database busy',
  'transaction was blocked',
  'blocked by another connection',
  'version change transaction was blocked',
  'transactioninactiveerror',
] as const;

const STORAGE_FATAL = [
  'indexeddb',
  'idbdatabase',
  'quotaexceedederror',
  'quota exceeded',
  'notreadableerror',
  'internal error opening backing store',
  'object store',
  'objectstore',
  'datacloneerror',
  'invalidstateerror',
] as const;

const NETWORK = [
  'network:',
  'networkerror',
  'failed to fetch',
  'load failed',
  'timed out',
  'timeout',
  'deadline exceeded',
  'unavailable',
  'connection refused',
  'connection reset',
  'connection closed',
  'failed to connect',
  'broken pipe',
  'no route to host',
  'dns',
  'tls',
  'transport error',
  'socket',
  // status numbers only ever matched with their prefix — a bare "503" also
  // appears inside block heights, which is how a reorg gets misread as an outage
  'http 500',
  'http 502',
  'http 503',
  'http 504',
  'status 502',
  'status 503',
  'status 504',
  'bad gateway',
  'gateway timeout',
  'service unavailable',
] as const;

/**
 * Classify by substring. Order matters: the more specific, more dangerous
 * claims are tested first so that (for example) "server integrity check
 * failed: nullifier root mismatch: …" lands on `consensus` rather than being
 * swept up by the chain-recovery patterns.
 */
const classifyKind = (lower: string): SyncFailureKind => {
  if (has(lower, CONSENSUS)) {
    return 'consensus';
  }
  if (has(lower, CHAIN_RECOVERY)) {
    return 'chainRecovery';
  }
  if (has(lower, ENDPOINT)) {
    return 'endpoint';
  }
  if (has(lower, STORAGE_BUSY)) {
    return 'storageBusy';
  }
  if (has(lower, STORAGE_FATAL)) {
    return 'storageFatal';
  }
  if (has(lower, NETWORK)) {
    return 'network';
  }
  return 'unknown';
};

const build = (kind: SyncFailureKind, raw: string, message?: string): SyncFailure => ({
  kind,
  raw,
  message: message ?? MESSAGES[kind],
  ...(ACTIONS[kind] ? { action: ACTIONS[kind] } : {}),
  autoRetries: AUTO_RETRIES[kind],
});

/**
 * Classify a sync failure.
 *
 * `code` is the structured classification emitted by our own worker; when
 * present it wins outright. Everything else falls back to substring sniffing,
 * which is brittle (vizor concedes as much) but is the only option for errors
 * raised inside wasm, `fetch`, or IndexedDB.
 */
export const classifySyncFailure = (error: unknown, code?: unknown): SyncFailure => {
  const raw = errorText(error);
  const lower = raw.toLowerCase();

  // Not an error: the node is telling us it already has the transaction.
  // Never phrase this as a failure of the user's payment.
  if (has(lower, ALREADY_ACCEPTED)) {
    return build(
      'network',
      raw,
      "the node already has this transaction. we'll keep watching for it to confirm.",
    );
  }

  const tagged = code ?? syncErrorCodeOf(error);
  if (isSyncErrorCode(tagged)) {
    return build(KIND_BY_CODE[tagged], raw);
  }

  return build(classifyKind(lower), raw);
};

/**
 * Whether this failure may justify moving the wallet to a different endpoint.
 *
 * Only transport-shaped failures qualify. A consensus failure, a chain
 * continuity problem, or anything local (storage, wasm, unclassified) must
 * never rotate the endpoint on its own: a local problem must never make the
 * wallet blame the node. `consensus` still OFFERS the user a "switch node"
 * action, because a node that serves unverifiable data is a node worth
 * leaving — but that is the user's decision, not an automatic one.
 */
export const isEndpointFailoverCandidate = (failure: SyncFailure): boolean =>
  failure.kind === 'network' || failure.kind === 'endpoint';

// ── chain-continuity recovery (ported from sync_engine/error.rs) ──

/**
 * Rewind distances, escalating per attempt within one sync run. A stale local
 * commitment tree can disagree with the server over a much wider range than a
 * one-block reorg, so retrying the same short rewind just lands on the same
 * bad shard boundary.
 */
export const COMMITMENT_TREE_REWIND_DISTANCES: readonly number[] = [10, 100, 1000];

/**
 * Maximum rewinds inside one sync run. Caps a runaway rewind loop: if the
 * chain (or the endpoint's view of it) is flapping fast enough to burn the
 * budget, the run gives up and the failure becomes visible as
 * `chainRecovery`, with a fresh budget on the next run.
 */
export const MAX_REWINDS_PER_RUN = 3;

export const rewindDistanceForAttempt = (attemptIndex: number): number => {
  const last = COMMITMENT_TREE_REWIND_DISTANCES[COMMITMENT_TREE_REWIND_DISTANCES.length - 1]!;
  if (!Number.isInteger(attemptIndex) || attemptIndex < 0) {
    return COMMITMENT_TREE_REWIND_DISTANCES[0]!;
  }
  return COMMITMENT_TREE_REWIND_DISTANCES[attemptIndex] ?? last;
};

/**
 * Whether this error is a chain-continuity break the sync loop can recover
 * from by rewinding its scan cursor. These must NOT reach the user: they are
 * an expected consequence of scanning a chain whose tip moves, and the
 * recovery is automatic. Logged at warn, not error.
 *
 * Deliberately narrower than `classifySyncFailure`: an error that is really a
 * consensus failure must keep its own meaning and stay visible, so the
 * consensus patterns are checked first here too.
 */
export const isChainContinuityError = (error: unknown): boolean => {
  const code = syncErrorCodeOf(error);
  if (code) {
    return code === 'chain-recovery';
  }
  const lower = errorText(error).toLowerCase();
  if (has(lower, CONSENSUS)) {
    return false;
  }
  return has(lower, CHAIN_RECOVERY);
};
