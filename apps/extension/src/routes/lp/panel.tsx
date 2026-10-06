/**
 * The live data panel beside the column: each group names its source and
 * how old its read is, ticking. Not read until thornode is allowed; blocked
 * shows the last read, dimmed.
 */

import type { ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { cn } from '@repo/ui/lib/utils';
import { useNow } from '../../components/scroll-page';
import { Sensitive } from '../../components/sensitive';
import { isDone } from '../../lp/flight';
import { pairedWithdraw, runeText, zecText } from '../../lp/math';
import { openSheet, positionOf, show, worthOf } from './store';
import { short, useAddQuote, useLp } from './screens';

const usd0 = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const usd2 = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const rune = (v: bigint) =>
  (Number(v) / 1e8).toLocaleString('en-US', { maximumFractionDigits: Number(v) < 1e10 ? 2 : 0 });

interface R {
  k: string;
  v: ReactNode;
  c?: string;
  src?: string;
  /** a value not read: a dashed tag */
  tag?: boolean;
}

const Group = ({
  t,
  src,
  live,
  rows,
  big,
  bar,
  tint,
  first,
}: {
  t: string;
  src?: string;
  live?: boolean;
  rows: R[];
  big?: [string, string];
  bar?: [number, string, string];
  tint?: boolean;
  first?: boolean;
}) => (
  <div
    className={cn(
      'flex flex-col px-[18px] py-2',
      !first && 'border-t border-border-soft',
      tint ? 'bg-zigner-gold/10' : 'bg-elev-1',
    )}
  >
    <div className='flex h-6 items-center gap-2'>
      <span className='flex-1 text-[11px] tracking-[0.04em] text-fg-muted'>{t}</span>
      {src !== undefined && (
        <>
          <span
            className={cn(
              'size-1.5',
              live ? 'animate-pulse bg-green motion-reduce:animate-none' : 'bg-border-hard',
            )}
          />
          <span className='text-[11px] tabular-nums text-fg-dim'>{src}</span>
        </>
      )}
    </div>
    {big && (
      <div className='flex h-10 items-baseline gap-2.5'>
        <span className='font-display text-[30px] tabular-nums text-fg-high'>{big[0]}</span>
        <span className='text-xs text-fg-muted'>{big[1]}</span>
      </div>
    )}
    {rows.map(r => (
      <div key={r.k} className='flex h-[27px] items-center gap-2.5'>
        <span className='w-[128px] shrink-0 text-xs text-fg-muted'>{r.k}</span>
        <span className='flex flex-1 items-center'>
          {r.tag ? (
            <span className='inline-flex h-[18px] items-center whitespace-nowrap border border-dashed border-border-hard px-1.5 text-[10px] tracking-[0.04em] text-fg-dim'>
              {r.v}
            </span>
          ) : (
            <span className={cn('text-[13px] tabular-nums', r.c ?? 'text-fg-high')}>{r.v}</span>
          )}
        </span>
        {r.src && <span className='text-[11px] tabular-nums text-fg-dim'>{r.src}</span>}
      </div>
    ))}
    {bar && (
      <div className='flex flex-col gap-1.5 pb-1 pt-1.5'>
        <div className='relative h-1.5 bg-border-hard'>
          <span
            className={cn('absolute inset-y-0 left-0', bar[1])}
            style={{ width: `${bar[0]}%` }}
          />
        </div>
        <span className='text-[11px] text-fg-dim'>{bar[2]}</span>
      </div>
    )}
  </div>
);

const ago = (now: number, at?: number) =>
  at === undefined ? '' : `${Math.max(0, Math.round((now - at) / 1000))} s`;

export const Panel = ({ screen }: { screen: string }) => {
  const s = useLp(
    useShallow(s => ({
      thor: s.thor,
      mid: s.mid,
      zecUsd: s.zecUsd,
      pxAt: s.pxAt,
      address: s.lp?.address,
      cache: s.cache,
      flight: s.flight,
      egress: s.egress,
      readErr: s.readErr,
      blocked: s.blocked,
      thor1: s.rune?.on ? s.rune.address : undefined,
      runeRead: s.rune?.on ? s.runeRead : undefined,
    })),
  );
  const { a, q, small } = useAddQuote();
  const now = useNow();
  const t = s.thor;
  const off = !t || screen === 'first' || screen === 'egress' || screen === 'blocked';
  const offSrc = s.blocked ? 'off' : t ? '' : (s.readErr ?? 'after you allow');
  const nr = (k: string): R => ({ k, v: s.blocked ? 'off' : 'not read', tag: true });
  const p = positionOf(s);
  const worth = worthOf(s);
  const tSrc = t ? `thornode · ${ago(now, t.at)}` : '';
  const mSrc = s.mid
    ? `midgard · ${ago(now, s.mid.at)}`
    : s.egress.midgard
      ? 'midgard'
      : 'midgard off';
  const pxSrc = s.zecUsd ? `prices · ${ago(now, s.pxAt)}` : 'prices off';
  const adding = screen === 'add' && a && q && !small;
  const share = adding && t ? Math.min(100, (Number(a) / Number(t.pool.asset)) * 100) : 0;
  const status = off
    ? s.blocked
      ? 'not read · off'
      : 'not read yet'
    : t.addPaused
      ? 'adds paused'
      : t.pool.status.toLowerCase();
  const gap = t && s.zecUsd ? (t.pool.zecUsd / s.zecUsd - 1) * 100 : undefined;
  const days = s.mid?.since ? Math.max(0, Math.floor((now - s.mid.since) / 86_400_000)) : undefined;
  const inFlight =
    s.flight &&
    (s.flight.kind === 'add' || s.flight.kind === 'add2') &&
    !isDone(s.flight) &&
    !s.flight.lost &&
    s.flight.stage !== 'refunded';
  const rr = s.runeRead;
  const paired = rr?.paired;
  const pairedOut =
    paired && t ? pairedWithdraw(t.pool, paired.units, 10_000, t.minSlipBps, 'both') : undefined;
  const withRune: R[] = s.thor1
    ? [
        { k: 'rune address', v: short(s.thor1) },
        { k: 'lp address', v: short(s.address) },
        rr
          ? { k: 'holds', v: <Sensitive>{runeText(rr.balance)} rune</Sensitive> }
          : { k: 'holds', v: s.blocked ? 'off' : 'not read', tag: true },
        ...(paired && paired.units > 0n && pairedOut
          ? [
              {
                k: 'in the pool',
                v: (
                  <Sensitive>
                    {zecText(pairedOut.zat)} zec + {runeText(pairedOut.rune)} rune
                  </Sensitive>
                ),
              },
            ]
          : paired && (paired.pendingRune > 0n || paired.pendingAsset > 0n)
            ? [
                {
                  k: 'waiting',
                  v: (
                    <Sensitive>
                      {paired.pendingRune > 0n
                        ? `${runeText(paired.pendingRune)} rune`
                        : `${zecText(paired.pendingAsset)} zec`}
                    </Sensitive>
                  ),
                  c: 'text-warn',
                },
              ]
            : []),
      ]
    : [];
  const yours: R[] = inFlight
    ? [
        {
          k: 'on the way',
          v: <Sensitive>{zecText(BigInt(s.flight!.amountZat))} zec</Sensitive>,
          c: 'text-zigner-gold',
        },
        { k: 'lp address', v: short(s.address) },
      ]
    : p && worth !== undefined && t
      ? [
          {
            k: 'in the pool',
            v: (
              <Sensitive>
                {zecText(worth)} zec
                {s.zecUsd ? ` · ${usd2((Number(worth) / 1e8) * s.zecUsd)}` : ''}
              </Sensitive>
            ),
          },
          {
            k: 'share',
            v: (
              <Sensitive>{((Number(p.units) / Number(t.pool.units)) * 100).toFixed(2)}%</Sensitive>
            ),
          },
          { k: 'units', v: <Sensitive>{p.units.toLocaleString('en-US')}</Sensitive> },
        ]
      : [
          { k: 'in the pool', v: 'nothing yet', c: 'text-fg-muted' },
          { k: 'lp address', v: short(s.address) || 'made on first add' },
        ];
  return (
    <div className='flex w-[440px] shrink-0 flex-col self-stretch border border-border-soft bg-elev-1 max-xl:hidden'>
      <div className='flex h-12 shrink-0 items-center gap-2.5 border-b border-border-soft px-[18px]'>
        <span className='flex-1 text-xs tracking-[0.04em] text-fg-muted'>
          zec.zec pool · thorchain
        </span>
        <span
          className={cn(
            'text-[11px]',
            off ? 'text-fg-dim' : t.addPaused ? 'text-hanko' : 'text-green',
          )}
        >
          {status}
        </span>
      </div>
      {off ? (
        <>
          <Group first t='pool depth' src={offSrc} rows={[nr('zec side'), nr('rune side')]} />
          <Group
            t='price'
            src={offSrc}
            rows={[
              nr('pool'),
              s.zecUsd
                ? { k: 'market', v: usd2(s.zecUsd), src: pxSrc }
                : { k: 'market', v: 'not read', tag: true },
              nr('gap'),
            ]}
          />
          <Group
            t='activity'
            src={offSrc}
            rows={[nr('volume 24h'), nr('fees to the pool 7d'), nr('apr')]}
          />
          <Group t='waiting' src={offSrc} rows={[nr('waiting for zec')]} />
          <Group
            t='yours'
            src={s.blocked && s.cache ? 'last read' : ''}
            rows={
              s.blocked && s.cache
                ? [
                    {
                      k: 'in the pool',
                      v: <Sensitive>{zecText(BigInt(s.cache.zat))} zec</Sensitive>,
                      c: 'text-fg-muted',
                    },
                    { k: 'lp address', v: short(s.address), c: 'text-fg-muted' },
                  ]
                : [
                    {
                      k: 'lp address',
                      v: short(s.address) || 'made on first add',
                      c: 'text-fg-muted',
                    },
                  ]
            }
          />
        </>
      ) : (
        <>
          <Group
            first
            t='pool depth'
            src={tSrc}
            live
            big={[usd0((Number(t.pool.rune) / 1e8) * t.runeUsd * 2), 'both sides']}
            rows={[
              {
                k: 'zec side',
                v: `${zecText(t.pool.asset)} zec · ${usd0((Number(t.pool.asset) / 1e8) * t.pool.zecUsd)}`,
              },
              {
                k: 'rune side',
                v: `${rune(t.pool.rune)} rune · ${usd0((Number(t.pool.rune) / 1e8) * t.runeUsd)}`,
              },
              ...(t.addPaused ? [{ k: 'adds', v: 'paused', c: 'text-hanko', src: 'mimir' }] : []),
            ]}
            bar={
              screen === 'add'
                ? [
                    share ? Math.max(2, share) : 0,
                    q?.costPct !== undefined && q.costPct >= 10 ? 'bg-hanko' : 'bg-zigner-gold',
                    share
                      ? `your add is ${share.toFixed(1)}% of the zec side`
                      : 'type an amount to see it against the pool',
                  ]
                : undefined
            }
          />
          <Group
            t='price'
            rows={[
              { k: 'pool', v: usd2(t.pool.zecUsd), src: tSrc },
              s.zecUsd
                ? { k: 'market', v: usd2(s.zecUsd), src: pxSrc }
                : { k: 'market', v: 'not read · prices off', tag: true },
              gap === undefined
                ? { k: 'gap', v: 'not read', tag: true }
                : {
                    k: 'gap',
                    v: `${gap > 0 ? '+' : '−'}${Math.abs(gap).toFixed(1)}% · pool ${gap >= 0 ? 'over' : 'under'} market`,
                    c: Math.abs(gap) >= 2 ? 'text-warn' : 'text-fg-high',
                  },
            ]}
          />
          <Group
            t='activity'
            src={mSrc}
            live={!!s.mid}
            rows={
              s.mid
                ? [
                    {
                      k: 'volume 24h',
                      v: `${rune(s.mid.volume24hRune)} rune · ${usd0((Number(s.mid.volume24hRune) / 1e8) * t.runeUsd)}`,
                    },
                    {
                      k: 'fees to the pool 7d',
                      v: `${rune(s.mid.fees7dRune)} rune · ${usd2((Number(s.mid.fees7dRune) / 1e8) * t.runeUsd)}`,
                    },
                    {
                      k: 'apr',
                      v: `not yet · pool is ${days ?? '?'} day${days === 1 ? '' : 's'} old`,
                      tag: true,
                    },
                    { k: 'providers', v: String(s.mid.providers), src: 'midgard' },
                  ]
                : [nr('volume 24h'), nr('fees to the pool 7d'), nr('apr')]
            }
          />
          <Group
            t='waiting'
            src={tSrc}
            live
            rows={[
              {
                k: 'waiting for zec',
                v: t.pool.pendingRune
                  ? `${rune(t.pool.pendingRune)} rune · ${usd0((Number(t.pool.pendingRune) / 1e8) * t.runeUsd)}`
                  : 'none',
                c: t.pool.pendingRune ? 'text-fg-high' : 'text-fg-muted',
              },
            ]}
          />
          <Group t='yours' src={tSrc} live tint={!!p || !!inFlight} rows={yours} />
          {s.thor1 && (
            <Group
              t='with rune · linked'
              src={rr ? `thornode · ${ago(now, rr.at)}` : ''}
              live={!!rr}
              rows={withRune}
            />
          )}
        </>
      )}
      <div className='flex-1' />
      {inFlight && screen !== 'track' && (
        <button
          type='button'
          onClick={() => show(null)}
          className='flex h-11 shrink-0 items-center gap-2.5 border-t border-border-soft px-[18px] text-left hover:bg-elev-2'
        >
          <span className='flex-1 text-xs text-fg'>see the add on its way</span>
          <span className='i-lucide-chevron-right size-3 text-fg-muted' aria-hidden='true' />
        </button>
      )}
      {!off && p && (
        <button
          type='button'
          onClick={() => openSheet('history')}
          className='flex h-11 shrink-0 items-center gap-2.5 border-t border-border-soft px-[18px] text-left hover:bg-elev-2'
        >
          <span className='flex-1 text-xs text-fg'>adds and take-outs of this address</span>
          <span className='text-[11px] text-fg-dim'>midgard</span>
          <span className='i-lucide-chevron-right size-3 text-fg-muted' aria-hidden='true' />
        </button>
      )}
    </div>
  );
};
