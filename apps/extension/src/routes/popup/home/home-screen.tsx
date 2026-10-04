import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { BUY_PRELOAD, openBuyPage } from '../../../buy/open';
import { PAY_APPS } from '../../../buy/apps';
import { BalanceHero, type BalanceView } from '../../../components/wallet/balance-hero';
import { PopupPath } from '../paths';
import { HomeActions } from './actions';
import type { HomeLook } from './look';

/**
 * One home for every shielded network (boards Main, HomeSync, HomePenumbra):
 * the sync strip, the hero with the action row, then the network's own
 * sections. What differs per network is data in {@link HomeLook}; how a
 * network reads its state lives in its own module.
 */
export const HomeScreen = ({
  look,
  strip,
  view,
  amount,
  unit = look.unit,
  note,
  spendable,
  watermark,
  children,
}: {
  look: HomeLook;
  strip?: ReactNode;
  view: BalanceView;
  amount: string;
  /** when the figure is not in the network's own unit (penumbra's dollars) */
  unit?: string;
  note?: string;
  spendable: boolean;
  watermark: boolean;
  children: ReactNode;
}) => (
  <div className='flex min-h-full flex-col overflow-x-hidden'>
    {strip}
    <div className='flex flex-1 flex-col gap-6 px-4 pb-4 pt-6'>
      <BalanceHero
        view={view}
        amount={amount}
        unit={unit}
        label={look.label}
        eye={look.eye}
        note={note}
        watermark={watermark ? look.watermark : undefined}
      >
        <HomeActions spendable={spendable} icons={look.actionIcons} buy={!!look.buy} />
      </BalanceHero>
      {children}
    </div>
  </div>
);

/** the first-funds box, in place of the balance rows: buying with cash first, where it exists */
export const EmptyBox = ({ look }: { look: HomeLook }) => {
  const navigate = useNavigate();
  return (
    <section className='flex flex-1 flex-col items-center justify-center gap-3.5 border border-dashed border-surface-border py-10'>
      <span className='font-display text-xl text-fg-high'>{look.empty}</span>
      {look.buy && (
        <button
          type='button'
          data-preload={BUY_PRELOAD}
          onClick={openBuyPage}
          className='flex w-[85%] flex-col gap-2.5 border border-zigner-gold/40 bg-elev-1 px-4 py-3.5 text-left transition-colors hover:bg-elev-2'
        >
          <span className='flex items-center justify-between text-sm text-fg-high'>
            {look.buy} with cash
            <span
              className='i-lucide-arrow-up-right size-3.5 text-zigner-gold'
              aria-hidden='true'
            />
          </span>
          <span className='flex flex-wrap gap-1.5'>
            {PAY_APPS.filter(a => !a.off).map(a => (
              <span
                key={a.id}
                className='border border-border-soft px-2 py-0.5 text-[11px] text-fg-muted'
              >
                {a.name}
              </span>
            ))}
          </span>
        </button>
      )}
      <div className='flex gap-2'>
        <Button
          className='h-10 px-[18px] text-[13px]'
          data-preload={PopupPath.RECEIVE}
          onClick={() => navigate(PopupPath.RECEIVE)}
        >
          {look.receive}
        </Button>
        {look.swapInto && (
          <Button
            variant='secondary'
            className='h-10 px-[18px] text-[13px]'
            data-preload={PopupPath.SWAP}
            onClick={() => navigate(PopupPath.SWAP)}
          >
            {look.swapInto}
          </Button>
        )}
      </div>
    </section>
  );
};
