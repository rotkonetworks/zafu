/**
 * Zcash shielded receive addresses are single-use.
 *
 * `zcashShieldedIndex` is the diversifier index of the address currently on
 * offer. It only ever moves forward: every screen that hands the address out
 * (showing it on receive, copying it, copying a payment link) advances it, so
 * no two senders are ever given the same string to compare. Every diversified
 * address decrypts to the same wallet during scanning, so rotating costs
 * nothing, and orchard has no gap limit a restore could fall off.
 *
 * Contact addresses live at 1000 + a 48-bit hash (see diversified-address.ts);
 * this counter walks up from 0 and practically never meets one.
 */

export const SHIELDED_INDEX_KEY = 'zcashShieldedIndex';

/** Retire the address on offer and move to a fresh one; resolves to its index. */
export const rotateShieldedIndex = async (): Promise<number> => {
  const r = await chrome.storage.local.get(SHIELDED_INDEX_KEY);
  const next = ((r[SHIELDED_INDEX_KEY] as number | undefined) ?? 0) + 1;
  await chrome.storage.local.set({ [SHIELDED_INDEX_KEY]: next });
  return next;
};
