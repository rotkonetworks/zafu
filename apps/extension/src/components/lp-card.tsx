/**
 * The home's "in a pool" card (board LpHomeCard): the position as lp.html
 * last read it, with how long ago. Nothing is fetched here; the card is the
 * sealed cache alone, and a tap opens lp.html, which reads afresh.
 */

import { useEffect, useState } from 'react';
import { isDone } from '../lp/flight';
import { zecText } from '../lp/math';
import { LP_PRELOAD, openLpPage } from '../lp/open';
import { onLpChange, readLpPocket, type LpPocket } from '../lp/store';
import { Sensitive } from './sensitive';
import { BalanceGroup, BalanceRow } from './wallet/balance-rows';

export const LpWave = ({ className = 'size-4' }: { className?: string }) => (
  <span className={`i-lucide-waves text-zigner-gold ${className}`} aria-hidden='true' />
);

const readAgo = (ms: number): string => {
  const m = Math.round(ms / 60_000);
  return m < 1
    ? 'read just now'
    : m < 60
      ? `read ${m} min ago`
      : m < 48 * 60
        ? `read ${Math.round(m / 60)} h ago`
        : `read ${Math.round(m / 1440)} days ago`;
};

export const LpCard = ({ storeId }: { storeId?: string }) => {
  const [rec, setRec] = useState<LpPocket>();
  useEffect(() => {
    if (!storeId) {
      return;
    }
    const read = () => void readLpPocket(storeId).then(setRec);
    read();
    return onLpChange(read);
  }, [storeId]);
  const moving = rec?.flight && !isDone(rec.flight) ? rec.flight : undefined;
  if (!rec?.cache && !moving) {
    return null;
  }
  return (
    <BalanceGroup heading='in a pool'>
      <div data-preload={LP_PRELOAD}>
        <BalanceRow
          tile={
            <span className='grid size-[30px] shrink-0 place-items-center border border-zigner-gold/40'>
              <LpWave />
            </span>
          }
          label='zec liquidity'
          tag={
            <span className='flex items-center gap-1.5 whitespace-nowrap text-[11px] text-fg-muted'>
              thorchain ·{' '}
              {moving
                ? moving.error
                  ? 'needs you'
                  : moving.stage === 'refunded'
                    ? 'sent back'
                    : moving.kind === 'add'
                      ? 'adding'
                      : 'taking out'
                : readAgo(Date.now() - rec!.cache!.readAt)}
              <span className='i-lucide-eye size-[11px] text-warn' aria-hidden='true' />
            </span>
          }
          amount={rec?.cache ? zecText(BigInt(rec.cache.zat)) : zecText(BigInt(moving!.amountZat))}
          note={
            rec?.cache && (
              <span className='text-[11px] text-fg-muted'>
                <Sensitive>{rec.cache.sharePct.toFixed(2)}%</Sensitive> of the pool
              </span>
            )
          }
          onPress={openLpPage}
          action={
            <span className='i-lucide-arrow-up-right size-3.5 text-fg-muted' aria-hidden='true' />
          }
        />
      </div>
    </BalanceGroup>
  );
};
