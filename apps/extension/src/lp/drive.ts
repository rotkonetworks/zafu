/**
 * One turn of a flight: look at what the chain and THORNode say, move on,
 * and run the one send the stage wants. Every send is checked first and
 * refuses before anything moves: a vault zafu can't pay (a tex1 is paid as
 * its P2PKH twin, from transparent inputs only), a pause, a memo past 80
 * bytes. The vault is read fresh right before the zec leaves the shielded
 * pool and again right before the deposit. The record is saved with a
 * "sending" mark before each broadcast, so a closed tab never sends twice.
 *
 * Every save is a compare-and-set against the stored flight (`save` throws
 * StaleFlight when the stored copy moved on, say a cancel). The sending mark
 * is that save, so a cancel that lands first always wins: the turn stops
 * before anything is broadcast.
 */

import { checkVault, type DepositPlan, type DepositRequest } from '../workers/transparent-deposit';
import {
  advance,
  HALF_BLOCKS,
  needs,
  sending,
  sent,
  StaleFlight,
  stopped,
  type Facts,
  type Flight,
} from './flight';
import { askClears, memoFits, pairedAddMemo, RECOVER_MEMO } from './math';
import type { TxSeen, ZecInbound } from './thor';
import type { PairedPosition } from './rune';

export { StaleFlight };

export interface DriveDeps {
  /** the pocket store this page is bound to; a flight of another is never sent */
  owner: string;
  /** the pocket's lp address and its t-branch index */
  address: string;
  index: number;
  /** why this page may not send right now (zafu shows another wallet or pocket), or nothing */
  away?: () => string | undefined;
  /** THORChain's height, as last read */
  height?: () => number | undefined;
  /** a fresh look at the zec vault and the pauses */
  vault: () => Promise<{ inbound: ZecInbound; addPaused?: string; outPaused?: string }>;
  plan: (req: DepositRequest) => Promise<DepositPlan>;
  /** shielded -> the lp address */
  shieldOut: (zat: bigint) => Promise<string>;
  /** the lp address -> the vault, with the memo, at the reviewed fee */
  deposit: (req: DepositRequest, fee: string) => Promise<string>;
  /** the lp address -> shielded */
  shieldBack: () => Promise<string>;
  seen: (txid: string) => Promise<TxSeen>;
  units: () => Promise<bigint>;
  utxoZat: () => Promise<bigint[]>;
  /** Midgard's reason, when it may be asked */
  refundReason?: (txid: string) => Promise<string | undefined>;
  /**
   * Two-sided only (the pocket opted in to rune): sign one rune MsgDeposit in
   * the worker, simulate it, broadcast it; its hash.
   */
  runeSend?: (memo: string, rune: bigint) => Promise<string>;
  /** the position under the thor1 */
  paired?: () => Promise<PairedPosition | undefined>;
  /** a swap to rune: has THORChain paid it out */
  swapped?: (txid: string) => Promise<boolean>;
  /** a rune MsgDeposit by hash: on chain, refused there, or nowhere */
  runeTx?: (hash: string) => Promise<{ state: 'included' | 'failed' | 'missing'; log?: string }>;
  /**
   * Write `f` over the stored flight it was made from (same id and rev) and
   * hand back what was written; throws StaleFlight when the stored one moved
   * on. `after` a broadcast it writes over any rev of the same flight: the
   * txid is the truth then.
   */
  save: (f: Flight, after?: boolean) => Promise<Flight>;
}

export const VAULT_MOVED_LINE =
  'thorchain moved its zec vault since you confirmed · nothing was sent · continue to pay the new one';
export const ASK_LINE =
  "thorchain's least amount it sees moved past this take-out's ask · nothing was sent · please start the take-out again";
export const OWNER_LINE = 'this take-out or add belongs to another pocket · nothing was sent';

const line = (e: unknown) =>
  e instanceof Error && e.message ? e.message : 'something broke on our side, not yours';

export const PAUSED_LINE = {
  add: 'thorchain has paused adds to this pool · nothing was sent',
  withdraw: 'thorchain has paused take-outs from this pool · nothing was sent',
} as const;

/** this page may send this flight at all: its pocket, and the pocket zafu shows */
const mine = (f: Flight, d: DriveDeps) => {
  if (f.owner && f.owner !== d.owner) {
    throw new Error(OWNER_LINE);
  }
  const away = d.away?.();
  if (away) {
    throw new Error(away);
  }
};

/**
 * The vault to pay right now, or why not: asked before every move. The
 * first vault a flight pays toward is pinned on it; one that changes after
 * stops and asks (continue re-pins). A take-out's ask must still clear the
 * dust read now, within the cap.
 */
const isAdd = (f: Flight) => f.kind === 'add' || f.kind === 'add2';

const payable = async (f: Flight, d: DriveDeps): Promise<{ inbound: ZecInbound; f: Flight }> => {
  if (!memoFits(f.memo)) {
    throw new Error('this memo is longer than 80 bytes · nothing was sent');
  }
  const v = await d.vault();
  // a swap is not liquidity: its quote already checked that zec trades
  if (f.kind !== 'swap' && (isAdd(f) ? v.addPaused : v.outPaused)) {
    throw new Error(PAUSED_LINE[isAdd(f) ? 'add' : 'withdraw']);
  }
  await checkVault(v.inbound.address, true);
  if (f.vault && f.vault !== v.inbound.address) {
    throw new Error(VAULT_MOVED_LINE);
  }
  if (f.kind === 'withdraw' && !askClears(BigInt(f.amountZat), v.inbound.dust)) {
    throw new Error(ASK_LINE);
  }
  return { inbound: v.inbound, f: f.vault ? f : { ...f, vault: v.inbound.address } };
};

const reqOf = (f: Flight, d: DriveDeps, to: string): DepositRequest => ({
  tAddress: d.address,
  tIndex: d.index,
  to,
  amountZat: f.amountZat,
  memo: f.memo,
  mainnet: true,
});

/** what to look at for this stage, and only that */
export const observe = async (f: Flight, d: DriveDeps, to: string): Promise<Facts> => {
  const x: Facts = {};
  if (f.error || f.sending) {
    return x;
  }
  if (f.stage === 'settle') {
    x.short = BigInt((await d.plan(reqOf(f, d, to))).short);
  }
  // a two-sided take-out's ask is the rune MsgDeposit; THORNode tracks it by that hash
  const asked = f.kind === 'withdraw2' ? f.runeTxid : f.sendTxid;
  if ((f.stage === 'seen' || f.stage === 'credit' || f.stage === 'payout') && asked) {
    x.seen = await d.seen(asked);
    if (f.stage === 'credit' && f.kind !== 'add2') {
      x.units = await d.units();
    }
    if (f.stage === 'payout' && !x.seen.out && x.seen.finalised && d.refundReason) {
      x.refundReason = await d.refundReason(asked).catch(() => undefined);
    }
    if (x.seen.out?.refund && d.refundReason) {
      x.refundReason = await d.refundReason(asked).catch(() => undefined);
    }
  }
  if (f.stage === 'half') {
    x.height = d.height?.();
    const late =
      f.halfHeight !== undefined &&
      x.height !== undefined &&
      x.height - f.halfHeight >= HALF_BLOCKS;
    if (late && f.runeTxid && d.runeTx) {
      x.runeTx = await d.runeTx(f.runeTxid);
    }
  }
  if (f.kind === 'swap' && f.stage === 'seen' && f.sendTxid && d.swapped && !x.seen?.out?.refund) {
    x.swapped = await d.swapped(f.sendTxid);
  }
  if (
    d.paired &&
    (f.stage === 'half' ||
      f.stage === 'recovering' ||
      (f.stage === 'credit' && f.kind === 'add2') ||
      (f.stage === 'payout' && f.kind === 'withdraw2'))
  ) {
    const p = await d.paired();
    x.paired = p ?? { units: 0n, pendingRune: 0n, pendingAsset: 0n };
  }
  if (f.stage === 'payout') {
    x.height = d.height?.();
  }
  if (f.stage === 'arrive') {
    x.utxoZat = await d.utxoZat();
  }
  return x;
};

/**
 * Run the send the stage wants, and save what came of it. A refusal or
 * failure stops the flight with its line; a stored flight that moved on
 * (StaleFlight) stops the turn with nothing sent.
 */
export const act = async (f: Flight, d: DriveDeps): Promise<Flight> => {
  const step = needs(f);
  if (!step) {
    return f;
  }
  let at = f;
  try {
    mine(f, d);
    if (step === 'fund') {
      // refused here, before any zec leaves the shielded pool
      const p = await payable(f, d);
      at = p.f;
      const plan = await d.plan(reqOf(at, d, p.inbound.address));
      if (plan.short === '0') {
        return await d.save(sent(at, undefined));
      }
      const out = await d.save(sending(at));
      at = out;
      return await d.save(
        sent(out, await d.shieldOut(BigInt(plan.short)), { fundZat: plan.short }),
        true,
      );
    }
    if (step === 'rune' || step === 'recover') {
      if (!d.runeSend || !f.thor) {
        throw new Error('this pocket does not use rune here · nothing was sent');
      }
      // the pauses that stop zec liquidity stop its rune half too; a take-back goes regardless
      if (step === 'rune') {
        const v = await d.vault();
        if (isAdd(f) ? v.addPaused : v.outPaused) {
          throw new Error(PAUSED_LINE[isAdd(f) ? 'add' : 'withdraw']);
        }
      }
      const [memo, rune] =
        step === 'recover'
          ? [RECOVER_MEMO, 0n]
          : f.kind === 'add2'
            ? [pairedAddMemo(d.address), BigInt(f.runeBase ?? '0')]
            : [f.memo, 0n];
      if (f.kind === 'add2' && step === 'rune' && rune <= 0n) {
        throw new Error('this add has no rune half · nothing was sent');
      }
      const out = await d.save(sending(f));
      at = out;
      return await d.save(sent(out, await d.runeSend(memo, rune)), true);
    }
    if (step === 'send') {
      const p = await payable(f, d);
      at = p.f;
      const req = reqOf(at, d, p.inbound.address);
      const plan = await d.plan(req);
      if (plan.short !== '0') {
        throw new Error("your lp address doesn't hold this yet · nothing was sent");
      }
      const out = await d.save(sending(at));
      at = out;
      return await d.save(sent(out, await d.deposit(req, plan.fee)), true);
    }
    const out = await d.save(sending(f));
    at = out;
    return await d.save(sent(out, await d.shieldBack()), true);
  } catch (e) {
    if (e instanceof StaleFlight) {
      throw e;
    }
    // a step that failed stops with its line and waits for the person
    return d.save(stopped(at, line(e)), at.sending !== undefined);
  }
};

/**
 * One turn: look, move on, and send only when `mayAct` (the person confirmed
 * this flight in this tab). A reopened tab watches but never sends on its own.
 * The record is saved when it changed.
 */
export const drive = async (
  f: Flight,
  d: DriveDeps,
  to: string,
  mayAct = true,
): Promise<Flight> => {
  const seen = advance(f, await observe(f, d, to));
  const next = seen === f ? f : await d.save(seen);
  return mayAct ? act(next, d) : next;
};
