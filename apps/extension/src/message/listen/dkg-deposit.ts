/**
 * A deposit a site folds into its `zafu_dkg_join`, so joining a vault and
 * paying into it take one approval. The address is never the site's to name:
 * it is the joined vault's own address at `vaultIndex` (a diversifier index),
 * derived in zafu once the co-signers agreed on the viewing key - so the
 * approval can honestly say the money goes to the 2-of-3 vault being joined.
 * Index 0 is the vault's main address; an escrow may give each seat its own
 * index (zk.poker: seat 0 -> 1, seat 1 -> 2).
 */
export interface DkgDeposit {
  vaultIndex: number;
  amountZat: number;
  memo?: string;
}

/** the largest index the wasm takes (u32), and a sane memo bound (512 bytes on chain) */
const MAX_INDEX = 0xffff_ffff;
const MAX_MEMO = 512;
const MAX_ZAT = 21_000_000 * 1e8;

/** a request's `deposit`: absent is null, malformed is 'invalid' (refused, never dropped) */
export const parseDkgDeposit = (raw: unknown): DkgDeposit | null | 'invalid' => {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'object') {
    return 'invalid';
  }
  const { vaultIndex, amountZat, memo } = raw as Record<string, unknown>;
  if (
    !Number.isSafeInteger(vaultIndex) ||
    (vaultIndex as number) < 0 ||
    (vaultIndex as number) > MAX_INDEX ||
    !Number.isSafeInteger(amountZat) ||
    (amountZat as number) <= 0 ||
    (amountZat as number) > MAX_ZAT ||
    (memo !== undefined &&
      (typeof memo !== 'string' || new TextEncoder().encode(memo).length > MAX_MEMO))
  ) {
    return 'invalid';
  }
  return {
    vaultIndex: vaultIndex as number,
    amountZat: amountZat as number,
    ...(memo ? { memo: memo } : {}),
  };
};
