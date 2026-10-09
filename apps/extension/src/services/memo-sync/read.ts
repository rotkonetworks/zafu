/**
 * What one memo pass may mark as read for good. A txid whose memo it found is
 * left out: that memo is safe only once the page has stored it (it then comes
 * back as an existing txid), and a window closed mid-pass never stores it.
 * Marked read here, it was lost for good; left out, the next open reads it
 * again. For the same reason the pass is settled (the inbox may answer from
 * its note counts next time) only when it found nothing and no spend is
 * still waiting for its block.
 */
export const afterPass = ({
  scanned,
  read,
  found,
  unmined,
}: {
  /** txids marked read by earlier passes */
  scanned: ReadonlySet<string>;
  /** txids this pass read */
  read: Iterable<string>;
  /** the memos this pass hands the page */
  found: readonly { txId: string }[];
  /** spends broadcast but not mined: nothing to read yet */
  unmined: number;
}): { scanned: Set<string>; settled: boolean } => {
  const next = new Set([...scanned, ...read]);
  for (const { txId } of found) {
    next.delete(txId);
  }
  return { scanned: next, settled: unmined === 0 && found.length === 0 };
};
