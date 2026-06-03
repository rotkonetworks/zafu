/**
 * blockRangeFetcher — the only concrete MemoFetcher in the strategy stack.
 *
 * privacy property at the transport layer:
 *   for each bucket the wallet wants, fetch a 100-block contiguous range
 *   using GetBlockTransactions. the server sees the height range, NOT the
 *   txid the wallet cares about. every transaction in those blocks comes
 *   back regardless of ownership.
 *
 * the per-tx leaky path (GetTransaction(txid)) is DELIBERATELY NOT exposed
 * here. there is no concrete fetcher in this module that calls it, and there
 * is no filter on top that can recover privacy after a leak. if a future
 * caller insists on per-tx fetches, they have to build their own concrete
 * fetcher outside this module and explicitly accept the privacy cost.
 *
 * concurrency: honours ctx.concurrency (set by withConcurrency). buckets are
 * fetched in batches; within a bucket, the per-height calls are sequential
 * because the server batches small queries reasonably well already.
 */

import { BUCKET_SIZE } from './types';
import type { BucketStart, FetchContext, MemoEvent, MemoFetcher } from './types';

/**
 * minimal client interface — exact shape of the relevant ZidecarClient
 * methods. allows tests to inject a fake without pulling the whole client in.
 */
export interface BlockRangeClient {
  getBlockTransactions(height: number): Promise<{
    height: number;
    txs: Array<{ data: Uint8Array; height: number }>;
  }>;
}

export interface BlockRangeOptions {
  readonly bucketSize?: number;
  /** maximum height to fetch (typically chain tip). */
  readonly maxHeight?: number;
  /** called when a per-bucket fetch errors. defaults to console.error. */
  readonly onError?: (bucket: BucketStart, height: number, err: unknown) => void;
}

const DEFAULT_BUCKET_SIZE = BUCKET_SIZE;
const DEFAULT_CONCURRENCY = 4;

export function blockRangeFetcher(
  client: BlockRangeClient,
  opts: BlockRangeOptions = {},
): MemoFetcher {
  const bucketSize = opts.bucketSize ?? DEFAULT_BUCKET_SIZE;
  const onError = opts.onError ?? defaultOnError;

  return async function* (_walletId, ownedBuckets, ctx) {
    const buckets = [...ownedBuckets];
    if (buckets.length === 0) return;

    const concurrency = Math.max(1, ctx.concurrency ?? DEFAULT_CONCURRENCY);
    const maxHeight = opts.maxHeight ?? ctx.tip;
    let completed = 0;

    for (let i = 0; i < buckets.length; i += concurrency) {
      if (ctx.signal.aborted) return;
      const batch = buckets.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map((bucket) => fetchOne(client, bucket, bucketSize, maxHeight, ctx, onError)),
      );
      for (const ev of results) {
        completed += 1;
        ctx.onProgress?.(completed, buckets.length);
        if (ev) yield ev;
      }
    }
  };
}

async function fetchOne(
  client: BlockRangeClient,
  bucket: BucketStart,
  bucketSize: number,
  maxHeight: number,
  ctx: FetchContext,
  onError: (b: BucketStart, h: number, err: unknown) => void,
): Promise<MemoEvent | null> {
  const start = bucket;
  const end = Math.min(bucket + bucketSize - 1, maxHeight);
  const blocks: { height: number; txs: { data: Uint8Array }[] }[] = [];

  for (let h = start; h <= end; h++) {
    if (ctx.signal.aborted) return null;
    try {
      const { txs } = await client.getBlockTransactions(h);
      blocks.push({ height: h, txs: txs.map(({ data }) => ({ data })) });
    } catch (err) {
      onError(bucket, h, err);
      // partial buckets are still yielded so the caller can decide whether to
      // mark the bucket as processed. the cache filter checks event payload
      // length / partial flag if it wants to be strict; for now we yield what
      // we have and let downstream caching decide.
      return null;
    }
  }

  return { bucketStart: bucket, blocks };
}

function defaultOnError(bucket: BucketStart, height: number, err: unknown) {
  // eslint-disable-next-line no-console
  console.error(`[memo-sync] bucket ${bucket} block ${height}:`, err);
}
