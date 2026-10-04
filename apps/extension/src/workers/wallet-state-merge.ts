/**
 * How a fresh IndexedDB read is folded into a wallet's shared in-memory state.
 *
 * The sync loop advances ironwood witnesses on the in-memory note objects each
 * batch, then persists them. Anything that re-reads IndexedDB while the loop
 * is live (a balance poll, history, a send) sees notes one batch behind the
 * loop's frontier. If that read REPLACES the loop's notes, the next batch
 * advances each witness from the stale point: it skips a batch of commitments
 * but is stamped with the correct tree size, so the size check passes and only
 * the spend-time root check catches it - as a silent ~minute replay.
 *
 * So while the loop is live, its note objects are authoritative: the read may
 * only add notes the loop has never seen (written by another worker realm) and
 * union spent nullifiers. When no loop is running, the read replaces state.
 */
export interface MergeableNote {
  nullifier: string;
}

export const mergeLoadedNotes = <N extends MergeableNote>(
  live: N[],
  loaded: N[],
  syncing: boolean,
): N[] => {
  if (!syncing) {
    return loaded;
  }
  // in place: the loop keeps pushing onto this same array
  const known = new Set(live.map(n => n.nullifier));
  for (const n of loaded) {
    if (!known.has(n.nullifier)) {
      live.push(n);
    }
  }
  return live;
};

export const mergeLoadedSpent = (
  live: Set<string>,
  loaded: Iterable<string>,
  syncing: boolean,
): Set<string> => {
  if (!syncing) {
    return new Set(loaded);
  }
  for (const nf of loaded) {
    live.add(nf);
  }
  return live;
};
