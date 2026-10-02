/**
 * Which unclaimed swaps to claim on this block, and in how many transactions.
 *
 * A claim's fee is prepaid in its swap, and the planner takes the transaction's
 * fee token from the claims, so one transaction carries the claims that share a
 * fee asset. A claim already sent is skipped until it shows up on chain, or
 * until RESEND_AFTER_BLOCKS pass (a dropped transaction is then sent again).
 */

export const RESEND_AFTER_BLOCKS = 5;

export interface UnclaimedSwap {
  /** swap commitment, hex */
  commitment: string;
  /** the prepaid claim fee's asset id, hex ('' = staking token) */
  feeAsset: string;
}

/** commitment hex -> sync height it was last sent at */
export type SentClaims = Map<string, number>;

/** claims still waiting, grouped by fee asset, skipping ones sent recently */
export const claimBatches = (
  unclaimed: readonly UnclaimedSwap[],
  sent: SentClaims,
  height: number,
): string[][] => {
  const byFee = new Map<string, string[]>();
  for (const { commitment, feeAsset } of unclaimed) {
    const at = sent.get(commitment);
    if (at !== undefined && height - at < RESEND_AFTER_BLOCKS) {
      continue;
    }
    byFee.set(feeAsset, [...(byFee.get(feeAsset) ?? []), commitment]);
  }
  return [...byFee.values()];
};

/** forget sent claims that are no longer unclaimed (they landed) */
export const pruneSent = (sent: SentClaims, unclaimed: readonly UnclaimedSwap[]): void => {
  const open = new Set(unclaimed.map(u => u.commitment));
  for (const c of sent.keys()) {
    if (!open.has(c)) {
      sent.delete(c);
    }
  }
};
