/**
 * Notes someone else paid in, out of a batch the scan just found: not change
 * (its own key scope) and not from a transaction that spends this wallet's
 * notes (a move between your own pockets). A note with no txid cannot be told
 * apart and is left out.
 */
export const receivedFrom = (
  found: { txid: string; is_change?: boolean }[],
  owned: { spent_by_txid?: string }[],
): number => {
  const ours = new Set(owned.map(n => n.spent_by_txid).filter(Boolean));
  return found.filter(n => !n.is_change && n.txid && !ours.has(n.txid)).length;
};
