/**
 * Welcome + "bring your wallet" choice - Onb1Welcome board, the `welcome`
 * and `choose` screens. Local phase state, not two routes: both live at
 * PagePath.WELCOME so a fresh tab always opens on the same first decision.
 */

import { useCallback, useState } from 'react';
import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { Button } from '@repo/ui/components/ui/button';
import { usePageNav } from '../../../utils/navigate';
import { PagePath } from '../paths';
import { HARDWARE_WALLET_ENABLED, LEDGER_TRANSPARENT_ENABLED } from '../../../config/feature-flags';
import { OnboardingBack, OnboardingShell } from './onboarding-shell';

type Phase = 'welcome' | 'choose';

interface BringOption {
  readonly icon: string;
  readonly label: string;
  readonly hint: string;
  readonly target: PagePath;
  readonly flagged?: boolean;
}

const BRING_OPTIONS: readonly BringOption[] = [
  {
    icon: 'i-ph-key',
    label: 'recovery phrase',
    hint: '12 or 24 words from any zcash wallet',
    target: PagePath.IMPORT_SEED_PHRASE,
  },
  {
    icon: 'i-ph-device-mobile',
    label: 'zigner or keystone',
    hint: 'scan its connect code',
    target: PagePath.IMPORT_ZIGNER,
  },
  {
    icon: 'i-ph-usb',
    label: 'ledger',
    hint: 'plug in over usb',
    target: PagePath.CONNECT_LEDGER,
    flagged: true,
  },
];

export const OnboardingStart = () => {
  const navigate = usePageNav();
  const [phase, setPhase] = useState<Phase>('welcome');
  const go = useCallback((p: PagePath) => () => navigate(p), [navigate]);

  const visibleOptions = BRING_OPTIONS.filter(
    opt => !opt.flagged || HARDWARE_WALLET_ENABLED || LEDGER_TRANSPARENT_ENABLED,
  );

  if (phase === 'choose') {
    return (
      <OnboardingShell art='bamboo'>
        <FadeTransition>
          <div className='flex flex-col gap-[22px]'>
            <OnboardingBack onClick={() => setPhase('welcome')} />
            <h1 className='font-display text-[38px] font-medium text-fg-high'>bring your wallet</h1>
            <div className='flex flex-col gap-2.5'>
              {visibleOptions.map(opt => (
                <button
                  key={opt.target}
                  type='button'
                  onClick={go(opt.target)}
                  className='row flex h-[72px] items-center gap-4 border border-surface-border-soft bg-surface-elev-1 px-5 text-left transition-colors hover:bg-surface-elev-2'
                >
                  <span className={opt.icon + ' size-[22px] shrink-0 text-zigner-gold'} aria-hidden='true' />
                  <span className='flex flex-col gap-1'>
                    <span className='text-data text-fg-high lowercase'>{opt.label}</span>
                    <span className='text-label text-fg-muted lowercase'>{opt.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </FadeTransition>
      </OnboardingShell>
    );
  }

  return (
    <OnboardingShell art='samurai'>
      <FadeTransition>
        <div className='flex flex-col gap-[22px]'>
          <span className='text-label text-fg-muted tracking-[0.18em] lowercase'>zafu wallet</span>
          <h1 className='font-display text-[50px] font-medium leading-[1.15] text-fg-high'>
            shielded money,
            <br />
            held in your
            <br />
            own hands.
          </h1>
          <p className='text-body text-fg-muted lowercase'>zcash and penumbra · private by default</p>
          <div className='mt-2 flex flex-col gap-3'>
            <Button
              variant='primary'
              className='h-14 w-full text-body'
              onClick={go(PagePath.GENERATE_SEED_PHRASE)}
            >
              create a wallet
            </Button>
            <Button
              variant='secondary'
              className='h-14 w-full text-body'
              onClick={() => setPhase('choose')}
            >
              i already have a wallet
            </Button>
          </div>
          <span className='mt-[22px] text-label text-fg-dim lowercase'>
            open source · your keys never leave this computer
          </span>
        </div>
      </FadeTransition>
    </OnboardingShell>
  );
};
