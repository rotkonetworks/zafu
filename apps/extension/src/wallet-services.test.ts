import { beforeEach, describe, expect, it } from 'vitest';
import { localExtStorage } from '@repo/storage-chrome/local';
import { publishSyncHeight } from './wallet-services';

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;

/** an indexedDb double: a stored height, then the heights pushed to its subscription */
const db = (stored: bigint | undefined) => {
  const queue: bigint[] = [];
  let wake: (() => void) | undefined;
  return {
    push: (h: bigint) => {
      queue.push(h);
      wake?.();
    },
    indexedDb: {
      getFullSyncHeight: () => Promise.resolve(stored),
      subscribe: () =>
        (async function* () {
          for (;;) {
            while (queue.length) {
              yield { value: queue.shift()! };
            }
            await new Promise<void>(r => (wake = r));
          }
        })(),
    } as never,
  };
};

const published = () => localExtStorage.get('penumbraSync');
const tick = () => new Promise(r => setTimeout(r, 10));

describe('publishSyncHeight', () => {
  beforeEach(() => localMock.clear());

  it('names the wallet and the height this run started from', async () => {
    const d = db(12_997_731n);
    void publishSyncHeight('w1', d, new AbortController().signal);
    await tick();
    expect(await published()).toEqual({ walletId: 'w1', height: 12_997_731, from: 12_997_731 });
    d.push(12_997_800n);
    await tick();
    expect(await published()).toEqual({ walletId: 'w1', height: 12_997_800, from: 12_997_731 });
  });

  it('a fresh scan starts from the start of the chain', async () => {
    void publishSyncHeight('w1', db(undefined), new AbortController().signal);
    await tick();
    expect(await published()).toEqual({ walletId: 'w1', height: 0, from: 0 });
  });

  it('writes nothing once its wallet is switched away from', async () => {
    const old = db(435_000n);
    const stop = new AbortController();
    void publishSyncHeight('w0', old, stop.signal);
    await tick();
    stop.abort();
    void publishSyncHeight('w1', db(12_997_731n), new AbortController().signal);
    await tick();
    old.push(435_001n);
    await tick();
    expect(await published()).toEqual({ walletId: 'w1', height: 12_997_731, from: 12_997_731 });
  });
});
