import type { LocalStorageState } from '@repo/storage-chrome/local';

/**
 * Where a penumbra wallet's sync starts, one record per wallet.
 *
 * The node serves the state commitment frontier only at its tip, so a past
 * date can never start a scan there: every block from genesis is still read,
 * and the birthday only skips trial decryption below it. Only "nothing before
 * now" (a phrase made in zafu, or a person who says so) starts at the tip.
 */
export type PenumbraStart = NonNullable<LocalStorageState['penumbraStarts']>[string];
export interface ResolvedStart {
  creation: number;
  frontier?: number;
}
export type PenumbraStarts = Record<string, PenumbraStart>;

/** a stored map, or nothing when the value is not a plain record (never coerced) */
export const startsOf = (raw: unknown): PenumbraStarts | undefined =>
  raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as PenumbraStarts) : undefined;

export const isResolved = (s: PenumbraStart): s is ResolvedStart =>
  typeof s === 'object' && typeof (s as ResolvedStart).creation === 'number';

// Penumbra aims at 5s blocks and has run nearer 4.5s; reading 4s backwards
// overcounts the blocks since a date, and a halt only widens that, so the
// height lands before the real one. Late skips notes, early costs time.
const FAST_BLOCK_MS = 4_000;
const MARGIN_BLOCKS = 20_000;

/** the latest height at or before `since`, biased early */
export const penumbraHeightAt = (since: number, tip: number, now: number): number => {
  if (!Number.isFinite(since) || since <= 0 || !Number.isFinite(tip) || tip <= 0) {
    return 0;
  }
  const back = Math.ceil(Math.max(0, now - since) / FAST_BLOCK_MS) + MARGIN_BLOCKS;
  return Math.max(0, Math.floor((tip - back) / 10_000) * 10_000);
};

/** the record a start resolves to against the node's tip at `now` */
export const resolveStart = (s: PenumbraStart, tip: number, now: number): ResolvedStart =>
  isResolved(s)
    ? s
    : s === 'tip'
      ? { creation: tip, frontier: tip }
      : { creation: penumbraHeightAt(s.since, tip, now) };

/**
 * The legacy global birthday, given to the one wallet it can only have been
 * written for. Onboarding wrote it once, for the wallet it was creating; with
 * more than one wallet there is no telling which, so it belongs to none.
 * Returns the map to store, or undefined to leave storage as it is.
 */
export const adoptLegacyStart = (
  walletIds: string[],
  legacy: { creation?: number; frontier?: number },
  raw: unknown,
): PenumbraStarts | undefined => {
  const starts = raw === undefined ? {} : startsOf(raw);
  const [only, ...rest] = walletIds;
  const { creation, frontier } = legacy;
  if (!starts || !only || rest.length || typeof creation !== 'number' || only in starts) {
    return undefined;
  }
  return {
    ...starts,
    [only]: typeof frontier === 'number' ? { creation, frontier } : { creation },
  };
};

/** 0..100 of this run: counted from the height it started at, not genesis */
export const runPercent = (height: number, from: number, tip: number): number =>
  tip <= 0
    ? 0
    : tip <= from
      ? 100
      : Math.min(100, Math.max(0, ((height - from) / (tip - from)) * 100));

/** what the worker's penumbra services run for */
export interface PenumbraTarget {
  /** undefined while locked: the start waiting for unlock takes whichever wallet is active then */
  walletId: string | undefined;
  run: boolean;
  /**
   * the chain the services read; undefined before any is known (a first run).
   * The services start on the stored chain id, so the node serving another
   * one later must rebuild them rather than keep a mismatched chain.
   */
  chainId?: string;
}

export const sameTarget = (running: PenumbraTarget, next: PenumbraTarget) =>
  running.run === next.run &&
  (running.walletId === undefined || running.walletId === next.walletId) &&
  (!running.run ||
    running.chainId === undefined ||
    next.chainId === undefined ||
    running.chainId === next.chainId);

/**
 * What a finished start actually runs: its wallet, and nothing while that
 * wallet's start is still to be chosen - so choosing it differs from what is
 * running, and the scheduler builds the real services then.
 */
export const settledTarget = (
  target: PenumbraTarget,
  walletId: string | undefined,
  waitingForStart: boolean,
): PenumbraTarget => ({
  ...target,
  walletId: walletId ?? target.walletId,
  run: target.run && !waitingForStart,
});
