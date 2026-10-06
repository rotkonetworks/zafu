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
 *
 * With rune too (the pocket opted in; lp/store.ts optInRune):
 *  add2:      fund -> settle -> rune -> half -> send -> seen -> credit -> credited
 *             the rune half goes first and is seen waiting before any zec goes
 *             to the pool; a zec half sent back leaves the rune waiting:
 *             refunded -> recover -> recovering -> shield -> shielded
 *             a rune half not seen waiting within HALF_BLOCKS and not on chain: lost
 *  withdraw2: ask (from the thor1) -> payout -> arrive -> shield -> shielded
 *                                         \-> received (paid all in rune)
 *  swap:      fund -> settle -> send -> seen -> received (zec to rune, paid to the thor1)
 *                                          \-> refunded -> shield -> shielded
 */

import type { PayoutAs } from './math';

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
  | 'refused'
  | 'rune'
  | 'half'
  | 'recover'
  | 'recovering'
  | 'received'
  | 'lost';

export interface Flight {
  v: 1;
  id: string;
  kind: 'add' | 'withdraw' | 'add2' | 'withdraw2' | 'swap';
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
  /** bumped on every write: a write made from an older copy is refused (lp/store.ts saveFlight) */
  rev?: number;
  /** the pocket store this flight belongs to; a page bound to another pocket never sends it */
  owner?: string;
  /** the vault the person's flight first paid toward: a change stops and asks */
  vault?: string;
  /** THORChain's height when the take-out's payout was first watched */
  askHeight?: number;
  /** no payout planned within PAYOUT_BLOCKS of the ask: still watched, and said plainly */
  late?: true;
  /** two-sided: the pocket's thor1 the rune half goes from */
  thor?: string;
  /** two-sided add: the rune half, 1e8 */
  runeBase?: string;
  /** the rune MsgDeposit's hash: an add's rune half, or a take-out's ask */
  runeTxid?: string;
  /** THORChain's height when the rune half was first watched for */
  halfHeight?: number;
  /** the rune half never arrived: the add ended with nothing added */
  lost?: true;
  /** the MsgDeposit that took a waiting half back */
  recoverTxid?: string;
  /** a two-sided take-out pays both sides, or all in one */
  payoutAs?: PayoutAs;
  /** two-sided take-out: the rune it should pay, 1e8, at the review */
  expectRune?: string;
  /** when each stage began */
  at: Partial<Record<Stage, number>>;
  started: number;
}

/** the stored flight moved on (a cancel, another writer): this turn stops, nothing is sent */
export class StaleFlight extends Error {
  constructor() {
    super('this flight changed while it was being driven');
  }
}

export const DONE: ReadonlySet<Stage> = new Set([
  'credited',
  'shielded',
  'refused',
  'received',
  'lost',
]);
export const PAIRED_KINDS: ReadonlySet<Flight['kind']> = new Set(['add2', 'withdraw2', 'swap']);
export const isPaired = (f: Pick<Flight, 'kind'>): boolean => PAIRED_KINDS.has(f.kind);
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
  'rune',
  'half',
  'recover',
  'recovering',
  'received',
  'lost',
]);

const KINDS: ReadonlySet<string> = new Set(['add', 'withdraw', 'add2', 'withdraw2', 'swap']);

/** a stored value is a flight only if it has the shape this build writes */
export const isFlight = (v: unknown): v is Flight => {
  const f = v as Flight;
  return (
    !!f &&
    typeof f === 'object' &&
    f.v === 1 &&
    KINDS.has(f.kind) &&
    (!isPaired(f) || typeof f.thor === 'string') &&
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

export type Step = 'fund' | 'send' | 'shield' | 'rune' | 'recover';

/** the step that sends something, if the stage wants one and none is out */
export const needs = (f: Flight): Step | undefined =>
  f.error || f.sending
    ? undefined
    : f.stage === 'fund' && !f.fundTxid
      ? 'fund'
      : (f.stage === 'rune' || (f.stage === 'ask' && f.kind === 'withdraw2')) && !f.runeTxid
        ? 'rune'
        : (f.stage === 'send' || f.stage === 'ask') && !f.sendTxid
          ? 'send'
          : f.stage === 'recover' && !f.recoverTxid
            ? 'recover'
            : f.stage === 'shield' && !f.shieldTxid
              ? 'shield'
              : undefined;

/** the stage a funded add moves to: the rune half first when there is one */
const afterFund = (f: Flight): Stage =>
  f.kind === 'add2' ? 'rune' : f.kind === 'add' || f.kind === 'swap' ? 'send' : 'ask';

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
      return txid ? to(base, 'settle', { fundTxid: txid }) : to(base, afterFund(f));
    case 'rune':
      return to(base, 'half', { runeTxid: txid });
    case 'send':
      return to(base, 'seen', { sendTxid: txid });
    case 'ask':
      return f.kind === 'withdraw2'
        ? to(base, 'payout', { runeTxid: txid })
        : to(base, 'payout', { sendTxid: txid });
    case 'recover':
      return to(base, 'recovering', { recoverTxid: txid });
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
  /** THORChain's height now */
  height?: number;
  /** the position under the thor1, two-sided only */
  paired?: { units: bigint; pendingRune: bigint; pendingAsset: bigint };
  /** a swap to rune: THORChain has paid it out */
  swapped?: boolean;
  /** the rune half's tx, looked up past the deadline: on chain, refused there, or nowhere */
  runeTx?: { state: 'included' | 'failed' | 'missing'; log?: string };
}

/**
 * How long a rune half may take to show as waiting before its tx is looked
 * up: about 10 minutes of THORChain blocks. Included means it is late and
 * still watched; missing or refused ends the add, with nothing added.
 */
export const HALF_BLOCKS = 100;

/**
 * How long a take-out waits for THORChain to plan its payout before the page
 * says so: about 30 minutes of THORChain blocks. Past it the flight keeps
 * watching (a late payout still moves it on); the page only stops pretending.
 */
export const PAYOUT_BLOCKS = 300;

/** move on from what was seen; nothing seen, nothing moves */
export const advance = (f: Flight, x: Facts, now = Date.now()): Flight => {
  if (f.error || f.sending) {
    return f;
  }
  switch (f.stage) {
    case 'settle':
      return x.short === 0n ? to(f, afterFund(f), {}, now) : f;
    case 'half': {
      // the rune half is in, waiting: now the zec half may go. A two-sided add
      // onto units already there is credited at once (no pending), which also counts
      const p = x.paired;
      const before = BigInt(f.unitsBefore ?? '0');
      if (p && (p.pendingRune >= BigInt(f.runeBase ?? '1') || p.units > before)) {
        return to(f, 'send', { halfHeight: undefined }, now);
      }
      // not seen waiting: the zec half never goes. Past the deadline, a rune tx
      // that is nowhere (or refused) ends the add calmly; one that landed is waited for
      if (x.runeTx && x.runeTx.state !== 'included') {
        return to(f, 'lost', { reason: x.runeTx.log, lost: true }, now);
      }
      if (f.halfHeight === undefined && x.height !== undefined && x.height > 0) {
        return { ...f, halfHeight: x.height };
      }
      return f;
    }
    case 'recovering': {
      const p = x.paired;
      if (!p || p.pendingRune > 0n || p.pendingAsset > 0n) {
        return f;
      }
      // the rune is back at the thor1; zec that came back to the lp address is shielded
      return f.outZat || f.fundTxid || f.cancelled
        ? to(f, 'shield', {}, now)
        : to(f, 'received', {}, now);
    }
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
      if (f.kind === 'swap') {
        return x.swapped ? to(f, 'received', {}, now) : f;
      }
      if (f.stage === 'seen') {
        return s?.observed ? to(f, 'credit', {}, now) : f;
      }
      const before = BigInt(f.unitsBefore ?? '0');
      const units = f.kind === 'add2' ? x.paired?.units : x.units;
      return s?.finalised && units !== undefined && units > before ? to(f, 'credited', {}, now) : f;
    }
    case 'refunded':
      // the refund lands at the lp address; the person chooses to shield it or keep it
      return f.reason === undefined && x.refundReason ? { ...f, reason: x.refundReason } : f;
    case 'payout': {
      const out = x.seen?.out;
      // paid all in rune: nothing comes to the lp address, the units drop under the thor1
      if (f.kind === 'withdraw2' && f.payoutAs === 'rune') {
        const before = BigInt(f.unitsBefore ?? '0');
        if (x.seen?.finalised && x.paired && x.paired.units < before) {
          return to(f, 'received', { late: undefined }, now);
        }
      }
      if (out && !out.refund && out.txid) {
        return to(
          f,
          'arrive',
          { outZat: out.zat.toString(), outTxid: out.txid, late: undefined },
          now,
        );
      }
      if (x.refundReason) {
        return to(f, 'refused', { reason: x.refundReason, late: undefined }, now);
      }
      if (x.height === undefined || x.height <= 0) {
        return f;
      }
      if (f.askHeight === undefined) {
        return { ...f, askHeight: x.height };
      }
      // nothing planned for us this long after the ask: said plainly, still watched
      return !out && !f.late && x.height - f.askHeight >= PAYOUT_BLOCKS ? { ...f, late: true } : f;
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

/**
 * Cancel before the pool got anything: with nothing moved yet the flight is
 * simply dropped (undefined); once zec sits at the lp address (a shield-out,
 * or coins already there) it is shielded back. Past the send, there is
 * nothing to cancel.
 */
export const cancelFlight = (f: Flight, now = Date.now()): Flight | undefined =>
  !cancellable(f)
    ? f
    : f.stage === 'fund' && !f.fundTxid
      ? undefined
      : // a rune half already waiting is taken back first, then the zec is shielded
        f.runeTxid && f.kind === 'add2'
        ? to({ ...f, cancelled: true }, 'recover', {}, now)
        : to({ ...f, cancelled: true }, 'shield', {}, now);

/**
 * May this flight still be cancelled: nothing has reached the pool, and no
 * send is marked out (a marked send may already be on the network, so a
 * cancel then would only pretend).
 */
export const cancellable = (f: Flight): boolean =>
  !f.cancelled &&
  !f.sending &&
  f.kind !== 'withdraw2' &&
  (f.stage === 'fund' ||
    f.stage === 'settle' ||
    f.stage === 'rune' ||
    f.stage === 'half' ||
    f.stage === 'send' ||
    f.stage === 'ask') &&
  !f.sendTxid;

/**
 * The zec half came back (or never went) and the rune half waits under the
 * thor1: take it back, at the person's word. Only from the thor1, since
 * THORNode finds a pending position by its sender.
 */
export const recoverHalf = (f: Flight, now = Date.now()): Flight =>
  f.kind === 'add2' && f.runeTxid && (f.stage === 'refunded' || f.stage === 'half' || !!f.late)
    ? to({ ...f, late: undefined }, 'recover', {}, now)
    : f;

/** a refunded add's coins, or a payout that sits at the lp address, shielded back at the person's word */
export const shieldRefund = (f: Flight, now = Date.now()): Flight =>
  f.stage === 'refunded' || f.stage === 'arrive' || (f.stage === 'lost' && !!f.fundTxid)
    ? to(f, 'shield', {}, now)
    : f;

export type StepState = 'done' | 'now' | 'later' | 'turned';

export interface StepLine {
  t: string;
  d?: string;
  at?: number;
  state: StepState;
  /** the whole memo, behind a copy button, when d shows it cut short */
  copy?: string;
}

/** a memo a line can hold: its long parts (addresses) cut to their two ends */
export const memoText = (memo: string): string =>
  memo
    .split(':')
    .map(p => (p.length > 16 ? `${p.slice(0, 5)}…${p.slice(-4)}` : p))
    .join(':');

const ORDER: Record<Flight['kind'], Stage[]> = {
  add: ['fund', 'settle', 'send', 'seen', 'credit', 'credited'],
  withdraw: ['fund', 'settle', 'ask', 'payout', 'arrive', 'shield', 'shielded'],
  add2: ['fund', 'settle', 'rune', 'half', 'send', 'seen', 'credit', 'credited'],
  withdraw2: ['ask', 'payout', 'arrive', 'shield', 'shielded'],
  swap: ['fund', 'settle', 'send', 'seen', 'received'],
};

/** where the flight stands in its own order: a refund is past the send */
const rank = (f: Flight): number =>
  f.stage === 'refunded' || f.stage === 'refused'
    ? 3.5
    : f.stage === 'received'
      ? 99
      : (f.stage === 'shield' || f.stage === 'shielded') &&
          f.kind !== 'withdraw' &&
          f.kind !== 'withdraw2'
        ? 99
        : Math.max(0, ORDER[f.kind].indexOf(f.stage));

const stateAt = (f: Flight, i: number): StepState => {
  const r = rank(f);
  return i < r || isDone(f) ? 'done' : i === Math.floor(r) ? 'now' : 'later';
};

/** the tracker's lines: real steps, stamped when each began */
export interface LineText {
  zec: (zat: bigint) => string;
  address: string;
  pocket: string;
  /** rune, 1e8, as text (two-sided only) */
  rune?: (base: bigint) => string;
  /** the thor1, shortened */
  thor?: string;
}

type LineOf = (i: number, s: Stage, title: string, d?: string, copy?: string) => StepLine;

/** a two-sided add: the rune half waits for the zec half, said as it is */
const pairedAddLines = (
  f: Flight,
  t: LineText,
  line: LineOf,
  z: (s?: string) => string,
  at: (s: Stage) => number | undefined,
): StepLine[] => {
  const r = (s?: string) => (s && t.rune ? t.rune(BigInt(s)) : '');
  // a take-back started from the position: this page sent no halves, so none are listed
  const standalone = !f.fundTxid && !f.runeBase;
  const head = standalone
    ? []
    : [
        line(
          0,
          'fund',
          'shield out to your lp address',
          f.fundZat ? `${z(f.fundZat)} zec` : undefined,
        ),
        line(1, 'settle', 'one block to settle', 'zcash confirmation'),
        line(
          2,
          'rune',
          'rune half sent',
          `${r(f.runeBase)} rune from ${t.thor ?? 'your rune address'}`,
        ),
      ];
  if (f.lost) {
    return [
      ...head.map(l => ({ ...l, state: 'done' as const })),
      {
        // the title already says it didn't arrive; the line says what that means
        t: 'not seen by thorchain',
        d: 'nothing was added · your rune is still in your rune address',
        at: at('lost'),
        state: 'turned',
      },
      ...(f.stage === 'shield' || f.stage === 'shielded'
        ? [
            {
              t: `shielded back to ${t.pocket}`,
              at: at('shielded'),
              state: (f.stage === 'shield' ? 'now' : 'done') as StepState,
            },
          ]
        : []),
    ];
  }
  const waiting: StepLine = {
    t: 'waiting for the other side',
    d: 'the rune half is in · it waits for the zec half',
    at: at('half'),
    state: f.stage === 'half' ? 'now' : 'done',
  };
  if (f.cancelled || f.stage === 'refunded' || f.stage.startsWith('recover') || f.outZat) {
    const back = f.stage === 'shield' || f.stage === 'shielded';
    return [
      ...head.map(l => ({ ...l, state: 'done' as const })),
      ...(standalone
        ? []
        : [
            f.cancelled
              ? {
                  t: 'cancelled · the zec half was not sent',
                  at: at('recover'),
                  state: 'turned' as const,
                }
              : {
                  t: 'thorchain returned the zec half',
                  d: f.reason ? `its reason: ${f.reason}` : undefined,
                  at: at('refunded'),
                  state: 'turned' as const,
                },
          ]),
      {
        t: standalone ? 'waiting half taken back' : 'rune half taken back',
        d: 'from your rune address · less the network fee',
        at: at('recovering'),
        state:
          f.stage === 'refunded'
            ? 'later'
            : f.stage === 'recover' || f.stage === 'recovering'
              ? 'now'
              : 'done',
      },
      ...(back || f.stage === 'received'
        ? [
            {
              t: `shielded back to ${t.pocket}`,
              at: at('shielded'),
              state: (f.stage === 'shield' ? 'now' : 'done') as StepState,
            },
          ]
        : []),
    ];
  }
  return [
    ...head,
    { ...waiting, state: f.stage === 'half' ? 'now' : rank(f) > 3 ? 'done' : 'later' },
    line(4, 'send', 'zec half sent', `memo ${memoText(f.memo)} · ${z(f.amountZat)} zec`, f.memo),
    line(5, 'seen', 'seen by thorchain', 'after 1 confirmation, about 75 s'),
    line(6, 'credit', 'credited', 'both halves in · your units appear'),
  ];
};

/** a two-sided take-out: asked from the thor1, paid to both addresses or one */
const pairedOutLines = (
  f: Flight,
  t: LineText,
  line: LineOf,
  z: (s?: string) => string,
  at: (s: Stage) => number | undefined,
): StepLine[] => {
  const r = (s?: string) => (s && t.rune ? t.rune(BigInt(s)) : '');
  const ask = line(
    0,
    'ask',
    'asked the pool',
    `from ${t.thor ?? 'your rune address'} · ${memoText(f.memo)}`,
    f.memo,
  );
  if (f.stage === 'refused') {
    return [
      { ...ask, state: 'done' },
      {
        t: 'thorchain did not take it out',
        d: f.reason ? `its reason: ${f.reason}` : undefined,
        at: at('refused'),
        state: 'turned',
      },
    ];
  }
  const pays =
    f.payoutAs === 'rune'
      ? `≈ ${r(f.expectRune)} rune to your rune address`
      : f.payoutAs === 'zec'
        ? `≈ ${z(f.expectZat)} zec, after the pool's fee`
        : `≈ ${z(f.expectZat)} zec and ${r(f.expectRune)} rune`;
  const payout = line(
    1,
    'payout',
    'the pool pays out',
    f.outZat ? `${z(f.outZat)} zec` : f.late ? 'no payout planned yet · still watching' : pays,
  );
  if (f.payoutAs === 'rune') {
    return [ask, { ...payout, state: f.stage === 'received' ? 'done' : payout.state }];
  }
  return [
    ask,
    payout,
    line(2, 'arrive', 'zec arrived at your lp address'),
    line(3, 'shield', `shielded back to ${t.pocket}`),
  ];
};

export const stepLines = (f: Flight, t: LineText): StepLine[] => {
  const z = (s?: string) => (s ? t.zec(BigInt(s)) : '');
  const at = (s: Stage) => f.at[s];
  const line = (i: number, s: Stage, title: string, d?: string, copy?: string): StepLine => ({
    t: title,
    d,
    // a memo short enough to show whole needs no copy
    copy: copy && memoText(copy) !== copy ? copy : undefined,
    at: stateAt(f, i) === 'done' ? at(ORDER[f.kind][i + 1] ?? s) : undefined,
    state: stateAt(f, i),
  });
  if (f.kind === 'add2') {
    return pairedAddLines(f, t, line, z, at);
  }
  if (f.kind === 'withdraw2') {
    return pairedOutLines(f, t, line, z, at);
  }
  if (f.kind === 'swap' && !f.cancelled && f.stage !== 'refunded' && !f.outZat) {
    return [
      line(
        0,
        'fund',
        'shield out to your lp address',
        f.fundZat ? `${z(f.fundZat)} zec` : undefined,
      ),
      line(1, 'settle', 'one block to settle', 'zcash confirmation'),
      line(
        2,
        'send',
        'sent to thorchain',
        `${z(f.amountZat)} zec · memo ${memoText(f.memo)}`,
        f.memo,
      ),
      line(3, 'seen', 'swapped to rune', `paid to ${t.thor ?? 'your rune address'}`),
    ];
  }
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
      line(
        2,
        'send',
        'sent to the pool',
        `memo ${memoText(f.memo)} · ${z(f.amountZat)} zec`,
        f.memo,
      ),
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
    line(
      2,
      'ask',
      'asked the pool',
      `${z(f.amountZat)} zec from ${t.address} · ${memoText(f.memo)}`,
      f.memo,
    ),
    line(
      3,
      'payout',
      'the pool pays out',
      f.outZat
        ? `${z(f.outZat)} zec`
        : f.late
          ? 'no payout planned yet · still watching'
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
