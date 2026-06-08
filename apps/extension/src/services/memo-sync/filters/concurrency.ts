/**
 * withConcurrency — bound the number of in-flight bucket fetches.
 *
 * the underlying server has limits; flooding it with parallel requests hurts
 * latency for everyone and can trigger rate limiting. higher concurrency =
 * faster sync up to the server's saturation point. configurable per strategy:
 *   - 'private'  -> 4   (safe default)
 *   - 'fast'     -> 8   (acceptable when you trust the server / self-hosted)
 *
 * implementation note: the inner fetcher receives the FULL bucket set at once
 * and decides per-bucket concurrency internally. this filter doesn't split
 * the set — instead it enforces a workgroup pattern in cooperation with the
 * inner fetcher via a token bucket exposed through FetchContext.
 *
 * since the existing concrete fetcher in zcash-worker.ts already batches
 * buckets in chunks, this filter just narrows the effective batch size by
 * trimming what the inner sees. simple and predictable.
 *
 * for now this is a thin pass-through that records the desired limit on the
 * context — the concrete fetcher reads it. keeping the wiring explicit makes
 * the filter trivially testable.
 */

import type { MemoFetcher, MemoFilter, FetchContext } from '../types';

declare module '../types' {
  interface FetchContext {
    /** optional concurrency hint set by withConcurrency. concrete fetchers
     *  SHOULD honour this when batching parallel requests. */
    readonly concurrency?: number;
  }
}

export const withConcurrency = (limit: number): MemoFilter => {
  const clamped = Math.max(1, Math.floor(limit));
  return (inner: MemoFetcher): MemoFetcher =>
    async function* limited(walletId, ownedBuckets, ctx) {
      const wrapped: FetchContext = { ...ctx, concurrency: clamped };
      yield* inner(walletId, ownedBuckets, wrapped);
    };
};
