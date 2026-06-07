/** @vitest-environment node */

import { describe, expect, test } from 'vitest';
import { withShuffle, type RandomU32 } from './shuffle';
import type { BucketStart, FetchContext, MemoFetcher } from '../types';

// recording mock — captures the EXACT order buckets arrive in.
function recorder(): { fetcher: MemoFetcher; calls: BucketStart[][] } {
  const calls: BucketStart[][] = [];
  const fetcher: MemoFetcher = async function* (_w, owned, _ctx) {
    calls.push([...owned]);
  };
  return { fetcher, calls };
}

const seededRng = (seed: number): RandomU32 => {
  // simple linear congruential generator — deterministic across runs.
  let state = seed >>> 0;
  return (out) => {
    for (let i = 0; i < out.length; i++) {
      state = (state * 1664525 + 1013904223) >>> 0;
      out[i] = state;
    }
  };
};

const ctx = (): FetchContext => ({
  signal: new AbortController().signal,
  tip: 3_000_000,
  activation: 1_687_104,
});

describe('withShuffle', () => {
  test('preserves the bucket set', async () => {
    const { fetcher, calls } = recorder();
    const wrapped = withShuffle(seededRng(1))(fetcher);
    const owned = new Set([100, 200, 300, 400, 500]);
    for await (const _ of wrapped('w', owned, ctx())) { /* drain */ }
    expect(calls).toHaveLength(1);
    expect(new Set(calls[0])).toEqual(owned);
  });

  test('with seeded RNG, ordering is deterministic', async () => {
    const owned = new Set([100, 200, 300, 400, 500]);
    const a = recorder();
    const b = recorder();
    await drain(withShuffle(seededRng(42))(a.fetcher)('w', owned, ctx()));
    await drain(withShuffle(seededRng(42))(b.fetcher)('w', owned, ctx()));
    expect(a.calls[0]).toEqual(b.calls[0]);
  });

  test('different seeds produce different orderings (with high probability)', async () => {
    const owned = new Set([100, 200, 300, 400, 500, 600, 700, 800]);
    const a = recorder();
    const b = recorder();
    await drain(withShuffle(seededRng(1))(a.fetcher)('w', owned, ctx()));
    await drain(withShuffle(seededRng(2))(b.fetcher)('w', owned, ctx()));
    expect(a.calls[0]).not.toEqual(b.calls[0]);
  });

  test('empty input passes through', async () => {
    const { fetcher, calls } = recorder();
    await drain(withShuffle(seededRng(1))(fetcher)('w', new Set(), ctx()));
    expect(calls[0]).toEqual([]);
  });

  test('single-element input passes through unchanged', async () => {
    const { fetcher, calls } = recorder();
    await drain(withShuffle(seededRng(1))(fetcher)('w', new Set([500]), ctx()));
    expect(calls[0]).toEqual([500]);
  });
});

async function drain<T>(iter: AsyncIterable<T>) {
  for await (const _ of iter) { /* */ }
}
