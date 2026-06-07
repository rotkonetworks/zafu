/**
 * mempool-watch service interface
 *
 * follows the same shape as services/memo-sync (see docs/services-pattern.md):
 *   - service = async function (Req => AsyncIterable<Rep>)
 *   - filter  = (Service) => Service, orthogonal composable concern
 *   - strategy = named composition, picked by config
 *
 * privacy/perf tradeoff is sharper than memo-sync. opening a mempool stream
 * is a continuous transport-level signal — the server knows the wallet is
 * watching the mempool for the entire session. that's why the only
 * strategies are 'off' (no stream) and 'on' (one stream). there's no
 * "private" mode that keeps the stream open but hides it; the only way to
 * be unwatchable is not to connect.
 *
 * decoding stays in the worker (mirrors memo-sync's "decode after consume"
 * separation): the fetcher yields raw mempool snapshots, the worker calls
 * the wallet's scan_actions_parallel WASM entry point on the action bytes
 * and emits high-level pending-incoming / pending-spend events.
 */

/**
 * One mempool action — wire-compatible with the existing zidecar
 * CompactBlock format used for both block sync and mempool. Kept as
 * narrow as possible so the service module does not pull the full
 * CompactBlock proto.
 */
export interface MempoolAction {
  readonly nullifier: Uint8Array;
  readonly cmx: Uint8Array;
  readonly ephemeralKey: Uint8Array;
  readonly ciphertext: Uint8Array;
}

/**
 * One mempool transaction the wallet must consider.
 *
 * `hash` is the txid in big-endian display order (32 bytes). For zidecar's
 * mempool stream this comes back as `CompactBlock.hash` with `height = 0`.
 */
export interface MempoolEntry {
  readonly hash: Uint8Array;
  readonly actions: ReadonlyArray<MempoolAction>;
}

/**
 * A snapshot of the mempool at a point in time. The base fetcher emits
 * one of these per poll; filters may add more (decoy mempool draws are
 * not meaningful here — there's no anonymity-set padding on a stream
 * the server already attributes to this wallet).
 */
export interface MempoolSnapshot {
  readonly entries: ReadonlyArray<MempoolEntry>;
  /** wall-clock time the snapshot was observed (millis). */
  readonly observedAtMs: number;
}

/** lifecycle status surfaced to the UI. */
export type MempoolStreamStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'reconnecting'; attempt: number; nextAttemptInMs: number }
  | { kind: 'disconnected' }
  | { kind: 'error'; error: string };

/** context threaded through every fetch. */
export interface MempoolFetchContext {
  readonly signal: AbortSignal;
  /** lifecycle callback — fires on connect / reconnect / error / disconnect. */
  readonly onStatus?: (status: MempoolStreamStatus) => void;
}

/**
 * The service: given a walletId and a context, yield mempool snapshots.
 * Concrete implementations decide HOW (one-shot HTTP, real gRPC stream,
 * stub for tests). Filters layer policy (poll cadence, reconnect,
 * dedup) on top of any concrete fetcher.
 */
export type MempoolFetcher = (
  walletId: string,
  ctx: MempoolFetchContext,
) => AsyncIterable<MempoolSnapshot>;

/** a filter is `(MempoolFetcher) => MempoolFetcher`. */
export type MempoolFilter = (inner: MempoolFetcher) => MempoolFetcher;

/** closed enum the UI binds to. */
export type MempoolWatchStrategy = 'off' | 'on';
