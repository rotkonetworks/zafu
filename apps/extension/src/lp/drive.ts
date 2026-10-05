/**
 * One turn of a flight: look at what the chain and THORNode say, move on,
 * and run the one send the stage wants. Every send is checked first and
 * refuses before anything moves: a vault zafu can't pay (a tex1 is paid as
 * its P2PKH twin, from transparent inputs only), a pause, a memo past 80
 * bytes. The vault is read fresh right before the zec leaves the shielded
 * pool and again right before the deposit. The record is saved with a
 * "sending" mark before each broadcast, so a closed tab never sends twice.
 */

import { checkVault, type DepositPlan, type DepositRequest } from '../workers/transparent-deposit';
import { advance, needs, sending, sent, stopped, type Facts, type Flight } from './flight';
import { memoFits } from './math';
import type { TxSeen, ZecInbound } from './thor';

export interface DriveDeps {
  /** the pocket's lp address and its t-branch index */
  address: string;
  index: number;
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
  save: (f: Flight) => Promise<unknown>;
}

const line = (e: unknown) =>
  e instanceof Error && e.message ? e.message : 'something broke on our side, not yours';

export const PAUSED_LINE = {
  add: 'thorchain has paused adds to this pool · nothing was sent',
  withdraw: 'thorchain has paused take-outs from this pool · nothing was sent',
} as const;

/** the vault to pay right now, or why not: asked before every move */
const payable = async (f: Flight, d: DriveDeps): Promise<ZecInbound> => {
  if (!memoFits(f.memo)) {
    throw new Error('this memo is longer than 80 bytes · nothing was sent');
  }
  const v = await d.vault();
  if (f.kind === 'add' ? v.addPaused : v.outPaused) {
    throw new Error(PAUSED_LINE[f.kind]);
  }
  await checkVault(v.inbound.address, true);
  return v.inbound;
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
  if ((f.stage === 'seen' || f.stage === 'credit' || f.stage === 'payout') && f.sendTxid) {
    x.seen = await d.seen(f.sendTxid);
    if (f.stage === 'credit') {
      x.units = await d.units();
    }
    if (f.stage === 'payout' && !x.seen.out && x.seen.finalised && d.refundReason) {
      x.refundReason = await d.refundReason(f.sendTxid).catch(() => undefined);
    }
    if (x.seen.out?.refund && d.refundReason) {
      x.refundReason = await d.refundReason(f.sendTxid).catch(() => undefined);
    }
  }
  if (f.stage === 'arrive') {
    x.utxoZat = await d.utxoZat();
  }
  return x;
};

/** run the send the stage wants; a refusal or failure stops the flight with its line */
export const act = async (f: Flight, d: DriveDeps): Promise<Flight> => {
  const step = needs(f);
  if (!step) {
    return f;
  }
  try {
    if (step === 'fund') {
      // refused here, before any zec leaves the shielded pool
      const inbound = await payable(f, d);
      const plan = await d.plan(reqOf(f, d, inbound.address));
      if (plan.short === '0') {
        return sent(f, undefined);
      }
      await d.save(sending(f));
      return sent(f, await d.shieldOut(BigInt(plan.short)), { fundZat: plan.short });
    }
    if (step === 'send') {
      const inbound = await payable(f, d);
      const req = reqOf(f, d, inbound.address);
      const plan = await d.plan(req);
      if (plan.short !== '0') {
        throw new Error("your lp address doesn't hold this yet · nothing was sent");
      }
      await d.save(sending(f));
      return sent(f, await d.deposit(req, plan.fee));
    }
    await d.save(sending(f));
    return sent(f, await d.shieldBack());
  } catch (e) {
    return stopped(f, line(e));
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
  let next = advance(f, await observe(f, d, to));
  if (mayAct) {
    next = await act(next, d);
  }
  if (next !== f) {
    await d.save(next);
  }
  return next;
};
