import { cn } from '@repo/ui/lib/utils';
import { Sensitive } from '../../../components/sensitive';
import { fmtZecHero } from './format';

/**
 * The hero balance figure, in the states it can honestly be in. A dash where a
 * number belongs reads as "gone", so loading and still-scanning show a
 * skeleton the size of the figure, and a failed read says so in words.
 * `partial` still shows the number, pulsing: a floor, not a total.
 */
export const BalanceFigure = ({
  view,
  zec,
}: {
  view: 'loading' | 'error' | 'unknown' | 'partial' | 'ready';
  zec: number;
}) => (
  <div className='flex h-11 min-w-0 items-baseline gap-2.5'>
    {view === 'loading' || view === 'unknown' ? (
      <span className='h-9 w-[170px] self-center bg-elev-2' aria-label='reading balance' />
    ) : view === 'error' ? (
      <span className='self-center text-xs text-hanko'>balance unavailable</span>
    ) : (
      <>
        <span
          className={cn(
            'min-w-0 truncate font-display text-[44px] leading-none tracking-[-0.01em] text-fg-high',
            view === 'partial' && 'animate-pulse',
          )}
        >
          <Sensitive>{fmtZecHero(zec)}</Sensitive>
        </span>
        <span className='shrink-0 text-lg text-network-accent'>zec</span>
      </>
    )}
  </div>
);
