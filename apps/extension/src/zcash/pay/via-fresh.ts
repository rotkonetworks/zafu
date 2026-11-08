/**
 * A payment that must leave from transparent inputs (a thorchain deposit, a
 * ZIP 320 tex address) as one service: fund the payment's own fresh
 * transparent address from the shielded pool when it is short, wait for the
 * network to confirm that, then send the reviewed payment from it. One press
 * starts it; the legs run here, outside any screen, so the person can leave
 * and home shows where it stands. A closed popup stops the run; its record
 * is where the next popup picks it up.
 *
 * How a leg is signed is the `Legs` given (./legs: a hot wallet's under the
 * payment's one unlock, or zigner's one qr round for both, the payment held
 * until the move is mined). What the payment is for is the caller's: a
 * `check` filter asked before each leg signs (thorchain's vault still open),
 * and an `expiresAt` for a price that runs out.
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

/**
 * How much of a price's life the move needs: build, a block or two and the
 * poll. A price with less than this left is asked again before any zec
 * leaves the shielded pool.
 */
export const MOVE_NEEDS_MS = 6 * 60_000;

/** true when the price can't outlast the move: ask again before moving */
export const tooLateToMove = (expiresAt: number | undefined, now = Date.now()): boolean =>
  !!expiresAt && expiresAt - now < MOVE_NEEDS_MS;

/** a move confirms in a block or two; asking the light client is all a poll costs */
export const MOVED_POLL_MS = 15_000;

export type Leg = 'move' | 'wait' | 'pay' | 'expired';

/** what the payment does next, from its address's plan and its record alone */
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

/** the payment as reviewed: what the fresh address pays, and how far it got */
export interface FreshPayment {
  id: string;
  /** exactly what is signed; `tAddress`/`tIndex` are the payment's own fresh address */
  req: DepositRequest & { reviewedFee: string };
  moveTxid?: string;
  /** zigner: the payment signed with the move, sent once the move is mined */
  held?: Held;
  /** ms epoch the price stops holding; none never expires */
  expiresAt?: number;
}

/** how a wallet signs the two legs */
export interface Legs {
  /** may the next leg sign now; false holds the run for the person */
  ready: () => Promise<boolean>;
  /**
   * shielded -> the fresh address, `shortZat`; resolves the txid. A wallet
   * that signs the payment with it (zigner, one round) hands it to `hold`
   * before the move is broadcast.
   */
  move: (shortZat: string, hold: (held: Held | undefined) => Promise<void>) => Promise<string>;
  /** the reviewed payment, or the one held since the move; resolves the txid */
  pay: (req: DepositRequest & { reviewedFee: string }, held?: Held) => Promise<string>;
}

type Step = 'move' | 'pay';

export interface FreshDeps {
  plan: (req: DepositRequest) => Promise<DepositPlan>;
  /** the height a txid was mined at, if it was */
  mined: (txid: string) => Promise<number | undefined>;
  tip: () => Promise<number>;
  /** what the record learns: the move, or the payment held with it */
  save: (patch: { held?: Held; moveTxid?: string }) => Promise<unknown>;
  /** the payment went out */
  done: (txid: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** asked before each leg signs; throws to stop the run with its line */
  check?: (leg: Step) => Promise<void>;
  /** the caller's line for money that isn't there yet, per step */
  short?: Record<Step, string>;
}

const SHORT: Record<Step, string> = {
  move: "the shielded balance doesn't cover this yet · nothing was sent",
  pay: "the fresh address doesn't cover this yet · nothing was paid",
};

const lineOf = (e: unknown, leg: Step, short: Record<Step, string>) => {
  const line =
    e instanceof Error && e.message ? e.message : 'something broke on our side, not yours';
  return /insufficient/i.test(line) ? short[leg] : line;
};

const stopped = new Set<string>();

/**
 * Both legs, from wherever the record stands: a fresh payment moves first, a
 * reopened one whose move is out waits for it, a funded address pays. The
 * first plan may be the one the person reviewed.
 */
export const runViaFresh = async (
  p: FreshPayment,
  legs: Legs,
  deps: FreshDeps,
  reviewed?: DepositPlan,
): Promise<void> => {
  const { req } = p;
  const short = deps.short ?? SHORT;
  let held = p.held;
  let moved = !!p.moveTxid;
  let moveTxid = p.moveTxid;
  let plan = reviewed;
  let leg: Step = 'move';
  const hold = async (h: Held | undefined) => {
    held = h;
    moved = !!h;
    moveTxid = h?.moveTxid;
    await deps.save({ held: h, moveTxid: h?.moveTxid });
  };
  try {
    for (;;) {
      plan ??= await deps.plan(req);
      if (stopped.has(p.id)) {
        return;
      }
      const now = deps.now();
      let next = nextLeg(plan, moved, p.expiresAt, now);
      // a payment signed with the move goes once the move is mined, and only then
      if (held && next !== 'expired') {
        const h = heldNext(held, await deps.mined(held.moveTxid), await deps.tip());
        if (h === 'lost') {
          await hold(undefined);
          report(p.id, { at: 'held', moved: false, late: true });
          return;
        }
        if (h === 'drop') {
          held = undefined;
          await deps.save({ held: undefined });
          plan = undefined;
          continue;
        }
        next = h === 'wait' ? 'wait' : p.expiresAt && p.expiresAt <= now ? 'expired' : 'pay';
      }
      if (next === 'expired') {
        report(p.id, { at: 'expired', moved });
        await closePayUnlock(p.id);
        return;
      }
      if (next === 'wait') {
        report(p.id, { at: 'funding', moved });
        await deps.sleep(MOVED_POLL_MS);
        plan = undefined;
        continue;
      }
      // a held payment was approved with the move: it sends without asking again
      if (!held && !(await legs.ready())) {
        report(p.id, { at: 'held', moved });
        return;
      }
      // a zigner move signs the payment with it, so the check runs before either leg
      leg = next;
      await deps.check?.(leg);
      if (next === 'move') {
        report(p.id, { at: 'moving', moved });
        moveTxid = await legs.move(plan.short, hold);
        moved = true;
        await deps.save({ moveTxid });
        report(p.id, { at: 'funding', moved });
        await deps.sleep(MOVED_POLL_MS);
        plan = undefined;
        continue;
      }
      report(p.id, { at: 'paying', moved });
      // the payment's record carries its move, so history shows one row
      const txid = await legs.pay(moveTxid ? { ...req, moveTxid } : req, held);
      await deps.done(txid);
      report(p.id, { at: 'sent', moved: true, txid });
      await closePayUnlock(p.id);
      return;
    }
  } catch (e) {
    // stepping back from zigner signs nothing: the run waits for the person
    report(
      p.id,
      isZignerDeclined(e)
        ? { at: 'held', moved }
        : { at: 'stopped', moved, error: lineOf(e, leg, short) },
    );
    if (!isZignerDeclined(e)) {
      await closePayUnlock(p.id);
    }
  }
};

const live = new Set<string>();

/** start a payment's run unless one is going; it reports into `runs` */
export const startViaFresh = (
  p: FreshPayment,
  legs: Legs,
  deps: FreshDeps,
  reviewed?: DepositPlan,
): void => {
  if (live.has(p.id)) {
    return;
  }
  live.add(p.id);
  stopped.delete(p.id);
  void runViaFresh(p, legs, deps, reviewed).finally(() => live.delete(p.id));
};

/** the person let the payment go: the run ends at its next step, and its unlock with it */
export const stopViaFresh = (id: string): void => {
  stopped.add(id);
  void closePayUnlock(id);
};

export const isRunning = (id: string): boolean => live.has(id);

// ── the payment's one unlock ──
//
// A hot payment asks the password once, at confirm, for both legs. The
// window is the grace window's rule (shared/tx-signing-security) scoped to
// this one payment: no longer than its price lives and never longer than
// grace, cleared with the session key on lock, and dropped when the last leg
// is sent or the run stops. Each leg that signs spends one of its `legs`; at
// foilhat ("always ask") a password covers one leg, so the payment asks again.

/** how many legs one password signs at a security level */
export const legsPerUnlock = (level: TxSigningSecurity): number => (level === 'foilhat' ? 1 : 2);

export const openPayUnlock = (
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

/** true, and one leg spent, when this payment's unlock still covers a leg */
export const takePayUnlock = async (id: string, now = Date.now()): Promise<boolean> => {
  const w = await sessionExtStorage.get('swapUnlock');
  const left = w?.id === id ? (w.legs ?? 0) : 0;
  if (!left || shouldPromptPassword('grace', now, w!.until)) {
    return false;
  }
  await sessionExtStorage.set('swapUnlock', { ...w!, legs: left - 1 });
  return true;
};

const closePayUnlock = async (id: string) => {
  if ((await sessionExtStorage.get('swapUnlock'))?.id === id) {
    await sessionExtStorage.remove('swapUnlock');
  }
};
