/**
 * A thorchain swap out of zec as one service: fund the swap's own transparent
 * address from the shielded pool when it is short, wait for the network to
 * confirm that, then send the reviewed deposit (a t->t with the memo in an
 * OP_RETURN). One press starts it; the legs run here, outside any screen, so
 * the person can leave and home shows where it stands. A closed popup stops
 * the run; its record (open-swaps) is where the next popup picks it up.
 *
 * How a leg is signed is the `Legs` given: a hot wallet's, under the swap's
 * one unlock, or zigner's: one qr round for both, the deposit held (sealed,
 * on the record) until the move is mined.
 */

import { createStore } from 'zustand/vanilla';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import {
  SIGN_GRACE_MS,
  shouldPromptPassword,
  type TxSigningSecurity,
} from '../../shared/tx-signing-security';
import type { DepositPlan, DepositRequest } from '../../workers/transparent-deposit';
import { isZignerDeclined } from '../../signing/zigner-round';
import { heldNext, type Held } from '../../signing/move-and-deposit';
import type { ZecInbound } from '../../lp/thor';
import type { OpenSwap } from './open-swaps';
import { toUnits } from './provider';

/**
 * How much of the price's life the move needs: build, a block or two (75 s
 * apart on average, often longer) and the poll. THORNode's ZEC quotes live
 * about 15 minutes (890 s measured live, 2026-10-04), so a price with less
 * than this left is asked again before any zec leaves the shielded pool.
 */
export const MOVE_NEEDS_MS = 6 * 60_000;

/** true when the price can't outlast the move: ask again before moving */
export const tooLateToMove = (expiresAt: number | undefined, now = Date.now()): boolean =>
  !!expiresAt && expiresAt - now < MOVE_NEEDS_MS;

/** a move confirms in a block or two; asking the light client is all a poll costs */
export const MOVED_POLL_MS = 15_000;

export type Leg = 'move' | 'wait' | 'pay' | 'expired';

/** what the swap does next, from its address's plan and its record alone */
export const nextLeg = (
  plan: DepositPlan,
  moved: boolean,
  expiresAt: number | undefined,
  now: number,
): Leg =>
  plan.short === '0'
    ? expiresAt && expiresAt <= now
      ? 'expired'
      : 'pay'
    : moved
      ? 'wait'
      : tooLateToMove(expiresAt, now)
        ? 'expired'
        : 'move';

/** where a run stands, for the tracker */
export type Run =
  | { at: 'moving' | 'funding' | 'paying'; moved: boolean }
  /**
   * waiting for the person: an unlock that ran out, a zigner round they
   * stepped back from, or (`late`) a move that never reached a block
   */
  | { at: 'held'; moved: boolean; late?: true }
  | { at: 'sent'; moved: true; txid: string }
  | { at: 'expired'; moved: boolean }
  | { at: 'stopped'; moved: boolean; error: string };

export const runs = createStore<Record<string, Run>>()(() => ({}));

const report = (id: string, run: Run) => runs.setState({ [id]: run });

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

/** how a wallet signs the two legs */
export interface Legs {
  /** may the next leg sign now; false holds the run for the person */
  ready: () => Promise<boolean>;
  /**
   * shielded -> the swap's address, `shortZat`; resolves the txid. A wallet
   * that signs the deposit with it (zigner, one round) hands it to `hold`
   * before the move is broadcast.
   */
  move: (shortZat: string, hold: (held: Held | undefined) => Promise<void>) => Promise<string>;
  /** the reviewed deposit, or the one held since the move; resolves the txid */
  pay: (req: DepositRequest & { reviewedFee: string }, held?: Held) => Promise<string>;
}

export interface RunDeps {
  plan: (req: DepositRequest) => Promise<DepositPlan>;
  /** the height a txid was mined at, if it was */
  mined: (txid: string) => Promise<number | undefined>;
  tip: () => Promise<number>;
  save: (patch: Partial<OpenSwap>) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** the zec vault as every thornode operator reads it now; throws when they disagree */
  vault: () => Promise<{ inbound: Pick<ZecInbound, 'address' | 'halted' | 'tradingPaused'> }>;
}

const NOT_SENT = { move: 'nothing was sent', pay: 'nothing went to the vault' } as const;

/**
 * Throws unless the vault the quote named is still the one to pay and zec
 * trades: asked before each leg signs, since a vault can churn or a chain
 * halt between the quote and the deposit.
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

/** a step's own line for money that isn't there yet, over the worker's arithmetic */
const SHORT = {
  move: "the shielded balance doesn't cover this yet · nothing was sent",
  pay: "the swap's address doesn't cover this yet · nothing went to the vault",
} as const;

const lineOf = (e: unknown, leg: keyof typeof SHORT) => {
  const line =
    e instanceof Error && e.message ? e.message : 'something broke on our side, not yours';
  return /insufficient/i.test(line) ? SHORT[leg] : line;
};

const stopped = new Set<string>();

/**
 * Both legs, from wherever the record stands: a fresh swap moves first, a
 * reopened one whose move is out waits for it, a funded address pays. The
 * first plan may be the one the person reviewed.
 */
export const runThorOut = async (
  swap: OpenSwap,
  legs: Legs,
  deps: RunDeps,
  reviewed?: DepositPlan,
): Promise<void> => {
  const req = depositOf(swap);
  let held = swap.held;
  let moved = !!swap.moveTxid;
  let plan = reviewed;
  let leg: keyof typeof SHORT = 'move';
  const hold = async (h: Held | undefined) => {
    held = h;
    moved = !!h;
    await deps.save({ held: h, moveTxid: h?.moveTxid });
  };
  try {
    for (;;) {
      plan ??= await deps.plan(req);
      if (stopped.has(swap.id)) {
        return;
      }
      const now = deps.now();
      let next = nextLeg(plan, moved, swap.expiresAt, now);
      // a deposit signed with the move goes once the move is mined, and only then
      if (held && next !== 'expired') {
        const h = heldNext(held, await deps.mined(held.moveTxid), await deps.tip());
        if (h === 'lost') {
          await hold(undefined);
          report(swap.id, { at: 'held', moved: false, late: true });
          return;
        }
        if (h === 'drop') {
          held = undefined;
          await deps.save({ held: undefined });
          plan = undefined;
          continue;
        }
        next = h === 'wait' ? 'wait' : swap.expiresAt && swap.expiresAt <= now ? 'expired' : 'pay';
      }
      if (next === 'expired') {
        report(swap.id, { at: 'expired', moved });
        await closeSwapUnlock(swap.id);
        return;
      }
      if (next === 'wait') {
        report(swap.id, { at: 'funding', moved });
        await deps.sleep(MOVED_POLL_MS);
        plan = undefined;
        continue;
      }
      // a held deposit was approved with the move: it sends without asking again
      if (!held && !(await legs.ready())) {
        report(swap.id, { at: 'held', moved });
        return;
      }
      // a zigner move signs the deposit with it, so the vault is read again before either leg
      leg = next;
      stillPayable(await deps.vault(), req.to, leg);
      if (next === 'move') {
        report(swap.id, { at: 'moving', moved });
        const moveTxid = await legs.move(plan.short, hold);
        moved = true;
        await deps.save({ moveTxid });
        report(swap.id, { at: 'funding', moved });
        await deps.sleep(MOVED_POLL_MS);
        plan = undefined;
        continue;
      }
      report(swap.id, { at: 'paying', moved });
      const txid = await legs.pay(req, held);
      await deps.save({ stage: 'sent', depositTxid: txid, held: undefined });
      report(swap.id, { at: 'sent', moved: true, txid });
      await closeSwapUnlock(swap.id);
      return;
    }
  } catch (e) {
    // stepping back from zigner signs nothing: the run waits for the person
    report(
      swap.id,
      isZignerDeclined(e) ? { at: 'held', moved } : { at: 'stopped', moved, error: lineOf(e, leg) },
    );
    if (!isZignerDeclined(e)) {
      await closeSwapUnlock(swap.id);
    }
  }
};

const live = new Set<string>();

/** start a swap's run unless one is going; it reports into `runs` */
export const startThorOut = (
  swap: OpenSwap,
  legs: Legs,
  deps: RunDeps,
  reviewed?: DepositPlan,
): void => {
  if (live.has(swap.id)) {
    return;
  }
  live.add(swap.id);
  stopped.delete(swap.id);
  void runThorOut(swap, legs, deps, reviewed).finally(() => live.delete(swap.id));
};

/** the person let the swap go: the run ends at its next step, and its unlock with it */
export const stopThorOut = (id: string): void => {
  stopped.add(id);
  void closeSwapUnlock(id);
};

export const isRunning = (id: string): boolean => live.has(id);

// ── the swap's one unlock ──
//
// A hot swap asks the password once, at confirm, for both legs. The window
// is the grace window's rule (shared/tx-signing-security) scoped to this one
// swap: no longer than its price lives and never longer than grace, cleared
// with the session key on lock, and dropped when the swap's last leg is sent
// or the swap stops. Each leg that signs spends one of its `legs`; at
// foilhat ("always ask") a password covers one leg, so the deposit asks again.

/** how many legs one password signs at a security level */
export const legsPerUnlock = (level: TxSigningSecurity): number => (level === 'foilhat' ? 1 : 2);

export const openSwapUnlock = (
  id: string,
  expiresAt: number | undefined,
  legs: number,
  now = Date.now(),
) =>
  sessionExtStorage.set('swapUnlock', {
    id,
    until: Math.min(expiresAt ?? Infinity, now + SIGN_GRACE_MS),
    legs,
  });

/** true, and one leg spent, when this swap's unlock still covers a leg */
export const takeSwapUnlock = async (id: string, now = Date.now()): Promise<boolean> => {
  const w = await sessionExtStorage.get('swapUnlock');
  const left = w?.id === id ? (w.legs ?? 0) : 0;
  if (!left || shouldPromptPassword('grace', now, w!.until)) {
    return false;
  }
  await sessionExtStorage.set('swapUnlock', { ...w!, legs: left - 1 });
  return true;
};

const closeSwapUnlock = async (id: string) => {
  if ((await sessionExtStorage.get('swapUnlock'))?.id === id) {
    await sessionExtStorage.remove('swapUnlock');
  }
};
