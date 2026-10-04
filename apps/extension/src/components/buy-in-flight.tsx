/**
 * The open buy, on the home's in-flight slot: its stage from the sealed
 * record alone (no network from the popup), the pay window's real clock, and
 * a tap back into the buy page where it left off.
 */

import { useEffect, useState } from 'react';
import { PendingLine } from './in-flight-card';
import { cardLines, type OpenBuy } from '../buy/machine';
import { onOpenBuyChange, readOpenBuy } from '../buy/store';
import { BUY_PRELOAD, openBuyPage } from '../buy/open';

export const BuyInFlight = () => {
  const [buy, setBuy] = useState<OpenBuy | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const read = () => void readOpenBuy().then(setBuy);
    read();
    return onOpenBuyChange(read);
  }, []);
  const ticking = buy?.stage === 'pay';
  useEffect(() => {
    if (!ticking) {
      return;
    }
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);
  // a finished buy was shown on its own page
  if (!buy || buy.stage === 'done') {
    return null;
  }
  const line = cardLines(buy, now);
  return (
    <button type='button' data-preload={BUY_PRELOAD} onClick={openBuyPage} className='text-left'>
      <PendingLine tone={line.tone} icon='i-zafu-enso' title={line.title} status={line.status} />
    </button>
  );
};
