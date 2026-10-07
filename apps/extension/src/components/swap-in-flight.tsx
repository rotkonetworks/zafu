/**
 * Swaps in flight, on the home's in-flight slot: each from its sealed record,
 * the pay window's real clock, and a tap back into the swap screen where it
 * stood. The swap screen does the watching; a thorchain swap out of zec whose
 * legs were running when the popup closed picks them up again here.
 */

import { useEffect, useState } from 'react';
import { useStore as useZustand } from 'zustand';
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
import { legContextOf, resumeSwapLegs } from '../state/swap/thor-legs';
import { runs } from '../state/swap/thor-out';
import { usePopupNav } from '../utils/navigate';
import { PopupPath } from '../routes/popup/paths';

export const SwapInFlight = () => {
  const wallet = useStore(swapWallet);
  const navigate = usePopupNav();
  const [swaps, setSwaps] = useState<OpenSwap[]>([]);
  const [now, setNow] = useState(Date.now);
  // a run waiting for the person: an unlock, or a zigner round no screen is showing
  const cold = useStore(s => legContextOf(s)?.cold);
  const waiting = useZustand(runs, r =>
    Object.keys(r)
      .filter(id => r[id]!.at === 'held' || (cold && /moving|paying/.test(r[id]!.at)))
      .join(),
  );
  useEffect(() => {
    const read = () => void readOpenSwaps().then(setSwaps);
    read();
    return onOpenSwapsChange(read);
  }, []);
  const mine = swaps.filter(s => s.wallet === wallet && !isStale(s, now));
  useEffect(() => {
    for (const s of mine) {
      resumeSwapLegs(s, useStore.getState());
    }
  }, [mine.map(s => s.id + s.stage).join()]);
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
        const line = waiting.split(',').includes(s.id)
          ? {
              ...swapCardLines(s, now),
              status: cold
                ? 'zigner waits for you · tap to carry on'
                : 'waiting for you · tap to carry on',
            }
          : swapCardLines(s, now);
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
