/**
 * Bounded, in-order look-ahead fetch for the compact-block sync loop.
 *
 * The catch-up loop used to be strictly serial — fetch, scan, write, fetch —
 * so the network idled for the whole scan and the cores idled for the whole
 * fetch. Measured against zcash.rotko.net, a single 200-block
 * `GetCompactBlocks` costs ~1s wall (~90ms of that is RTT; the rest is the
 * server walking its block store), while the same 200 blocks trial-decrypt in
 * ~1.2s single-threaded. Two comparable halves running one after the other.
 *
 * Two things fix that, and this class does both:
 *
 *   1. Overlap — batch N+1 is already in flight while batch N is scanned, so
 *      wall clock becomes max(fetch, scan) instead of fetch + scan.
 *   2. Depth — a SINGLE in-flight request only removes one of the two. The
 *      server parallelises across streams: over one HTTP/2 connection the
 *      fetch stage measured 205 blocks/s at depth 1, 614 at depth 4 and ~730
 *      at depth 6, flat after that. Depth is what actually moves the fetch
 *      ceiling above the scan rate; overlap is what lets you spend it.
 *
 * The whole point is that it stays BOUNDED and STRICTLY ORDERED. Notes and
 * nullifiers must be applied in chain order, so results are handed back in
 * ascending contiguous ranges no matter what order the network completes
 * them, and at most `depth` batches are ever in memory.
 *
 * Everything that can invalidate the cursor — abort, a rejected fetch, an
 * empty batch, or a rewind after a chain-continuity error — discards the
 * whole queue rather than trying to salvage it. A stale in-flight batch
 * applied across a reorg boundary is a corrupt wallet; a re-fetched batch is
 * one wasted second.
 */

/** A fetched, not-yet-applied range. `blocks` may be empty (see below). */
export interface PrefetchedBatch<B> {
  /** first height in the range (inclusive) */
  start: number;
  /** last height in the range (inclusive) */
  end: number;
  /**
   * What the server returned. EMPTY IS NOT AN ERROR and must not be treated
   * as "this range had nothing in it": lightwalletd/zidecar can report a tip
   * it has not finished indexing, and an empty result there means "ask again",
   * not "skip". The caller keeps its height cursor where it is and backs off.
   * The prefetcher has already discarded the queue behind an empty batch,
   * since every one of those was fired at a range the server just told us it
   * cannot serve yet.
   */
  blocks: B[];
}

export interface BlockPrefetcherOptions<B> {
  fetch: (start: number, end: number) => Promise<B[]>;
  /** heights per request */
  batchSize: number;
  /** maximum requests in flight (>= 1). 1 reproduces the old serial loop. */
  depth: number;
  /**
   * Consulted before every hand-off. Once it returns true, `next()` resolves
   * null forever and no fetched batch is ever handed back — an in-flight
   * request cannot resurrect a sync the user stopped.
   */
  isAborted: () => boolean;
}

interface Slot<B> {
  start: number;
  end: number;
  /**
   * Never rejects — a failed fetch is carried as `err` so the queue stays
   * intact until we reach that slot in order.
   *
   * Typed `Error` rather than `unknown` because the value is rethrown
   * verbatim: the sync loop's classifier reads both `.code` and the message
   * text off it to decide rewind-vs-backoff, so wrapping or normalising it
   * would silently downgrade a chain-continuity error to a generic one. A
   * non-Error rejection is forwarded unchanged too; the classifier takes
   * `unknown`.
   */
  settled: Promise<{ blocks?: B[]; err?: Error }>;
}

export class BlockPrefetcher<B> {
  private readonly opts: BlockPrefetcherOptions<B>;
  private queue: Slot<B>[] = [];
  /** next height to request; `end` of the last queued slot */
  private cursor = 0;
  /** last height worth requesting */
  private ceiling = 0;
  /**
   * Bumped by every reset. A fetch started under an older generation has its
   * result dropped on arrival, so a batch queued before a rewind can never be
   * applied after it.
   */
  private generation = 0;

  constructor(opts: BlockPrefetcherOptions<B>) {
    this.opts = { ...opts, depth: Math.max(1, Math.floor(opts.depth)) };
  }

  /** number of requests currently queued (in flight or already resolved) */
  get inFlight(): number {
    return this.queue.length;
  }

  /**
   * Point the pipeline at `fromHeight + 1` and top it up towards
   * `chainHeight`. Safe to call every iteration: if the cursor still lines up
   * with what is queued this only tops the queue back up, and if it does not
   * (rewind, retry, a tip that moved backwards) the queue is discarded first.
   */
  prime(fromHeight: number, chainHeight: number): void {
    const head = this.queue[0];
    if (head && head.start !== fromHeight + 1) {
      // the caller's cursor no longer matches the head of the queue — the only
      // safe reading is that everything queued is about the wrong range
      this.reset();
    } else if (this.cursor > chainHeight) {
      // The tip moved BACKWARDS (endpoint reorg, or a load-balanced peer that
      // is behind). Applying a range queued past the new tip would push the
      // scan cursor above the chain and wedge the loop in its caught-up
      // branch, so re-aim at the shorter chain.
      this.reset();
    }
    if (this.queue.length === 0) {
      this.cursor = fromHeight;
    }
    this.ceiling = chainHeight;
    this.fill();
  }

  /**
   * The next contiguous range, in ascending order. Resolves null when the
   * sync has been aborted or there is nothing left to request below the
   * ceiling — never a batch out of order, and never a batch fetched under a
   * superseded generation.
   */
  async next(): Promise<PrefetchedBatch<B> | null> {
    for (;;) {
      if (this.opts.isAborted()) {
        this.reset();
        return null;
      }
      const slot = this.queue.shift();
      if (!slot) {
        return null;
      }
      const gen = this.generation;
      const { blocks, err } = await slot.settled;

      // Anything that happened while we were awaiting wins over this result:
      // an abort, or a reset from the caller's error handling. Dropping the
      // batch is always safe — it is only ever a cache of what the server
      // will happily serve again.
      if (this.opts.isAborted()) {
        this.reset();
        return null;
      }
      if (gen !== this.generation) {
        continue;
      }

      if (err !== undefined) {
        // Surface to the loop's existing classifier (continuity → rewind,
        // otherwise backoff). Everything behind it was fired at a range that
        // classifier may be about to invalidate, so drop it all.
        this.reset();
        throw err;
      }

      const list = blocks ?? [];
      if (list.length === 0) {
        // Server is behind its own reported tip. Hand the empty range back so
        // the caller can hold its cursor and back off; discard the look-ahead,
        // which was aimed past a range the server cannot serve.
        this.reset();
        return { start: slot.start, end: slot.end, blocks: [] };
      }

      this.fill();
      return { start: slot.start, end: slot.end, blocks: list };
    }
  }

  /**
   * Discard everything queued. In-flight requests are not cancelled (there is
   * no per-request signal on the compact-block RPC) but their results are
   * dropped by the generation check, so they can neither be applied nor keep
   * the loop waiting on them.
   */
  reset(): void {
    this.generation++;
    this.queue = [];
  }

  private fill(): void {
    if (this.opts.isAborted()) {
      return;
    }
    while (this.queue.length < this.opts.depth && this.cursor < this.ceiling) {
      const start = this.cursor + 1;
      const end = Math.min(this.cursor + this.opts.batchSize, this.ceiling);
      this.cursor = end;
      let settled: Promise<{ blocks?: B[]; err?: Error }>;
      try {
        settled = this.opts.fetch(start, end).then(
          blocks => ({ blocks }),
          // forwarded verbatim; see Slot.settled
          (err: Error) => ({ err }),
        );
      } catch (err) {
        // a `fetch` that throws synchronously must not abort the fill loop
        settled = Promise.resolve({ err: err as Error });
      }
      this.queue.push({ start, end, settled });
    }
  }
}
