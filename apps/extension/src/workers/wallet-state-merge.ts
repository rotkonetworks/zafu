/**
 * How a fresh IndexedDB read is folded into a wallet's shared in-memory state.
 *
 * The sync loop updates the in-memory note objects each batch (spends seen,
 * their heights and txids), then persists them. Anything that re-reads
 * IndexedDB while the loop is live (a balance poll, history, a send) sees notes
 * one batch behind. If that read REPLACED the loop's notes, the loop would go
 * on updating objects nothing reads, and the state shown would trail it.
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
