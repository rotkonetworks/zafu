/** Welcome and "bring your wallet" - the Onb1Welcome and Onb6Choose boards. */

import { Button } from '@repo/ui/components/ui/button';
import { usePageNav } from '../../../utils/navigate';
import { PagePath } from '../paths';
import { HARDWARE_WALLET_ENABLED, LEDGER_TRANSPARENT_ENABLED } from '../../../config/feature-flags';

const BRING = [
  {
    icon: 'i-zafu-hi text-zigner-gold',
    label: 'recovery phrase',
    hint: '12 or 24 words from any zcash wallet',
    to: PagePath.IMPORT_SEED_PHRASE,
    shown: true,
  },
  {
    icon: 'i-zafu-kori text-device-blue',
    label: 'zigner or keystone',
    hint: 'scan its connect code',
    to: PagePath.IMPORT_ZIGNER,
    shown: true,
  },
  {
    icon: 'i-ph-usb text-device-blue',
    label: 'ledger',
    hint: 'plug in over usb',
    to: PagePath.CONNECT_LEDGER,
    shown: HARDWARE_WALLET_ENABLED || LEDGER_TRANSPARENT_ENABLED,
  },
  {
    icon: 'i-lucide-eye text-fg-muted',
    label: 'viewing key',
    hint: 'watch only',
    to: PagePath.IMPORT_VIEWING_KEY,
    shown: true,
  },
].filter(o => o.shown);

export const OnboardingStart = () => {
  const navigate = usePageNav();
  return (
    <div className='flex flex-col gap-[22px]'>
      <span className='text-label tracking-[0.18em] text-fg-muted'>zafu wallet</span>
      <h1 className='font-display text-[50px] leading-[1.15] text-fg-high'>
        held in your
        <br />
        own hands, seen
        <br />
        by no one.
      </h1>
      <p className='text-body text-fg-muted'>zcash and penumbra · private by default</p>
      <div className='mt-[18px] flex flex-col gap-3'>
        <Button
          autoFocus
          className='h-14 w-full text-[15px]'
          onClick={() => navigate(PagePath.CREATE_PASSWORD)}
        >
          create a wallet
        </Button>
        <Button
          variant='secondary'
          className='h-14 w-full text-[15px]'
          onClick={() => navigate(PagePath.CHOOSE)}
        >
          i already have a wallet
        </Button>
      </div>
      <span className='mt-[22px] text-label text-fg-dim'>
        open source · your keys never leave this computer
      </span>
    </div>
  );
};

export const OnboardingChoose = () => {
  const navigate = usePageNav();
  return (
    <div className='flex flex-col gap-[22px]'>
      <h1 className='font-display text-[38px] text-fg-high'>bring your wallet</h1>
      <div className='flex flex-col gap-2.5'>
        {BRING.map((o, i) => (
          <button
            key={o.to}
            type='button'
            autoFocus={i === 0}
            onClick={() => navigate(o.to)}
            className='flex h-[72px] items-center gap-4 border border-border-soft bg-elev-1 px-5 text-left transition-colors hover:border-border-hard hover:bg-elev-2 focus-visible:border-zigner-gold focus-visible:outline-none'
          >
            <span className={o.icon + ' size-[22px] shrink-0'} aria-hidden='true' />
            <span className='flex flex-col gap-1'>
              <span className='text-[15px] text-fg-high'>{o.label}</span>
              <span className='text-label text-fg-muted'>{o.hint}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};
