import { ZCASH_ORCHARD_ACTIVATION } from '../config/networks';

/**
 * zcash height ↔ date, approximated from a fixed anchor.
 *
 * Zcash targets 75s blocks, so extrapolating from orchard activation is
 * accurate to within a few days across the whole post-NU5 range — good
 * enough to pick a sync start, and good enough to *show* the user which
 * chain a height belongs to.
 *
 * That second use is the important one. A bare "2910104" says nothing
 * about whether it is a Zcash height or a Penumbra one, and in a seed
 * vault (which derives keys for both) the two sit inches apart in the UI.
 * Rendering the height as a date makes the chain obvious without anyone
 * having to know what a plausible Zcash tip looks like.
 *
 * Extracted from onboarding/select-networks.tsx so settings shows the same
 * numbers rather than a second, drifting approximation.
 */

const ANCHOR_BLOCK = ZCASH_ORCHARD_ACTIVATION; // 1,687,104
const ANCHOR_DATE = new Date('2022-05-31T00:00:00Z');
const BLOCK_TIME_S = 75;

export const dateToBlock = (date: Date): number => {
  const diffBlocks = Math.floor((date.getTime() - ANCHOR_DATE.getTime()) / (BLOCK_TIME_S * 1000));
  return Math.max(ZCASH_ORCHARD_ACTIVATION, ANCHOR_BLOCK + diffBlocks);
};

export const blockToDate = (block: number): Date =>
  new Date(ANCHOR_DATE.getTime() + (block - ANCHOR_BLOCK) * BLOCK_TIME_S * 1000);

/** yyyy-mm-dd, for <input type='date'> */
export const formatDateInput = (date: Date): string => date.toISOString().split('T')[0]!;

/** "mar 2025" — deliberately coarse; the estimate is not day-accurate */
export const formatBlockMonth = (block: number): string =>
  blockToDate(block)
    .toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
    .toLowerCase();

/**
 * The height a rescan may start from.
 *
 * A rescan deletes the note database and writes its start height as the
 * wallet's new birthday, so the wallet can never look below it again. The home
 * screen used to fall back to the CHAIN TIP when no birthday was stored —
 * which is the default for any wallet imported without one — and that fallback
 * turned "re-read the chain" into "forget every note you hold".
 *
 * There is no safe way to guess forward. Orchard activation is the earliest
 * height that can hold a note this wallet cares about: slow to scan, but it
 * cannot hide anything.
 */
export const rescanStartHeight = (walletBirthday: number | undefined | null): number => {
  if (typeof walletBirthday !== 'number' || !Number.isFinite(walletBirthday)) {
    return ZCASH_ORCHARD_ACTIVATION;
  }
  return Math.max(ZCASH_ORCHARD_ACTIVATION, Math.floor(walletBirthday));
};

/**
 * Describe a height for display: either the month it lands in, or why it
 * is not a usable zcash height. Returning the reason (rather than silently
 * clamping) is what surfaces a wrong-chain paste.
 */
export const describeZcashHeight = (block: number, tip?: number): { ok: boolean; text: string } => {
  if (!Number.isFinite(block) || block <= 0) {
    return { ok: false, text: 'not a block height' };
  }
  if (block < ZCASH_ORCHARD_ACTIVATION) {
    return {
      ok: false,
      text: `before orchard activation (${ZCASH_ORCHARD_ACTIVATION.toLocaleString()}) — nothing to scan`,
    };
  }
  if (tip && block > tip) {
    return { ok: false, text: `ahead of the zcash tip (${tip.toLocaleString()})` };
  }
  return { ok: true, text: `≈ ${formatBlockMonth(block)}` };
};
