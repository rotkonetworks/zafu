// Note trees on the real shipped blob: every path must equal the old replay
// path's (build_merkle_paths from the empty tree), across a reload from rows
// and a migration from a stored per-note witness.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  addWitnesses,
  applyTreeWrites,
  changesToWrite,
  concatRoots,
  encodeBlocks,
  loadTree,
  MAX_CHECKPOINTS,
  rootsIndexOf,
  seedTree,
  treePaths,
  type NoteTree,
  type TreeWrite,
} from './note-trees';
import { encodeSubtreeRootsArg, parseSubtreeRootStream } from '../state/keyring/subtree-roots';

interface Wasm {
  initSync(opts: { module: Uint8Array }): void;
  NoteTree: new (maxCheckpoints: number) => NoteTree;
  build_merkle_paths(tree: string, blocks: string, positions: string, anchor: number): string;
  build_witnesses_and_paths(tree: string, blocks: string, positions: string): string;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** deterministic cmxs below 2^254 (always canonical), in blocks of 0..4 */
const makeChain = (n: number) => {
  let x = 0x9e3779b9;
  const next = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x >>> 0;
  };
  const blocks: { height: number; cmxs: Uint8Array[] }[] = [];
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

const asJson = (blocks: { height: number; cmxs: Uint8Array[] }[]) =>
  JSON.stringify(
    blocks.map(b => ({ height: b.height, actions: b.cmxs.map(c => ({ cmx_hex: hex(c) })) })),
  );

const sizeAfter = (blocks: { cmxs: Uint8Array[] }[]) =>
  blocks.reduce((n, b) => n + b.cmxs.length, 0);

/** the worker's `meta` store, by key, for one wallet */
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
  beforeAll(async () => {
    (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange ??= {
      bound: (lower: unknown, upper: unknown) => ({ lower, upper }),
    };
    wasm = (await import('@repo/zcash-wasm')) as unknown as Wasm;
    wasm.initSync({
      module: readFileSync(resolve(process.cwd(), '../../packages/zcash-wasm/zafu_wasm_bg.wasm')),
    });
  });

  const write = (meta: FakeMeta, writes: TreeWrite[]) =>
    applyTreeWrites(meta as unknown as IDBObjectStore, 'w', writes);

  test('seeded, appended in batches, reloaded from rows: the replay paths', () => {
    const chain = makeChain(3_000);
    const cut = 400; // blocks in the first batch
    const notes = [17, sizeAfter(chain.slice(0, cut)) + 3, 2_998];
    const end = chain[chain.length - 1]!.height;
    const oracle = JSON.parse(
      wasm.build_merkle_paths('', asJson(chain), JSON.stringify(notes), end),
    ) as { anchor_hex: string; paths: { position: number; path: { hash: string }[] }[] };

    const meta = new FakeMeta();
    const tree = new wasm.NoteTree(MAX_CHECKPOINTS);
    expect(seedTree(tree, '', 1_999, [])).toEqual({ seeded: 0, failed: 0 });
    const marked = (from: number, to: number) => notes.filter(p => p >= from && p < to);
    const s1 = sizeAfter(chain.slice(0, cut));
    tree.append_blocks(
      0,
      encodeBlocks(chain.slice(0, cut)),
      Uint32Array.from(marked(0, s1)),
      end - 50,
    );
    write(meta, [changesToWrite('orchard', tree.take_changes())]);
    tree.append_blocks(
      s1,
      encodeBlocks(chain.slice(cut)),
      Uint32Array.from(marked(s1, 3_000)),
      end - 50,
    );
    write(meta, [changesToWrite('orchard', tree.take_changes())]);
    tree.free();

    const loaded = loadTree(meta.list(), 'orchard', () => new wasm.NoteTree(MAX_CHECKPOINTS))!;
    expect(loaded.latest_checkpoint()).toBe(end);
    expect(loaded.next_position()).toBe(3_000);
    const got = treePaths(loaded, notes);
    expect(got).toEqual({ anchorHeight: end, rootHex: oracle.anchor_hex, paths: oracle.paths });
    // the other pool has no rows, and a note outside the tree is refused, not guessed
    expect(
      loadTree(meta.list(), 'ironwood', () => new wasm.NoteTree(MAX_CHECKPOINTS)),
    ).toBeUndefined();
    expect(treePaths(loaded, [18])).toMatch(/not in the tree/);
    // an anchor below the newest checkpoint must be one that is retained
    expect(treePaths(loaded, notes, chain[cut]!.height)).toMatch(/no retained checkpoint/);
    loaded.free();
  });

  test('a stored per-note witness migrates with no replay', () => {
    const chain = makeChain(1_500);
    const head = chain.slice(0, 300);
    const size = sizeAfter(head);
    const h = head[head.length - 1]!.height;
    // what the wallet has stored today: a witness at the frontier's size
    const legacy = JSON.parse(
      wasm.build_witnesses_and_paths('', asJson(head), JSON.stringify([5])),
    ) as { end_frontier_hex: string; entries: { witness_hex: string }[] };

    const tree = new wasm.NoteTree(MAX_CHECKPOINTS);
    expect(seedTree(tree, legacy.end_frontier_hex, h, legacy.entries)).toEqual({
      seeded: 1,
      failed: 0,
    });
    // a witness at another size is counted, not thrown
    expect(addWitnesses(tree, [{ witness_hex: '00' }])).toEqual({ seeded: 0, failed: 1 });
    tree.append_blocks(size, encodeBlocks(chain.slice(300)), new Uint32Array(), 0);

    const end = chain[chain.length - 1]!.height;
    const oracle = JSON.parse(wasm.build_merkle_paths('', asJson(chain), '[5]', end)) as {
      anchor_hex: string;
      paths: unknown[];
    };
    expect(treePaths(tree, [5])).toEqual({
      anchorHeight: end,
      rootHex: oracle.anchor_hex,
      paths: oracle.paths,
    });
    tree.free();
  });

  test('a dropped tree clears every row; a truncation rewrites the shards', () => {
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
    // rows that do not load give no tree rather than half of one
    meta.put({ key: 'st:ironwood:s:00000000', value: new Uint8Array([9]) });
    expect(
      loadTree(meta.list(), 'ironwood', () => new wasm.NoteTree(MAX_CHECKPOINTS)),
    ).toBeUndefined();
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
