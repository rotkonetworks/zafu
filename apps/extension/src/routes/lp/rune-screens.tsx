/**
 * lp.html's rune screens, only for a pocket that chose to add with rune too:
 * getting rune (a zec -> rune swap paid to the pocket's thor1, or receiving
 * it) and taking a two-sided position out. Nothing here exists anywhere else
 * in zafu; the swap screen never offers this thor1.
 */

import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@repo/ui/components/ui/button';
import { cn } from '@repo/ui/lib/utils';
import { Column, useNow } from '../../components/scroll-page';
import { QrCode } from '../../components/qr-code';
import { Sensitive } from '../../components/sensitive';
import {
  afterFee,
  pairedWithdraw,
  pairedWithdrawMemo,
  parseZec,
  runeText,
  zecText,
  type PayoutAs,
} from '../../lp/math';
import {
  ADD_FEES,
  quoteSwap,
  setPart,
  setPayoutAs,
  setSwapAmt,
  SHIELD_BACK_FEE,
  swapGuessOf,
  type LpState,
} from './store';
import { blocksToMin, pct, Row, Short, Table, useLp } from './screens';

const CopyAddress = ({ address }: { address: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <div className='flex items-center gap-3 border border-border-soft bg-elev-1 px-[18px] py-3'>
      <span className='min-w-0 flex-1 break-all font-mono text-sm text-fg-high'>{address}</span>
      <Button
        variant='secondary'
        aria-label='copy your rune address'
        className={cn('h-9 w-[76px] text-xs', copied ? 'text-green' : 'text-zigner-gold')}
        onClick={() => void navigator.clipboard.writeText(address).then(() => setCopied(true))}
      >
        {copied ? 'copied' : 'copy'}
      </Button>
    </div>
  );
};

/** LpRune: rune for the add, from this pocket's zec (a THORChain swap) or sent in */
export const RuneScreen = ({ onSwap }: { onSwap: () => void }) => {
  const s = useLp(
    useShallow(s => ({
      address: s.rune?.address,
      read: s.runeRead,
      swapAmt: s.swapAmt,
      q: s.swapQuote,
      err: s.swapErr,
      shielded: s.shieldedZat,
      flight: !!s.flight,
      guess: swapGuessOf(s),
    })),
  );
  const [tab, setTab] = useState<'swap' | 'receive'>('swap');
  const now = useNow();
  const zat = parseZec(s.swapAmt);
  // typed amounts are quoted once the typing settles; the guess fills an empty field
  useEffect(() => {
    if (!s.swapAmt && s.guess) {
      setSwapAmt(zecText(s.guess).replace(/\.?0+$/, ''));
    }
  }, [s.swapAmt, s.guess]);
  useEffect(() => {
    if (!zat) {
      return;
    }
    const id = setTimeout(() => void quoteSwap(), 400);
    return () => clearTimeout(id);
  }, [zat]);
  if (!s.address) {
    return null;
  }
  const over = !!zat && s.shielded !== undefined && zat + ADD_FEES > s.shielded;
  const fresh = s.q && s.q.amountZat === zat && s.q.expiry > now;
  return (
    <Column title='get rune' sub='rune for the add, kept at your rune address.'>
      <div className='grid grid-cols-2 gap-2'>
        {(['swap', 'receive'] as const).map(t => (
          <button
            key={t}
            type='button'
            onClick={() => setTab(t)}
            className={cn(
              'h-11 border text-[14px]',
              tab === t
                ? 'border-zigner-gold bg-zigner-gold/10 text-fg-high'
                : 'border-border-soft bg-elev-2 text-fg',
            )}
          >
            {t === 'swap' ? 'swap from this pocket' : 'receive rune'}
          </button>
        ))}
      </div>
      {tab === 'swap' ? (
        <>
          <div className='border border-border-soft bg-elev-1'>
            <div className='flex h-20 items-center gap-3.5 px-5'>
              <label htmlFor='lpswap' className='sr-only'>
                zec to swap
              </label>
              <input
                id='lpswap'
                inputMode='decimal'
                value={s.swapAmt}
                onChange={e => setSwapAmt(e.target.value)}
                className='h-14 min-w-0 flex-1 bg-transparent font-display text-[42px] text-fg-high outline-none'
              />
              <span className='text-base text-zigner-gold'>zec</span>
            </div>
          </div>
          <Table>
            <Row
              k='you get'
              w='w-[110px]'
              h='h-[52px]'
              side={fresh ? 'thorchain quote' : undefined}
            >
              {fresh ? `≈ ${runeText(s.q!.runeOut)} rune` : zat ? 'asking…' : 'type an amount'}
            </Row>
            <Row k='at least' w='w-[110px]' h='h-[52px]' side='or it comes back'>
              {fresh ? `${runeText(s.q!.atLeast)} rune` : 'n/a'}
            </Row>
            <Row k='to' w='w-[110px]' h='h-[52px]' side='your rune address'>
              <span className='font-mono'>
                <Short>{s.address}</Short>
              </span>
            </Row>
            {s.read && (
              <Row k='holds now' w='w-[110px]' h='h-[52px]'>
                <Sensitive>{runeText(s.read.balance)} rune</Sensitive>
              </Row>
            )}
          </Table>
          {(s.err ??
            (over ? 'more than this pocket holds shielded, with the network fees' : undefined)) && (
            <span className='text-xs text-warn'>
              {s.err ?? 'more than this pocket holds shielded, with the network fees'}
            </span>
          )}
          <Button className='h-14' disabled={!fresh || over || s.flight} onClick={onSwap}>
            {fresh ? `swap ${zecText(zat)} zec for rune` : 'swap for rune'}
          </Button>
          <span className='text-xs text-fg-dim'>
            the zec goes from your lp address, as an add does · network fees about{' '}
            {zecText(ADD_FEES)} zec
          </span>
        </>
      ) : (
        <>
          <div className='flex items-start gap-5'>
            <QrCode value={s.address} size={176} label='your rune address' />
            <span className='flex-1 text-[13px] leading-relaxed text-fg'>
              send rune here from anywhere on thorchain. it shows once it lands, and is used only
              for liquidity on this page.
            </span>
          </div>
          <CopyAddress address={s.address} />
        </>
      )}
    </Column>
  );
};

const PARTS: [LpState['part'], string][] = [
  [25, '25%'],
  [50, 'half'],
  [100, 'all'],
];

const AS: [PayoutAs, string][] = [
  ['both', 'zec and rune'],
  ['zec', 'all as zec'],
  ['rune', 'all as rune'],
];

/** LpWithdraw for a two-sided position: asked from the thor1, paid out as chosen */
export const Withdraw2Screen = ({ onOut }: { onOut: () => void }) => {
  const s = useLp(
    useShallow(s => ({
      thor: s.thor,
      read: s.runeRead,
      part: s.part,
      as: s.payoutAs,
      pocket: s.pocket,
      err: s.error,
    })),
  );
  const t = s.thor;
  const p = s.read?.paired;
  if (!t || !p || p.units === 0n || !s.read) {
    return null;
  }
  const bps = s.part * 100;
  const pays = pairedWithdraw(t.pool, p.units, bps, t.minSlipBps, s.as);
  const outFee = t.inbound?.outboundFee ?? 0n;
  const zecBack = pays.zat > 0n ? afterFee(pays.zat, outFee) : 0n;
  const zecFees = pays.zat > 0n ? outFee + SHIELD_BACK_FEE : 0n;
  const lockedFor = p.lastAddHeight + t.lockupBlocks - t.height;
  const memo = pairedWithdrawMemo(bps, s.as);
  const noFee = s.read.balance < s.read.fee;
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
      <div className='grid grid-cols-3 gap-2'>
        {AS.map(([v, label]) => (
          <button
            key={v}
            type='button'
            onClick={() => setPayoutAs(v)}
            className={cn(
              'h-11 border text-[13px]',
              s.as === v
                ? 'border-zigner-gold bg-zigner-gold/10 text-fg-high'
                : 'border-border-soft bg-elev-2 text-fg',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <Table>
        {pays.zat > 0n && (
          <Row k='zec' w='w-[150px]' h='h-[52px]' side={`shielded back to ${s.pocket}`}>
            <Sensitive>≈ {zecText(zecBack)} zec</Sensitive>
          </Row>
        )}
        {pays.rune > 0n && (
          <Row k='rune' w='w-[150px]' h='h-[52px]' side='to your rune address'>
            <Sensitive>≈ {runeText(pays.rune)} rune</Sensitive>
          </Row>
        )}
        <Row k='network fees' w='w-[150px]' h='h-[52px]'>
          {runeText(s.read.fee)} rune
          {zecFees > 0n && ` + ${zecText(zecFees)} zec`}
        </Row>
        <Row k='asks with' w='w-[150px]' h='h-[52px]' side={memo}>
          <span className='text-[13px]'>
            0 rune from <Short>{s.read.address}</Short>
          </span>
        </Row>
      </Table>
      {(s.err ??
        (noFee
          ? 'your rune address needs its network fee to ask · please get a little rune'
          : undefined)) && (
        <span className='text-xs text-warn'>
          {s.err ?? 'your rune address needs its network fee to ask · please get a little rune'}
        </span>
      )}
      <Button className='h-14' disabled={!!t.outPaused || lockedFor > 0 || noFee} onClick={onOut}>
        {t.outPaused
          ? 'take-outs are paused · check again'
          : lockedFor > 0
            ? `take it out in about ${blocksToMin(lockedFor)} min`
            : s.part === 100
              ? 'take out all'
              : s.part === 50
                ? 'take out half'
                : `take out ${pct(25, 0)}`}
      </Button>
    </div>
  );
};
