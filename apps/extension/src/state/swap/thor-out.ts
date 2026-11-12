/**
 * A thorchain swap out of zec: a payment from the swap's own fresh
 * transparent address (zcash/pay/via-fresh), with the memo in an OP_RETURN.
 * What is the swap's own is here: the record's shape, and the vault read
 * again before each leg signs, since a vault can churn or a chain halt
 * between the quote and the deposit.
 *
 * THORNode's ZEC quotes live about 15 minutes (890 s measured live,
 * 2026-10-04); a price with less than MOVE_NEEDS_MS left is asked again
 * before any zec leaves the shielded pool.
 */

import type { DepositPlan, DepositRequest } from '../../workers/transparent-deposit';
import type { ZecInbound } from '../../lp/thor';
import {
  isRunning,
  legsPerUnlock,
  MOVE_NEEDS_MS,
  MOVED_POLL_MS,
  nextLeg,
  openPayUnlock,
  runs,
  runViaFresh,
  startViaFresh,
  stopViaFresh,
  takePayUnlock,
  tooLateToMove,
  type FreshDeps,
  type FreshPayment,
  type Leg,
  type Legs,
  type Run,
} from '../../zcash/pay/via-fresh';
import type { OpenSwap } from './open-swaps';
import { toUnits } from './provider';

export {
  isRunning,
  legsPerUnlock,
  MOVE_NEEDS_MS,
  MOVED_POLL_MS,
  nextLeg,
  runs,
  tooLateToMove,
  type Leg,
  type Legs,
  type Run,
};
export const openSwapUnlock = openPayUnlock;
export const takeSwapUnlock = takePayUnlock;
export const stopThorOut = stopViaFresh;

/** the deposit a record reviewed, exactly as it is signed */
export const depositOf = (s: OpenSwap): DepositRequest & { reviewedFee: string } => ({
  tAddress: s.swapT!.address,
  tIndex: s.swapT!.index,
  to: s.depositAddress,
  amountZat: toUnits(s.amountIn, 8).toString(),
  memo: s.memo ?? '',
  mainnet: true,
  reviewedFee: s.depositFee ?? '',
});

/** the swap as the runner reads it */
export const paymentOf = (s: OpenSwap): FreshPayment => ({
  id: s.id,
  req: depositOf(s),
  moveTxid: s.moveTxid,
  held: s.held,
  expiresAt: s.expiresAt,
});

export interface RunDeps extends Omit<FreshDeps, 'save' | 'done' | 'check' | 'short'> {
  save: (patch: Partial<OpenSwap>) => Promise<unknown>;
  /** the zec vault as every thornode operator reads it now; throws when they disagree */
  vault: () => Promise<{ inbound: Pick<ZecInbound, 'address' | 'halted' | 'tradingPaused'> }>;
}

const NOT_SENT = { move: 'nothing was sent', pay: 'nothing went to the vault' } as const;

/**
 * Throws unless the vault the quote named is still the one to pay and zec
 * trades: asked before each leg signs.
 */
export const stillPayable = (
  { inbound }: Awaited<ReturnType<RunDeps['vault']>>,
  to: string,
  leg: keyof typeof NOT_SENT,
): void => {
  if (inbound.halted || inbound.tradingPaused) {
    throw new Error(`thorchain isn't taking zec right now · ${NOT_SENT[leg]}`);
  }
  if (inbound.address !== to) {
    throw new Error(`the swap's vault changed · please get a new quote, ${NOT_SENT[leg]}`);
  }
};

const SHORT = {
  move: "the shielded balance doesn't cover this yet · nothing was sent",
  pay: "the swap's address doesn't cover this yet · nothing went to the vault",
} as const;

/** the swap's own: its record, the vault filter, its lines */
const swapDeps = (swap: OpenSwap, deps: RunDeps): FreshDeps => ({
  ...deps,
  save: patch => deps.save(patch),
  done: txid => deps.save({ stage: 'sent', depositTxid: txid, held: undefined }),
  check: async leg => stillPayable(await deps.vault(), swap.depositAddress, leg),
  short: SHORT,
});

/** both legs of a swap, from wherever its record stands */
export const runThorOut = (
  swap: OpenSwap,
  legs: Legs,
  deps: RunDeps,
  reviewed?: DepositPlan,
): Promise<void> => runViaFresh(paymentOf(swap), legs, swapDeps(swap, deps), reviewed);

/** start a swap's run unless one is going; it reports into `runs` */
export const startThorOut = (
  swap: OpenSwap,
  legs: Legs,
  deps: RunDeps,
  reviewed?: DepositPlan,
): void => startViaFresh(paymentOf(swap), legs, swapDeps(swap, deps), reviewed);
