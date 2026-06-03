/** @vitest-environment node */

import { describe, expect, test } from 'vitest';
import { withDecoyBuckets } from './decoy';
import { BUCKET_SIZE } from '../types';
import type { BucketStart, FetchContext, MemoFetcher } from '../types';
import type { RandomU32 } from './shuffle';

function recorder(): { fetcher: MemoFetcher; calls: Set<BucketStart>[] } {
  const calls: Set<BucketStart>[] = [];
  const fetcher: MemoFetcher = async function* (_w, owned, _c) {
    calls.push(new Set(owned));
  };
  return { fetcher, calls };
}

const seededRng = (seed: number): RandomU32 => {
  let s = seed >>> 0;
  return (out) => {
    for (let i = 0; i < out.length; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      out[i] = s;
    }
  };
};

const ctx = (overrides: Partial<FetchContext> = {}): FetchContext => ({
  signal: new AbortController().signal,
  tip: 3_000_000,
  activation: 1_687_104,
  ...overrides,
});

describe('withDecoyBuckets', () => {
  test('ratio=0 yields no decoys', async () => {
    const { fetcher, calls } = recorder();
    const owned = new Set([100, 200, 300]);
    await drain(withDecoyBuckets({ ratio: 0, rng: seededRng(1) })(fetcher)('w', owned, ctx()));
    expect(calls[0]).toEqual(owned);
  });

  test('ratio=2 adds 2× decoys (when range is large enough)', async () => {
    const { fetcher, calls } = recorder();
    const owned = new Set([1_700_000, 1_800_000, 1_900_000]);
    await drain(withDecoyBuckets({ ratio: 2, rng: seededRng(1) })(fetcher)('w', owned, ctx()));
    expect(calls[0]!.size).toBeGreaterThanOrEqual(owned.size + 2 * owned.size - 1);
    expect(calls[0]!.size).toBeLessThanOrEqual(owned.size + 2 * owned.size);
    // all real buckets present
    for (const b of owned) expect(calls[0]!.has(b)).toBe(true);
  });

  test('decoys never collide with real buckets', async () => {
    const { fetcher, calls } = recorder();
    const owned = new Set([100, 200, 300]);
    await drain(withDecoyBuckets({ ratio: 2, rng: seededRng(1) })(fetcher)('w', owned, ctx()));
    const decoys = [...calls[0]!].filter((b) => !owned.has(b));
    for (const d of decoys) expect(owned.has(d)).toBe(false);
  });

  test('exclude predicate is honoured', async () => {
    const { fetcher, calls } = recorder();
    const owned = new Set([1_700_000, 1_800_000]);
    const forbidden = new Set([1_700_100, 1_700_200, 1_700_300]);
    await drain(
      withDecoyBuckets({
        ratio: 5,
        rng: seededRng(1),
        exclude: (b) => forbidden.has(b),
      })(fetcher)('w', owned, ctx()),
    );
    for (const b of forbidden) expect(calls[0]!.has(b)).toBe(false);
  });

  test('decoys land within [activation, tip]', async () => {
    const { fetcher, calls } = recorder();
    const owned = new Set([1_700_000]);
    const c = ctx({ tip: 1_800_000, activation: 1_687_104 });
    await drain(withDecoyBuckets({ ratio: 5, rng: seededRng(7) })(fetcher)('w', owned, c));
    const decoys = [...calls[0]!].filter((b) => !owned.has(b));
    const minBucket = Math.floor(c.activation / BUCKET_SIZE) * BUCKET_SIZE;
    const maxBucket = Math.floor(c.tip / BUCKET_SIZE) * BUCKET_SIZE;
    for (const d of decoys) {
      expect(d).toBeGreaterThanOrEqual(minBucket);
      expect(d).toBeLessThanOrEqual(maxBucket);
      expect(d % BUCKET_SIZE).toBe(0);
    }
  });

  test('empty input → empty output (no decoys added when nothing to hide)', async () => {
    const { fetcher, calls } = recorder();
    await drain(withDecoyBuckets({ ratio: 2, rng: seededRng(1) })(fetcher)('w', new Set(), ctx()));
    expect(calls[0]!.size).toBe(0);
  });

  test('cramped range degrades gracefully (no decoys when range < 2×target)', async () => {
    // range = 3 buckets total, target = 4 decoys → impossible, get 0
    const { fetcher, calls } = recorder();
    const owned = new Set([1_700_000, 1_700_100]);
    const c = ctx({ tip: 1_700_200, activation: 1_700_000 });
    await drain(withDecoyBuckets({ ratio: 2, rng: seededRng(1) })(fetcher)('w', owned, c));
    // got only the real buckets back
    expect(calls[0]).toEqual(owned);
  });
});

async function drain<T>(iter: AsyncIterable<T>) {
  for await (const _ of iter) { /* */ }
}
