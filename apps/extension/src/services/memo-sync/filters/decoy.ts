/**
 * withDecoyBuckets — mix in N* random decoy buckets per real bucket.
 *
 * the privacy property: server sees (1 + ratio)*N bucket fetches and cannot
 * distinguish real from decoy. matches Penumbra's FMD shape, where the scanner
 * receives a superset of "interesting" items it can't narrow down.
 *
 * decoys are sampled uniformly over [activation .. tip], skipping buckets that
 * are real OR already cached (we want decoys to land on buckets the server
 * hasn't seen this wallet touch before — fetching a bucket twice burns its
 * deniability).
 *
 * if the chain range is too small to accommodate the requested decoy count
 * after the skip set, we add as many as we can. that's a graceful degradation,
 * not an error — bandwidth/privacy ratio drops slightly but real buckets are
 * still fetched.
 *
 * note: this filter does NOT shuffle. compose with withShuffle if you want
 * the fetch order randomized too — shuffling is a separate concern.
 */

import { BUCKET_SIZE } from '../types';
import type {
  BucketStart,
  MemoFetcher,
  MemoFilter,
  FetchContext,
} from '../types';
import type { BucketStore } from './cache';
import type { RandomU32 } from './shuffle';

export interface DecoyOptions {
  /** decoys per real bucket. 0 disables. default 2. */
  ratio: number;
  /** RNG override for tests. defaults to crypto.getRandomValues. */
  rng?: RandomU32;
  /**
   * predicate returning true for buckets that must NOT be used as decoys
   * (typically buckets the cache already knows about). called once per
   * candidate; should be cheap (sync, in-memory check). default: () => false.
   */
  exclude?: (bucket: BucketStart) => boolean;
  /**
   * Optional cache to consult: any bucket present here is excluded as a decoy
   * candidate. Wiring this prevents decoys from landing on real buckets that
   * we've already fetched (and would otherwise be re-fetched, wasting bandwidth
   * and producing duplicate events). Combined with `exclude`, both predicates
   * apply (union).
   */
  excludeStore?: BucketStore;
}

const defaultRng: RandomU32 = (out) => crypto.getRandomValues(out);

export const withDecoyBuckets = (opts: DecoyOptions): MemoFilter => {
  const ratio = Math.max(0, Math.floor(opts.ratio));
  const rng = opts.rng ?? defaultRng;
  const userExclude = opts.exclude ?? (() => false);
  const excludeStore = opts.excludeStore;

  return (inner: MemoFetcher): MemoFetcher =>
    async function* withDecoys(walletId, ownedBuckets, ctx) {
      if (ratio === 0 || ownedBuckets.size === 0) {
        yield* inner(walletId, ownedBuckets, ctx);
        return;
      }
      const seen = excludeStore ? await excludeStore.list(walletId) : null;
      const exclude = (b: BucketStart) => userExclude(b) || (seen?.has(b) ?? false);
      const decoys = pickDecoys(ownedBuckets, ratio, exclude, rng, ctx);
      const merged = new Set<BucketStart>(ownedBuckets);
      for (const d of decoys) merged.add(d);
      yield* inner(walletId, merged, ctx);
    };
};

function pickDecoys(
  real: ReadonlySet<BucketStart>,
  ratio: number,
  exclude: (b: BucketStart) => boolean,
  rng: RandomU32,
  ctx: FetchContext,
): Set<BucketStart> {
  const target = real.size * ratio;
  const minBucket = snapBucket(ctx.activation);
  const maxBucket = snapBucket(ctx.tip);
  const range = (maxBucket - minBucket) / BUCKET_SIZE + 1;
  // need at least 2x target slots otherwise we waste cycles on collisions
  if (range < target * 2) return new Set();

  const decoys = new Set<BucketStart>();
  // oversample to absorb collisions with real/exclude/each-other
  const draws = new Uint32Array(Math.max(target * 4, 16));
  rng(draws);

  for (let i = 0; i < draws.length && decoys.size < target; i++) {
    const offset = draws[i]! % range;
    const candidate = minBucket + offset * BUCKET_SIZE;
    if (real.has(candidate)) continue;
    if (decoys.has(candidate)) continue;
    if (exclude(candidate)) continue;
    decoys.add(candidate);
  }
  return decoys;
}

function snapBucket(height: number): BucketStart {
  return Math.floor(height / BUCKET_SIZE) * BUCKET_SIZE;
}
