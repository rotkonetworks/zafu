/** @vitest-environment node */

import { describe, expect, test } from 'vitest';
import { blockRangeFetcher, type BlockRangeClient } from './block-range-fetcher';
import type { FetchContext, MemoEvent } from './types';

function fakeClient(): { client: BlockRangeClient; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    client: {
      async getBlockTransactions(height) {
        calls.push(height);
        return {
          height,
          txs: [{ data: new Uint8Array([height & 0xff]), height }],
        };
      },
    },
  };
}

const ctx = (overrides: Partial<FetchContext> = {}): FetchContext => ({
  signal: new AbortController().signal,
  tip: 3_000_000,
  activation: 1_687_104,
  ...overrides,
});

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe('blockRangeFetcher', () => {
  test('yields one event per requested bucket', async () => {
    const { client, calls } = fakeClient();
    const fetcher = blockRangeFetcher(client);
    const events = await collect(fetcher('w', new Set([1_700_000, 1_700_100]), ctx()));
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.bucketStart).sort()).toEqual([1_700_000, 1_700_100]);
    // 100 blocks per bucket × 2 buckets = 200 fetches
    expect(calls).toHaveLength(200);
  });

  test('each event has bucketSize blocks (or fewer near tip)', async () => {
    const { client } = fakeClient();
    const fetcher = blockRangeFetcher(client);
    const events = await collect(fetcher('w', new Set([1_700_000]), ctx()));
    expect(events[0]!.blocks).toHaveLength(100);
    expect(events[0]!.blocks[0]!.height).toBe(1_700_000);
    expect(events[0]!.blocks[99]!.height).toBe(1_700_099);
  });

  test('bucket near tip is clipped', async () => {
    const { client } = fakeClient();
    const fetcher = blockRangeFetcher(client);
    const events = await collect(fetcher('w', new Set([2_999_900]), ctx({ tip: 2_999_950 })));
    expect(events[0]!.blocks).toHaveLength(51); // 2_999_900 .. 2_999_950 inclusive
  });

  test('honours ctx.concurrency by batching', async () => {
    let active = 0;
    let maxActive = 0;
    const client: BlockRangeClient = {
      async getBlockTransactions(height) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 1));
        active -= 1;
        return { height, txs: [] };
      },
    };
    const buckets = new Set([100, 200, 300, 400, 500, 600, 700, 800]);
    await collect(blockRangeFetcher(client)('w', buckets, { ...ctx(), concurrency: 2 }));
    // 2 buckets at a time, but within each bucket calls are sequential, so
    // maxActive == 2 exactly.
    expect(maxActive).toBe(2);
  });

  test('abort signal stops fetching', async () => {
    const ac = new AbortController();
    const calls: number[] = [];
    const client: BlockRangeClient = {
      async getBlockTransactions(height) {
        calls.push(height);
        // small async gap so the abort microtask can fire between calls
        await new Promise((r) => setTimeout(r, 0));
        return { height, txs: [] };
      },
    };
    const fetcher = blockRangeFetcher(client);
    // abort after a few microticks
    setTimeout(() => ac.abort(), 5);
    await collect(fetcher('w', new Set([1_700_000, 1_700_100, 1_700_200]), {
      ...ctx(),
      signal: ac.signal,
    }));
    expect(calls.length).toBeLessThan(300);
  });

  test('per-bucket error skips that bucket (null) without halting others', async () => {
    const errors: Array<{ bucket: number; height: number }> = [];
    const client: BlockRangeClient = {
      async getBlockTransactions(height) {
        if (height === 1_700_050) throw new Error('boom');
        return { height, txs: [] };
      },
    };
    const fetcher = blockRangeFetcher(client, {
      onError: (b, h) => errors.push({ bucket: b, height: h }),
    });
    const events = await collect(fetcher('w', new Set([1_700_000, 1_700_100]), ctx()));
    // 1_700_000 bucket errors at height 1_700_050 → null → not yielded
    // 1_700_100 bucket completes
    const buckets = events.map((e: MemoEvent) => e.bucketStart);
    expect(buckets).toEqual([1_700_100]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({ bucket: 1_700_000, height: 1_700_050 });
  });

  test('progress callback fires once per bucket', async () => {
    const { client } = fakeClient();
    const seen: Array<[number, number]> = [];
    const fetcher = blockRangeFetcher(client);
    await collect(fetcher('w', new Set([100, 200, 300]), {
      ...ctx(),
      onProgress: (done, total) => seen.push([done, total]),
    }));
    expect(seen.map(([d]) => d)).toEqual([1, 2, 3]);
    expect(seen.every(([_, t]) => t === 3)).toBe(true);
  });

  test('empty input → no events, no calls', async () => {
    const { client, calls } = fakeClient();
    const events = await collect(blockRangeFetcher(client)('w', new Set(), ctx()));
    expect(events).toEqual([]);
    expect(calls).toEqual([]);
  });
});
