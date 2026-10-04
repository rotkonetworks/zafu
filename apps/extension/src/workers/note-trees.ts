/**
 * Note commitment trees kept as ShardTrees (zafu-wasm `NoteTree`), one per
 * pool: the only source of spend witnesses. A spend reads each path at a
 * retained checkpoint and never fetches a block.
 *
 * A tree that cannot be trusted is reseeded from the server's tree state, and
 * the notes it no longer holds are recovered by the sync loop (`recover`, the
 * one remaining replay) - never by a send. Every root a spend uses is checked
 * against the server's at the anchor, so a wrong tree costs a delay, never a
 * bad spend.
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
  checkpoint_at_or_below(height: number): number | undefined;
  recover(frontierHex: string, blocks: Uint8Array, positions: Uint32Array, height: number): number;
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
  return IDBKeyRange.bound([walletId, prefix], [walletId, `${prefix}\uffff`]);
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
  const anchorHeight =
    maxHeight === undefined ? tree.latest_checkpoint() : tree.checkpoint_at_or_below(maxHeight);
  if (anchorHeight === undefined) {
    return maxHeight === undefined
      ? 'the tree has no checkpoint'
      : `no retained checkpoint at or below ${maxHeight}`;
  }
  const unmarked = positions.filter(p => !tree.is_marked(p));
  if (unmarked.length > 0) {
    return `${unmarked.length}/${positions.length} notes are not in the tree yet`;
  }
  const rootHex = tree.root_at(anchorHeight);
  if (rootHex === undefined) {
    return `no root at ${anchorHeight}`;
  }
  try {
    const paths = positions.map(p => {
      const w = JSON.parse(tree.witness(p, anchorHeight)) as {
        position: number;
        root_hex: string;
        path: { hash: string }[];
      };
      return { position: w.position, path: w.path };
    });
    return { anchorHeight, rootHex, paths };
  } catch (e) {
    // a note newer than the anchor, most often
    return `no path at ${anchorHeight}: ${e instanceof Error ? e.message : String(e)}`;
  }
};

// ── one sync run's trees ──

export interface TreeBlock {
  height: number;
  cmxs: Uint8Array[];
}

/** what the trees need from the chain (the server's tree state is public data) */
export interface TreeChain {
  /** the pool's zcashd frontier at `height`; '' = the empty tree; undefined = the server has none */
  frontierAt(pool: TreePool, height: number): Promise<string | undefined>;
  subtreeRoots(pool: TreePool, start: number): Promise<{ rootHash: Uint8Array }[]>;
  blocks(pool: TreePool, from: number, to: number, signal?: AbortSignal): Promise<TreeBlock[]>;
}

/** an unspent note of the pool, as far as the tree is concerned */
export interface TreeNote {
  position: number;
  height: number;
}

/** a per-note IncrementalWitness the wallet stored before the trees existed */
export interface LegacyWitness {
  witness_hex: string;
  witness_tree_size: number;
}

export interface PoolStart {
  pool: TreePool;
  /** the sync height the stored tree must end at */
  height: number;
  /** the tree size the loop stored with that height */
  size: number;
  legacy: readonly LegacyWitness[];
}

/** a replay from a rounded height below the notes (so the request does not point at one) */
export const RECOVERY_ROUNDING = 5_000;

export interface Trees {
  get(pool: TreePool): NoteTree | undefined;
  /** the pool's tree size, where the next batch starts; undefined without a tree */
  size(pool: TreePool): number | undefined;
  /** append one batch; a refused batch drops the tree until the next `check` */
  append(
    pool: TreePool,
    startSize: number,
    blocks: readonly TreeBlock[],
    marked: readonly number[],
    checkpointFrom: number,
  ): void;
  /**
   * Compare the tree with the server's tree state at the tree's newest
   * checkpoint `height`. A tree that differs, or a dropped one, is reseeded
   * from the server's frontier. True when the pool was reseeded (its notes then
   * need `recover`).
   */
  check(
    pool: TreePool,
    height: number,
    server: { frontier: string; root: string } | undefined,
  ): boolean;
  /**
   * Roll every tree back to the newest checkpoint at or below `target` they all
   * retain (not below `floor`), or reseed them from the server at `target`.
   * Returns the height the trees now end at.
   */
  rewind(target: number, floor: number): Promise<number>;
  /** replay the blocks a pool's unmarked notes need, up to its newest checkpoint */
  recover(pool: TreePool, notes: readonly TreeNote[], signal?: AbortSignal): Promise<void>;
  takeWrites(): TreeWrite[];
  free(): void;
}

const log = (msg: string) => console.log(`[zcash-worker] ${msg}`);
const warn = (msg: string) => console.warn(`[zcash-worker] ${msg}`);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Load each pool's stored tree, or seed it from the server at the sync height
 * (taking the legacy witnesses that stand at that size), then take any new
 * subtree roots. A pool the server has no tree for stays without one.
 */
export const openTrees = async (
  make: () => NoteTree,
  chain: TreeChain,
  rows: readonly { key: string; value: unknown }[],
  starts: readonly PoolStart[],
): Promise<Trees> => {
  const trees: Partial<Record<TreePool, NoteTree>> = {};
  let writes: TreeWrite[] = [];
  const collect = (pool: TreePool) => {
    const t = trees[pool];
    if (t) {
      writes.push(changesToWrite(pool, t.take_changes()));
    }
  };
  const forget = (pool: TreePool) => {
    trees[pool]?.free();
    delete trees[pool];
    writes = writes.filter(w => w.pool !== pool);
    writes.push({ pool, clear: true, puts: [] });
  };
  const seed = (pool: TreePool, frontierHex: string | undefined, height: number) => {
    forget(pool);
    if (frontierHex === undefined) {
      return;
    }
    const t = make();
    t.insert_frontier(frontierHex, height);
    trees[pool] = t;
    collect(pool);
  };
  const takeRoots = async (pool: TreePool, from: number) => {
    const t = trees[pool];
    if (!t) {
      return;
    }
    try {
      const roots = await chain.subtreeRoots(pool, from);
      if (roots.length > 0) {
        const taken = t.insert_subtree_roots(from, concatRoots(roots.map(r => r.rootHash)));
        writes.push({ pool, puts: [{ key: `st:${pool}:roots`, value: from + taken }] });
        collect(pool);
      }
    } catch (e) {
      // roots that disagree with our own hashes say the tree is wrong
      if (errText(e).includes('do not match')) {
        warn(`${pool} note tree disagrees with the server's subtree roots: reseeding`);
        throw e;
      }
      warn(`${pool} subtree roots unavailable: ${errText(e)}`);
    }
  };

  for (const p of starts) {
    let t = loadTree(rows, p.pool, make);
    if (t && (t.next_position() !== p.size || t.latest_checkpoint() !== p.height)) {
      warn(
        `${p.pool} note tree ends at ${t.next_position()}@${t.latest_checkpoint()}, ` +
          `the wallet at ${p.size}@${p.height}: reseeding`,
      );
      t.free();
      t = undefined;
    }
    if (t) {
      trees[p.pool] = t;
    } else {
      seed(p.pool, await chain.frontierAt(p.pool, p.height), p.height);
      const fresh = trees[p.pool];
      if (fresh && p.legacy.length > 0) {
        const size = fresh.next_position();
        const r = addWitnesses(
          fresh,
          p.legacy.filter(w => w.witness_tree_size === size),
        );
        log(`${p.pool} note tree seeded at ${p.height}: ${r.seeded} stored witnesses taken`);
        collect(p.pool);
      }
    }
    try {
      await takeRoots(p.pool, rootsIndexOf(rows, p.pool));
    } catch {
      seed(p.pool, await chain.frontierAt(p.pool, p.height), p.height);
    }
  }

  return {
    get: pool => trees[pool],
    size: pool => trees[pool]?.next_position(),
    append(pool, startSize, blocks, marked, checkpointFrom) {
      const t = trees[pool];
      if (!t) {
        return;
      }
      try {
        t.append_blocks(startSize, encodeBlocks(blocks), Uint32Array.from(marked), checkpointFrom);
        collect(pool);
      } catch (e) {
        warn(`${pool} note tree dropped, batch refused: ${errText(e)}`);
        forget(pool);
      }
    },
    check(pool, height, server) {
      const t = trees[pool];
      if (!server) {
        return false;
      }
      if (t) {
        if (t.latest_checkpoint() !== height || t.root_at(height) === server.root) {
          return false;
        }
        warn(`${pool} note tree root at ${height} differs from the server's: reseeding`);
      }
      seed(pool, server.frontier, height);
      return true;
    },
    async rewind(target, floor) {
      const pools = Object.keys(trees) as TreePool[];
      const landing = pools.reduce<number | undefined>((low, pool) => {
        const at = trees[pool]!.checkpoint_at_or_below(target);
        return at === undefined || low === undefined ? undefined : Math.min(low, at);
      }, target);
      if (landing !== undefined && landing >= floor) {
        for (const pool of pools) {
          const t = trees[pool]!;
          if (t.root_at(landing) !== undefined && t.truncate(landing)) {
            collect(pool);
          } else {
            seed(pool, await chain.frontierAt(pool, landing), landing);
          }
        }
        return landing;
      }
      for (const pool of ['orchard', 'ironwood'] as const) {
        if (trees[pool] || starts.some(s => s.pool === pool)) {
          seed(pool, await chain.frontierAt(pool, target), target);
        }
      }
      return target;
    },
    async recover(pool, notes, signal) {
      const t = trees[pool];
      const height = t?.latest_checkpoint();
      if (!t || height === undefined) {
        return;
      }
      const lost = notes.filter(n => !t.is_marked(n.position));
      if (lost.length === 0) {
        return;
      }
      const t0 = performance.now();
      const lowest = Math.min(...lost.map(n => n.height));
      const from = Math.max(1, Math.floor((lowest - 1) / RECOVERY_ROUNDING) * RECOVERY_ROUNDING);
      const frontier = await chain.frontierAt(pool, from);
      if (frontier === undefined) {
        throw new Error(`no ${pool} tree state at ${from}`);
      }
      const blocks = await chain.blocks(pool, from + 1, height, signal);
      signal?.throwIfAborted();
      // the loop has not moved the tree while the blocks were fetched
      if (trees[pool] !== t || t.latest_checkpoint() !== height) {
        return;
      }
      t.recover(
        frontier,
        encodeBlocks(blocks),
        Uint32Array.from(lost.map(n => n.position)),
        height,
      );
      collect(pool);
      log(
        `${pool} note tree recovered ${lost.length} notes from ${from} to ${height} ` +
          `(${blocks.length} blocks, ${Math.round(performance.now() - t0)}ms)`,
      );
    },
    takeWrites() {
      const out = writes;
      writes = [];
      return out;
    },
    free() {
      for (const t of Object.values(trees)) {
        t.free();
      }
    },
  };
};

// ── what the wallet stored before the trees ──

/** a note record as stored before the trees: orchard records carried their witness */
export interface LegacyNoteRecord {
  nullifier: string;
  pool?: TreePool;
  witness_hex?: string;
  witness_tree_size?: number;
}

/** a row of the old `witnesses-ironwood` store */
export interface LegacyIronwoodRow {
  nullifier: string;
  witness_hex: string;
  witness_tree_size: number;
}

/** the stored per-note witnesses of unspent notes, by pool */
export const legacyWitnesses = (
  notes: readonly LegacyNoteRecord[],
  ironwoodRows: readonly LegacyIronwoodRow[],
  spent: ReadonlySet<string>,
): Record<TreePool, LegacyWitness[]> => {
  const out: Record<TreePool, LegacyWitness[]> = { orchard: [], ironwood: [] };
  const valid = (w: Partial<LegacyWitness>): w is LegacyWitness =>
    typeof w.witness_hex === 'string' && Number.isSafeInteger(w.witness_tree_size);
  for (const n of notes) {
    if ((n.pool ?? 'orchard') === 'orchard' && !spent.has(n.nullifier) && valid(n)) {
      out.orchard.push({ witness_hex: n.witness_hex, witness_tree_size: n.witness_tree_size });
    }
  }
  for (const r of ironwoodRows) {
    if (!spent.has(r.nullifier) && valid(r)) {
      out.ironwood.push({ witness_hex: r.witness_hex, witness_tree_size: r.witness_tree_size });
    }
  }
  return out;
};

/** a note record without the witness fields the trees replaced (other fields untouched) */
export const withoutWitness = <T extends LegacyNoteRecord>(
  note: T,
): Omit<T, 'witness_hex' | 'witness_tree_size'> => {
  const { witness_hex: _w, witness_tree_size: _s, ...rest } = note;
  return rest;
};

/** meta keys of the per-note witness era, deleted once the trees are seeded */
export const LEGACY_META_KEYS = [
  'orchardTreeFrontier',
  'orchardTreeFrontierHeight',
  'ironwoodTreeFrontier',
  'ironwoodTreeFrontierHeight',
  'frontierSnapshots',
] as const;
