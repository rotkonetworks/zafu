import { describe, expect, it, vi } from 'vitest';
import { BlockPrefetcher } from './block-prefetcher';

interface Blk {
  height: number;
}

/** deterministic fake: every requested range resolves to its blocks */
const makeFetch = (
  opts: { empty?: Set<number>; fail?: Map<number, Error>; log?: number[][] } = {},
) => {
  const calls: number[][] = opts.log ?? [];
  const fetch = (start: number, end: number): Promise<Blk[]> => {
    calls.push([start, end]);
    const fail = opts.fail?.get(start);
    if (fail) {
      return Promise.reject(fail);
    }
    if (opts.empty?.has(start)) {
      return Promise.resolve([]);
    }
    const blocks: Blk[] = [];
    for (let h = start; h <= end; h++) {
      blocks.push({ height: h });
    }
    return Promise.resolve(blocks);
  };
  return { fetch, calls };
};

/** a fetch whose completion the test controls, one deferred per start height */
const makeDeferredFetch = () => {
  const pending = new Map<number, { resolve: (b: Blk[]) => void; reject: (e: unknown) => void }>();
  const order: number[] = [];
  const fetch = (start: number, _end: number): Promise<Blk[]> => {
    order.push(start);
    return new Promise<Blk[]>((resolve, reject) => pending.set(start, { resolve, reject }));
  };
  return { fetch, pending, order };
};

describe('BlockPrefetcher', () => {
  it('fills up to `depth` requests ahead and no further', () => {
    const { fetch, order } = makeDeferredFetch();
    const p = new BlockPrefetcher<Blk>({ fetch, batchSize: 100, depth: 3, isAborted: () => false });
    p.prime(1000, 10_000);
    expect(order).toEqual([1001, 1101, 1201]);
    expect(p.inFlight).toBe(3);
  });

  it('depth 1 reproduces the old strictly-serial loop', () => {
    const { fetch, order } = makeDeferredFetch();
    const p = new BlockPrefetcher<Blk>({ fetch, batchSize: 200, depth: 1, isAborted: () => false });
    p.prime(1000, 10_000);
    expect(order).toEqual([1001]);
  });

  it('hands batches back in contiguous ascending order regardless of completion order', async () => {
    const { fetch, pending } = makeDeferredFetch();
    const p = new BlockPrefetcher<Blk>({ fetch, batchSize: 10, depth: 3, isAborted: () => false });
    p.prime(0, 1000);

    // complete out of order: the third, then the first, then the second
    pending.get(21)!.resolve([{ height: 21 }]);
    pending.get(1)!.resolve([{ height: 1 }]);
    pending.get(11)!.resolve([{ height: 11 }]);

    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      const b = await p.next();
      seen.push(b!.start);
      // keep the pipeline fed so `next` never blocks on an unresolved slot
      for (const [, d] of pending) {
        d.resolve([]);
      }
    }
    expect(seen).toEqual([1, 11, 21]);
  });

  it('advances the cursor batch by batch across the whole range', async () => {
    const { fetch, calls } = makeFetch();
    const p = new BlockPrefetcher<Blk>({ fetch, batchSize: 100, depth: 4, isAborted: () => false });
    let cursor = 0;
    const ends: number[] = [];
    for (let i = 0; i < 5; i++) {
      p.prime(cursor, 1000);
      const b = await p.next();
      expect(b!.start).toBe(cursor + 1);
      cursor = b!.end;
      ends.push(cursor);
    }
    expect(ends).toEqual([100, 200, 300, 400, 500]);
    // every range requested exactly once, none skipped or duplicated:
    // the 5 consumed batches plus the 4 still queued ahead
    expect(calls.map(c => c[0])).toEqual([1, 101, 201, 301, 401, 501, 601, 701, 801]);
  });

  it('clamps the last batch to the chain tip', async () => {
    const { fetch } = makeFetch();
    const p = new BlockPrefetcher<Blk>({ fetch, batchSize: 100, depth: 4, isAborted: () => false });
    p.prime(0, 150);
    expect((await p.next())!.end).toBe(100);
    const last = await p.next();
    expect(last!.start).toBe(101);
    expect(last!.end).toBe(150);
    expect(await p.next()).toBeNull();
  });

  // ── the two correctness properties the pipeline must not break ──

  it('does not hand back an in-flight batch once the sync is aborted', async () => {
    const { fetch, pending } = makeDeferredFetch();
    let aborted = false;
    const p = new BlockPrefetcher<Blk>({
      fetch,
      batchSize: 100,
      depth: 2,
      isAborted: () => aborted,
    });
    p.prime(0, 10_000);

    const inflight = p.next();
    // the batch lands *after* the user stops the sync — the classic
    // apply-after-abort window
    aborted = true;
    pending.get(1)!.resolve([{ height: 1 }]);

    expect(await inflight).toBeNull();
    // and it stays null: an in-flight request can never resurrect the sync
    pending.get(101)!.resolve([{ height: 101 }]);
    expect(await p.next()).toBeNull();
    expect(p.inFlight).toBe(0);
  });

  it('queues nothing new once aborted', () => {
    const { fetch, order } = makeDeferredFetch();
    const p = new BlockPrefetcher<Blk>({ fetch, batchSize: 100, depth: 4, isAborted: () => true });
    p.prime(0, 10_000);
    expect(order).toEqual([]);
    expect(p.inFlight).toBe(0);
  });

  it('a transient empty batch does not advance the height and drops the look-ahead', async () => {
    const { fetch, calls } = makeFetch({ empty: new Set([201]) });
    const p = new BlockPrefetcher<Blk>({ fetch, batchSize: 100, depth: 3, isAborted: () => false });

    let cursor = 0;
    p.prime(cursor, 10_000);
    cursor = (await p.next())!.end; // 100
    p.prime(cursor, 10_000);
    cursor = (await p.next())!.end; // 200

    p.prime(cursor, 10_000);
    const empty = await p.next();
    expect(empty).not.toBeNull();
    expect(empty!.blocks).toEqual([]);
    expect(empty!.start).toBe(201);
    // caller holds its cursor — this is the "server reported a tip it has not
    // indexed" case, NOT "this range was empty"
    expect(cursor).toBe(200);
    // everything speculatively queued past the un-indexed range is gone, so a
    // later batch can never be applied over the skipped one
    expect(p.inFlight).toBe(0);

    // when the caller retries from the same cursor the range is re-requested
    calls.length = 0;
    p.prime(cursor, 10_000);
    expect(calls[0]).toEqual([201, 300]);
  });

  it('re-requests a range that a later retry re-primes, never skipping it', async () => {
    // same empty range, but the server has caught up by the retry
    const empty = new Set([201]);
    const { fetch } = makeFetch({ empty });
    const p = new BlockPrefetcher<Blk>({ fetch, batchSize: 100, depth: 3, isAborted: () => false });
    let cursor = 200;
    p.prime(cursor, 10_000);
    expect((await p.next())!.blocks).toEqual([]);

    empty.delete(201);
    p.prime(cursor, 10_000);
    const retried = await p.next();
    expect(retried!.start).toBe(201);
    expect(retried!.blocks).toHaveLength(100);
  });

  it('rethrows a failed fetch and discards everything queued behind it', async () => {
    const boom = new Error('tree root mismatch at height 500');
    const { fetch } = makeFetch({ fail: new Map([[101, boom]]) });
    const p = new BlockPrefetcher<Blk>({ fetch, batchSize: 100, depth: 3, isAborted: () => false });
    p.prime(0, 10_000);
    expect((await p.next())!.start).toBe(1);
    await expect(p.next()).rejects.toThrow('tree root mismatch');
    expect(p.inFlight).toBe(0);
  });

  it('does not apply a batch fetched before a rewind', async () => {
    const { fetch, pending } = makeDeferredFetch();
    const p = new BlockPrefetcher<Blk>({ fetch, batchSize: 100, depth: 3, isAborted: () => false });
    p.prime(1000, 10_000);

    // a continuity error rewinds the cursor while 1001.. is still in flight
    p.reset();
    p.prime(500, 10_000);

    // the pre-rewind fetch lands now — it describes a chain we no longer trust
    pending.get(1001)!.resolve([{ height: 1001 }]);
    pending.get(501)!.resolve([{ height: 501 }]);

    const b = await p.next();
    expect(b!.start).toBe(501);
    expect(b!.blocks).toEqual([{ height: 501 }]);
  });

  it('re-aims when the caller cursor no longer matches the queue head', () => {
    const { fetch, order } = makeDeferredFetch();
    const p = new BlockPrefetcher<Blk>({ fetch, batchSize: 100, depth: 2, isAborted: () => false });
    p.prime(1000, 10_000);
    expect(order).toEqual([1001, 1101]);
    p.prime(300, 10_000); // rewind
    expect(order).toEqual([1001, 1101, 301, 401]);
  });

  it('re-aims when the tip moves backwards', () => {
    const { fetch, order } = makeDeferredFetch();
    const p = new BlockPrefetcher<Blk>({ fetch, batchSize: 100, depth: 3, isAborted: () => false });
    p.prime(0, 10_000);
    expect(order).toEqual([1, 101, 201]);
    // endpoint now reports a SHORTER chain: nothing queued past 150 is valid
    p.prime(0, 150);
    expect(order).toEqual([1, 101, 201, 1, 101]);
    expect(p.inFlight).toBe(2);
  });

  it('never holds more than `depth` batches in memory', async () => {
    const { fetch } = makeFetch();
    const p = new BlockPrefetcher<Blk>({ fetch, batchSize: 100, depth: 2, isAborted: () => false });
    let cursor = 0;
    for (let i = 0; i < 20; i++) {
      p.prime(cursor, 1_000_000);
      expect(p.inFlight).toBeLessThanOrEqual(2);
      cursor = (await p.next())!.end;
    }
  });

  it('survives a fetch that throws synchronously', async () => {
    const boom = new Error('client torn down');
    const fetch = vi.fn(() => {
      throw boom;
    });
    const p = new BlockPrefetcher<Blk>({ fetch, batchSize: 100, depth: 2, isAborted: () => false });
    p.prime(0, 10_000);
    await expect(p.next()).rejects.toThrow('client torn down');
  });
});
