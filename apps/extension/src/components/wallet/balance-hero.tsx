import type { ReactNode } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { Sensitive } from '../sensitive';
import { useStore } from '../../state';
import { useOnline } from '../../hooks/use-online';

/**
 * What the hero figure is allowed to claim: loading - not read yet; error -
 * the read failed, nothing to fall back on; unknown - zero while still
 * scanning ("nothing found YET"); partial - positive while scanning (a
 * floor); ready - read to the tip.
 */
export type BalanceView = 'loading' | 'error' | 'unknown' | 'partial' | 'ready';

/** a dash where a number belongs reads as "gone", so not-yet is a skeleton */
const BalanceFigure = ({
  view,
  amount,
  unit,
}: {
  view: BalanceView;
  amount: string;
  unit: string;
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
          <Sensitive>{amount}</Sensitive>
        </span>
        <span className='shrink-0 text-lg text-network-accent'>{unit}</span>
      </>
    )}
  </div>
);

/** the global hide-balances control, the same state as settings > privacy */
const HideToggle = () => {
  const hidden = useStore(s => s.privacy.settings.hideBalances);
  const setSetting = useStore(s => s.privacy.setSetting);
  return (
    <button
      onClick={() => void setSetting('hideBalances', !hidden)}
      aria-label={hidden ? 'show balances' : 'hide balances'}
      className='grid size-5 place-items-center text-fg-muted hover:text-fg-high'
    >
      <span className={cn('size-3.5', hidden ? 'i-lucide-eye-off' : 'i-lucide-eye')} />
    </button>
  );
};

const LastKnown = () =>
  useOnline() ? null : (
    <span className='text-[11px] text-fg-dim'>last known · while you still had a connection</span>
  );

/**
 * The unboxed balance hero (boards Main, HomePenumbra): label and the
 * hide-balances eye, the Mincho figure with its accent unit, a quiet line
 * under it, a faint watermark behind, and the screen's actions as children.
 */
export const BalanceHero = ({
  view,
  amount,
  unit,
  sub,
  watermark,
  children,
}: {
  view: BalanceView;
  amount: string;
  unit: string;
  sub?: ReactNode;
  /** an icon class (i-zafu-*), painted in the network accent; omit for none */
  watermark?: string;
  children?: ReactNode;
}) => (
  <section className='relative flex flex-col gap-[18px]'>
    {watermark && (
      <span
        aria-hidden='true'
        className={cn(
          watermark,
          'pointer-events-none absolute -right-[54px] -top-[46px] size-[210px] text-network-accent opacity-[0.09]',
        )}
      />
    )}
    <div className='flex flex-col gap-1.5'>
      <div className='flex h-5 items-center gap-1.5'>
        <span className='text-xs tracking-[0.04em] text-fg-muted'>total balance</span>
        {(view === 'ready' || view === 'partial') && <HideToggle />}
      </div>
      <BalanceFigure view={view} amount={amount} unit={unit} />
      {sub && <span className='text-[13px] text-fg-muted'>{sub}</span>}
      {view !== 'loading' && <LastKnown />}
    </div>
    {children}
  </section>
);
