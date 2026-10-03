/**
 * A snapshot start writes nothing until the snapshot is in hand.
 *
 * The height used to be saved before the view server was built from the
 * snapshot, so a failed init left an empty stored tree at the snapshot height;
 * the block processor then took the wallet for a fresh one, flushed the empty
 * tree as its frontier and read on from there with every position counted from
 * zero. Now the frontier and its height are saved together, once, and a failed
 * init stores nothing and reads the chain from genesis.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FullViewingKey, WalletId } from '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb';

const h = vi.hoisted(() => ({
  stored: undefined as bigint | undefined,
  saved: [] as { height: bigint; sctUpdates: unknown }[],
  savedHeights: [] as bigint[],
  snapshotFails: false,
  processorArgs: undefined as Record<string, unknown> | undefined,
}));

vi.mock('@penumbra-zone/storage/indexed-db', () => ({
  IndexedDb: {
    initialize: () =>
      Promise.resolve({
        getFullSyncHeight: () => Promise.resolve(h.stored),
        saveFullSyncHeight: (height: bigint) => {
          h.savedHeights.push(height);
          return Promise.resolve();
        },
        saveScanResult: (r: { height: bigint; sctUpdates: unknown }) => {
          h.saved.push(r);
          return Promise.resolve();
        },
        getStateCommitmentTree: () => Promise.resolve({}),
        constants: () => ({}),
      }),
  },
}));

vi.mock('@penumbra-zone/query/root-querier', () => ({
  RootQuerier: class {
    sct = {
      sctFrontier: () => Promise.resolve({ height: 5000n, compactFrontier: new Uint8Array() }),
    };
  },
}));

vi.mock('@penumbra-zone/query/block-processor', () => ({
  BlockProcessor: class {
    constructor(args: Record<string, unknown>) {
      h.processorArgs = args;
    }
    sync = () => Promise.resolve();
  },
}));

vi.mock('@penumbrafi/wasm/view-server', () => ({
  ViewServer: {
    initialize: () => Promise.resolve({ kind: 'stored' }),
    initialize_from_snapshot: () =>
      h.snapshotFails
        ? Promise.reject(new Error('bad frontier'))
        : Promise.resolve({
            kind: 'snapshot',
            // a snapshot server that has scanned nothing reports u64::MAX
            flushUpdates: () => ({
              height: 0xffffffffffffffffn,
              sctUpdates: { set_position: 'frontier' },
              newNotes: [],
              newSwaps: [],
            }),
          }),
  },
}));

vi.mock('./registry-client', () => ({
  withBundledFallback: () => ({
    bundled: { globals: () => ({ stakingAssetId: {} }) },
  }),
}));

const { Services } = await import('./index');

const start = (cfg: { creation?: number; frontier?: number }) =>
  new Services({
    chainId: 'penumbra-testnet',
    grpcEndpoint: 'http://node',
    walletId: new WalletId({}),
    fullViewingKey: new FullViewingKey({}),
    numeraires: [],
    walletCreationBlockHeight: cfg.creation,
    compactFrontierBlockHeight: cfg.frontier,
  }).getWalletServices();

describe('snapshot start', () => {
  beforeEach(() => {
    h.stored = undefined;
    h.saved = [];
    h.savedHeights = [];
    h.snapshotFails = false;
    h.processorArgs = undefined;
    vi.stubGlobal('fetch', () => Promise.resolve({ arrayBuffer: () => new ArrayBuffer(0) }));
  });

  it('saves the frontier and its height together, at the frontier height', async () => {
    const ws = await start({ creation: 4000, frontier: 4000 });
    expect(h.savedHeights).toEqual([]);
    expect(h.saved).toEqual([
      expect.objectContaining({ height: 5000n, sctUpdates: { set_position: 'frontier' } }),
    ]);
    expect((ws.viewServer as unknown as { kind: string }).kind).toBe('snapshot');
    expect(h.processorArgs?.['compactFrontierBlockHeight']).toBe(5000);
  });

  it('a failed snapshot init stores nothing and is read from genesis', async () => {
    h.snapshotFails = true;
    const ws = await start({ creation: 4000, frontier: 4000 });
    expect(h.savedHeights).toEqual([]);
    expect(h.saved).toEqual([]);
    expect((ws.viewServer as unknown as { kind: string }).kind).toBe('stored');
    expect(h.processorArgs?.['compactFrontierBlockHeight']).toBeUndefined();
  });

  it('a wallet that stored height 0 (a genesis read) is never given a snapshot', async () => {
    h.stored = 0n;
    const ws = await start({ creation: 4000, frontier: 4000 });
    expect(h.saved).toEqual([]);
    expect((ws.viewServer as unknown as { kind: string }).kind).toBe('stored');
  });
});
