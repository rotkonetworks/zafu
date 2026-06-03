/**
 * named strategies — closed enum of pre-composed filter stacks.
 *
 * the UI exposes only this enum, never the raw filters. this is deliberate:
 *   - users can pick "private / fast / paranoid" without having to reason
 *     about decoy ratios, shuffle, or concurrency interactions
 *   - we can change the internal composition without breaking the public API
 *   - a dev or test can construct a custom stack by calling the filters
 *     directly, bypassing this module
 *
 * privacy summary:
 *   - 'private'  → 2× decoy, shuffle, cache, concurrency 4 (default)
 *   - 'fast'     → no decoys, cache, concurrency 8 (visible buckets, no leak of txids)
 *   - 'paranoid' → 5× decoy, shuffle, cache, concurrency 2
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
  switch (name) {
    case 'fast':
      return compose(base, [
        cache,
        withConcurrency(8),
      ]);
    case 'paranoid':
      return compose(base, [
        cache,
        withDecoyBuckets({ ratio: 5, rng }),
        withShuffle(rng),
        withConcurrency(2),
      ]);
    case 'private':
    default:
      return compose(base, [
        cache,
        withDecoyBuckets({ ratio: 2, rng }),
        withShuffle(rng),
        withConcurrency(4),
      ]);
  }
}

/**
 * apply filters in array order, where the FIRST filter wraps the base directly
 * and each subsequent filter wraps the previous. so `compose(base, [A, B, C])`
 * produces `C(B(A(base)))`.
 *
 * call-time order is opposite: C runs first (outermost), then B, then A, then
 * base. for the 'private' stack `[cache, decoy, shuffle, concurrency]`:
 *
 *   call() → concurrency annotates ctx
 *          → shuffle reorders the input set
 *          → decoy adds random buckets to the (shuffled) set
 *          → cache strips already-processed buckets from the (real + decoy) set
 *          → base fetches the survivors
 *          ← base yields events
 *          ← cache records new buckets as processed
 *          ← decoy / shuffle / concurrency pass-through events unchanged
 *
 * cache stripping decoys that collide with cached real buckets is intentional:
 * we never re-fetch a bucket that's already been correlated with this wallet.
 * the count loss (3N → 3N - collisions) is small and acceptable.
 */
function compose(
  base: MemoFetcher,
  filters: ReadonlyArray<(f: MemoFetcher) => MemoFetcher>,
): MemoFetcher {
  return filters.reduce((acc, filter) => filter(acc), base);
}
