/**
 * Note commitment trees kept as ShardTrees (zafu-wasm `NoteTree`), one per
 * pool, so a spend reads each witness at a retained checkpoint instead of
 * replaying blocks from a snapshot.
 *
 * A tree that cannot be trusted is dropped, never repaired in place: the spend
 * then takes the per-note witness path, as it did before this existed. Every
 * root the tree produces is checked against the server's tree state before it
 * is used, so a wrong tree costs a fallback, never a bad spend.
 *
 * Rows live in the worker's `meta` store under `st:<pool>:...`, so deleting a
 * wallet deletes them and no schema bump is needed. They are written in the
 * same transaction as the batch they describe (`TreeWrite`).
 */

/** the zafu-wasm `NoteTree` class surface used here */
export interface NoteTree {
  load_shard(index: number, bytes: Uint8Array): void;
  load_cap(bytes: Uint8Array): void;
  load_checkpoints(bytes: Uint8Array): void;
  latest_checkpoint(): number | undefined;
  next_position(): number | undefined;
  is_marked(position: number): boolean;
  root_at(height: number): string | undefined;
  insert_frontier(frontierHex: string, height: number): void;
  insert_witness(witnessHex: string, height: number): void;
  insert_subtree_roots(startIndex: number, roots: Uint8Array): number;
  append_blocks(
    startPosition: number,
    blocks: Uint8Array,
    marked: Uint32Array,
    checkpointFrom: number,
  ): void;
  truncate(height: number): boolean;
  witness(position: number, height: number): string;
  take_changes(): TreeChanges;
  free(): void;
}

export interface TreeChanges {
  rewrite: boolean;
  shards: [number, Uint8Array][];
  cap?: Uint8Array;
  checkpoints?: Uint8Array;
}

export type TreePool = 'orchard' | 'ironwood';

/** checkpoints kept: the anchor and any rewind must land on one of these */
export const MAX_CHECKPOINTS = 100;

export const treeKeyPrefix = (pool: TreePool) => `st:${pool}:`;
const shardKey = (pool: TreePool, index: number) =>
  `st:${pool}:s:${String(index).padStart(8, '0')}`;
const SHARD_KEY = /^st:(orchard|ironwood):s:(\d{8})$/;

/** rows to write for one pool, inside the batch's transaction */
export interface TreeWrite {
  pool: TreePool;
  /** delete the pool's shard rows first (after a truncation) */
  rewriteShards?: boolean;
  /** delete every row of the pool (the tree was dropped) */
  clear?: boolean;
  puts: { key: string; value: Uint8Array | number }[];
}

export const changesToWrite = (pool: TreePool, c: TreeChanges): TreeWrite => {
  const puts: TreeWrite['puts'] = c.shards.map(([index, bytes]) => ({
    key: shardKey(pool, index),
    value: bytes,
  }));
  if (c.cap) {
    puts.push({ key: `st:${pool}:cap`, value: c.cap });
  }
  if (c.checkpoints) {
    puts.push({ key: `st:${pool}:ck`, value: c.checkpoints });
  }
  return { pool, rewriteShards: c.rewrite, puts };
};

/** key ranges of the `meta` store ([walletId, key]) holding a pool's rows */
export const treeRowRange = (walletId: string, pool: TreePool, shardsOnly = false) => {
  const prefix = shardsOnly ? `st:${pool}:s:` : treeKeyPrefix(pool);
  return IDBKeyRange.bound([walletId, prefix], [walletId, `${prefix}￿`]);
};

/** apply writes to an open readwrite `meta` store (requests run in order) */
export const applyTreeWrites = (
  meta: IDBObjectStore,
  walletId: string,
  writes: readonly TreeWrite[],
): void => {
  for (const w of writes) {
    if (w.clear) {
      meta.delete(treeRowRange(walletId, w.pool));
    } else if (w.rewriteShards) {
      meta.delete(treeRowRange(walletId, w.pool, true));
    }
    for (const { key, value } of w.puts) {
      meta.put({ walletId, key, value });
    }
  }
};

/**
 * Rebuild a tree from its rows. Undefined when there is nothing stored, or the
 * rows do not load (a tree that half-loads is worse than none).
 */
export const loadTree = (
  rows: readonly { key: string; value: unknown }[],
  pool: TreePool,
  make: () => NoteTree,
): NoteTree | undefined => {
  const mine = rows.filter(r => r.key.startsWith(treeKeyPrefix(pool)));
  const ck = mine.find(r => r.key === `st:${pool}:ck`)?.value;
  if (!(ck instanceof Uint8Array)) {
    return undefined;
  }
  const tree = make();
  try {
    for (const r of mine) {
      const m = SHARD_KEY.exec(r.key);
      if (m && r.value instanceof Uint8Array) {
        tree.load_shard(Number(m[2]), r.value);
      }
    }
    const cap = mine.find(r => r.key === `st:${pool}:cap`)?.value;
    if (cap instanceof Uint8Array) {
      tree.load_cap(cap);
    }
    tree.load_checkpoints(ck);
    return tree;
  } catch (e) {
    console.warn(`[zcash-worker] ${pool} note tree rows do not load: ${String(e)}`);
    tree.free();
    return undefined;
  }
};

/** where the next GetSubtreeRoots call for a pool starts */
export const rootsIndexOf = (rows: readonly { key: string; value: unknown }[], pool: TreePool) => {
  const v = rows.find(r => r.key === `st:${pool}:roots`)?.value;
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
};

/** `[u32 height][u32 n][n x 32-byte cmx]...`, little-endian, for append_blocks */
export const encodeBlocks = (blocks: readonly { height: number; cmxs: Uint8Array[] }[]) => {
  let len = 0;
  for (const b of blocks) {
    len += 8 + 32 * b.cmxs.length;
  }
  const out = new Uint8Array(len);
  const view = new DataView(out.buffer);
  let off = 0;
  for (const b of blocks) {
    view.setUint32(off, b.height, true);
    view.setUint32(off + 4, b.cmxs.length, true);
    off += 8;
    for (const cmx of b.cmxs) {
      // a malformed cmx is hashed as the empty leaf, as the replay path does
      if (cmx.length === 32) {
        out.set(cmx, off);
      } else {
        out.fill(0xff, off, off + 32);
      }
      off += 32;
    }
  }
  return out;
};

/** concatenated 32-byte roots for insert_subtree_roots */
export const concatRoots = (roots: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(32 * roots.length);
  roots.forEach((r, i) => {
    if (r.length !== 32) {
      throw new Error(`subtree root ${i} is ${r.length} bytes`);
    }
    out.set(r, 32 * i);
  });
  return out;
};

/**
 * Seed an empty tree from the frontier the sync loop holds and every stored
 * per-note witness at that frontier's size (no network, no replay). Notes whose
 * witness is at another size stay unmarked and keep the old path.
 */
export const seedTree = (
  tree: NoteTree,
  frontierHex: string,
  height: number,
  witnesses: readonly { witness_hex: string }[],
): { seeded: number; failed: number } => {
  tree.insert_frontier(frontierHex, height);
  return addWitnesses(tree, witnesses);
};

/** migrate stored witnesses at the tree's newest checkpoint; failures are counted, not thrown */
export const addWitnesses = (
  tree: NoteTree,
  witnesses: readonly { witness_hex: string }[],
): { seeded: number; failed: number } => {
  const at = tree.latest_checkpoint();
  let seeded = 0;
  let failed = 0;
  if (at === undefined) {
    return { seeded, failed: witnesses.length };
  }
  for (const w of witnesses) {
    try {
      tree.insert_witness(w.witness_hex, at);
      seeded++;
    } catch {
      failed++;
    }
  }
  return { seeded, failed };
};

export interface TreePaths {
  anchorHeight: number;
  rootHex: string;
  paths: { position: number; path: { hash: string }[] }[];
}

/**
 * Paths for `positions` at the newest checkpoint at or below `maxHeight`
 * (the newest checkpoint when it is omitted), read in one synchronous step so
 * a live sync cannot move the tree in between. A string says why the tree
 * cannot answer; the caller then takes the old path.
 */
export const treePaths = (
  tree: NoteTree,
  positions: readonly number[],
  maxHeight?: number,
): TreePaths | string => {
  const latest = tree.latest_checkpoint();
  if (latest === undefined) {
    return 'the tree has no checkpoint';
  }
  let anchorHeight = latest;
  if (maxHeight !== undefined && latest > maxHeight) {
    if (tree.root_at(maxHeight) === undefined) {
      return `no retained checkpoint at ${maxHeight} (newest ${latest})`;
    }
    anchorHeight = maxHeight;
  }
  const unmarked = positions.filter(p => !tree.is_marked(p));
  if (unmarked.length > 0) {
    return `${unmarked.length}/${positions.length} notes are not in the tree`;
  }
  const rootHex = tree.root_at(anchorHeight);
  if (rootHex === undefined) {
    return `no root at ${anchorHeight}`;
  }
  const paths = positions.map(p => {
    const w = JSON.parse(tree.witness(p, anchorHeight)) as {
      position: number;
      root_hex: string;
      path: { hash: string }[];
    };
    return { position: w.position, path: w.path };
  });
  return { anchorHeight, rootHex, paths };
};
