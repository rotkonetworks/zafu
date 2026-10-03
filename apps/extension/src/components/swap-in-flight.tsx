/**
 * Swaps in flight, on the home's in-flight slot: each from its sealed record
 * alone (no network from home), the pay window's real clock, and a tap back
 * into the swap screen where it stood. The swap screen does the watching.
 */

import { useEffect, useState } from 'react';
import { PendingLine } from './in-flight-card';
import { useStore } from '../state';
import { swapWallet } from '../hooks/swap-preload';
import {
  isStale,
  onOpenSwapsChange,
  readOpenSwaps,
  swapCardLines,
  type OpenSwap,
} from '../state/swap/open-swaps';
import { usePopupNav } from '../utils/navigate';
import { PopupPath } from '../routes/popup/paths';

export const SwapInFlight = () => {
  const wallet = useStore(swapWallet);
  const navigate = usePopupNav();
  const [swaps, setSwaps] = useState<OpenSwap[]>([]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const read = () => void readOpenSwaps().then(setSwaps);
    read();
    return onOpenSwapsChange(read);
  }, []);
  const mine = swaps.filter(s => s.wallet === wallet && !isStale(s, now));
  const ticking = mine.some(s => s.stage === 'deposit' && s.direction === 'into_zec');
  useEffect(() => {
    if (!ticking) {
      return;
    }
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);
  return (
    <>
      {mine.map(s => {
        const line = swapCardLines(s, now);
        return (
          <button
            key={s.id}
            type='button'
            className='text-left'
            onClick={() => navigate(PopupPath.SWAP, { state: { resume: s.id } })}
          >
            <PendingLine
              tone={line.tone}
              icon='i-ph-shuffle'
              title={line.title}
              status={line.status}
            />
          </button>
        );
      })}
    </>
  );
};
