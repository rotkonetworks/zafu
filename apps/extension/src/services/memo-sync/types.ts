/**
 * memo-sync service interface
 *
 * follows Eriksen "Your Server as a Function":
 *   - service = async function (Req => Future[Rep])
 *   - filter  = (Service) => Service, orthogonal composable concern
 *   - strategy = named composition of filters, chosen by config
 *
 * the service surface here is deliberately narrow. all privacy / caching /
 * decoy / concurrency / retry behaviour lives in filters wrapped around a
 * concrete MemoFetcher. swapping the strategy at the call site changes
 * behaviour without touching the worker or the underlying RPC client.
 */

/** a single block height bucket (start-aligned to BUCKET_SIZE). */
export type BucketStart = number;

/** the range of valid bucket starts (orchard activation .. current tip). */
export interface BucketRange {
  readonly min: BucketStart;
  readonly max: BucketStart;
}

/**
 * one fetched bucket: the raw transaction bytes from a 100-block range, plus
 * the bucket-start the caller asked for so the consumer can correlate.
 *
 * the fetcher does NOT decode memos — that lives in the wallet (and uses
 * private WASM keys). this keeps the fetcher narrow: it's transport + privacy
 * policy only.
 */
export interface MemoEvent {
  readonly bucketStart: BucketStart;
  /** every block in the bucket (height-ordered), with raw orchard tx bytes. */
  readonly blocks: ReadonlyArray<BucketBlock>;
}

export interface BucketBlock {
  readonly height: number;
  readonly txs: ReadonlyArray<{ readonly data: Uint8Array }>;
}

/** context threaded through every fetch. */
export interface FetchContext {
  readonly signal: AbortSignal;
  /** current chain tip height — used to bound decoy range, estimate block time. */
  readonly tip: number;
  /** orchard activation height — lower bound for decoy bucket range. */
  readonly activation: number;
  /** progress callback. fires with (completed, total) bucket counts. */
  readonly onProgress?: (completed: number, total: number) => void;
}

/**
 * a memo fetcher takes the set of buckets containing owned notes and yields
 * memo events. concrete implementations decide HOW to fetch (per-block-range,
 * per-tx, etc.). filters layer policy on top of any concrete fetcher.
 */
export type MemoFetcher = (
  walletId: string,
  ownedBuckets: ReadonlySet<BucketStart>,
  ctx: FetchContext,
) => AsyncIterable<MemoEvent>;

/** a filter is a function that wraps a MemoFetcher with one orthogonal concern. */
export type MemoFilter = (inner: MemoFetcher) => MemoFetcher;

/** named strategy = closed enum of pre-composed filter stacks. */
export type MemoSyncStrategy = 'private' | 'fast';

/** standard bucket size (100 blocks). matches the existing zafu deployment. */
export const BUCKET_SIZE = 100;

/** snap a height to its bucket start. */
export const bucketOf = (height: number): BucketStart =>
  Math.floor(height / BUCKET_SIZE) * BUCKET_SIZE;
