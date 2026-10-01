/**
 * The sync loop must outlive a dropped stream.
 *
 * `keepAlive` asks the node to hold the compact-block stream open, but a proxy
 * or a node restart can still end it cleanly. A clean end used to return from
 * syncAndStore, which cleared the sync promise: the wallet then resumed only
 * when some unrelated view RPC poked `sync()` again - a GetStatus and a fresh
 * stream per view call, with no block processed in between (the reported
 * "workers looping on getStatus, nothing happening"). The loop re-subscribes on
 * its own now, and this pins that: the stream is opened again after it ends.
 */

import { describe, expect, it, vi } from 'vitest';
import { BlockProcessor } from './block-processor';
import { AssetId } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { FullViewingKey } from '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb';

type BlockProcessorDeps = ConstructorParameters<typeof BlockProcessor>[0];

/** `onStream` counts streams that reach the network: an aborted signal never does */
const makeProcessor = (onStream: () => void) =>
  // partial doubles: only what syncAndStore touches before the stream loop
  new BlockProcessor({
    querier: {
      tendermint: { latestBlockHeight: () => Promise.resolve(100n) },
      compactBlock: {
        // ends immediately, without yielding a block: the dropped-stream case
        compactBlockRange: ({ abortSignal }: { abortSignal: AbortSignal }) => {
          if (abortSignal.aborted) {
            throw new Error('aborted');
          }
          onStream();
          return (async function* () {
            /* no blocks: the node has nothing to send and closed the stream */
          })();
        },
      },
    },
    indexedDb: {
      getFullSyncHeight: () => Promise.resolve(99n),
      getFmdParams: () => Promise.resolve({}),
      getAppParams: () => Promise.resolve({ chainId: 'penumbra-1', sctParams: {} }),
      // a stored validator keeps the (fire-and-forget) validator repair out of
      // this test - it would otherwise fetch the validator list
      iterateValidatorInfos: () => ({ next: () => Promise.resolve({ done: false, value: {} }) }),
    },
    viewServer: { resetTreeToStored: () => Promise.resolve(undefined) },
    numeraires: [],
    stakingAssetId: new AssetId({}),
    genesisBlock: undefined,
    walletCreationBlockHeight: undefined,
    compactFrontierBlockHeight: undefined,
    fullViewingKey: new FullViewingKey({}),
  } as unknown as BlockProcessorDeps);

describe('BlockProcessor sync loop', () => {
  it('reopens the compact block stream when it ends cleanly', async () => {
    let streamsOpened = 0;
    const processor = makeProcessor(() => streamsOpened++);

    // never settles by design (the loop is indefinite); stop() ends it, and the
    // abort surfaces as a rejection we are not asserting on here
    void processor.sync().catch(() => undefined);

    await vi.waitFor(() => expect(streamsOpened).toBeGreaterThanOrEqual(2), { timeout: 5_000 });
    processor.stop('test done');
  });

  it('stays stopped: a later sync or resume through old services opens nothing', async () => {
    let streamsOpened = 0;
    const processor = makeProcessor(() => streamsOpened++);
    void processor.sync().catch(() => undefined);
    await vi.waitFor(() => expect(streamsOpened).toBeGreaterThanOrEqual(1));

    processor.pause();
    processor.stop('wallet switch');
    const before = streamsOpened;
    await processor.sync();
    processor.resume();
    await new Promise(r => {
      setTimeout(r, 1_500);
    });
    expect(streamsOpened).toBe(before);
  });
});
