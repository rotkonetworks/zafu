/** the buy page's small shared pieces: its store hook, its clock, its column */

import type { ReactNode } from 'react';
import { useStore } from 'zustand';
import { buyStore, type BuyState } from './store';

export const useBuy = <T,>(sel: (s: BuyState) => T): T => useStore(buyStore, sel);

export { useNow } from '../../hooks/use-now';

export const Column = ({
  title,
  sub,
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
}) => (
  <div className='flex flex-col gap-5'>
    <div className='flex flex-col gap-2'>
      <h1 className='font-display text-[38px] leading-[1.15] text-fg-high'>{title}</h1>
      {sub && <p className='text-[13px] leading-relaxed text-fg-muted'>{sub}</p>}
    </div>
    {children}
  </div>
);
