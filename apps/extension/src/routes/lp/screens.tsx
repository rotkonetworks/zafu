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
import { depositFeeZat } from '../../workers/transparent-deposit';
import { stepLines } from '../../lp/flight';
import {
  ADD_MEMO,
  afterFee,
  costTone,
  fairAmount,
  impermanentLoss,
  MIN_ADD_ZAT,
  parseZec,
  quoteAdd,
  withdrawMemo,
  withdrawZec,
  zecMoveSinceAdd,
  zecText,
} from '../../lp/math';
import {
  allowEgress,
  allowThornode,
  finish,
  goEgress,
  goFirst,
  lpStore,
  openSheet,
  positionOf,
  retry,
  setAmount,
  setPart,
  shieldItBack,
  show,
  tick,
  worthOf,
  type LpState,
} from './store';

export const useLp = <T,>(sel: (s: LpState) => T): T => useStore(lpStore, sel);

/** the zcash network fee of a shield-out to a t-address, about: two orchard actions and the t-output */
const SHIELD_OUT_FEE = 15_000n;
/** one shielding input */
const SHIELD_BACK_FEE = 10_000n;

export const short = (a?: string) => (a ? `${a.slice(0, 5)}…${a.slice(-4)}` : '');
const usd = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n: number, d = 1) => `${n.toFixed(d)}%`;
const blocksToMin = (b: number) => Math.max(1, Math.ceil((b * 6) / 60));

const EyeIcon = ({ className }: { className?: string }) => (
  <span className={cn('i-lucide-eye size-4 shrink-0 text-warn', className)} aria-hidden='true' />
);

const Table = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div
    className={cn(
      'flex flex-col divide-y divide-border-soft border border-border-soft bg-elev-1',
      className,
    )}
  >
    {children}
  </div>
);

const Row = ({
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
const LpAddressRow = ({ w }: { w?: string }) => {
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
  const prices = useLp(s => s.egress.prices);
  const hosts: Host[] = [
    {
      mark: 't',
      name: 'thornode',
      does: 'the pool, your position, its address, pauses',
      host: 'gateway.liquify.com\n/thorchain_api',
      c: 'text-zigner-gold',
    },
    {
      mark: 'm',
      name: 'midgard',
      does: 'volume, fees, your history',
      host: 'gateway.liquify.com\n/thorchain_midgard',
      c: 'text-zigner-gold',
    },
    {
      mark: '$',
      name: 'prices',
      does: 'the market price, for cost vs market',
      host: prices ? 'already allowed' : '1click.chaindefuser.com',
      c: prices ? 'text-fg-muted' : 'text-zigner-gold',
    },
  ];
  return (
    <AskOnce
      sub='liquidity talks to these, and only while this page is open.'
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
  const { amt, shielded, pocket, at, read, thorAt, flight } = useLp(
    useShallow(s => ({
      amt: s.amt,
      shielded: s.shieldedZat,
      pocket: s.pocket,
      at: s.thor?.at,
      read: !!s.thor,
      thorAt: s.thor?.at,
      flight: !!s.flight,
    })),
  );
  const { a, q, small, fair, fairQ, paused } = useAddQuote();
  const now = useNow();
  const tone = costTone(q?.costPct);
  const large = !small && tone === 'strong';
  const age = at ? Math.max(0, Math.round((now - at) / 1000)) : 0;
  const fees = SHIELD_OUT_FEE + depositFeeZat(ADD_MEMO.length);
  const can = read && !!a && !!q && !small && !paused && !flight;
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
            <span className='text-xs text-fg-dim'>of {zecText(shielded)} shielded</span>
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
        with rune too, later
      </button>
    </div>
  );
};

/** LpPosition: worth now, since adding, fees, share */
export const PositionScreen = () => {
  const s = useLp(
    useShallow(s => ({ thor: s.thor, zecUsd: s.zecUsd, mid: s.mid, flight: s.flight })),
  );
  const p = positionOf(s);
  const worth = worthOf(s);
  const now = useNow(60_000);
  if (!p || worth === undefined) {
    return null;
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
          <span className='font-display text-[52px] leading-[1.05] tabular-nums text-fg-high'>
            {zecText(worth)}
          </span>
          <span className='text-base text-zigner-gold'>zec</span>
          <span className='flex-1' />
          {s.zecUsd && (
            <span className='text-[15px] text-fg-muted'>
              {usd((Number(worth) / 1e8) * s.zecUsd)}
            </span>
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
          {zecText(added)} zec
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
        <Row k='your share' side={`${p.units.toLocaleString('en-US')} units`}>
          {s.thor && pct((Number(p.units) / Number(s.thor.pool.units)) * 100, 2)}
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
  const dust = t.inbound.dust;
  const fees =
    t.inbound.outboundFee +
    dust +
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
            <span className={cn('font-display text-[22px] tabular-nums', c)}>{v}</span>
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
            {zecText(all)} zec{usdOf(all)}
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
            {zecText(added)} zec{usdOf(added)}
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
          <Row k='asks with' w='w-[110px]' h='h-[52px]' side={withdrawMemo(bps)}>
            <span className='text-[13px] text-fg'>
              {zecText(dust)} zec from {short(s.address)}
            </span>
          </Row>
        </Table>
      )}
      <Button className='h-14' disabled={!!t.outPaused} onClick={onOut}>
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
export const TrackScreen = () => {
  const s = useLp(
    useShallow(s => ({ flight: s.flight, address: s.lp?.address, pocket: s.pocket, err: s.error })),
  );
  const now = useNow();
  const f = s.flight;
  if (!f) {
    return null;
  }
  const lines = stepLines(f, { zec: zecText, address: short(s.address), pocket: s.pocket });
  const done = lines.filter(l => l.state === 'done').length;
  const refunded = f.stage === 'refunded';
  const finished = f.stage === 'credited' || f.stage === 'shielded' || f.stage === 'refused';
  const title =
    refunded || (f.kind === 'add' && f.outZat)
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
  return (
    <div className='flex flex-col gap-5'>
      <div className='flex items-end justify-between gap-4'>
        <h1 className='font-display text-[38px] leading-[1.15] text-fg-high'>{title}</h1>
        <span className='flex shrink-0 flex-col items-end gap-1.5'>
          <span className='font-display text-[34px] tabular-nums text-fg-high'>
            {refunded && f.outZat ? zecText(BigInt(f.outZat)) : clock(now - f.started)}
          </span>
          <span className='text-[11px] text-fg-muted'>
            {refunded
              ? 'zec at your lp address'
              : f.kind === 'add'
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
      {f.error || s.err ? (
        <div className='flex min-h-11 items-center gap-2.5 border border-warn/40 px-3.5 py-2'>
          <span className='flex-1 text-xs text-fg'>{f.error ?? s.err}</span>
          {f.error && (
            <Button variant='secondary' size='sm' onClick={() => void retry()}>
              try again
            </Button>
          )}
        </div>
      ) : (
        <div className='flex h-11 items-center border border-border-soft bg-elev-1 px-3.5'>
          <span className='text-xs text-fg'>
            {refunded
              ? 'nothing else was lost. it waits at your lp address until you choose.'
              : f.kind === 'add'
                ? 'close this any time. anything not yet sent waits until this page is open.'
                : 'the pool pays out once thorchain has seen the ask.'}
          </span>
        </div>
      )}
      <Buttons>
        {refunded ? (
          <>
            <Button variant='secondary' className='h-14 w-[170px]' onClick={() => void finish()}>
              keep it there
            </Button>
            <Button className='h-14 flex-1' onClick={() => void shieldItBack()}>
              shield it back
            </Button>
          </>
        ) : finished ? (
          <Button className='h-14 flex-1' onClick={() => void finish()}>
            {f.kind === 'add' && f.stage === 'credited' ? 'see your liquidity' : 'done'}
          </Button>
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
    <Column title='thornode is blocked' sub="so we can't read the pool or your position right now.">
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
          {cache ? `${zecText(BigInt(cache.zat))} zec` : 'not read yet'}
        </Row>
        <Row k='add, take out' h='h-14'>
          wait for a fresh read
        </Row>
      </Table>
      <Buttons>
        <Button variant='secondary' className='h-14 w-[170px]' onClick={() => window.close()}>
          keep it blocked
        </Button>
        <Button className='h-14 flex-1' onClick={() => void allowThornode()}>
          allow thornode
        </Button>
      </Buttons>
      <span className='text-xs text-fg-dim'>
        only while this page is open · blockable again any time
      </span>
    </Column>
  );
};

/** LpTwoSided: with rune too, later */
export const TwoSidedScreen = () => {
  const { a, q } = useAddQuote();
  const rune = useLp(s =>
    s.thor && a
      ? (Number(a) * Number(s.thor.pool.rune)) / Number(s.thor.pool.asset) / 1e8
      : undefined,
  );
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
              {a ? zecText(a) : '0'} zec{rune !== undefined && ` + ${rune.toFixed(2)} rune`}
            </span>
          </span>
          <span className='flex flex-col items-end gap-1'>
            <span className='text-sm text-green'>≈ 0%</span>
            <span className='text-[11px] text-fg-dim'>cost vs market</span>
          </span>
        </div>
      </div>
      <Table>
        <Row k='rune address' w='w-[110px]' h='h-[52px]' side='from your recovery phrase'>
          thor1…
        </Row>
        <Row k='rune from' w='w-[110px]' h='h-[52px]'>
          a swap, or sent in
        </Row>
      </Table>
      <Button variant='secondary' className='h-14' disabled>
        coming later · thank you for waiting
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
};
