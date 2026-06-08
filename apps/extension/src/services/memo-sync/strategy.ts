/**
 * named strategies - closed enum of pre-composed filter stacks.
 *
 * the UI exposes only this enum, never the raw filters. this is deliberate:
 *   - users can pick "private / fast" without having to reason about decoy
 *     ratios, shuffle, or concurrency interactions
 *   - we can change the internal composition without breaking the public API
 *   - a dev or test can construct a custom stack by calling the filters
 *     directly, bypassing this module
 *
 * privacy summary:
 *   - 'private'  -> 2x decoy, shuffle, cache, concurrency 4 (default)
 *   - 'fast'     -> no decoys, cache, concurrency 8 (visible buckets, no leak of txids)
 *
 * NOTE: even 'fast' fetches by block-range, never per-txid. there's no mode
 * that ever calls GetTransaction(txid), because there's no filter that can
 * recover privacy from a leaked txid lookup.
 */

import type {
  BucketStore,
} from './filters/cache';
import { withBucketCache } from './filters/cache';
import { withConcurrency } from './filters/concurrency';
import { withDecoyBuckets } from './filters/decoy';
import { withShuffle, type RandomU32 } from './filters/shuffle';
import type { MemoFetcher, MemoSyncStrategy } from './types';

export interface StrategyParams {
  /** concrete fetcher to wrap (typically blockRangeFetcher(client)). */
  readonly base: MemoFetcher;
  /** bucket cache backend. */
  readonly store: BucketStore;
  /** optional RNG override (tests). */
  readonly rng?: RandomU32;
  /**
   * predicate: if true for a given bucket, fetch it even when cached.
   * used by callers (e.g. the worker) to force re-fetch of buckets that
   * contain notes spent in this sync run so the OVK decode path can rediscover
   * outgoing memos. defaults to () => false.
   */
  readonly alwaysFetch?: (bucket: number) => boolean;
}

export function buildStrategy(
  name: MemoSyncStrategy,
  params: StrategyParams,
): MemoFetcher {
  const { base, store, rng, alwaysFetch } = params;
  const cache = withBucketCache(store, { alwaysFetch });
  // ordering note: filters are applied left-to-right, so the LAST entry is the
  // outermost call-time wrapper. cache must be outermost so:
  //   - it sees real-only input (never decoys) when deciding what to mark
  //   - it strips already-cached real buckets before decoy widens the set
  // see strategy.ts header comment for call-time flow.
  switch (name) {
    case 'fast':
      return compose(base, [
        withConcurrency(8),
        cache,
      ]);
    case 'private':
    default:
      return compose(base, [
        withConcurrency(4),
        withShuffle(rng),
        withDecoyBuckets({ ratio: 2, rng, excludeStore: store }),
        cache,
      ]);
  }
}

/**
 * apply filters in array order, where the FIRST filter wraps the base directly
 * and each subsequent filter wraps the previous. so `compose(base, [A, B, C])`
 * produces `C(B(A(base)))`.
 *
 * call-time order is opposite: C runs first (outermost), then B, then A, then
 * base. for the 'private' stack `[concurrency, shuffle, decoy, cache]`:
 *
 *   call() → cache strips already-processed buckets from the REAL set
 *          → decoy adds random buckets (excluding cached real via excludeStore)
 *          → shuffle reorders the (real + decoy) set
 *          → concurrency annotates ctx
 *          → base fetches the survivors
 *          ← base yields events (one per fetched bucket, including decoys)
 *          ← concurrency / shuffle / decoy pass-through unchanged
 *          ← cache records buckets whose events arrived AND were in its
 *            real-only input (decoys are never marked, keeping the decoy
 *            universe full for future syncs)
 */
function compose(
  base: MemoFetcher,
  filters: ReadonlyArray<(f: MemoFetcher) => MemoFetcher>,
): MemoFetcher {
  return filters.reduce((acc, filter) => filter(acc), base);
}
