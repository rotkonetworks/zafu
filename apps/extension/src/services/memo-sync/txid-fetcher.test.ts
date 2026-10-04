import { describe, expect, it } from 'vitest';
import { txidMemoFetcher } from './txid-fetcher';

const ctx = (signal = new AbortController().signal) => ({ signal, tip: 100, activation: 0 });

const collect = async <T>(it: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const x of it) {
    out.push(x);
  }
  return out;
};

describe('txidMemoFetcher', () => {
  it('asks for each txid in wire order and yields one block per height', async () => {
    const asked: string[] = [];
    const client = {
      getTransaction: async (txid: Uint8Array) => {
        asked.push(Buffer.from(txid).toString('hex'));
        return { data: txid };
      },
    };
    const byHeight = new Map([
      [150, new Set(['0a0b', '0c0d'])],
      [260, new Set(['0e0f'])],
    ]);
    const progress: [number, number][] = [];
    const events = await collect(
      txidMemoFetcher(client, byHeight)('w', new Set(), {
        ...ctx(),
        onProgress: (a, b) => progress.push([a, b]),
      }),
    );
    expect(asked).toEqual(['0b0a', '0d0c', '0f0e']);
    expect(events.map(e => [e.bucketStart, e.blocks[0]!.height, e.blocks[0]!.txs.length])).toEqual([
      [100, 150, 2],
      [200, 260, 1],
    ]);
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it('throws on a failed fetch instead of yielding an empty block', async () => {
    const client = {
      getTransaction: () => Promise.reject(new Error('not found')),
    };
    await expect(
      collect(txidMemoFetcher(client, new Map([[1, new Set(['00'])]]))('w', new Set(), ctx())),
    ).rejects.toThrow('not found');
  });

  it('stops when aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const client = { getTransaction: () => Promise.resolve({ data: new Uint8Array() }) };
    const events = await collect(
      txidMemoFetcher(client, new Map([[1, new Set(['00'])]]))('w', new Set(), ctx(ac.signal)),
    );
    expect(events).toEqual([]);
  });
});
