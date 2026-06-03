/**
 * withShuffle — randomize bucket fetch order.
 *
 * if buckets were fetched in numerically increasing order, an observer could
 * tell when a wallet started skipping or when its activity clusters lie. by
 * shuffling we leak only the SET of fetched buckets, not the ordering.
 *
 * uses crypto.getRandomValues so the shuffle is unpredictable even within a
 * single sync session. tests can inject a deterministic RNG via the optional
 * `rng` parameter.
 *
 * implementation detail: Set iterates in insertion order, so we shuffle into
 * a fresh Set and pass it downstream. callers that iterate the Set get the
 * shuffled order; callers that .has()-check are unaffected.
 */

import type { BucketStart, MemoFetcher, MemoFilter } from '../types';

/** RNG signature: fills the provided buffer with uniform u32 values. */
export type RandomU32 = (out: Uint32Array) => void;

const defaultRng: RandomU32 = (out) => crypto.getRandomValues(out);

export const withShuffle = (rng: RandomU32 = defaultRng): MemoFilter =>
  (inner: MemoFetcher): MemoFetcher =>
    async function* shuffled(walletId, ownedBuckets, ctx) {
      const arr = shuffle([...ownedBuckets], rng);
      const reordered = new Set(arr); // insertion order = shuffle order
      yield* inner(walletId, reordered, ctx);
    };

/** Fisher-Yates shuffle. */
function shuffle(arr: BucketStart[], rng: RandomU32): BucketStart[] {
  if (arr.length <= 1) return arr;
  const rnd = new Uint32Array(arr.length);
  rng(rnd);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rnd[i]! % (i + 1);
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}
