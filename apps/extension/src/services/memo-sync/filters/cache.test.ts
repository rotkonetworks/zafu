/** @vitest-environment node */

import { describe, expect, test } from 'vitest';
import { memoryBucketStore, withBucketCache } from './cache';
import type { BucketStart, FetchContext, MemoFetcher } from '../types';

function recorder(): { fetcher: MemoFetcher; calls: BucketStart[][] } {
  const calls: BucketStart[][] = [];
  const fetcher: MemoFetcher = async function* (_w, owned, _c) {
    calls.push([...owned]);
    for (const b of owned) yield { bucketStart: b, blocks: [] };
  };
  return { fetcher, calls };
}

/** fetcher that drops a specific bucket (simulates a network error). */
function flakyRecorder(failOn: ReadonlySet<BucketStart>): {
  fetcher: MemoFetcher;
  calls: BucketStart[][];
} {
  const calls: BucketStart[][] = [];
  const fetcher: MemoFetcher = async function* (_w, owned, _c) {
    calls.push([...owned]);
    for (const b of owned) {
      if (failOn.has(b)) continue;
      yield { bucketStart: b, blocks: [] };
    }
  };
  return { fetcher, calls };
}

const ctx = (): FetchContext => ({
  signal: new AbortController().signal,
  tip: 3_000_000,
  activation: 1_687_104,
});

describe('withBucketCache', () => {
  test('first call passes all buckets through and marks them', async () => {
    const store = memoryBucketStore();
    const { fetcher, calls } = recorder();
    const wrapped = withBucketCache(store)(fetcher);
    const owned = new Set([100, 200, 300]);
    await drain(wrapped('w', owned, ctx()));
    expect(new Set(calls[0])).toEqual(owned);
    const seen = await store.list('w');
    expect(seen).toEqual(owned);
  });

  test('second call with same buckets short-circuits (no inner call)', async () => {
    const store = memoryBucketStore();
    const { fetcher, calls } = recorder();
    const wrapped = withBucketCache(store)(fetcher);
    const owned = new Set([100, 200, 300]);
    await drain(wrapped('w', owned, ctx()));
    await drain(wrapped('w', owned, ctx()));
    expect(calls).toHaveLength(1);
  });

  test('second call with overlap only fetches new buckets', async () => {
    const store = memoryBucketStore();
    const { fetcher, calls } = recorder();
    const wrapped = withBucketCache(store)(fetcher);
    await drain(wrapped('w', new Set([100, 200]), ctx()));
    await drain(wrapped('w', new Set([100, 200, 300, 400]), ctx()));
    expect(calls).toHaveLength(2);
    expect(new Set(calls[1])).toEqual(new Set([300, 400]));
  });

  test('cache is keyed per wallet', async () => {
    const store = memoryBucketStore();
    const { fetcher, calls } = recorder();
    const wrapped = withBucketCache(store)(fetcher);
    await drain(wrapped('alice', new Set([100, 200]), ctx()));
    await drain(wrapped('bob', new Set([100, 200]), ctx()));
    expect(calls).toHaveLength(2);
    expect(new Set(calls[0])).toEqual(new Set([100, 200]));
    expect(new Set(calls[1])).toEqual(new Set([100, 200]));
  });

  test('marks every input bucket whose event arrived', async () => {
    // cache is OUTERMOST (call-time first) — its input is real-only.
    // every bucket the inner generator yields an event for, in this case
    // every bucket, should be recorded.
    const store = memoryBucketStore();
    const { fetcher } = recorder();
    const wrapped = withBucketCache(store)(fetcher);
    const input = new Set([100, 200, 999_900]);
    await drain(wrapped('w', input, ctx()));
    for (const b of input) expect(await store.has('w', b)).toBe(true);
  });

  test('does NOT mark buckets that errored (no event yielded)', async () => {
    // a transient fetch failure (inner skips the bucket) must not poison the
    // cache. the bucket should retry naturally on the next sync.
    const store = memoryBucketStore();
    const { fetcher } = flakyRecorder(new Set([200]));
    const wrapped = withBucketCache(store)(fetcher);
    await drain(wrapped('w', new Set([100, 200, 300]), ctx()));
    expect(await store.has('w', 100)).toBe(true);
    expect(await store.has('w', 200)).toBe(false);
    expect(await store.has('w', 300)).toBe(true);
  });

  test('does NOT mark buckets that were not in its input (e.g. decoys)', async () => {
    // simulate an inner filter (decoy) widening the set: cache records only
    // buckets it asked for, even though the inner yields events for more.
    const store = memoryBucketStore();
    const widening: MemoFetcher = async function* (_w, owned, _c) {
      for (const b of owned) yield { bucketStart: b, blocks: [] };
      // decoy not in cache's input:
      yield { bucketStart: 555_500, blocks: [] };
    };
    const wrapped = withBucketCache(store)(widening);
    await drain(wrapped('w', new Set([100, 200]), ctx()));
    expect(await store.has('w', 100)).toBe(true);
    expect(await store.has('w', 200)).toBe(true);
    expect(await store.has('w', 555_500)).toBe(false);
  });
});

describe('memoryBucketStore', () => {
  test('has / put / list round-trip', async () => {
    const store = memoryBucketStore();
    expect(await store.has('w', 100)).toBe(false);
    await store.put('w', 100);
    await store.put('w', 200);
    expect(await store.has('w', 100)).toBe(true);
    expect(await store.has('w', 200)).toBe(true);
    expect(await store.has('w', 300)).toBe(false);
    const list = await store.list('w');
    expect(list).toEqual(new Set([100, 200]));
  });
});

async function drain<T>(iter: AsyncIterable<T>) {
  for await (const _ of iter) { /* */ }
}
