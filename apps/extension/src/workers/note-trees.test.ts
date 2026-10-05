// Note trees on the real shipped blob, against a chain built in the test: every
// path must equal a full replay's (build_merkle_paths from the empty tree), across
// reload, migration from the per-note era, recovery, rewind and reseeding.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  applyTreeWrites,
  changesToWrite,
  concatRoots,
  encodeBlocks,
  legacyWitnesses,
  loadTree,
  MAX_CHECKPOINTS,
  openTrees,
  RESEED_INTERVAL_MS,
  retiredLegacy,
  rootsIndexOf,
  SHARD_LEAVES,
  treePaths,
  withoutWitness,
  type NoteTree,
  type TreeBlock,
  type TreeChain,
  type TreeWrite,
} from './note-trees';
import { encodeSubtreeRootsArg, parseSubtreeRootStream } from '../state/keyring/subtree-roots';

interface Wasm {
  initSync(opts: { module: Uint8Array }): void;
  NoteTree: new (maxCheckpoints: number) => NoteTree;
  build_merkle_paths(tree: string, blocks: string, positions: string, anchor: number): string;
  build_witnesses_and_paths(tree: string, blocks: string, positions: string): string;
  tree_root_hex(tree: string): string;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** deterministic cmxs below 2^254 (always canonical), in blocks of 0..4 from height 2000 */
const makeChain = (n: number): TreeBlock[] => {
  let x = 0x9e3779b9;
  const next = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x >>> 0;
  };
  const blocks: TreeBlock[] = [];
  let made = 0;
  for (let height = 2_000; made < n; height++) {
    const k = Math.min(next() % 5, n - made);
    const cmxs = Array.from({ length: k }, () => {
      const b = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        b[i] = next() & 0xff;
      }
      b[31]! &= 0x3f;
      return b;
    });
    blocks.push({ height, cmxs });
    made += k;
  }
  return blocks;
};

const asJson = (blocks: readonly TreeBlock[]) =>
  JSON.stringify(
    blocks.map(b => ({ height: b.height, actions: b.cmxs.map(c => ({ cmx_hex: hex(c) })) })),
  );

const upTo = (chain: readonly TreeBlock[], height: number) => chain.filter(b => b.height <= height);
const sizeAt = (chain: readonly TreeBlock[], height: number) =>
  upTo(chain, height).reduce((n, b) => n + b.cmxs.length, 0);
/** position of the k-th leaf of the first block at or above `height` that has one */
const leafNear = (chain: readonly TreeBlock[], height: number) => {
  const b = chain.find(x => x.height >= height && x.cmxs.length > 0)!;
  return { position: sizeAt(chain, b.height - 1), height: b.height };
};

/** the worker's `meta` store for one wallet, by key */
class FakeMeta {
  rows = new Map<string, unknown>();
  put({ key, value }: { key: string; value: unknown }) {
    this.rows.set(key, value);
  }
  delete(range: { lower: [string, string]; upper: [string, string] }) {
    for (const k of [...this.rows.keys()]) {
      if (k >= range.lower[1] && k <= range.upper[1]) {
        this.rows.delete(k);
      }
    }
  }
  list() {
    return [...this.rows].map(([key, value]) => ({ key, value }));
  }
}

describe('note trees on the real wasm', () => {
  let wasm: Wasm;
  const make = () => new wasm.NoteTree(MAX_CHECKPOINTS);
  /** the frontier (zcashd hex) after block `height` */
  const frontier = (chain: readonly TreeBlock[], height: number) =>
    (
      JSON.parse(wasm.build_witnesses_and_paths('', asJson(upTo(chain, height)), '[]')) as {
        end_frontier_hex: string;
      }
    ).end_frontier_hex;
  /** the replay oracle: root and paths at `height` */
  const replay = (chain: readonly TreeBlock[], positions: number[], height: number) =>
    JSON.parse(
      wasm.build_merkle_paths('', asJson(upTo(chain, height)), JSON.stringify(positions), height),
    ) as { anchor_hex: string; paths: { position: number; path: { hash: string }[] }[] };
  /** a server over `chain`, counting the blocks it serves */
  const serverOver = (chain: readonly TreeBlock[]) => {
    const served = { blocks: 0 };
    const c: TreeChain = {
      frontierAt: (_pool, height) => Promise.resolve(height <= 0 ? '' : frontier(chain, height)),
      sizeAt: (_pool, height) => Promise.resolve(sizeAt(chain, height)),
      subtreeRoots: () => Promise.resolve([]),
      blocks: (_pool, from, to) => {
        const out = chain.filter(b => b.height >= from && b.height <= to);
        served.blocks += out.length;
        return Promise.resolve(out);
      },
      poolStart: () => 2_000,
    };
    return { chain: c, served };
  };
  const write = (meta: FakeMeta, writes: TreeWrite[]) =>
    applyTreeWrites(meta as unknown as IDBObjectStore, 'w', writes);

  beforeAll(async () => {
    (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange ??= {
      bound: (lower: unknown, upper: unknown) => ({ lower, upper }),
    };
    wasm = (await import('@repo/zcash-wasm')) as unknown as Wasm;
    wasm.initSync({
      module: readFileSync(resolve(process.cwd(), '../../packages/zcash-wasm/zafu_wasm_bg.wasm')),
    });
  });

  test('a fresh wallet: seeded, appended in batches, reloaded from rows, the replay paths', async () => {
    const chain = makeChain(3_000);
    const birthday = 2_100;
    const end = chain[chain.length - 1]!.height;
    const { chain: server } = serverOver(chain);
    const meta = new FakeMeta();
    const trees = await openTrees(
      make,
      server,
      [],
      [{ pool: 'orchard', height: birthday, size: sizeAt(chain, birthday), legacy: [] }],
    );
    write(meta, trees.takeWrites());
    const notes = [leafNear(chain, 2_150), leafNear(chain, 2_600)];
    const mid = 2_400;
    for (const [from, to] of [
      [birthday + 1, mid],
      [mid + 1, end],
    ] as const) {
      const batch = chain.filter(b => b.height >= from && b.height <= to);
      const start = trees.size('orchard')!;
      const found = notes.filter(n => n.height >= from && n.height <= to).map(n => n.position);
      trees.append('orchard', start, batch, found, end - 50);
      write(meta, trees.takeWrites());
    }
    trees.free();

    const loaded = loadTree(meta.list(), 'orchard', make)!;
    expect(loaded.latest_checkpoint()).toBe(end);
    const positions = notes.map(n => n.position);
    const oracle = replay(chain, positions, end);
    expect(treePaths(loaded, positions)).toEqual({
      anchorHeight: end,
      rootHex: oracle.anchor_hex,
      paths: oracle.paths,
    });
    // a spend's requested anchor lands on the newest checkpoint at or below it
    const older = treePaths(loaded, positions, end - 3);
    expect(typeof older !== 'string' && older.anchorHeight).toBe(end - 3);
    // an anchor below a note cannot carry it; one above both is fine
    expect(treePaths(loaded, positions, mid)).toMatch(/no path at 2400/);
    expect(treePaths(loaded, positions, birthday - 1)).toMatch(/no retained checkpoint/);
    // a note outside the tree is refused, not guessed
    expect(treePaths(loaded, [positions[0]! + 1])).toMatch(/not in the tree yet/);
    loaded.free();
  });

  test('the per-note era migrates: aligned witnesses taken, a stale one recovered, rows retired', async () => {
    const chain = makeChain(2_000);
    const synced = 2_500;
    const size = sizeAt(chain, synced);
    const kept = leafNear(chain, 2_100);
    const stale = leafNear(chain, 2_200);
    const spent = leafNear(chain, 2_300);
    // the witnesses as the old version stored them: two at the synced size,
    // one left behind at an older size
    const atSynced = JSON.parse(
      wasm.build_witnesses_and_paths(
        '',
        asJson(upTo(chain, synced)),
        JSON.stringify([kept.position, spent.position]),
      ),
    ) as { entries: { witness_hex: string }[] };
    const behind = JSON.parse(
      wasm.build_witnesses_and_paths('', asJson(upTo(chain, 2_400)), `[${stale.position}]`),
    ) as { entries: { witness_hex: string }[] };
    // real-shaped stored records: orchard notes carry their witness, ironwood
    // ones live in the witnesses-ironwood store
    const record = (n: { position: number; height: number }, nf: string) => ({
      walletId: 'w',
      height: n.height,
      value: '50000',
      nullifier: nf,
      cmx: 'aa'.repeat(32),
      txid: 'bb'.repeat(32),
      position: n.position,
      is_change: false,
      rseed: 'cc'.repeat(32),
      rho: 'dd'.repeat(32),
      recipient: 'ee'.repeat(43),
    });
    const noteRecords = [
      {
        ...record(kept, 'nf-kept'),
        witness_hex: atSynced.entries[0]!.witness_hex,
        witness_tree_size: size,
      },
      {
        ...record(stale, 'nf-stale'),
        witness_hex: behind.entries[0]!.witness_hex,
        witness_tree_size: sizeAt(chain, 2_400),
      },
      {
        ...record(spent, 'nf-spent'),
        witness_hex: atSynced.entries[1]!.witness_hex,
        witness_tree_size: size,
      },
      { ...record(kept, 'nf-iw'), pool: 'ironwood' as const },
    ];
    const iwRows = [
      { walletId: 'w', nullifier: 'nf-iw', witness_hex: 'not-a-witness', witness_tree_size: 7 },
    ];
    const byPool = legacyWitnesses(noteRecords, iwRows, new Set(['nf-spent']));
    expect(byPool.orchard).toHaveLength(2);
    expect(byPool.ironwood).toEqual([{ witness_hex: 'not-a-witness', witness_tree_size: 7 }]);
    // the record a migration writes back: everything but the witness
    const { witness_hex: _w, witness_tree_size: _s, ...bare } = noteRecords[0]!;
    expect(withoutWitness(noteRecords[0]!)).toEqual(bare);

    const { chain: server, served } = serverOver(chain);
    const trees = await openTrees(
      make,
      server,
      [],
      [{ pool: 'orchard', height: synced, size, legacy: byPool.orchard }],
    );
    const tree = trees.get('orchard')!;
    expect(tree.is_marked(kept.position)).toBe(true);
    expect(tree.is_marked(stale.position)).toBe(false);
    expect(served.blocks).toBe(0);

    // the sync loop scans on, then recovers the stale note once caught up
    const end = chain[chain.length - 1]!.height;
    trees.append(
      'orchard',
      size,
      chain.filter(b => b.height > synced),
      [],
      end,
    );
    await trees.recover('orchard', [kept, stale]);
    expect(served.blocks).toBeGreaterThan(0);
    const positions = [kept.position, stale.position];
    const oracle = replay(chain, positions, end);
    expect(treePaths(tree, positions)).toEqual({
      anchorHeight: end,
      rootHex: oracle.anchor_hex,
      paths: oracle.paths,
    });
    // nothing left to recover: no blocks fetched
    const before = served.blocks;
    await trees.recover('orchard', [kept, stale]);
    expect(served.blocks).toBe(before);
    trees.free();
  });

  test('a stored tree that does not end where the wallet does is reseeded', async () => {
    const chain = makeChain(1_200);
    const { chain: server } = serverOver(chain);
    const meta = new FakeMeta();
    const first = await openTrees(
      make,
      server,
      [],
      [{ pool: 'orchard', height: 2_200, size: sizeAt(chain, 2_200), legacy: [] }],
    );
    write(meta, first.takeWrites());
    first.free();
    // the wallet says it is at 2_300: the stored tree (at 2_200) is not that
    const second = await openTrees(make, server, meta.list(), [
      { pool: 'orchard', height: 2_300, size: sizeAt(chain, 2_300), legacy: [] },
    ]);
    expect(second.get('orchard')!.latest_checkpoint()).toBe(2_300);
    expect(second.size('orchard')).toBe(sizeAt(chain, 2_300));
    second.free();
  });

  test('a rewind lands on a retained checkpoint; past them it reseeds', async () => {
    const chain = makeChain(1_500);
    const { chain: server } = serverOver(chain);
    const trees = await openTrees(
      make,
      server,
      [],
      [{ pool: 'orchard', height: 2_000, size: sizeAt(chain, 2_000), legacy: [] }],
    );
    const note = leafNear(chain, 2_050);
    const end = chain[chain.length - 1]!.height;
    trees.append(
      'orchard',
      trees.size('orchard')!,
      chain.filter(b => b.height > 2_000),
      [note.position],
      end - 30,
    );
    const landed = await trees.rewind(end - 10, 0);
    expect(landed).toBe(end - 10);
    expect(trees.size('orchard')).toBe(sizeAt(chain, end - 10));
    expect(trees.get('orchard')!.is_marked(note.position)).toBe(true);
    // between checkpoints: lands on the one below (the seed at 2_000 is the only one there)
    expect(await trees.rewind(end - 100, 0)).toBe(2_000);
    // below everything retained: reseeded from the server at the target
    expect(await trees.rewind(1_999, 0)).toBe(1_999);
    expect(trees.size('orchard')).toBe(sizeAt(chain, 1_999));
    expect(trees.get('orchard')!.is_marked(note.position)).toBe(false);
    trees.free();
  });

  test('a tree that differs from the server is reseeded; a matching one is kept', async () => {
    const chain = makeChain(800);
    const { chain: server } = serverOver(chain);
    const trees = await openTrees(
      make,
      server,
      [],
      [{ pool: 'orchard', height: 2_100, size: sizeAt(chain, 2_100), legacy: [] }],
    );
    const f = frontier(chain, 2_100);
    const same = { frontier: f, root: wasm.tree_root_hex(f) };
    expect(await trees.check('orchard', 2_100, same)).toBe(false);
    const other = frontier(chain, 2_101);
    const differs = { frontier: other, root: wasm.tree_root_hex(other) };
    // differs: asks without changing anything
    trees.takeWrites();
    expect(trees.differs('orchard', 2_100, same.root)).toBe(false);
    expect(trees.differs('orchard', 2_100, differs.root)).toBe(true);
    expect(trees.differs('orchard', 2_099, differs.root)).toBe(false);
    expect(trees.differs('orchard', 2_100, undefined)).toBe(false);
    expect(trees.differs('ironwood', 2_100, differs.root)).toBe(false);
    expect(trees.takeWrites()).toEqual([]);
    // one answer, or two that disagree with each other, never replace the tree
    expect(await trees.check('orchard', 2_100, differs)).toBe(false);
    expect(await trees.check('orchard', 2_100, differs, () => Promise.resolve(same))).toBe(false);
    expect(await trees.check('orchard', 2_100, differs, () => Promise.resolve(differs))).toBe(true);
    // a dropped tree (a batch it refused) is reseeded by the next check
    trees.append('orchard', trees.size('orchard')!, [], [], 0);
    expect(trees.get('orchard')).toBeDefined();
    trees.append('orchard', 5, chain.slice(200, 201), [], 0);
    expect(trees.get('orchard')).toBeUndefined();
    expect(await trees.check('orchard', 2_150, { frontier: f, root: 'x' })).toBe(true);
    expect(trees.get('orchard')).toBeDefined();
    // the dropped tree's rows are cleared before the reseed's are written
    const writes = trees.takeWrites();
    expect(writes.some(w => w.clear)).toBe(true);
    trees.free();
  });

  test('legacy witnesses are retired only for a pool that has a tree', () => {
    expect(retiredLegacy({ orchard: true, ironwood: false })).toEqual({
      orchardWitnessFields: true,
      ironwoodRows: false,
      metaKeys: ['orchardTreeFrontier', 'orchardTreeFrontierHeight', 'frontierSnapshots'],
    });
    const none = retiredLegacy({ orchard: false, ironwood: false });
    expect(none.orchardWitnessFields || none.ironwoodRows).toBe(false);
    expect(none.metaKeys).toEqual([]);
  });

  test('rows: a dropped tree clears them, a truncation rewrites the shards, bad rows load nothing', () => {
    const meta = new FakeMeta();
    meta.put({ key: 'syncHeight', value: 5 });
    write(meta, [
      { pool: 'orchard', puts: [{ key: 'st:orchard:s:00000001', value: new Uint8Array([1]) }] },
      { pool: 'orchard', puts: [{ key: 'st:orchard:roots', value: 7 }] },
      { pool: 'ironwood', puts: [{ key: 'st:ironwood:ck', value: new Uint8Array([0, 0, 0, 0]) }] },
    ]);
    expect(rootsIndexOf(meta.list(), 'orchard')).toBe(7);
    expect(rootsIndexOf(meta.list(), 'ironwood')).toBe(0);
    write(meta, [{ pool: 'orchard', rewriteShards: true, puts: [] }]);
    expect([...meta.rows.keys()].sort()).toEqual([
      'st:ironwood:ck',
      'st:orchard:roots',
      'syncHeight',
    ]);
    write(meta, [{ pool: 'orchard', clear: true, puts: [] }]);
    expect([...meta.rows.keys()].sort()).toEqual(['st:ironwood:ck', 'syncHeight']);
    meta.put({ key: 'st:ironwood:s:00000000', value: new Uint8Array([9]) });
    expect(loadTree(meta.list(), 'ironwood', make)).toBeUndefined();
    // changesToWrite keys shards by a fixed-width index, so a range covers them
    const t = make();
    t.insert_frontier('', 1);
    expect(changesToWrite('orchard', t.take_changes()).puts.map(p => p.key)).toContain(
      'st:orchard:ck',
    );
    t.free();
  });
});

describe('wire helpers', () => {
  test('encodeBlocks lays out height, count and cmxs; a bad cmx becomes an invalid one', () => {
    const out = encodeBlocks([
      { height: 0x01020304, cmxs: [new Uint8Array(32).fill(7), new Uint8Array(3)] },
      { height: 9, cmxs: [] },
    ]);
    expect(out.length).toBe(8 + 64 + 8);
    expect([...out.subarray(0, 8)]).toEqual([4, 3, 2, 1, 2, 0, 0, 0]);
    expect(out[8]).toBe(7);
    expect([...out.subarray(40, 72)]).toEqual(Array<number>(32).fill(0xff));
    expect([...out.subarray(72)]).toEqual([9, 0, 0, 0, 0, 0, 0, 0]);
    expect(() => concatRoots([new Uint8Array(31)])).toThrow(/31 bytes/);
  });

  test('GetSubtreeRoots request and stream', () => {
    expect([...encodeSubtreeRootsArg('ironwood', 300)]).toEqual([0x08, 0xac, 0x02, 0x10, 2]);
    expect([...encodeSubtreeRootsArg('orchard', 0, 5)]).toEqual([0x08, 0, 0x10, 1, 0x18, 5]);
    const root = new Uint8Array(32).fill(0xab);
    // SubtreeRoot { rootHash = 2; completingBlockHeight = 4 }
    const msg = new Uint8Array([0x12, 32, ...root, 0x20, 0xe8, 0x07]);
    const frame = (flags: number, body: Uint8Array) =>
      new Uint8Array([flags, 0, 0, 0, body.length, ...body]);
    const ok = new TextEncoder().encode('grpc-status:0\r\n');
    const stream = new Uint8Array([...frame(0, msg), ...frame(0, msg), ...frame(0x80, ok)]);
    const roots = parseSubtreeRootStream(stream);
    expect(roots).toHaveLength(2);
    expect(roots[0]).toEqual({ rootHash: root, completingBlockHeight: 1000 });
    const bad = new TextEncoder().encode('grpc-status:12\r\ngrpc-message:nope\r\n');
    expect(() => parseSubtreeRootStream(frame(0x80, bad))).toThrow(/nope/);
  });
});

describe('shard recovery on the real wasm', () => {
  let wasm: Wasm;
  const make = () => new wasm.NoteTree(MAX_CHECKPOINTS);
  const write = (meta: FakeMeta, writes: TreeWrite[]) =>
    applyTreeWrites(meta as unknown as IDBObjectStore, 'w', writes);

  // one complete shard and part of the next, in blocks of 0..40 leaves
  const N = SHARD_LEAVES + 3_000;
  let chain: TreeBlock[];
  let end: number;
  /** the block that brings the tree to SHARD_LEAVES */
  let completing: number;
  let root0: Uint8Array;
  /** the frontier at the tip (one slow replay, shared by the tests) */
  let tip: string;
  /** a tree that saw every block, with every note marked: the oracle */
  let full: NoteTree;
  let notes: { position: number; height: number }[];

  /** a server over the chain that records the ranges it serves */
  const server = (opts: { failBlocks?: (from: number) => boolean } = {}) => {
    const ranges: [number, number][] = [];
    const c: TreeChain = {
      frontierAt: (_pool, height) => {
        if (height !== end) {
          throw new Error(`no frontier at ${height} in this test`);
        }
        return Promise.resolve(tip);
      },
      sizeAt: (_pool, height) => Promise.resolve(sizeAt(chain, height)),
      subtreeRoots: (_pool, start) =>
        Promise.resolve([{ rootHash: root0, completingBlockHeight: completing }].slice(start)),
      blocks: (_pool, from, to) => {
        if (opts.failBlocks?.(from)) {
          return Promise.reject(new Error('node gap'));
        }
        ranges.push([from, to]);
        return Promise.resolve(chain.filter(b => b.height >= from && b.height <= to));
      },
      poolStart: () => 2_000,
    };
    return { chain: c, ranges };
  };
  const open = (c: TreeChain, rows: { key: string; value: unknown }[] = [], now?: () => number) =>
    openTrees(make, c, rows, [{ pool: 'orchard', height: end, size: N, legacy: [] }], now);

  beforeAll(async () => {
    (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange ??= {
      bound: (lower: unknown, upper: unknown) => ({ lower, upper }),
    };
    wasm = (await import('@repo/zcash-wasm')) as unknown as Wasm;
    wasm.initSync({
      module: readFileSync(resolve(process.cwd(), '../../packages/zcash-wasm/zafu_wasm_bg.wasm')),
    });
    let x = 0x2545f491;
    const next = () => {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      return x >>> 0;
    };
    chain = [];
    let made = 0;
    for (let height = 2_000; made < N; height++) {
      const k = Math.min(next() % 41, N - made);
      chain.push({
        height,
        cmxs: Array.from({ length: k }, () => {
          const b = new Uint8Array(32);
          for (let i = 0; i < 32; i++) {
            b[i] = next() & 0xff;
          }
          b[31]! &= 0x3f;
          return b;
        }),
      });
      made += k;
    }
    end = chain[chain.length - 1]!.height;
    let size = 0;
    completing = chain.find(b => (size += b.cmxs.length) >= SHARD_LEAVES)!.height;
    notes = [leafNear(chain, 2_100), leafNear(chain, completing + 3)];
    full = make();
    full.insert_frontier('', 1_999);
    full.append_blocks(0, encodeBlocks(chain), Uint32Array.from(notes.map(n => n.position)), end);
    // a shard-1 note's level-16 sibling is shard 0's root
    root0 = new Uint8Array(
      Buffer.from(
        (JSON.parse(full.witness(notes[1]!.position, end)) as { path: { hash: string }[] })
          .path[16]!.hash,
        'hex',
      ),
    );
    tip = (
      JSON.parse(wasm.build_witnesses_and_paths('', asJson(chain), '[]')) as {
        end_frontier_hex: string;
      }
    ).end_frontier_hex;
  }, 120_000);

  const expectOracle = (tree: NoteTree) => {
    const positions = notes.map(n => n.position);
    const want = treePaths(full, positions);
    expect(typeof want).not.toBe('string');
    expect(treePaths(tree, positions)).toEqual(want);
  };

  test('each shard is replayed from its own blocks only, checked by its root', async () => {
    const { chain: c, ranges } = server();
    const trees = await open(c);
    // the complete shard: from the pool's start to the block that completed it
    expect(await trees.recover('orchard', [notes[0]!])).toMatchObject({ left: 0, recovered: 1 });
    expect(ranges).toEqual([[2_000, completing]]);
    // the tip's shard: from that block to the tree's checkpoint
    expect(await trees.recover('orchard', notes)).toMatchObject({ left: 0, recovered: 1 });
    expect(ranges[1]).toEqual([completing, end]);
    expectOracle(trees.get('orchard')!);
    trees.free();
  });

  test('a budget hands the loop back between shards; a failed shard backs off, the rest go on', async () => {
    let clock = 1_000_000;
    const { chain: c, ranges } = server({ failBlocks: from => from === 2_000 });
    const meta = new FakeMeta();
    const trees = await open(c, [], () => clock);
    // a zero budget runs one shard per call: shard 0 fails and waits
    expect(await trees.recover('orchard', notes, undefined, 0)).toMatchObject({
      left: 2,
      waiting: 1,
    });
    // the next call skips it and goes on to shard 1
    expect(await trees.recover('orchard', notes, undefined, 0)).toMatchObject({
      left: 1,
      waiting: 1,
    });
    // still waiting: nothing is fetched
    expect(await trees.recover('orchard', notes)).toMatchObject({ left: 1, waiting: 1 });
    expect(ranges).toEqual([[completing, end]]);
    write(meta, trees.takeWrites());
    // the backoff and the recovered mark are in the rows, so a restart keeps both
    expect(String(meta.rows.get('st:orchard:rec'))).toContain('"fails":1');
    trees.free();
    const again = server();
    clock += 2 * 60_000;
    const reopened = await open(again.chain, meta.list(), () => clock);
    expect(reopened.get('orchard')!.is_marked(notes[1]!.position)).toBe(true);
    expect(await reopened.recover('orchard', notes)).toMatchObject({ left: 0 });
    expect(again.ranges).toEqual([[2_000, completing]]);
    expectOracle(reopened.get('orchard')!);
    reopened.free();
  });

  test('a reseed keeps the marks its subtree roots confirm, and is taken at most once an hour', async () => {
    let clock = 5_000_000;
    const { chain: c } = server();
    const trees = await open(c, [], () => clock);
    await trees.recover('orchard', notes);
    const wrong = { frontier: tip, root: 'not-our-root' };
    expect(await trees.check('orchard', end, wrong, () => Promise.resolve(wrong))).toBe(true);
    const tree = trees.get('orchard')!;
    // shard 0 is confirmed by its root: kept. shard 1 holds the tip: recovered again
    expect(notes.map(n => tree.is_marked(n.position))).toEqual([true, false]);
    expect(await trees.recover('orchard', notes)).toMatchObject({ left: 0, recovered: 1 });
    expectOracle(tree);
    // a second server-asked reseed within the hour is refused, the tree kept
    expect(await trees.check('orchard', end, wrong, () => Promise.resolve(wrong))).toBe(false);
    expect(trees.get('orchard')).toBe(tree);
    await expect(trees.rewind(2_100, 0)).rejects.toThrow(/within the hour/);
    clock += RESEED_INTERVAL_MS;
    expect(await trees.check('orchard', end, wrong, () => Promise.resolve(wrong))).toBe(true);
    trees.free();
  });
});
