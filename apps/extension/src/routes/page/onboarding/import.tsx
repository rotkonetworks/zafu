/**
 * Import recovery-phrase screen — lives inside OnboardingShell.
 *
 * Removes the nested Card / brand lockup from the legacy version; the
 * shell already provides the rounded pane and stepper. What's left is
 * the actual decision surface: paste-friendly word grid, one CTA, one
 * back link.
 */

import { FormEvent, MouseEvent } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { useStore } from '../../../state';
import { importSelector } from '../../../state/seed-phrase/import';
import { usePageNav } from '../../../utils/navigate';
import { ImportForm } from '../../../shared/containers/import-form';
import { navigateToNetworkSelection } from './password/utils';
import { SEED_PHRASE_ORIGIN } from './password/types';
import { PagePath } from '../paths';

export const ImportSeedPhrase = () => {
  const navigate = usePageNav();
  const { phrase, phraseIsValid } = useStore(importSelector);

  const allFilled = phrase.length > 0 && phrase.every(w => w.length > 0);
  const valid = allFilled && phraseIsValid();

  const handleSubmit = (event: MouseEvent | FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    navigateToNetworkSelection(navigate, SEED_PHRASE_ORIGIN.IMPORTED);
  };

  const submitLabel = !allFilled
    ? 'fill in your phrase'
    : !phraseIsValid()
      ? 'phrase looks invalid'
      : 'continue';

  return (
    <FadeTransition>
      <div className='flex h-full flex-col gap-6'>
        <header className='flex flex-col gap-1'>
          <button
            type='button'
            onClick={() => navigate(PagePath.WELCOME)}
            className='mb-2 inline-flex items-center gap-1.5 self-start text-[11px] text-fg-muted transition-colors hover:text-fg-high lowercase tracking-[0.02em]'
          >
            <span className='i-lucide-arrow-left h-3 w-3' />
            back
          </button>
          <h2 className='text-2xl lowercase tracking-[-0.01em] text-fg-high'>
            enter your recovery phrase
          </h2>
          <p className='text-xs text-fg-muted lowercase tracking-[0.02em]'>
            12 or 24 words. paste the first box; the rest fill in.
          </p>
        </header>

        <form onSubmit={handleSubmit} className='flex flex-col gap-5'>
          <ImportForm />

          <button
            type='submit'
            disabled={!valid}
            onClick={handleSubmit}
            className={cn(
              'group relative flex items-center justify-center gap-2 self-stretch px-5 py-3 text-sm lowercase tracking-[0.01em]',
              '[border-radius:14px] border transition-[transform,opacity,background-color,border-color] duration-200',
              valid
                ? 'border-zigner-gold/30 bg-zigner-gold/10 text-zigner-gold hover:-translate-y-[1px] hover:bg-zigner-gold/15'
                : 'cursor-not-allowed border-border-soft/60 bg-elev-2/30 text-fg-muted',
            )}
          >
            {submitLabel}
            {valid && (
              <span className='i-lucide-arrow-right h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5' />
            )}
          </button>
        </form>
      </div>
    </FadeTransition>
  );
};
