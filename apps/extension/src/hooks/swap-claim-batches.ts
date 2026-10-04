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

/** the claims were sent (true), or the worker went away and the rest waits (false) */
type ClaimOutcome = 'sent' | 'transient';

/**
 * Send each batch; when a batch fails, send its claims one at a time, so one
 * claim whose planning or build fails (say its prepaid fee no longer covers
 * gas) never holds back the others - as it would every block, since the
 * batch is formed again from the same claims. A claim that fails on its own
 * is counted as tried at this height, so it is tried again only after
 * RESEND_AFTER_BLOCKS instead of costing a proof every block.
 *
 * `claim` resolves once the transaction is broadcast, and returns
 * 'transient' when the service worker went away (the next block retries
 * everything left). Returns the number of claims sent.
 */
export const sendClaimBatches = async (
  batches: readonly string[][],
  sent: SentClaims,
  height: number,
  claim: (batch: string[]) => Promise<ClaimOutcome>,
  onError: (err: unknown, batch: string[]) => void = () => undefined,
): Promise<number> => {
  let claimed = 0;
  // one batch, then (on failure) each of its claims alone
  const attempt = async (batch: string[]): Promise<'sent' | 'failed' | 'transient'> => {
    try {
      const outcome = await claim(batch);
      if (outcome === 'sent') {
        for (const c of batch) {
          sent.set(c, height);
        }
        claimed += batch.length;
      }
      return outcome;
    } catch (err) {
      onError(err, batch);
      return 'failed';
    }
  };
  for (const batch of batches) {
    const outcome = await attempt(batch);
    if (outcome === 'transient') {
      return claimed;
    }
    if (outcome === 'sent') {
      continue;
    }
    if (batch.length === 1) {
      sent.set(batch[0]!, height);
      continue;
    }
    for (const c of batch) {
      const alone = await attempt([c]);
      if (alone === 'transient') {
        return claimed;
      }
      if (alone === 'failed') {
        sent.set(c, height);
      }
    }
  }
  return claimed;
};

/** sent claims as stored in chrome.storage.session (shared by every open view) */
export const SENT_CLAIMS_KEY = 'penumbraSentClaims';

export const sentFromStored = (raw: unknown): SentClaims =>
  new Map(
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.entries(raw as Record<string, unknown>).filter(
          (e): e is [string, number] => typeof e[1] === 'number',
        )
      : [],
  );

export const sentToStored = (sent: SentClaims): Record<string, number> => Object.fromEntries(sent);
