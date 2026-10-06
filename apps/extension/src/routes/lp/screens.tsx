/**
 * lp.html's column, one screen per board (LpFirst, LpEgress, LpFlow add,
 * LpAdding, LpPosition, LpWithdraw, LpLowRune, LpWithdrawing, LpRefunded,
 * LpBlocked, LpTwoSided). Every figure is computed from the last read with
 * THORNode's own formulas (lp/math.ts); nothing here asks the network.
 */

import type { ReactNode } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@repo/ui/components/ui/button';
import { cn } from '@repo/ui/lib/utils';
import { AskOnce, Column, StepLines, useNow, type Host } from '../../components/scroll-page';
import { clock } from '../../buy/machine';
import { Sensitive } from '../../components/sensitive';
import { useStore as useZafu } from '../../state';
import { selectHideBalances } from '../../state/privacy';
import { depositFeeZat } from '../../workers/transparent-deposit';
import {
  cancellable,
  isDone,
  LOST_LINE,
  needs,
  PAYOUT_BLOCKS,
  stepLines,
  type Flight,
} from '../../lp/flight';
import {
  afterFee,
  costTone,
  fairAmount,
  impermanentLoss,
  MIN_ADD_ZAT,
  parseZec,
  quoteAdd,
  pairedWithdraw,
  quotePaired,
  runeText,
  withdrawMemo,
  withdrawZec,
  zecMoveSinceAdd,
  zecText,
} from '../../lp/math';
import { pairedLive, reserveOf } from '../../lp/rune';
import type { RuneSource } from '../../lp/store';
import {
  ADD_FEES,
  allowEgress,
  ASK_CAP_LINE,
  chooseRune,
  setRuneChoice,
  mayStopRune,
  runeHalfOf,
  runeNeedOf,
  stopRune,
  allowThornode,
  askOf,
  finish,
  goEgress,
  goFirst,
  lpStore,
  openSheet,
  positionOf,
  setAmount,
  setPart,
  SHIELD_BACK_FEE,
  SHIELD_OUT_FEE,
  shieldItBack,
  show,
  tick,
  worthOf,
  type LpState,
} from './store';

export const useLp = <T,>(sel: (s: LpState) => T): T => useStore(lpStore, sel);

export const short = (a?: string) => (a ? `${a.slice(0, 5)}…${a.slice(-4)}` : '');
export const usd = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const pct = (n: number, d = 1) => `${n.toFixed(d)}%`;
export const blocksToMin = (b: number) => Math.max(1, Math.ceil((b * 6) / 60));

export const EyeIcon = ({ className }: { className?: string }) => (
  <span className={cn('i-lucide-eye size-4 shrink-0 text-warn', className)} aria-hidden='true' />
);

export const Table = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div
    className={cn(
      'flex flex-col divide-y divide-border-soft border border-border-soft bg-elev-1',
      className,
    )}
  >
    {children}
  </div>
);

export const Row = ({
  k,
  children,
  side,
  w = 'w-[128px]',
  h = 'min-h-[50px]',
}: {
  k: ReactNode;
  children: ReactNode;
  side?: ReactNode;
  w?: string;
  h?: string;
}) => (
  <div className={cn('flex items-center gap-3.5 px-[18px] py-2', h)}>
    <span className={cn('shrink-0 text-xs text-fg-muted', w)}>{k}</span>
    <span className='flex-1 text-sm text-fg-high'>{children}</span>
    {side !== undefined && <span className='text-xs text-fg-dim'>{side}</span>}
  </div>
);

/** the lp address row: public, and a sheet that says so in one line */
export const LpAddressRow = ({ w }: { w?: string }) => {
  const address = useLp(s => s.lp?.address);
  return (
    <button
      type='button'
      onClick={() => openSheet('public')}
      className='flex min-h-[50px] items-center gap-3.5 bg-elev-1 px-[18px] text-left transition-colors hover:bg-elev-2'
    >
      <span className={cn('shrink-0 text-xs text-fg-muted', w ?? 'w-[128px]')}>lp address</span>
      <span className='flex-1 font-mono text-sm text-fg-high'>{short(address) || '…'}</span>
      <span className='text-xs text-warn'>public</span>
      <EyeIcon />
    </button>
  );
};

const Buttons = ({ children }: { children: ReactNode }) => (
  <div className='flex gap-2.5'>{children}</div>
);

/** LpFirst: what it is, in four lines */
export const FirstScreen = () => (
  <Column
    title='provide zec liquidity'
    sub="lend zec to thorchain's zec pool. every swap through it pays the pool a fee."
  >
    <Table>
      <Row k='earns' w='w-16' h='min-h-14'>
        a share of every swap fee
      </Row>
      <Row k='price' w='w-16' h='min-h-14'>
        if zec rises against rune, less zec comes back. if it falls, more.
      </Row>
      <div className='flex min-h-14 items-center gap-3.5 px-[18px] py-2'>
        <span className='w-16 shrink-0 text-xs text-warn'>public</span>
        <span className='flex-1 text-sm text-fg-high'>
          it lives on one transparent address anyone can see
        </span>
        <EyeIcon />
      </div>
      <Row k='out' w='w-16' h='min-h-14'>
        part or all, whenever you like
      </Row>
    </Table>
    <Buttons>
      <Button variant='secondary' className='h-14 w-[140px]' onClick={() => window.close()}>
        not now
      </Button>
      <Button className='h-14 flex-1' onClick={goEgress}>
        continue
      </Button>
    </Buttons>
  </Column>
);

/** LpEgress: thornode, midgard and prices, asked once */
export const EgressScreen = () => {
  const on = useLp(s => s.egress);
  const prices = on.prices;
  const hosts: Host[] = [
    {
      mark: 't',
      name: 'thornode',
      does: 'the pool, your position, its vault, pauses',
      // the vault and pauses are read from both and must agree before any zec moves
      host: on.thornode
        ? 'already allowed'
        : 'gateway.liquify.com/thorchain_api\nthornode.ninerealms.com · checks the vault',
      c: on.thornode ? 'text-fg-muted' : 'text-zigner-gold',
    },
    {
      mark: 'm',
      name: 'midgard',
      does: 'volume, fees, your history',
      host: on.midgard ? 'already allowed' : 'gateway.liquify.com\n/thorchain_midgard',
      c: on.midgard ? 'text-fg-muted' : 'text-zigner-gold',
    },
    {
      mark: '$',
      name: 'prices',
      does: 'the market price, for cost vs market',
      // the same destination near intents swaps ask: allowing it here allows those prices too
      host: `${prices ? 'already allowed' : '1click.chaindefuser.com'}\nnear intents · also used for swap prices`,
      c: prices ? 'text-fg-muted' : 'text-zigner-gold',
    },
  ];
  return (
    <AskOnce
      sub='liquidity talks to these, and only while this page is open. thornode and midgard see your one lp address with your ip.'
      hosts={hosts}
      onNotNow={goFirst}
      onAllow={() => void allowEgress()}
    />
  );
};

/** what an add costs and earns right now, derived from the last read; undefined until the pool is read */
export const useAddQuote = () => {
  const { amt, thor, zecUsd } = useLp(
    useShallow(s => ({ amt: s.amt, thor: s.thor, zecUsd: s.zecUsd })),
  );
  const a = parseZec(amt);
  const px = zecUsd && thor ? { zec: zecUsd, rune: thor.runeUsd } : undefined;
  const fair = thor && px ? fairAmount(thor.pool, px) : undefined;
  return {
    a,
    q: thor && a ? quoteAdd(thor.pool, a, px) : undefined,
    small: !!a && a < MIN_ADD_ZAT,
    fair,
    fairQ: thor && fair ? quoteAdd(thor.pool, fair, px) : undefined,
    paused: thor?.addPaused,
  };
};

const CHIPS = ['0.005', '0.01', '0.02'];

/** LpFlow add, with its slot states: calm, too small, large, paused */
export const AddScreen = ({ onAdd }: { onAdd: () => void }) => {
  const { amt, shielded, pocket, at, read, thorAt, flight, err } = useLp(
    useShallow(s => ({
      amt: s.amt,
      shielded: s.shieldedZat,
      pocket: s.pocket,
      at: s.thor?.at,
      read: !!s.thor,
      thorAt: s.thor?.at,
      flight: !!s.flight,
      err: s.error,
    })),
  );
  const { a, q, small, fair, fairQ, paused } = useAddQuote();
  const now = useNow();
  const tone = costTone(q?.costPct);
  const large = !small && tone === 'strong';
  const age = at ? Math.max(0, Math.round((now - at) / 1000)) : 0;
  const fees = ADD_FEES;
  // the most this pocket can add: its shielded zec, less the network fees
  const max = shielded !== undefined && shielded > fees ? shielded - fees : 0n;
  const over = !!a && shielded !== undefined && a > max;
  const can = read && !!a && !!q && !small && !paused && !flight && shielded !== undefined && !over;
  const costText = small || !q ? 'n/a' : q.costPct === undefined ? 'no price' : pct(q.costPct);
  const costC =
    small || !q || q.costPct === undefined
      ? 'text-fg-dim'
      : tone === 'strong'
        ? 'text-hanko'
        : tone === 'warn'
          ? 'text-warn'
          : 'text-fg-high';
  return (
    <div className='flex flex-col gap-4'>
      <h1 className='font-display text-[38px] text-fg-high'>add zec</h1>
      <div
        className={cn('border bg-elev-1', large && !paused ? 'border-hanko' : 'border-border-soft')}
      >
        <div className='flex h-24 items-center gap-3.5 px-5'>
          <label htmlFor='lpamt' className='sr-only'>
            amount in zec
          </label>
          <input
            id='lpamt'
            inputMode='decimal'
            value={amt}
            onChange={e => setAmount(e.target.value)}
            className='h-[66px] min-w-0 flex-1 bg-transparent font-display text-[52px] text-fg-high outline-none'
          />
          <span className='text-base text-zigner-gold'>zec</span>
        </div>
        <div className='flex h-[52px] items-center gap-2 border-t border-border-soft px-5'>
          {CHIPS.map(c => {
            const on = parseZec(c) === a;
            return (
              <button
                key={c}
                type='button'
                onClick={() => setAmount(c)}
                className={cn(
                  'h-8 border px-3.5 text-[13px]',
                  on
                    ? 'border-zigner-gold bg-zigner-gold/10 text-fg-high'
                    : 'border-border-soft bg-elev-2 text-fg',
                )}
              >
                {c}
              </button>
            );
          })}
          <span className='flex-1' />
          {shielded !== undefined && (
            <span className='text-xs text-fg-dim'>
              of <Sensitive>{zecText(shielded)}</Sensitive> shielded
            </span>
          )}
        </div>
      </div>

      <div className='grid grid-cols-3 border border-border-soft bg-elev-1'>
        {[
          ['you add', a ? `${zecText(a)} zec` : '0 zec', 'text-fg-high'],
          ['cost vs market', costText, costC],
          [
            'your share',
            small || !q ? 'n/a' : pct(q.sharePct, 2),
            small || !q ? 'text-fg-dim' : 'text-fg-high',
          ],
        ].map(([k, v, c], i) => (
          <div
            key={k}
            className={cn(
              'flex h-[72px] flex-col justify-center gap-1.5 px-4',
              i && 'border-l border-border-soft',
            )}
          >
            <span className='text-[11px] tracking-[0.04em] text-fg-muted'>{k}</span>
            <span className={cn('font-display text-[22px] tabular-nums', c)}>{v}</span>
          </div>
        ))}
      </div>

      <div
        className={cn(
          'flex h-11 items-center gap-2.5 border px-3.5',
          paused || large ? 'border-hanko' : small ? 'border-warn/40' : 'border-border-soft',
        )}
      >
        {paused ? (
          <>
            <span className='size-2 shrink-0 bg-hanko' />
            <span className='flex-1 text-[13px] text-fg'>
              thorchain has paused adds to this pool. nothing was sent.
            </span>
            <span className='text-[11px] text-fg-dim'>{age} s ago</span>
          </>
        ) : over ? (
          <>
            <span className='size-2 shrink-0 bg-warn' />
            <span className='flex-1 text-[13px] text-fg'>
              more than {pocket} holds shielded, with the network fees
            </span>
            {max >= MIN_ADD_ZAT && (
              <Button
                variant='secondary'
                size='sm'
                className='h-[30px] text-zigner-gold'
                onClick={() => setAmount(zecText(max).replace(/\.?0+$/, ''))}
              >
                use max
              </Button>
            )}
          </>
        ) : small ? (
          <>
            <span className='size-2 shrink-0 bg-warn' />
            <span className='flex-1 text-[13px] text-fg'>
              the least that comes back whole is {zecText(MIN_ADD_ZAT)} zec
            </span>
            <Button
              variant='secondary'
              size='sm'
              className='h-[30px] text-zigner-gold'
              onClick={() => setAmount(zecText(MIN_ADD_ZAT).replace(/0+$/, ''))}
            >
              use {zecText(MIN_ADD_ZAT).replace(/0+$/, '')}
            </Button>
          </>
        ) : large && q?.lostUsd !== undefined ? (
          <>
            <span className='size-2 shrink-0 bg-hanko' />
            <span className='flex-1 text-[13px] text-fg'>
              about {usd(q.lostUsd)} of this goes to arbitrage
            </span>
            {fair && fairQ?.costPct !== undefined && (
              <Button size='sm' className='h-[30px]' onClick={() => setAmount(zecText(fair))}>
                use {zecText(fair)} · {pct(fairQ.costPct)}
              </Button>
            )}
          </>
        ) : (
          <>
            <span className='size-1.5 shrink-0 animate-pulse bg-green motion-reduce:animate-none' />
            <span className='flex-1 text-xs text-fg-muted'>
              {thorAt ? `priced from the pool ${age} s ago` : 'reading the pool'}
            </span>
            <span className='text-xs text-fg-dim'>network fees about {zecText(fees)} zec</span>
          </>
        )}
      </div>

      <Table>
        <div className='flex h-14 items-center gap-3.5 px-[18px]'>
          <span className='w-[92px] shrink-0 text-xs text-fg-muted'>from</span>
          <span className='flex-1 text-sm text-fg-high'>{pocket} · shielded</span>
          <span className='i-lucide-shield size-3.5 text-fg-muted' aria-hidden='true' />
        </div>
        <LpAddressRow w='w-[92px]' />
      </Table>

      {err && <span className='text-xs text-warn'>{err}</span>}
      <Button
        variant={large || !can ? 'secondary' : 'primary'}
        className='h-14'
        disabled={!can && !paused}
        onClick={paused ? () => void tick() : onAdd}
      >
        {paused
          ? 'adds are paused · check again'
          : !a || !can
            ? 'add zec'
            : large
              ? `add ${zecText(a)} zec anyway`
              : `add ${zecText(a)} zec`}
      </Button>
      <button
        type='button'
        onClick={() => show('twoSided')}
        className='self-center text-xs text-fg-muted hover:text-fg-high'
      >
        with rune too
      </button>
    </div>
  );
};

/** the two-sided position under the thor1: its halves, or a half waiting for the other */
const PairedBlock = ({ onRecover }: { onRecover: () => void }) => {
  const s = useLp(
    useShallow(s => ({
      thor: s.thor,
      paired: s.runeRead?.paired,
      flight: s.flight,
      zecUsd: s.zecUsd,
    })),
  );
  const p = s.paired;
  const t = s.thor;
  if (!pairedLive(p) || !t) {
    return null;
  }
  const both = pairedWithdraw(t.pool, p.units, 10_000, t.minSlipBps, 'both');
  const share = (Number(p.units) / Number(t.pool.units)) * 100;
  const waiting = p.units === 0n;
  const lockedFor = p.lastAddHeight + t.lockupBlocks - t.height;
  return (
    <div className='flex flex-col gap-3'>
      <span className='text-xs text-fg-muted'>with rune</span>
      <Table>
        {waiting ? (
          <>
            <Row k='waiting' side='for the other side'>
              <Sensitive>
                {p.pendingRune > 0n
                  ? `${runeText(p.pendingRune)} rune`
                  : `${zecText(p.pendingAsset)} zec`}
              </Sensitive>
            </Row>
            <div className='px-[18px] py-3 text-xs text-fg'>
              this half waits in the pool until the other comes. if it will not come, you may take
              it back from your rune address, less the network fee.
            </div>
          </>
        ) : (
          <>
            <Row k='in the pool' side='at the pool price now'>
              <Sensitive>
                {zecText(both.zat)} zec + {runeText(both.rune)} rune
              </Sensitive>
            </Row>
            <Row
              k='your share'
              side={<Sensitive>{p.units.toLocaleString('en-US')} units</Sensitive>}
            >
              <Sensitive>{pct(share, 2)}</Sensitive>
            </Row>
            <Row k='fees earned' side='pool growth, thornode'>
              <span className='text-green'>+{pct(p.luviGrowthPct, 2)}</span>
            </Row>
          </>
        )}
        <LpAddressRow />
        <RuneAddressRow />
        <SourceRow />
      </Table>
      {waiting ? (
        <Button
          variant='secondary'
          className='h-14'
          disabled={!!s.flight && !isDone(s.flight)}
          onClick={onRecover}
        >
          take it back
        </Button>
      ) : (
        <Button
          className='h-14'
          disabled={lockedFor > 0 || (!!s.flight && !isDone(s.flight))}
          onClick={() => show('withdraw2')}
        >
          {lockedFor > 0 ? `take it out in about ${blocksToMin(lockedFor)} min` : 'take it out'}
        </Button>
      )}
    </div>
  );
};

/** LpPosition: worth now, since adding, fees, share */
export const PositionScreen = ({ onRecover }: { onRecover: () => void }) => {
  const s = useLp(
    useShallow(s => ({
      thor: s.thor,
      zecUsd: s.zecUsd,
      mid: s.mid,
      flight: s.flight,
      paired: pairedLive(s.runeRead?.paired),
    })),
  );
  const p = positionOf(s);
  const worth = worthOf(s);
  const now = useNow(60_000);
  if (!p || worth === undefined) {
    return s.paired ? (
      <div className='flex flex-col gap-5'>
        <h1 className='font-display text-[38px] text-fg-high'>your liquidity</h1>
        <PairedBlock onRecover={onRecover} />
        <Button variant='secondary' className='h-14' onClick={() => show('twoSided')}>
          add more
        </Button>
      </div>
    ) : null;
  }
  const added = p.depositAsset * 2n;
  const since = added ? (Number(worth) / Number(added) - 1) * 100 : 0;
  const first = s.mid?.history?.filter(h => h.kind === 'add').at(-1)?.at;
  const days = first ? Math.max(0, Math.floor((now - first) / 86_400_000)) : undefined;
  const lockedFor = s.thor ? p.lastAddHeight + s.thor.lockupBlocks - s.thor.height : 0;
  return (
    <div className='flex flex-col gap-5'>
      <h1 className='font-display text-[38px] text-fg-high'>your liquidity</h1>
      <div className='flex flex-col gap-1.5'>
        <span className='text-xs text-fg-muted'>worth now, if taken out</span>
        <div className='flex items-baseline gap-2.5'>
          <Sensitive className='font-display text-[52px] leading-[1.05] tabular-nums text-fg-high'>
            {zecText(worth)}
          </Sensitive>
          <span className='text-base text-zigner-gold'>zec</span>
          <span className='flex-1' />
          {s.zecUsd && (
            <Sensitive className='text-[15px] text-fg-muted'>
              {usd((Number(worth) / 1e8) * s.zecUsd)}
            </Sensitive>
          )}
        </div>
      </div>
      <Table>
        <Row
          k='you added'
          side={
            first
              ? `${new Date(first).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toLowerCase()} · ${days} days`
              : undefined
          }
        >
          <Sensitive>{zecText(added)} zec</Sensitive>
        </Row>
        <Row k='since adding' side='after the pool fee to take it out'>
          <span className={since < 0 ? 'text-warn' : 'text-green'}>
            {since > 0 ? '+' : ''}
            {pct(since)}
          </span>
        </Row>
        <Row k='fees earned' side='pool growth, thornode'>
          <span className='text-green'>+{pct(p.luviGrowthPct, 2)}</span>
        </Row>
        <Row k='your share' side={<Sensitive>{p.units.toLocaleString('en-US')} units</Sensitive>}>
          <Sensitive>
            {s.thor && pct((Number(p.units) / Number(s.thor.pool.units)) * 100, 2)}
          </Sensitive>
        </Row>
        <LpAddressRow />
      </Table>
      <Buttons>
        <Button variant='secondary' className='h-14 w-[170px]' onClick={() => show('add')}>
          add more
        </Button>
        <Button
          className='h-14 flex-1'
          disabled={lockedFor > 0 || !!s.flight}
          onClick={() => show('withdraw')}
        >
          {lockedFor > 0 ? `take it out in about ${blocksToMin(lockedFor)} min` : 'take it out'}
        </Button>
      </Buttons>
      {s.paired && <PairedBlock onRecover={onRecover} />}
      <button
        type='button'
        onClick={() => openSheet('history')}
        className='self-center text-xs text-fg-muted hover:text-fg-high'
      >
        history of this address
      </button>
    </div>
  );
};

const PARTS: [LpState['part'], string][] = [
  [25, '25%'],
  [50, 'half'],
  [100, 'all'],
];

/** LpWithdraw, and LpLowRune when zec has moved against rune since the add */
export const WithdrawScreen = ({ onOut }: { onOut: () => void }) => {
  const s = useLp(
    useShallow(s => ({
      thor: s.thor,
      part: s.part,
      zecUsd: s.zecUsd,
      pocket: s.pocket,
      address: s.lp?.address,
      ask: askOf(s),
      err: s.error,
    })),
  );
  const now = useNow();
  const p = positionOf(s);
  const t = s.thor;
  if (!p || !t || !t.inbound) {
    return null;
  }
  const bps = s.part * 100;
  const pays = withdrawZec(t.pool, p.units, bps, t.minSlipBps);
  // the ask pays above THORChain's dust (lp/math.ts askZat); none when the dust is past the caps
  const ask = s.ask ?? 0n;
  const fees =
    t.inbound.outboundFee +
    ask +
    depositFeeZat(withdrawMemo(bps).length) +
    SHIELD_OUT_FEE +
    SHIELD_BACK_FEE;
  const gets = pays > fees ? pays - fees : 0n;
  const feePct = pays ? (Number(fees) / Number(pays)) * 100 : 0;
  const move = zecMoveSinceAdd(t.pool, p.depositAsset, p.depositRune);
  const moved = move !== undefined && Math.abs(move) >= 0.05;
  const added = p.depositAsset * 2n;
  // all of it, after the pool's fee: what the position screen calls worth now
  const all = afterFee(withdrawZec(t.pool, p.units, 10_000, t.minSlipBps), t.inbound.outboundFee);
  const age = Math.max(0, Math.round((now - t.at) / 1000));
  const usdOf = (zat: bigint) => (s.zecUsd ? ` · ${usd((Number(zat) / 1e8) * s.zecUsd)}` : '');
  const back = (Number(all) / Number(added) - 1) * 100;
  return (
    <div className='flex flex-col gap-4'>
      <h1 className='font-display text-[38px] text-fg-high'>take it out</h1>
      <div className='grid grid-cols-3 gap-2'>
        {PARTS.map(([v, label]) => (
          <button
            key={v}
            type='button'
            onClick={() => setPart(v)}
            className={cn(
              'h-14 border text-[15px]',
              s.part === v
                ? 'border-zigner-gold bg-zigner-gold/10 text-fg-high'
                : 'border-border-soft bg-elev-2 text-fg',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className='grid grid-cols-3 border border-border-soft bg-elev-1'>
        {[
          ['the pool pays', `≈ ${zecText(pays)}`, 'text-fg-high'],
          [
            'network fees',
            zecText(fees),
            feePct >= 20 ? 'text-hanko' : feePct >= 10 ? 'text-warn' : 'text-fg-high',
          ],
          ['you get, shielded', `≈ ${zecText(gets)}`, 'text-fg-high'],
        ].map(([k, v, c], i) => (
          <div
            key={k}
            className={cn(
              'flex h-[72px] flex-col justify-center gap-1.5 px-4',
              i && 'border-l border-border-soft',
            )}
          >
            <span className='text-[11px] tracking-[0.04em] text-fg-muted'>{k}</span>
            <Sensitive className={cn('font-display text-[22px] tabular-nums', c)}>{v}</Sensitive>
          </div>
        ))}
      </div>
      {moved ? (
        <div
          className={cn(
            'flex flex-col border bg-elev-1',
            move > 0 ? 'border-warn/40' : 'border-border-soft',
          )}
        >
          <div className='flex h-[46px] items-center gap-3 border-b border-border-soft px-[18px]'>
            <span className={cn('size-2 shrink-0', move > 0 ? 'bg-warn' : 'bg-fg-muted')} />
            <span className='flex-1 text-[13px] text-fg-high'>
              zec is {pct(Math.abs(move) * 100, 0)} {move > 0 ? 'higher' : 'lower'} against rune
              than when you added
            </span>
            <span className='text-[11px] text-fg-dim'>thornode · {age} s</span>
          </div>
          <Row
            k='back now'
            w='w-[150px]'
            h='h-11'
            side={
              <span className={back < 0 ? 'text-warn' : 'text-green'}>
                {back > 0 ? '+' : ''}
                {pct(back)} zec
              </span>
            }
          >
            <Sensitive>
              {zecText(all)} zec{usdOf(all)}
            </Sensitive>
          </Row>
          <Row
            k='had you kept the zec'
            w='w-[150px]'
            h='h-11'
            side={
              s.zecUsd && (
                <span className={all < added ? 'text-warn' : 'text-green'}>
                  {all < added ? '−' : '+'}
                  {usd((Math.abs(Number(all - added)) / 1e8) * s.zecUsd)}
                </span>
              )
            }
          >
            <Sensitive>
              {zecText(added)} zec{usdOf(added)}
            </Sensitive>
          </Row>
          <Row
            k='lost to the price move'
            w='w-[150px]'
            h='h-11'
            side={pct(impermanentLoss(move) * 100)}
          >
            vs half zec, half rune
          </Row>
        </div>
      ) : (
        <Table>
          <Row k='comes back to' w='w-[110px]' h='h-[52px]'>
            {s.pocket} · shielded
          </Row>
        </Table>
      )}
      <Table>
        <Row k='asks with' w='w-[110px]' h='h-[52px]' side={withdrawMemo(bps)}>
          <span className='text-[13px] text-fg'>
            {s.ask ? `${zecText(s.ask)} zec from ${short(s.address)}` : 'n/a'}
          </span>
        </Row>
      </Table>
      {(s.err ?? (!s.ask ? ASK_CAP_LINE : undefined)) && (
        <span className='text-xs text-warn'>{s.err ?? ASK_CAP_LINE}</span>
      )}
      <Button className='h-14' disabled={!!t.outPaused || !s.ask} onClick={onOut}>
        {t.outPaused
          ? 'take-outs are paused · check again'
          : s.part === 100
            ? 'take out all'
            : s.part === 50
              ? 'take out half'
              : 'take out 25%'}
      </Button>
    </div>
  );
};

/** LpAdding, LpWithdrawing, LpRefunded: the flight's real steps and clock */
/** where a flight from before this tab stands, in one line */
const waitLine = (f: Flight, zec: (zat: bigint) => string): string =>
  f.stage === 'shield'
    ? 'your zec is waiting to be shielded back · at your lp address'
    : f.stage === 'recover'
      ? 'taking the waiting half back is ready to be sent · from your rune address'
      : f.stage === 'rune'
        ? 'the rune half is waiting to be sent · from your rune address'
        : f.kind === 'swap'
          ? `your swap is waiting to be sent · ${zec(BigInt(f.amountZat))} zec to thorchain`
          : f.kind === 'add' || f.kind === 'add2'
            ? `your add is waiting to be sent · ${zec(BigInt(f.amountZat))} zec to thorchain`
            : `your take-out is waiting to be sent · the ask to thorchain`;

/** the tracker's title, said for what the flight is */
const titleOf = (f: Flight): string => {
  const finished = isDone(f);
  if (f.kind === 'swap') {
    return f.stage === 'refunded' || f.outZat
      ? 'thorchain sent the swap back'
      : finished
        ? 'rune at your rune address'
        : 'swapping zec for rune';
  }
  if (f.kind === 'add2' && f.lost) {
    return f.stage === 'shielded' ? 'nothing was added' : "the rune half didn't arrive";
  }
  if (f.kind === 'add2') {
    return f.cancelled
      ? 'taking the rune half back'
      : f.stage === 'refunded' || f.stage.startsWith('recover') || f.outZat
        ? f.stage === 'shielded' || f.stage === 'received'
          ? 'both halves are back'
          : 'the zec half came back'
        : f.stage === 'half'
          ? 'waiting for the other side'
          : finished
            ? 'in the pool, both sides'
            : 'adding zec and rune';
  }
  if (f.kind === 'withdraw2') {
    return f.stage === 'refused'
      ? 'the pool did not take it out'
      : finished
        ? 'taken out'
        : 'taking it out';
  }
  return f.stage === 'refunded' || (f.kind === 'add' && f.outZat)
    ? 'the pool sent this add back'
    : f.stage === 'refused'
      ? 'the pool did not take it out'
      : f.kind === 'add'
        ? finished
          ? 'in the pool'
          : 'adding to the pool'
        : finished
          ? 'back in your wallet'
          : 'taking it out';
};

export const TrackScreen = ({
  onContinue,
  onCancel,
  onRecover,
}: {
  /** password, then the re-checks, then the next send */
  onContinue: () => void;
  onCancel: () => void;
  /** two-sided: take the waiting rune half back, from the thor1 */
  onRecover: () => void;
}) => {
  const s = useLp(
    useShallow(s => ({
      flight: s.flight,
      address: s.lp?.address,
      thor: s.rune?.address,
      pocket: s.pocket,
      err: s.error,
      confirmed: s.confirmed,
      moved: s.moved,
      paused:
        s.flight?.kind === 'swap'
          ? undefined
          : s.flight?.kind === 'withdraw' || s.flight?.kind === 'withdraw2'
            ? s.thor?.outPaused
            : s.thor?.addPaused,
    })),
  );
  const now = useNow();
  // hide balances masks every figure the tracker writes, the same five dots as Sensitive
  const hidden = useZafu(selectHideBalances);
  const zec = hidden ? () => '•••••' : zecText;
  const f = s.flight;
  if (!f) {
    return null;
  }
  const lines = stepLines(f, {
    zec,
    rune: hidden ? () => '•••••' : runeText,
    address: short(s.address),
    thor: short(s.thor),
    pocket: s.pocket,
  });
  // a send this tab was not asked for: it waits for continue, with the password
  const held =
    !isDone(f) &&
    !!needs({ ...f, error: undefined, sending: undefined }) &&
    (s.confirmed !== f.id || !!f.error);
  const done = lines.filter(l => l.state === 'done').length;
  const refunded = f.stage === 'refunded';
  const finished = isDone(f);
  const title = titleOf(f);
  // the zec half came back while the rune half waits: the take-back comes first
  const halfBack = refunded && f.kind === 'add2';
  const lost = f.stage === 'lost';
  return (
    <div className='flex flex-col gap-5'>
      <div className='flex items-end justify-between gap-4'>
        <h1 className='font-display text-[38px] leading-[1.15] text-fg-high'>{title}</h1>
        <span className='flex shrink-0 flex-col items-end gap-1.5'>
          <span className='font-display text-[34px] tabular-nums text-fg-high'>
            {refunded && f.outZat ? zec(BigInt(f.outZat)) : clock(now - f.started)}
          </span>
          <span className='text-[11px] text-fg-muted'>
            {refunded
              ? 'zec at your lp address'
              : f.kind === 'add' || f.kind === 'add2' || f.kind === 'swap'
                ? 'usually about 4 minutes'
                : 'usually 3 to 6 minutes'}
          </span>
        </span>
      </div>
      <div className='relative h-0.5 overflow-hidden bg-border-soft'>
        <span
          className={cn('absolute inset-y-0 left-0', refunded ? 'bg-warn' : 'bg-zigner-gold')}
          style={{
            width: `${finished || refunded ? 100 : Math.round((done / lines.length) * 100)}%`,
          }}
        />
      </div>
      <StepLines steps={lines} />
      {held ? (
        <div className='flex flex-col divide-y divide-border-soft border border-zigner-gold/40 bg-elev-1'>
          <span className='px-3.5 py-3 text-[13px] text-fg-high'>{waitLine(f, zec)}</span>
          {s.moved && (
            <span className='px-3.5 py-2.5 text-xs text-warn'>
              the pool moved · this add now costs {pct(s.moved.now)}
              {s.moved.was !== undefined && (
                <>
                  , not <span className='line-through'>{pct(s.moved.was)}</span>
                </>
              )}
            </span>
          )}
          {s.paused && (
            <span className='px-3.5 py-2.5 text-xs text-warn'>
              thorchain has paused this right now · nothing will be sent until it opens
            </span>
          )}
          {(f.error ?? s.err) && (
            <span className='px-3.5 py-2.5 text-xs text-fg'>{f.error ?? s.err}</span>
          )}
        </div>
      ) : f.error || s.err ? (
        <div className='flex min-h-11 items-center gap-2.5 border border-warn/40 px-3.5 py-2'>
          <span className='flex-1 text-xs text-fg'>{f.error ?? s.err}</span>
          {f.error && (
            <Button variant='secondary' size='sm' onClick={onContinue}>
              try again
            </Button>
          )}
        </div>
      ) : f.late ? (
        <div className='flex flex-col gap-1.5 border border-warn/40 bg-elev-1 px-3.5 py-3'>
          <span className='text-[13px] text-fg-high'>
            thorchain has planned no payout in about {blocksToMin(PAYOUT_BLOCKS)} minutes. we are
            sorry for the wait.
          </span>
          <span className='text-xs text-fg'>
            your position stays yours until it pays. this page keeps watching; a payout that comes
            later lands at your lp address and shows in your wallet. you may look up the ask
            {f.sendTxid && ` (tx ${f.sendTxid.slice(0, 4)}…${f.sendTxid.slice(-4)})`} on a thorchain
            explorer, or stop watching and ask again from your position.
          </span>
        </div>
      ) : (
        <div className='flex h-11 items-center border border-border-soft bg-elev-1 px-3.5'>
          <span className='text-xs text-fg'>
            {lost
              ? LOST_LINE
              : halfBack
                ? 'the rune half still waits in the pool. you may take it back, and the zec is shielded after.'
                : refunded
                  ? 'nothing else was lost. it waits at your lp address until you choose.'
                  : f.stage === 'half'
                    ? 'the rune half is in. the zec half goes as soon as thorchain shows it waiting.'
                    : f.kind === 'add' || f.kind === 'add2' || f.kind === 'swap'
                      ? 'close this any time. anything not yet sent waits until this page is open.'
                      : 'the pool pays out once thorchain has seen the ask.'}
          </span>
        </div>
      )}
      <Buttons>
        {held ? (
          <>
            {cancellable(f) ? (
              <Button variant='secondary' className='h-14 w-[200px]' onClick={onCancel}>
                {f.stage === 'fund' && !f.fundTxid ? 'cancel' : 'cancel and shield back'}
              </Button>
            ) : (
              <Button
                variant='secondary'
                className='h-14 w-[170px]'
                onClick={() => show('position')}
              >
                not now
              </Button>
            )}
            <Button className='h-14 flex-1' disabled={!!s.paused} onClick={onContinue}>
              {s.moved ? `continue at ${pct(s.moved.now)}` : 'continue'}
            </Button>
          </>
        ) : lost ? (
          <>
            <Button
              variant='secondary'
              className='h-14 w-[170px]'
              onClick={() => void (f.fundTxid ? shieldItBack() : finish())}
            >
              stop
            </Button>
            <Button
              className='h-14 flex-1'
              onClick={() => void finish().then(() => show('twoSided'))}
            >
              try again
            </Button>
          </>
        ) : halfBack ? (
          <>
            <Button variant='secondary' className='h-14 w-[170px]' onClick={() => show('position')}>
              not now
            </Button>
            <Button className='h-14 flex-1' onClick={onRecover}>
              take the rune back
            </Button>
          </>
        ) : refunded ? (
          <>
            <Button variant='secondary' className='h-14 w-[170px]' onClick={() => void finish()}>
              keep it there
            </Button>
            <Button className='h-14 flex-1' onClick={() => void shieldItBack()}>
              shield it back
            </Button>
          </>
        ) : finished ? (
          <Button
            className='h-14 flex-1'
            onClick={() =>
              void finish().then(
                () => f.kind === 'swap' && f.stage === 'received' && show('twoSided'),
              )
            }
          >
            {f.stage === 'credited'
              ? 'see your liquidity'
              : f.kind === 'swap' && f.stage === 'received'
                ? 'back to adding'
                : 'done'}
          </Button>
        ) : f.late ? (
          <>
            <Button variant='secondary' className='h-14 w-[170px]' onClick={() => void finish()}>
              stop watching
            </Button>
            <Button className='h-14 flex-1' onClick={() => show('position')}>
              keep watching
            </Button>
          </>
        ) : f.stage === 'arrive' ? (
          <>
            <Button variant='secondary' className='h-14 w-[170px]' onClick={() => show('position')}>
              in the background
            </Button>
            <Button className='h-14 flex-1' onClick={() => void shieldItBack()}>
              shield it back now
            </Button>
          </>
        ) : (
          <Button variant='secondary' className='h-14 flex-1' onClick={() => show('position')}>
            keep going in the background
          </Button>
        )}
      </Buttons>
    </div>
  );
};

/** LpBlocked: thornode blocked by the person; the last read, dimmed */
export const BlockedScreen = () => {
  const cache = useLp(s => s.cache);
  const now = useNow(60_000);
  const ago = cache ? Math.round((now - cache.readAt) / 3_600_000) : undefined;
  return (
    <Column
      title='thornode is off for now'
      sub='the pool and your position are read once it is on.'
    >
      <Table className='opacity-70'>
        <Row
          k='your position'
          h='h-14'
          side={
            ago === undefined
              ? undefined
              : ago < 1
                ? 'last read under an hour ago'
                : ago < 48
                  ? `last read ${ago} h ago`
                  : `last read ${Math.round(ago / 24)} days ago`
          }
        >
          {cache ? <Sensitive>{zecText(BigInt(cache.zat))} zec</Sensitive> : 'not read yet'}
        </Row>
        <Row k='add, take out' h='h-14'>
          wait for a fresh read
        </Row>
      </Table>
      <Buttons>
        <Button variant='secondary' className='h-14 w-[170px]' onClick={() => window.close()}>
          keep it off
        </Button>
        <Button className='h-14 flex-1' onClick={() => void allowThornode()}>
          turn on
        </Button>
      </Buttons>
      <span className='text-xs text-fg-dim'>
        only while this page is open · it can be turned off again any time
      </span>
    </Column>
  );
};

/** where the pocket's rune key comes from, in one honest line */
export const SOURCE_LINE: Record<RuneSource, string> = {
  seed: 'from your recovery phrase',
  random: 'kept in zafu and its backup, not on your device',
  fvk: 'anyone with this viewing key can also move this rune',
};

const SourceRow = ({ w }: { w?: string }) => {
  const source = useLp(s => s.rune?.source);
  return source ? (
    <Row k='rune key' w={w} h='h-[52px]'>
      <span className={cn('text-[13px]', source === 'fvk' ? 'text-warn' : 'text-fg')}>
        {SOURCE_LINE[source]}
      </span>
    </Row>
  ) : null;
};

/** the cold wallet's one choice at the opt-in: a new key here (default), or the viewing key */
const ColdChoice = () => {
  const choice = useLp(s => s.runeChoice);
  const options: ['random' | 'fvk', string, string][] = [
    ['random', 'make a new key here', SOURCE_LINE.random],
    ['fvk', "use my device's viewing key", SOURCE_LINE.fvk],
  ];
  return (
    <div
      role='radiogroup'
      aria-label='rune key'
      className='flex flex-col border border-border-soft'
    >
      {options.map(([v, t, line], i) => (
        <button
          key={v}
          type='button'
          role='radio'
          aria-checked={choice === v}
          onClick={() => setRuneChoice(v)}
          className={cn(
            'flex min-h-[64px] items-center gap-3.5 px-[18px] py-2 text-left',
            i && 'border-t border-border-soft',
            choice === v ? 'bg-zigner-gold/10' : 'bg-elev-1 hover:bg-elev-2',
          )}
        >
          <span
            className={cn(
              'size-3 shrink-0 border',
              choice === v ? 'border-zigner-gold bg-zigner-gold' : 'border-border-hard',
            )}
          />
          <span className='flex flex-1 flex-col gap-1'>
            <span className='text-sm text-fg-high'>{t}</span>
            <span className={cn('text-xs', v === 'fvk' ? 'text-warn' : 'text-fg-muted')}>
              {line}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
};

/** the thor1 row: public, and linked to the lp address as one position */
export const RuneAddressRow = ({ w }: { w?: string }) => {
  const address = useLp(s => s.rune?.address);
  return (
    <button
      type='button'
      onClick={() => openSheet('public')}
      className='flex min-h-[50px] items-center gap-3.5 bg-elev-1 px-[18px] text-left transition-colors hover:bg-elev-2'
    >
      <span className={cn('shrink-0 text-xs text-fg-muted', w ?? 'w-[128px]')}>rune address</span>
      <span className='flex-1 font-mono text-sm text-fg-high'>{short(address) || '…'}</span>
      <span className='text-xs text-warn'>public</span>
      <EyeIcon />
    </button>
  );
};

/** LpTwoSided: with rune too. Before the opt-in it only compares and asks; after, it adds both halves */
export const TwoSidedScreen = ({ onAdd }: { onAdd: () => void }) => {
  const { a, q } = useAddQuote();
  const s = useLp(
    useShallow(s => ({
      on: !!s.rune?.on,
      cold: !!s.cold,
      thor: s.thor,
      zecUsd: s.zecUsd,
      runeRead: s.runeRead,
      runeErr: s.runeErr,
      amt: s.amt,
      shielded: s.shieldedZat,
      flight: !!s.flight,
      err: s.error,
      half: runeHalfOf(s),
      need: runeNeedOf(s),
      mayStop: mayStopRune(s),
    })),
  );
  const now = useNow();
  const rune = s.half;
  const px = s.zecUsd && s.thor ? { zec: s.zecUsd, rune: s.thor.runeUsd } : undefined;
  const both = s.thor && a && rune ? quotePaired(s.thor.pool, a, rune, px) : undefined;
  if (!s.on) {
    return (
      <Column
        title='add with rune too'
        sub='both sides go in together, so nothing goes to arbitrage.'
      >
        <div className='flex flex-col border border-border-soft'>
          <div className='flex h-[66px] items-center gap-3.5 bg-elev-1 px-[18px]'>
            <span className='flex flex-1 flex-col gap-1'>
              <span className='text-sm text-fg-high'>zec only</span>
              <span className='text-xs text-fg-muted'>{a ? zecText(a) : '0'} zec</span>
            </span>
            <span className='flex flex-col items-end gap-1'>
              <span className='text-sm text-warn'>
                {q?.costPct === undefined ? 'n/a' : pct(q.costPct)}
              </span>
              <span className='text-[11px] text-fg-dim'>cost vs market</span>
            </span>
          </div>
          <div className='flex h-[66px] items-center gap-3.5 border-t border-zigner-gold/40 bg-zigner-gold/10 px-[18px]'>
            <span className='flex flex-1 flex-col gap-1'>
              <span className='text-sm text-fg-high'>zec and rune</span>
              <span className='text-xs text-fg-muted'>
                {a ? zecText(a) : '0'} zec{rune !== undefined && ` + ${runeText(rune)} rune`}
              </span>
            </span>
            <span className='flex flex-col items-end gap-1'>
              <span className='text-sm text-green'>
                ≈ {both?.costPct === undefined ? '0%' : pct(Math.max(0, both.costPct))}
              </span>
              <span className='text-[11px] text-fg-dim'>cost vs market</span>
            </span>
          </div>
        </div>
        {s.cold && <ColdChoice />}
        <Table>
          <Row
            k='rune address'
            w='w-[110px]'
            h='h-[52px]'
            side={s.cold ? undefined : SOURCE_LINE.seed}
          >
            made when you choose this
          </Row>
          <Row k='rune from' w='w-[110px]' h='h-[52px]'>
            a swap from this pocket, or sent in
          </Row>
        </Table>
        <span className='flex items-center gap-2 text-xs text-fg-muted'>
          <EyeIcon className='size-3.5' />
          your rune address and lp address are public, and linked as one position.
        </span>
        {s.err && <span className='text-xs text-warn'>{s.err}</span>}
        <Button className='h-14' onClick={() => void chooseRune()}>
          use a rune address here
        </Button>
        <button
          type='button'
          onClick={() => show('add')}
          className='self-center text-xs text-fg-muted hover:text-fg-high'
        >
          add zec only
        </button>
      </Column>
    );
  }
  const r = s.runeRead;
  const shortRune = r && s.need !== undefined && r.balance < s.need ? s.need - r.balance : 0n;
  const over = !!a && s.shielded !== undefined && a + ADD_FEES > s.shielded;
  const paused = s.thor?.addPaused;
  const waiting = !!r?.paired && (r.paired.pendingRune > 0n || r.paired.pendingAsset > 0n);
  const age = s.thor ? Math.max(0, Math.round((now - s.thor.at) / 1000)) : 0;
  const can =
    !waiting &&
    !!s.thor &&
    !!a &&
    !!rune &&
    !!r &&
    !shortRune &&
    !over &&
    !paused &&
    !s.flight &&
    a >= MIN_ADD_ZAT;
  return (
    <div className='flex flex-col gap-4'>
      <h1 className='font-display text-[38px] text-fg-high'>add zec and rune</h1>
      <div className='border border-border-soft bg-elev-1'>
        <div className='flex h-24 items-center gap-3.5 px-5'>
          <label htmlFor='lpamt2' className='sr-only'>
            amount in zec
          </label>
          <input
            id='lpamt2'
            inputMode='decimal'
            value={s.amt}
            onChange={e => setAmount(e.target.value)}
            className='h-[66px] min-w-0 flex-1 bg-transparent font-display text-[52px] text-fg-high outline-none'
          />
          <span className='text-base text-zigner-gold'>zec</span>
        </div>
        <div className='flex h-[52px] items-center gap-2 border-t border-border-soft px-5'>
          <span className='text-sm text-fg-high'>
            + {rune === undefined ? '…' : runeText(rune)}
          </span>
          <span className='text-sm text-zigner-gold'>rune</span>
          <span className='flex-1' />
          {r && (
            <span className='text-xs text-fg-dim'>
              of <Sensitive>{runeText(r.balance)}</Sensitive> rune
            </span>
          )}
        </div>
      </div>
      <div className='grid grid-cols-3 border border-border-soft bg-elev-1'>
        {[
          ['you add', a ? `${zecText(a)} zec` : '0 zec', 'text-fg-high'],
          [
            'cost vs market',
            both?.costPct === undefined ? 'n/a' : pct(Math.max(0, both.costPct)),
            'text-fg-high',
          ],
          [
            'your share',
            both ? pct(both.sharePct, 2) : 'n/a',
            both ? 'text-fg-high' : 'text-fg-dim',
          ],
        ].map(([k, v, c], i) => (
          <div
            key={k}
            className={cn(
              'flex h-[72px] flex-col justify-center gap-1.5 px-4',
              i && 'border-l border-border-soft',
            )}
          >
            <span className='text-[11px] tracking-[0.04em] text-fg-muted'>{k}</span>
            <span className={cn('font-display text-[22px] tabular-nums', c)}>{v}</span>
          </div>
        ))}
      </div>
      <div
        className={cn(
          'flex h-11 items-center gap-2.5 border px-3.5',
          paused ? 'border-hanko' : shortRune || over ? 'border-warn/40' : 'border-border-soft',
        )}
      >
        {paused ? (
          <>
            <span className='size-2 shrink-0 bg-hanko' />
            <span className='flex-1 text-[13px] text-fg'>
              thorchain has paused adds to this pool. nothing was sent.
            </span>
          </>
        ) : !r ? (
          <span className='flex-1 text-xs text-fg-muted'>
            {s.runeErr ?? 'reading your rune address'}
          </span>
        ) : waiting ? (
          <>
            <span className='size-2 shrink-0 bg-warn' />
            <span className='flex-1 text-[13px] text-fg'>a half is still waiting in the pool</span>
            <Button
              variant='secondary'
              size='sm'
              className='h-[30px] text-zigner-gold'
              onClick={() => show('position')}
            >
              see it
            </Button>
          </>
        ) : shortRune ? (
          <>
            <span className='size-2 shrink-0 bg-warn' />
            <span className='flex-1 text-[13px] text-fg'>
              {runeText(shortRune)} rune more, with a little kept for fees
            </span>
            <Button
              variant='secondary'
              size='sm'
              className='h-[30px] text-zigner-gold'
              onClick={() => show('rune')}
            >
              get rune
            </Button>
          </>
        ) : over ? (
          <>
            <span className='size-2 shrink-0 bg-warn' />
            <span className='flex-1 text-[13px] text-fg'>
              more than this pocket holds shielded, with the network fees
            </span>
          </>
        ) : (
          <>
            <span className='size-1.5 shrink-0 animate-pulse bg-green motion-reduce:animate-none' />
            <span className='flex-1 text-xs text-fg-muted'>
              at the pool's ratio, read {age} s ago
            </span>
            <span className='text-xs text-fg-dim'>
              keeps {runeText(reserveOf(r.fee))} rune for fees
            </span>
          </>
        )}
      </div>
      <Table>
        <Row k='zec from' w='w-[92px]' h='h-14'>
          your shielded pocket
        </Row>
        <LpAddressRow w='w-[92px]' />
        <RuneAddressRow w='w-[92px]' />
        <SourceRow w='w-[92px]' />
      </Table>
      <span className='flex items-center gap-2 text-xs text-fg-muted'>
        <EyeIcon className='size-3.5' />
        your rune address and lp address are public, and linked as one position.
      </span>
      {s.err && <span className='text-xs text-warn'>{s.err}</span>}
      <Button className='h-14' disabled={!can} onClick={onAdd}>
        {a && rune && can ? `add ${zecText(a)} zec and ${runeText(rune)} rune` : 'add zec and rune'}
      </Button>
      <div className='flex items-center justify-center gap-5'>
        <button
          type='button'
          onClick={() => show('rune')}
          className='text-xs text-fg-muted hover:text-fg-high'
        >
          get rune
        </button>
        <button
          type='button'
          onClick={() => show('add')}
          className='text-xs text-fg-muted hover:text-fg-high'
        >
          add zec only
        </button>
        {s.mayStop && (
          <button
            type='button'
            onClick={() => void stopRune()}
            className='text-xs text-fg-dim hover:text-fg-high'
          >
            stop using rune here
          </button>
        )}
      </div>
    </div>
  );
};
