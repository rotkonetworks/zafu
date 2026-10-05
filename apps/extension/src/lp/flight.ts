/**
 * One add or take-out in flight, as a small machine. A stage names the step
 * running now; the page drives it (`needs` says which step wants a send,
 * `advance` moves on from what the chain and THORNode were seen to say). The
 * record is persisted after every move, so a closed tab resumes where it
 * stood: a send whose txid was never written is never sent twice, it stops
 * and asks.
 *
 *  add:      fund -> settle -> send -> seen -> credit -> credited
 *                                             \-> refunded -> shield -> shielded
 *  withdraw: fund -> settle -> ask  -> payout -> arrive -> shield -> shielded
 *                                     \-> refused
 */

import type { TxSeen } from './thor';

export type Stage =
  | 'fund'
  | 'settle'
  | 'send'
  | 'seen'
  | 'credit'
  | 'credited'
  | 'refunded'
  | 'ask'
  | 'payout'
  | 'arrive'
  | 'shield'
  | 'shielded'
  | 'refused';

export interface Flight {
  v: 1;
  id: string;
  kind: 'add' | 'withdraw';
  stage: Stage;
  /** what goes to the vault: the add, or the withdraw's dust ask (zat, decimal) */
  amountZat: string;
  memo: string;
  /** a withdraw's basis points */
  bps?: number;
  /** an add's cost vs market at the confirm, percent: a reopened tab compares against it */
  costPct?: number;
  /** a withdraw's expected payout, before its fee, at the review */
  expectZat?: string;
  /** what the shield-out moved to the lp address */
  fundZat?: string;
  /** the position's units before an add, to tell when it is credited */
  unitsBefore?: string;
  fundTxid?: string;
  sendTxid?: string;
  outTxid?: string;
  shieldTxid?: string;
  /** zec THORChain sent back to the lp address: a refund or a payout */
  outZat?: string;
  /** THORChain's reason for a refund or a refusal */
  reason?: string;
  /** a send went to the network and its txid isn't written yet */
  sending?: Stage;
  /** stopped: one calm line, the flight waits for the person */
  error?: string;
  /** the person cancelled before the pool got it: whatever reached the lp address is shielded back */
  cancelled?: true;
  /** when each stage began */
  at: Partial<Record<Stage, number>>;
  started: number;
}

export const DONE: ReadonlySet<Stage> = new Set(['credited', 'shielded', 'refused']);
export const isDone = (f: Flight): boolean => DONE.has(f.stage);

const STAGES: ReadonlySet<string> = new Set([
  'fund',
  'settle',
  'send',
  'seen',
  'credit',
  'credited',
  'refunded',
  'ask',
  'payout',
  'arrive',
  'shield',
  'shielded',
  'refused',
]);

/** a stored value is a flight only if it has the shape this build writes */
export const isFlight = (v: unknown): v is Flight => {
  const f = v as Flight;
  return (
    !!f &&
    typeof f === 'object' &&
    f.v === 1 &&
    (f.kind === 'add' || f.kind === 'withdraw') &&
    STAGES.has(f.stage) &&
    typeof f.amountZat === 'string' &&
    typeof f.memo === 'string' &&
    typeof f.at === 'object'
  );
};

export const startFlight = (
  kind: Flight['kind'],
  amountZat: bigint,
  memo: string,
  extra: Partial<Flight> = {},
  now = Date.now(),
): Flight => ({
  v: 1,
  id: `${kind}-${now.toString(36)}`,
  kind,
  stage: 'fund',
  amountZat: amountZat.toString(),
  memo,
  at: { fund: now },
  started: now,
  ...extra,
});

const to = (f: Flight, stage: Stage, patch: Partial<Flight> = {}, now = Date.now()): Flight => ({
  ...f,
  ...patch,
  stage,
  error: undefined,
  at: { ...f.at, [stage]: now },
});

/** the step that sends something, if the stage wants one and none is out */
export const needs = (f: Flight): 'fund' | 'send' | 'shield' | undefined =>
  f.error || f.sending
    ? undefined
    : f.stage === 'fund' && !f.fundTxid
      ? 'fund'
      : (f.stage === 'send' || f.stage === 'ask') && !f.sendTxid
        ? 'send'
        : f.stage === 'shield' && !f.shieldTxid
          ? 'shield'
          : undefined;

/** before a send leaves: written first, so a crash mid-send is never sent again */
export const sending = (f: Flight): Flight => ({ ...f, sending: f.stage });

/**
 * After a send: its txid, and the stage it leads to. A shield-out of nothing
 * (the lp address already holds enough) goes straight to the send.
 */
export const sent = (f: Flight, txid: string | undefined, patch: Partial<Flight> = {}): Flight => {
  const base = { ...f, ...patch, sending: undefined };
  switch (f.stage) {
    case 'fund':
      return txid
        ? to(base, 'settle', { fundTxid: txid })
        : to(base, f.kind === 'add' ? 'send' : 'ask');
    case 'send':
      return to(base, 'seen', { sendTxid: txid });
    case 'ask':
      return to(base, 'payout', { sendTxid: txid });
    case 'shield':
      return to(base, 'shielded', { shieldTxid: txid });
    default:
      return base;
  }
};

/** a send that failed before it left: the flight waits, with the line */
export const stopped = (f: Flight, error: string): Flight => ({ ...f, sending: undefined, error });

/**
 * Resuming a record: a send marked out with no txid may have reached the
 * network. It is never sent again by itself; it stops and asks.
 */
export const resumed = (f: Flight): Flight =>
  f.sending && !isDone(f)
    ? {
        ...f,
        sending: undefined,
        error:
          'this step may already have gone out · please look at the history before trying again',
      }
    : f;

/** what was seen since the last look */
export interface Facts {
  /** what the lp address is still missing for the send; 0 once the shield-out is mined */
  short?: bigint;
  /** THORNode's view of our send */
  seen?: TxSeen;
  /** the position's units now */
  units?: bigint;
  /** the coins at the lp address now, zat each (a payout lands as one coin of its exact amount) */
  utxoZat?: bigint[];
  /** Midgard's refund reason for our send */
  refundReason?: string;
}

/** move on from what was seen; nothing seen, nothing moves */
export const advance = (f: Flight, x: Facts, now = Date.now()): Flight => {
  if (f.error || f.sending) {
    return f;
  }
  switch (f.stage) {
    case 'settle':
      return x.short === 0n ? to(f, f.kind === 'add' ? 'send' : 'ask', {}, now) : f;
    case 'seen':
    case 'credit': {
      const s = x.seen;
      if (s?.out?.refund) {
        return to(
          f,
          'refunded',
          { outZat: s.out.zat.toString(), outTxid: s.out.txid, reason: x.refundReason ?? f.reason },
          now,
        );
      }
      if (f.stage === 'seen') {
        return s?.observed ? to(f, 'credit', {}, now) : f;
      }
      const before = BigInt(f.unitsBefore ?? '0');
      return s?.finalised && x.units !== undefined && x.units > before
        ? to(f, 'credited', {}, now)
        : f;
    }
    case 'refunded':
      // the refund lands at the lp address; the person chooses to shield it or keep it
      return f.reason === undefined && x.refundReason ? { ...f, reason: x.refundReason } : f;
    case 'payout': {
      const out = x.seen?.out;
      if (out && !out.refund && out.txid) {
        return to(f, 'arrive', { outZat: out.zat.toString(), outTxid: out.txid }, now);
      }
      return x.refundReason ? to(f, 'refused', { reason: x.refundReason }, now) : f;
    }
    case 'arrive': {
      // the payout lands as one coin of its amount; a coin a little under it (a fee taken on the
      // way) counts too, so a rounding THORChain does never leaves the zec sitting transparent
      const want = f.outZat ? BigInt(f.outZat) : undefined;
      return want && x.utxoZat?.some(v => v <= want && v >= (want * 99n) / 100n)
        ? to(f, 'shield', {}, now)
        : f;
    }
    default:
      return f;
  }
};

/** a refunded add's coins, shielded back at the person's word */
/**
 * Cancel before the pool got anything: with nothing moved yet the flight is
 * simply dropped (undefined); once zec sits at the lp address (a shield-out,
 * or coins already there) it is shielded back. Past the send, there is
 * nothing to cancel.
 */
export const cancelFlight = (f: Flight, now = Date.now()): Flight | undefined =>
  f.stage === 'fund' && !f.fundTxid && !f.sending
    ? undefined
    : f.stage === 'fund' || f.stage === 'settle' || f.stage === 'send' || f.stage === 'ask'
      ? to({ ...f, cancelled: true, sending: undefined }, 'shield', {}, now)
      : f;

/** may this flight still be cancelled (nothing has reached the pool) */
export const cancellable = (f: Flight): boolean =>
  !f.cancelled &&
  (f.stage === 'fund' || f.stage === 'settle' || f.stage === 'send' || f.stage === 'ask') &&
  !f.sendTxid;

/** a refunded add's coins, or a payout that sits at the lp address, shielded back at the person's word */
export const shieldRefund = (f: Flight, now = Date.now()): Flight =>
  f.stage === 'refunded' || f.stage === 'arrive' ? to(f, 'shield', {}, now) : f;

export type StepState = 'done' | 'now' | 'later' | 'turned';

export interface StepLine {
  t: string;
  d?: string;
  at?: number;
  state: StepState;
}

const ORDER: Record<Flight['kind'], Stage[]> = {
  add: ['fund', 'settle', 'send', 'seen', 'credit', 'credited'],
  withdraw: ['fund', 'settle', 'ask', 'payout', 'arrive', 'shield', 'shielded'],
};

/** where the flight stands in its own order: a refund is past the send */
const rank = (f: Flight): number =>
  f.stage === 'refunded' || f.stage === 'refused'
    ? 3.5
    : f.stage === 'shield' || f.stage === 'shielded'
      ? f.kind === 'add'
        ? 9
        : ORDER.withdraw.indexOf(f.stage)
      : ORDER[f.kind].indexOf(f.stage);

const stateAt = (f: Flight, i: number): StepState => {
  const r = rank(f);
  return i < r || isDone(f) ? 'done' : i === Math.floor(r) ? 'now' : 'later';
};

/** the tracker's lines: real steps, stamped when each began */
export const stepLines = (
  f: Flight,
  t: {
    zec: (zat: bigint) => string;
    address: string;
    pocket: string;
  },
): StepLine[] => {
  const z = (s?: string) => (s ? t.zec(BigInt(s)) : '');
  const at = (s: Stage) => f.at[s];
  const line = (i: number, s: Stage, title: string, d?: string): StepLine => ({
    t: title,
    d,
    at: stateAt(f, i) === 'done' ? at(ORDER[f.kind][i + 1] ?? s) : undefined,
    state: stateAt(f, i),
  });
  if (f.cancelled) {
    return [
      { t: 'cancelled · nothing went to the pool', at: at('shield'), state: 'turned' },
      {
        t: `shielded back to ${t.pocket}`,
        at: at('shielded'),
        state: f.stage === 'shielded' ? 'done' : 'now',
      },
    ];
  }
  if (f.kind === 'add') {
    const head = [
      line(
        0,
        'fund',
        'shield out to your lp address',
        f.fundZat ? `${z(f.fundZat)} zec` : undefined,
      ),
      line(1, 'settle', 'one block to settle', 'zcash confirmation'),
      line(2, 'send', 'sent to the pool', `memo ${f.memo} · ${z(f.amountZat)} zec`),
    ];
    if (f.stage === 'refunded' || (f.stage.startsWith('shield') && f.outZat)) {
      return [
        ...head.map(l => ({ ...l, state: 'done' as const })),
        {
          t: 'thorchain returned it',
          d: f.reason ? `its reason: ${f.reason}` : undefined,
          at: at('refunded'),
          state: 'turned',
        },
        {
          t: 'back at your lp address',
          d: f.outZat ? `${z(f.outZat)} zec, less the pool's return fee` : undefined,
          at: at('refunded'),
          state: 'done',
        },
        ...(f.stage === 'refunded'
          ? []
          : [
              {
                t: `shielded back to ${t.pocket}`,
                at: at('shielded'),
                state: (f.stage === 'shielded' ? 'done' : 'now') as StepState,
              },
            ]),
      ];
    }
    return [
      ...head,
      line(3, 'seen', 'seen by thorchain', 'after 1 confirmation, about 75 s'),
      line(4, 'credit', 'credited', 'your units and share appear'),
    ];
  }
  const lines = [
    line(
      0,
      'fund',
      'fund the ask',
      f.fundZat ? `${z(f.fundZat)} zec to your lp address, one block` : 'from your lp address',
    ),
    line(2, 'ask', 'asked the pool', `${z(f.amountZat)} zec from ${t.address} · ${f.memo}`),
    line(
      3,
      'payout',
      'the pool pays out',
      f.outZat
        ? `${z(f.outZat)} zec`
        : f.expectZat
          ? `≈ ${z(f.expectZat)} zec, after the pool's fee`
          : undefined,
    ),
    line(4, 'arrive', 'arrived at your lp address'),
    line(5, 'shield', `shielded back to ${t.pocket}`),
  ];
  // fund and settle are one line on a take-out
  lines[0] = { ...lines[0]!, state: f.stage === 'settle' ? 'now' : lines[0]!.state };
  if (f.stage === 'refused') {
    return [
      lines[0],
      { ...lines[1]!, state: 'done' },
      {
        t: 'thorchain did not take it out',
        d: f.reason ? `its reason: ${f.reason}` : undefined,
        at: at('refused'),
        state: 'turned',
      },
    ];
  }
  return lines;
};
