/**
 * Import review step - one read-only look at the recovery phrase before the
 * wallet is sealed. No canvas board of its own (the flow in Onb7Paste jumps
 * straight from paste to the birthday step) but kept as its own screen: the
 * paste screen is editable, exactly where an off-by-one paste hides, so this
 * still reflects the phrase back as static numbered words before continuing.
 *
 * The network checkbox pair (zcash/penumbra) is removed: imports are zcash
 * only now, same as fresh wallets - no network-select screen anywhere in
 * onboarding. Penumbra is a settings > networks toggle once the wallet
 * exists. Reported: an import can no longer land straight on a penumbra-only
 * recovery from this screen; it always sets up zcash first.
 *
 * Carries the POOL NOTICE - zafu is orchard + ironwood only, but a recovery
 * phrase is pool-agnostic (see the longer note this used to carry).
 */

import { useEffect } from 'react';
import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { Button } from '@repo/ui/components/ui/button';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { useStore } from '../../../state';
import { importSelector } from '../../../state/seed-phrase/import';
import { usePageNav } from '../../../utils/navigate';
import { PagePath } from '../paths';
import { OnboardingBack, OnboardingShell } from './onboarding-shell';

export const ImportReview = () => {
  const navigate = usePageNav();
  const { phrase, phraseIsValid } = useStore(importSelector);
  const valid = phrase.length > 0 && phrase.every(w => w.length > 0) && phraseIsValid();

  useEffect(() => {
    if (!valid) {
      navigate(PagePath.IMPORT_SEED_PHRASE);
    }
  }, [valid, navigate]);

  if (!valid) {
    return null;
  }

  return (
    <OnboardingShell art='bamboo'>
      <FadeTransition>
        <div className='flex flex-col gap-5'>
          <OnboardingBack onClick={() => navigate(PagePath.IMPORT_SEED_PHRASE)} />
          <h1 className='font-display text-[38px] text-fg-high'>review your phrase</h1>
          <p className='text-body text-fg-muted lowercase'>
            confirm these are the right words, in the right order.
          </p>

          <ol className='grid grid-cols-3 gap-x-4 gap-y-1.5 border border-border-soft bg-elev-1 p-3.5'>
            {phrase.map((word, i) => (
              <li key={i} className='flex items-baseline gap-2'>
                <span className='w-5 shrink-0 text-right text-label text-fg-dim'>{i + 1}</span>
                <span className='text-data text-fg-high'>{word}</span>
              </li>
            ))}
          </ol>

          <StatusSlot tone='gold' icon='i-ph-info'>
            zafu holds orchard and ironwood. if this phrase also has sapling funds from another
            wallet, they will not show up here and cannot be spent from zafu - they stay on-chain
            and untouched, zafu simply cannot see them.
          </StatusSlot>

          <Button
            variant='primary'
            className='h-14 w-full text-body'
            onClick={() => navigate(PagePath.IMPORT_BIRTHDAY)}
          >
            looks right, continue
          </Button>
        </div>
      </FadeTransition>
    </OnboardingShell>
  );
};
