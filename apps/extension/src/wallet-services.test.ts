import { beforeEach, describe, expect, it } from 'vitest';
import { localExtStorage } from '@repo/storage-chrome/local';
import { AppParameters } from '@penumbra-zone/protobuf/penumbra/core/app/v1/app_pb';
import { publishSyncHeight, refreshChainId, startChainId } from './wallet-services';

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

describe('params come from storage first', () => {
  const source = (stored: string | undefined, node: string | undefined | Error) => {
    const calls: string[] = [];
    let saved: AppParameters | undefined;
    return {
      calls,
      saved: () => saved,
      source: {
        stored: () => {
          calls.push('stored');
          return Promise.resolve(stored ? new AppParameters({ chainId: stored }) : undefined);
        },
        fetch: () => {
          calls.push('node');
          return node instanceof Error
            ? Promise.reject(node)
            : Promise.resolve(node ? new AppParameters({ chainId: node }) : undefined);
        },
        save: (p: AppParameters) => {
          calls.push('save');
          saved = p;
          return Promise.resolve();
        },
      },
    };
  };

  it('starts on the stored chain id without asking the node', async () => {
    const s = source('penumbra-1', 'penumbra-1');
    expect(await startChainId(s.source)).toEqual({ chainId: 'penumbra-1', confirmed: false });
    expect(s.calls).toEqual(['stored']);
  });

  it('asks the node only when nothing is stored, and stores its answer', async () => {
    const s = source(undefined, 'penumbra-1');
    expect(await startChainId(s.source)).toEqual({ chainId: 'penumbra-1', confirmed: true });
    expect(s.calls).toEqual(['stored', 'node', 'save']);
    expect(s.saved()?.chainId).toBe('penumbra-1');
  });

  it('a first run with no node and nothing stored has no chain id', async () => {
    await expect(startChainId(source(undefined, new Error('down')).source)).rejects.toThrow(
      'No chainId available',
    );
  });

  it('the refresh reports the node chain id, storing params only when they changed', async () => {
    const same = source('penumbra-1', 'penumbra-1');
    expect(await refreshChainId(same.source)).toBe('penumbra-1');
    expect(same.calls).not.toContain('save');

    const moved = source('penumbra-1', 'penumbra-2');
    expect(await refreshChainId(moved.source)).toBe('penumbra-2');
    expect(moved.saved()?.chainId).toBe('penumbra-2');
  });

  it('a node that does not answer leaves the stored params alone', async () => {
    const s = source('penumbra-1', new Error('down'));
    expect(await refreshChainId(s.source)).toBeUndefined();
    expect(s.calls).toEqual(['node']);
  });
});
