/**
 * What a rewind of the scan cursor to `target` takes back.
 *
 * The blocks above `target` are read again, so whatever the wallet learned
 * from them goes: the notes found there, and the spends seen there. If those
 * blocks were reorged away, keeping either leaves a note that no longer exists
 * (counted in the balance, picked by a send that can then never be built) or
 * a note marked spent by a transaction that is no longer on the chain. Notes
 * and spends still on the chain come back as the range is read again.
 *
 * A spend marked at broadcast and not yet seen in a block has no height; it is
 * kept (the mempool and reconcile paths own it).
 */

export interface RewindableNote {
  nullifier: string;
  height: number;
  spent_at_height?: number;
  spent_by_txid?: string;
}

export interface RewindPurge<N extends RewindableNote> {
  /** notes found above the target: deleted, found again if still on the chain */
  drop: N[];
  /** notes at or below the target whose spend was seen above it: unmarked */
  unspend: N[];
}

export const rewindPurge = <N extends RewindableNote>(
  notes: readonly N[],
  target: number,
): RewindPurge<N> => ({
  drop: notes.filter(n => n.height > target),
  unspend: notes.filter(n => n.height <= target && (n.spent_at_height ?? 0) > target),
});

/** rewinds a root that differs may cause, per wallet, in MISMATCH_REWIND_WINDOW_MS */
export const MISMATCH_REWINDS_PER_WINDOW = 3;
export const MISMATCH_REWIND_WINDOW_MS = 60 * 60_000;

/**
 * Whether a root that differs from the server's (twice) may rewind the scan
 * now, given when the earlier ones happened. The server is asked for the
 * root, so it could otherwise make the wallet throw away and re-read its
 * recent blocks on every check: a few per hour covers real reorgs, and past
 * that the trees are left to the reseed rule (two answers, once an hour).
 * Returns the history to store, or undefined when refused.
 */
export const allowMismatchRewind = (
  earlier: readonly number[],
  now: number,
): number[] | undefined => {
  const recent = earlier.filter(t => t <= now && now - t < MISMATCH_REWIND_WINDOW_MS);
  return recent.length < MISMATCH_REWINDS_PER_WINDOW ? [...recent, now] : undefined;
};
