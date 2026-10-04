/**
 * A paused or held sync must resume over the STORED tree, not the in-memory one.
 *
 * While catching up, scanned blocks live only in the wasm tree until a flush
 * (data for the wallet, every 5000th block, or the tip). A pause or hold ends
 * the run with those blocks still in memory, and the next run streams again
 * from the stored height. Without a reset, blocks K+1..N went into the tree a
 * second time: every later position shifted, nullifiers came out wrong and the
 * anchor was a root the chain never had.
 *
 * The fake view server below keeps the tree as the list of block heights it
 * holds, so a doubled block shows up as a duplicate and a wrong root as a list
 * that differs from the chain's.
 */

import { describe, expect, it, vi } from 'vitest';
import { BlockProcessor } from './block-processor';
import { AssetId } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { FullViewingKey } from '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb';
import { MerkleRoot } from '@penumbra-zone/protobuf/penumbra/crypto/tct/v1/tct_pb';

type BlockProcessorDeps = ConstructorParameters<typeof BlockProcessor>[0];

/** the last block the fake node has; the stream then waits, as keepAlive does */
const TIP = 60n;

const rootOf = (heights: readonly bigint[]) =>
  new MerkleRoot({ inner: new TextEncoder().encode(heights.join(',')) });

/** the chain's own tree after block h: every block 0..h, once */
const chainAt = (h: bigint) => Array.from({ length: Number(h) + 1 }, (_, i) => BigInt(i));

const tick = () =>
  new Promise(r => {
    setTimeout(r, 0);
  });

const makeChain = (start: { height: bigint | undefined; tree: bigint[] }) => {
  const db = { height: start.height, tree: [...start.tree], cleared: 0, failSaves: 0 };
  let memory = [...start.tree];

  const viewServer = {
    scanBlock: (block: { height: bigint }) => {
      memory.push(block.height);
      return Promise.resolve(false);
    },
    flushUpdates: () => ({
      height: memory[memory.length - 1] ?? 0n,
      sctUpdates: [...memory],
      newNotes: [],
      newSwaps: [],
    }),
    resetTreeToStored: () => {
      memory = [...db.tree];
      return Promise.resolve();
    },
    getSctRoot: () => rootOf(memory),
  };

  let closed: DOMException | undefined;
  const indexedDb = {
    getFullSyncHeight: () => (closed ? Promise.reject(closed) : Promise.resolve(db.height)),
    saveScanResult: (r: { height: bigint; sctUpdates: bigint[] }) => {
      if (db.failSaves > 0) {
        db.failSaves--;
        return Promise.reject(new Error('quota'));
      }
      db.tree = [...r.sctUpdates];
      db.height = r.height;
      return Promise.resolve();
    },
    clear: () => {
      db.cleared++;
      db.tree = [];
      db.height = undefined;
      return Promise.resolve();
    },
    addEpoch: () => Promise.resolve(),
    clearValidatorInfos: () => Promise.resolve(),
    getFmdParams: () => Promise.resolve({}),
    getAppParams: () => Promise.resolve({ chainId: 'penumbra-1', sctParams: {} }),
    iterateValidatorInfos: () => ({ next: () => Promise.resolve({ done: false, value: {} }) }),
  };

  const querier = {
    // far ahead: no block here is "new", so nothing flushes on its own
    tendermint: { latestBlockHeight: () => Promise.resolve(1_000_000n) },
    cnidarium: { fetchRemoteRoot: (h: bigint) => Promise.resolve(rootOf(chainAt(h))) },
    stake: {
      allValidatorInfos: async function* () {
        /* none */
      },
    },
    compactBlock: {
      compactBlockRange: async function* ({
        startHeight,
        abortSignal,
      }: {
        startHeight: bigint;
        abortSignal: AbortSignal;
      }) {
        for (let h = startHeight; ; h++) {
          if (h > TIP) {
            // keepAlive: hold the stream open until the run is aborted
            await new Promise(r => {
              abortSignal.addEventListener('abort', r);
            });
          }
          await tick();
          if (abortSignal.aborted) {
            throw new Error('aborted');
          }
          yield { height: h, nullifiers: [], swapOutputs: [], altGasPrices: [] };
        }
      },
    },
  };

  const processor = new BlockProcessor({
    querier,
    indexedDb,
    viewServer,
    numeraires: [],
    stakingAssetId: new AssetId({}),
    genesisBlock: undefined,
    walletCreationBlockHeight: undefined,
    compactFrontierBlockHeight: undefined,
    fullViewingKey: new FullViewingKey({}),
  } as unknown as BlockProcessorDeps);

  /** the browser closes the connection under the processor (the founder's "Sync failure #1680") */
  const closeConnection = () => {
    closed = new DOMException('The database connection is closing.', 'InvalidStateError');
  };

  return { processor, db, memory: () => memory, closeConnection };
};

const caughtUp = async (memory: () => bigint[]) =>
  vi.waitFor(() => expect(memory()[memory().length - 1]).toBe(TIP), { timeout: 5_000 });

describe('BlockProcessor resume', () => {
  it('a straight run holds every block once', async () => {
    const { processor, memory } = makeChain({ height: 0n, tree: [0n] });
    void processor.sync().catch(() => undefined);
    await caughtUp(memory);
    expect(memory()).toEqual(chainAt(TIP));
    processor.stop('test done');
  });

  it('pause mid catch-up, then resume: the same tree as a straight run', async () => {
    const { processor, db, memory } = makeChain({ height: 0n, tree: [0n] });
    void processor.sync().catch(() => undefined);
    await vi.waitFor(() => expect(memory().length).toBeGreaterThan(15));

    processor.pause();
    await new Promise(r => {
      setTimeout(r, 50);
    });
    // the blocks read before the pause are kept, as one tree with its height
    const last = memory()[memory().length - 1]!;
    expect(db.height).toBe(last);
    expect(db.tree).toEqual(chainAt(last));
    processor.resume();

    await caughtUp(memory);
    expect(memory()).toEqual(chainAt(TIP));
    expect(rootOf(memory()).equals(rootOf(chainAt(TIP)))).toBe(true);
    processor.stop('test done');
  });

  it('a pause whose save fails is read again from storage, never doubled', async () => {
    const { processor, db, memory } = makeChain({ height: 0n, tree: [0n] });
    void processor.sync().catch(() => undefined);
    await vi.waitFor(() => expect(memory().length).toBeGreaterThan(15));

    db.failSaves = 1;
    processor.pause();
    await new Promise(r => {
      setTimeout(r, 50);
    });
    expect(db.height).toBe(0n);
    processor.resume();

    await caughtUp(memory);
    expect(memory()).toEqual(chainAt(TIP));
    processor.stop('test done');
  });

  it('hold mid catch-up, then release: the same tree as a straight run', async () => {
    const { processor, memory } = makeChain({ height: 0n, tree: [0n] });
    void processor.sync().catch(() => undefined);
    await vi.waitFor(() => expect(memory().length).toBeGreaterThan(15));

    const release = processor.hold();
    await new Promise(r => {
      setTimeout(r, 50);
    });
    release();

    await caughtUp(memory);
    expect(memory()).toEqual(chainAt(TIP));
    processor.stop('test done');
  });

  it('pause and resume in quick succession, twice: still every block once', async () => {
    const { processor, memory } = makeChain({ height: 0n, tree: [0n] });
    void processor.sync().catch(() => undefined);
    await vi.waitFor(() => expect(memory().length).toBeGreaterThan(10));
    processor.pause();
    processor.resume();
    await vi.waitFor(() => expect(memory().length).toBeGreaterThan(25));
    processor.pause();
    processor.resume();

    await caughtUp(memory);
    expect(memory()).toEqual(chainAt(TIP));
    processor.stop('test done');
  });

  it('a stored tree the chain never had is read again from the start', async () => {
    // an older build doubled blocks 3 and 4, then flushed at 6
    const corrupt = [0n, 1n, 2n, 3n, 4n, 3n, 4n, 5n, 6n];
    const { processor, db, memory } = makeChain({ height: 6n, tree: corrupt });
    void processor.sync().catch(() => undefined);

    await caughtUp(memory);
    expect(db.cleared).toBe(1);
    expect(memory()).toEqual(chainAt(TIP));
    processor.stop('test done');
  });

  it('a sound stored tree is kept', async () => {
    const { processor, db, memory } = makeChain({ height: 6n, tree: chainAt(6n) });
    void processor.sync().catch(() => undefined);
    await caughtUp(memory);
    expect(db.cleared).toBe(0);
    expect(memory()).toEqual(chainAt(TIP));
    processor.stop('test done');
  });

  it('a closed database ends the loop once, told to its owner, instead of counting retries', async () => {
    const { processor, closeConnection } = makeChain({ height: 0n, tree: [0n] });
    closeConnection();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const told = vi.fn<[unknown], void>();
    processor.onStorageFailure = told;
    await processor.sync();
    expect(told).toHaveBeenCalledTimes(1);
    expect((told.mock.calls[0]![0] as DOMException).name).toBe('InvalidStateError');
    // a view call poking sync() again starts nothing on the dead connection
    await processor.sync();
    expect(told).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
