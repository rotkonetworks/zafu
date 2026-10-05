/**
 * Note commitment trees kept as ShardTrees (zafu-wasm `NoteTree`), one per
 * pool: the only source of spend witnesses. A spend reads each path at a
 * retained checkpoint and never fetches a block.
 *
 * A tree that cannot be trusted is reseeded from the server's tree state. The
 * marks of shards the new tree confirms are carried over, and the notes it
 * still does not hold are recovered by the sync loop one shard (2^16 leaves) at
 * a time (`recover`) - never by a send. Every root a spend uses is checked
 * against the server's at the anchor. The server is trusted for chain data, so
 * that check makes the tree agree with the server, nothing more: a wrong tree
 * costs a delay, never a bad spend.
 *
 * The server can ask for a reseed (a root that differs), so one is taken only
 * after two consistent answers, at most once an hour per pool, and a failed
 * shard recovery backs off: a server cannot make the wallet wipe or replay at
 * will.
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
  recover_shard(
    index: number,
    firstPosition: number,
    blocks: Uint8Array,
    positions: Uint32Array,
  ): number;
  carry_marks(old: NoteTree): number;
  oldest_checkpoint(): number | undefined;
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
  puts: { key: string; value: Uint8Array | number | string }[];
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
  /** the pool's tree size after block `height`; undefined = the server has no tree state */
  sizeAt(pool: TreePool, height: number): Promise<number | undefined>;
  subtreeRoots(
    pool: TreePool,
    start: number,
  ): Promise<{ rootHash: Uint8Array; completingBlockHeight: number }[]>;
  blocks(pool: TreePool, from: number, to: number, signal?: AbortSignal): Promise<TreeBlock[]>;
  /** the first height that can hold a leaf of the pool (its activation) */
  poolStart(pool: TreePool): number;
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

/** leaves per shard: the unit of recovery */
export const SHARD_LEAVES = 2 ** 16;
/** a reseed the server asks for is taken at most this often per pool */
export const RESEED_INTERVAL_MS = 60 * 60_000;
/** how long one `recover` call may run before it hands the loop back */
export const RECOVERY_BUDGET_MS = 20_000;
/** wait before a failed shard is tried again: 1 min, doubling, up to 6 h */
export const recoveryBackoffMs = (fails: number) =>
  Math.min(60_000 * 2 ** Math.max(0, fails - 1), 6 * 3_600_000);

/** a server's tree state at one height, as `check` compares it */
export interface ServerTree {
  frontier: string;
  root: string;
}

/** where a pool's recovery stands, for the progress line */
export interface RecoveryProgress {
  /** notes the tree does not hold yet */
  left: number;
  /** of those, notes whose shard failed and waits for its retry */
  waiting: number;
  /** notes marked by this call */
  recovered: number;
  /** shards still to replay (including waiting ones) */
  shards: number;
}

/** per-shard failure record, persisted so a restart keeps the backoff */
type RecoveryState = Record<string, { fails: number; retryAt: number }>;

const parseRecovery = (v: unknown): RecoveryState => {
  if (typeof v !== 'string') {
    return {};
  }
  try {
    const o = JSON.parse(v) as unknown;
    return o && typeof o === 'object' ? (o as RecoveryState) : {};
  } catch {
    return {};
  }
};

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
   * checkpoint `height`. A dropped tree is reseeded from the server's frontier.
   * A tree that differs is reseeded only when `again` (a second answer, from
   * another operator where one is allowed) gives the same root, and no
   * server-asked reseed of the pool happened in the last RESEED_INTERVAL_MS.
   * True when the pool was reseeded (its notes then need `recover`).
   */
  check(
    pool: TreePool,
    height: number,
    server: ServerTree | undefined,
    again?: () => Promise<ServerTree | undefined>,
  ): Promise<boolean>;
  /**
   * Roll every tree back to the newest checkpoint at or below `target` they all
   * retain (not below `floor`), or reseed them from the server at `target`
   * (rate-limited as `check`; refused with an error inside the interval).
   * Returns the height the trees now end at.
   */
  rewind(target: number, floor: number): Promise<number>;
  /**
   * Mark the pool's notes the tree does not hold, one shard at a time (the
   * shard's blocks only, checked against its subtree root), for at most
   * `budgetMs`. Each shard's rows are written as it finishes, so a stop or a
   * restart resumes where it was. A shard that fails waits (recoveryBackoffMs);
   * the others go on. Without subtree roots it falls back to one replay from a
   * rounded height below the notes.
   */
  recover(
    pool: TreePool,
    notes: readonly TreeNote[],
    signal?: AbortSignal,
    budgetMs?: number,
  ): Promise<RecoveryProgress>;
  takeWrites(): TreeWrite[];
  free(): void;
}

const log = (msg: string) => console.log(`[zcash-worker] ${msg}`);
const warn = (msg: string) => console.warn(`[zcash-worker] ${msg}`);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** a pool's rows that live outside the tree and survive a reseed */
const reseedKey = (pool: TreePool) => `st:${pool}:reseedAt`;
const recoveryKey = (pool: TreePool) => `st:${pool}:rec`;

const POOLS = ['orchard', 'ironwood'] as const;

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
  now: () => number = Date.now,
): Promise<Trees> => {
  const trees: Partial<Record<TreePool, NoteTree>> = {};
  /** a tree dropped after a refused batch, kept until the reseed takes its marks */
  const orphans: Partial<Record<TreePool, NoteTree>> = {};
  let writes: TreeWrite[] = [];
  const rootsFrom: Record<TreePool, number> = {
    orchard: rootsIndexOf(rows, 'orchard'),
    ironwood: rootsIndexOf(rows, 'ironwood'),
  };
  const rowOf = (key: string) => rows.find(r => r.key === key)?.value;
  const reseedAt: Partial<Record<TreePool, number>> = {};
  const recovery: Record<TreePool, RecoveryState> = { orchard: {}, ironwood: {} };
  for (const pool of POOLS) {
    const at = rowOf(reseedKey(pool));
    if (typeof at === 'number' && Number.isFinite(at)) {
      reseedAt[pool] = at;
    }
    recovery[pool] = parseRecovery(rowOf(recoveryKey(pool)));
  }
  const collect = (pool: TreePool) => {
    const t = trees[pool];
    if (t) {
      writes.push(changesToWrite(pool, t.take_changes()));
    }
  };
  /** drop a pool's rows (the reseed time stays) */
  const clearRows = (pool: TreePool) => {
    writes = writes.filter(w => w.pool !== pool);
    const at = reseedAt[pool];
    writes.push({
      pool,
      clear: true,
      puts: at === undefined ? [] : [{ key: reseedKey(pool), value: at }],
    });
    rootsFrom[pool] = 0;
    recovery[pool] = {};
  };
  const forget = (pool: TreePool) => {
    const t = trees[pool];
    if (t) {
      orphans[pool]?.free();
      orphans[pool] = t;
    }
    delete trees[pool];
    clearRows(pool);
  };
  /** a reseed the server asked for: allowed once per RESEED_INTERVAL_MS */
  const mayReseed = (pool: TreePool) => {
    const at = reseedAt[pool];
    return at === undefined || now() - at >= RESEED_INTERVAL_MS || now() < at;
  };
  const noteReseed = (pool: TreePool) => {
    reseedAt[pool] = now();
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
        rootsFrom[pool] = from + taken;
        writes.push({ pool, puts: [{ key: `st:${pool}:roots`, value: from + taken }] });
        collect(pool);
      }
    } catch (e) {
      // roots that disagree with our own hashes say the tree is wrong
      if (errText(e).includes('do not match')) {
        warn(`${pool} note tree disagrees with the server's subtree roots`);
        throw e;
      }
      warn(`${pool} subtree roots unavailable: ${errText(e)}`);
    }
  };
  /**
   * Replace a pool's tree with one seeded from `frontierHex` at `height`, and
   * keep the old tree's marks wherever the server's subtree roots confirm its
   * shard. The old tree is freed.
   */
  const seed = async (pool: TreePool, frontierHex: string | undefined, height: number) => {
    const old = trees[pool] ?? orphans[pool];
    delete trees[pool];
    delete orphans[pool];
    clearRows(pool);
    try {
      if (frontierHex === undefined) {
        return;
      }
      const t = make();
      t.insert_frontier(frontierHex, height);
      trees[pool] = t;
      collect(pool);
      try {
        await takeRoots(pool, 0);
      } catch {
        // the server's own frontier and roots disagree: keep the tree, no roots
      }
      if (old) {
        try {
          const carried = t.carry_marks(old);
          log(`${pool} note tree reseeded at ${height}: ${carried} marks kept`);
        } catch (e) {
          warn(`${pool} marks not carried over: ${errText(e)}`);
        }
        collect(pool);
      }
    } finally {
      old?.free();
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
      await seed(p.pool, await chain.frontierAt(p.pool, p.height), p.height);
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
      continue;
    }
    try {
      await takeRoots(p.pool, rootsFrom[p.pool]);
    } catch {
      // two answers, then the rate limit, before a stored tree is replaced
      let again = false;
      try {
        await takeRoots(p.pool, rootsFrom[p.pool]);
      } catch {
        again = true;
      }
      if (again && mayReseed(p.pool)) {
        noteReseed(p.pool);
        await seed(p.pool, await chain.frontierAt(p.pool, p.height), p.height);
      } else if (again) {
        warn(`${p.pool} reseed refused: one was taken within the hour`);
      }
    }
  }

  /** the roots with completing heights, fetched once per pool per run */
  const rootsCache: Partial<Record<TreePool, { completingBlockHeight: number }[]>> = {};

  /** one replay from a rounded height (no subtree roots to check shards against) */
  const recoverByReplay = async (
    pool: TreePool,
    t: NoteTree,
    height: number,
    lost: readonly TreeNote[],
    signal?: AbortSignal,
  ) => {
    const lowest = Math.min(...lost.map(n => n.height));
    const from = Math.max(1, Math.floor((lowest - 1) / RECOVERY_ROUNDING) * RECOVERY_ROUNDING);
    const frontier = await chain.frontierAt(pool, from);
    if (frontier === undefined) {
      throw new Error(`no ${pool} tree state at ${from}`);
    }
    const blocks = await chain.blocks(pool, from + 1, height, signal);
    signal?.throwIfAborted();
    if (trees[pool] !== t || t.latest_checkpoint() !== height) {
      return 0;
    }
    return t.recover(
      frontier,
      encodeBlocks(blocks),
      Uint32Array.from(lost.map(n => n.position)),
      height,
    );
  };

  const saveRecovery = (pool: TreePool) => {
    writes.push({
      pool,
      puts: [{ key: recoveryKey(pool), value: JSON.stringify(recovery[pool]) }],
    });
  };
  const failShard = (pool: TreePool, key: string, e: unknown) => {
    const fails = (recovery[pool][key]?.fails ?? 0) + 1;
    const wait = recoveryBackoffMs(fails);
    recovery[pool][key] = { fails, retryAt: now() + wait };
    saveRecovery(pool);
    warn(
      `${pool} recovery of shard ${key} failed (${fails}x), next try in ` +
        `${Math.round(wait / 1000)}s: ${errText(e)}`,
    );
  };

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
    async check(pool, height, server, again) {
      const t = trees[pool];
      if (!server) {
        return false;
      }
      if (t) {
        if (t.latest_checkpoint() !== height || t.root_at(height) === server.root) {
          return false;
        }
        const second = await again?.().catch(() => undefined);
        if (!second || second.root !== server.root) {
          warn(`${pool} note tree root at ${height} differs from one answer only: kept`);
          return false;
        }
        if (trees[pool] !== t || t.latest_checkpoint() !== height) {
          return false;
        }
        if (!mayReseed(pool)) {
          warn(`${pool} note tree root at ${height} differs, reseed refused: one was taken within the hour`);
          return false;
        }
        warn(`${pool} note tree root at ${height} differs from the server's (twice): reseeding`);
        noteReseed(pool);
      }
      await seed(pool, server.frontier, height);
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
            await seed(pool, await chain.frontierAt(pool, landing), landing);
          }
        }
        return landing;
      }
      const reseeding = POOLS.filter(pool => trees[pool] || starts.some(s => s.pool === pool));
      const limited = reseeding.filter(pool => trees[pool] && !mayReseed(pool));
      if (limited.length > 0) {
        throw new Error(
          `rewind to ${target} would reseed the ${limited.join(' and ')} note tree, ` +
            'and one was reseeded within the hour',
        );
      }
      for (const pool of reseeding) {
        if (trees[pool]) {
          noteReseed(pool);
        }
        await seed(pool, await chain.frontierAt(pool, target), target);
      }
      return target;
    },
    async recover(pool, notes, signal, budgetMs = RECOVERY_BUDGET_MS) {
      const done: RecoveryProgress = { left: 0, waiting: 0, recovered: 0, shards: 0 };
      const t = trees[pool];
      const height = t?.latest_checkpoint();
      const next = t?.next_position();
      if (!t || height === undefined || next === undefined) {
        return done;
      }
      const lost = notes.filter(n => !t.is_marked(n.position));
      if (lost.length === 0) {
        if (Object.keys(recovery[pool]).length > 0) {
          recovery[pool] = {};
          saveRecovery(pool);
        }
        return done;
      }
      const t0 = now();
      const byShard = new Map<number, TreeNote[]>();
      for (const n of lost) {
        const k = Math.floor(n.position / SHARD_LEAVES);
        byShard.set(k, [...(byShard.get(k) ?? []), n]);
      }
      const shards = [...byShard.keys()].sort((a, b) => a - b);
      const progress = (): RecoveryProgress => {
        const left = lost.filter(n => !t.is_marked(n.position));
        const waiting = left.filter(n => {
          const r = recovery[pool][String(Math.floor(n.position / SHARD_LEAVES))];
          return r !== undefined && r.retryAt > now();
        }).length;
        return {
          left: left.length,
          waiting,
          recovered: lost.length - left.length,
          shards: new Set(left.map(n => Math.floor(n.position / SHARD_LEAVES))).size,
        };
      };

      // every complete shard's root, checked against what the tree hashed
      try {
        await takeRoots(pool, rootsFrom[pool]);
      } catch (e) {
        failShard(pool, 'roots', e);
        return progress();
      }
      let roots = rootsCache[pool];
      const lastNeeded = shards[shards.length - 1]!;
      if (!roots || roots.length < Math.min(lastNeeded, rootsFrom[pool])) {
        roots = await chain.subtreeRoots(pool, 0).catch(() => []);
        rootsCache[pool] = roots;
      }

      if (roots.length === 0) {
        // a server without GetSubtreeRoots: the old replay, with the same backoff
        const r = recovery[pool]['replay'];
        if (r && r.retryAt > now()) {
          return progress();
        }
        try {
          const n = await recoverByReplay(pool, t, height, lost, signal);
          collect(pool);
          delete recovery[pool]['replay'];
          saveRecovery(pool);
          log(`${pool} note tree recovered ${n} notes by replay (${Math.round(now() - t0)}ms)`);
        } catch (e) {
          signal?.throwIfAborted();
          failShard(pool, 'replay', e);
        }
        return progress();
      }

      let ran = 0;
      for (const k of shards) {
        signal?.throwIfAborted();
        if (ran > 0 && now() - t0 >= budgetMs) {
          break;
        }
        const key = String(k);
        const r = recovery[pool][key];
        if (r && r.retryAt > now()) {
          continue;
        }
        const ns = byShard.get(k)!;
        const s0 = now();
        try {
          const startHeight = k === 0 ? chain.poolStart(pool) : roots[k - 1]?.completingBlockHeight;
          if (startHeight === undefined) {
            throw new Error(`no subtree root for shard ${k - 1}`);
          }
          const completing = roots[k]?.completingBlockHeight;
          const complete = completing !== undefined && (k + 1) * SHARD_LEAVES <= next;
          const endHeight = complete ? Math.min(completing, height) : height;
          const first = startHeight <= 1 ? 0 : await chain.sizeAt(pool, startHeight - 1);
          if (first === undefined) {
            throw new Error(`no ${pool} tree state at ${startHeight - 1}`);
          }
          const blocks = await chain.blocks(pool, startHeight, endHeight, signal);
          signal?.throwIfAborted();
          // the loop has not moved the tree while the blocks were fetched
          if (trees[pool] !== t || t.latest_checkpoint() !== height) {
            break;
          }
          t.recover_shard(
            k,
            first,
            encodeBlocks(blocks),
            Uint32Array.from(ns.map(n => n.position)),
          );
          collect(pool);
          if (recovery[pool][key]) {
            delete recovery[pool][key];
            saveRecovery(pool);
          }
          log(
            `${pool} note tree recovered ${ns.length} notes in shard ${k} ` +
              `(${startHeight}..${endHeight}, ${blocks.length} blocks, ${Math.round(now() - s0)}ms)`,
          );
        } catch (e) {
          signal?.throwIfAborted();
          failShard(pool, key, e);
        }
        ran++;
      }
      return progress();
    },
    takeWrites() {
      const out = writes;
      writes = [];
      return out;
    },
    free() {
      for (const t of [...Object.values(trees), ...Object.values(orphans)]) {
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

/**
 * What of the per-note era a run may delete: only what a pool that now has a
 * tree replaced. A pool the server had no tree state for keeps its witnesses
 * for a later run (on a node that serves it) to migrate.
 */
export const retiredLegacy = (seeded: Readonly<Record<TreePool, boolean>>) => ({
  orchardWitnessFields: seeded.orchard,
  ironwoodRows: seeded.ironwood,
  metaKeys: LEGACY_META_KEYS.filter(k =>
    k.startsWith('ironwood') ? seeded.ironwood : seeded.orchard,
  ),
});
