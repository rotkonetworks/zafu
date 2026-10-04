import type { ReactNode } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { Sensitive } from '../sensitive';
import { useStore } from '../../state';
import { useOnline } from '../../hooks/use-online';

/**
 * What the hero figure is allowed to claim: loading - not read yet; error -
 * the read failed, nothing to fall back on; unknown - zero while still
 * scanning ("nothing found YET"); partial - positive while scanning (a
 * floor); ready - read to the tip; held - still the pocket switched away
 * from, dimmed until this one's figure lands (never shown as current).
 */
export type BalanceView = 'loading' | 'error' | 'unknown' | 'partial' | 'ready' | 'held';

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
          aria-busy={view === 'held'}
          className={cn(
            'min-w-0 truncate font-display text-[44px] leading-none tracking-[-0.01em] text-fg-high',
            view === 'partial' && 'animate-pulse',
            view === 'held' && 'opacity-40',
          )}
        >
          <Sensitive>{amount}</Sensitive>
        </span>
        {/* dollars read as "$12.40"; a token's own unit sits beside the figure */}
        {unit !== 'usd' && <span className='shrink-0 text-lg text-network-accent'>{unit}</span>}
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
 * hide-balances eye, the Mincho figure with its accent unit, a faint
 * watermark behind, and the screen's actions as children.
 */
export const BalanceHero = ({
  view,
  amount,
  unit,
  label = 'balance',
  eye = true,
  note,
  watermark,
  children,
}: {
  label?: string;
  /** the hide-balances eye */
  eye?: boolean;
  /** one quiet line under the figure (penumbra's "3 assets · shielded") */
  note?: string;
  view: BalanceView;
  amount: string;
  unit: string;
  /** an icon class (i-zafu-*), painted in the network accent; omit for none */
  watermark?: string;
  children?: ReactNode;
}) => (
  // isolate + -z-10: the watermark sits behind the figure and the buttons
  <section className='relative isolate flex flex-col gap-[18px]'>
    {watermark && (
      <span
        aria-hidden='true'
        className={cn(
          watermark,
          'pointer-events-none absolute -right-[54px] -top-[46px] -z-10 size-[210px] text-network-accent opacity-[0.09]',
        )}
      />
    )}
    <div className='flex flex-col gap-1.5'>
      <div className='flex h-5 items-center gap-1.5'>
        <span className='text-xs tracking-[0.04em] text-fg-muted'>{label}</span>
        {eye && (view === 'ready' || view === 'partial' || view === 'held') && <HideToggle />}
      </div>
      <BalanceFigure view={view} amount={amount} unit={unit} />
      {note && view !== 'loading' && view !== 'error' && (
        <span className='text-[13px] text-fg-muted'>{note}</span>
      )}
      {view !== 'loading' && <LastKnown />}
    </div>
    {children}
  </section>
);
