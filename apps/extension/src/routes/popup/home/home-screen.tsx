import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { PEER_REFERRAL_CODE, PEER_REFERRAL_URL } from '../../../config/ramps';
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
        <HomeActions spendable={spendable} icons={look.actionIcons} />
      </BalanceHero>
      {children}
    </div>
  </div>
);

/** the first-funds box, in place of the balance rows */
export const EmptyBox = ({ look }: { look: HomeLook }) => {
  const navigate = useNavigate();
  const [buying, setBuying] = useState(false);
  return (
    <section className='flex flex-1 flex-col items-center justify-center gap-3.5 border border-dashed border-surface-border py-10'>
      <span className='font-display text-xl text-fg-high'>{look.empty}</span>
      <div className='flex gap-2'>
        <Button className='h-10 px-[18px] text-[13px]' onClick={() => navigate(PopupPath.RECEIVE)}>
          {look.receive}
        </Button>
        {look.swapInto && (
          <Button
            variant='secondary'
            className='h-10 px-[18px] text-[13px]'
            onClick={() => navigate(PopupPath.SWAP)}
          >
            {look.swapInto}
          </Button>
        )}
      </div>
      {look.buy && (
        <button
          type='button'
          onClick={() => setBuying(true)}
          className='text-xs text-fg-muted underline-offset-4 hover:text-fg-high hover:underline'
        >
          {look.buy}
        </button>
      )}
      {look.buy && (
        <Sheet open={buying} onOpenChange={setBuying} title={look.buy}>
          <ol className='flex flex-col gap-3'>
            <li className='flex flex-col gap-2 border border-border-soft bg-elev-1 p-3'>
              <span className='text-sm text-fg-high'>1 · buy usdc on peer</span>
              <span className='text-xs text-fg-muted'>
                pay a seller in an app you already use, such as revolut, wise or venmo. referral
                code {PEER_REFERRAL_CODE}.
              </span>
              <Button
                variant='secondary'
                className='h-10 text-[13px]'
                onClick={() => window.open(PEER_REFERRAL_URL, '_blank', 'noopener')}
              >
                open peer
              </Button>
            </li>
            <li className='flex flex-col gap-2 border border-border-soft bg-elev-1 p-3'>
              <span className='text-sm text-fg-high'>2 · swap it into zec</span>
              <Button className='h-10 text-[13px]' onClick={() => navigate(PopupPath.SWAP)}>
                {look.swapInto ?? 'swap'}
              </Button>
            </li>
          </ol>
          <span className='text-[11px] text-fg-dim'>
            peer is an outside service, not run by zafu. please look it over before you send money.
          </span>
        </Sheet>
      )}
    </section>
  );
};
