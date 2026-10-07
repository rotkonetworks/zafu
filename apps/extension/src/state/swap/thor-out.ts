/**
 * A thorchain swap out of zec as one service: fund the swap's own transparent
 * address from the shielded pool when it is short, wait for the network to
 * confirm that, then send the reviewed deposit (a t->t with the memo in an
 * OP_RETURN). One press starts it; the legs run here, outside any screen, so
 * the person can leave and home shows where it stands. A closed popup stops
 * the run; its record (open-swaps) is where the next popup picks it up.
 *
 * How a leg is signed is the `Legs` given: a hot wallet's, under the swap's
 * one unlock, or zigner's, one qr round each.
 */

import { createStore } from 'zustand/vanilla';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { SIGN_GRACE_MS, shouldPromptPassword } from '../../shared/tx-signing-security';
import type { DepositPlan, DepositRequest } from '../../workers/transparent-deposit';
import { isZignerDeclined } from '../../signing/zigner-round';
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
  /** waiting for the person: an unlock that ran out, or a zigner round they stepped back from */
  | { at: 'held'; moved: boolean }
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
  /** shielded -> the swap's address, `shortZat`; resolves the txid */
  move: (shortZat: string) => Promise<string>;
  /** the reviewed deposit; resolves the txid */
  pay: (req: DepositRequest & { reviewedFee: string }) => Promise<string>;
}

export interface RunDeps {
  plan: (req: DepositRequest) => Promise<DepositPlan>;
  save: (patch: Partial<OpenSwap>) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

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
  let moved = !!swap.moveTxid;
  let plan = reviewed;
  let leg: keyof typeof SHORT = 'move';
  try {
    for (;;) {
      plan ??= await deps.plan(req);
      if (stopped.has(swap.id)) {
        return;
      }
      const next = nextLeg(plan, moved, swap.expiresAt, deps.now());
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
      if (!(await legs.ready())) {
        report(swap.id, { at: 'held', moved });
        return;
      }
      if (next === 'move') {
        leg = 'move';
        report(swap.id, { at: 'moving', moved });
        const moveTxid = await legs.move(plan.short);
        moved = true;
        await deps.save({ moveTxid });
        report(swap.id, { at: 'funding', moved });
        await deps.sleep(MOVED_POLL_MS);
        plan = undefined;
        continue;
      }
      leg = 'pay';
      report(swap.id, { at: 'paying', moved });
      const txid = await legs.pay(req);
      await deps.save({ stage: 'sent', depositTxid: txid });
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
// or the swap stops.

export const openSwapUnlock = (id: string, expiresAt: number | undefined, now = Date.now()) =>
  sessionExtStorage.set('swapUnlock', {
    id,
    until: Math.min(expiresAt ?? Infinity, now + SIGN_GRACE_MS),
  });

export const swapUnlocked = async (id: string, now = Date.now()): Promise<boolean> => {
  const w = await sessionExtStorage.get('swapUnlock');
  return !shouldPromptPassword('grace', now, w?.id === id ? w.until : undefined);
};

const closeSwapUnlock = async (id: string) => {
  if ((await sessionExtStorage.get('swapUnlock'))?.id === id) {
    await sessionExtStorage.remove('swapUnlock');
  }
};
