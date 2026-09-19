/**
 * Import review step - one read-only look at the recovery phrase before the
 * wallet is sealed.
 *
 * The entry screen lets you type or paste into an editable grid, which is
 * exactly where an off-by-one paste or a mistyped word hides. This screen
 * reflects the phrase back as static numbered words so the user confirms what
 * will actually be imported, then continues to the birthday step. Cheap
 * insurance against importing the wrong wallet.
 */

import { useEffect, useState } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { useStore } from '../../../state';
import { importSelector } from '../../../state/seed-phrase/import';
import { usePageNav } from '../../../utils/navigate';
import { PagePath } from '../paths';
import { navigateToPasswordPage } from './password/utils';
import { SEED_PHRASE_ORIGIN } from './password/types';
import { PENDING_IMPORT_NETWORKS_KEY } from './constants';

type ImportNet = 'zcash' | 'penumbra';

export const ImportReview = () => {
  const navigate = usePageNav();
  const { phrase, phraseIsValid } = useStore(importSelector);

  // Which networks this phrase is being recovered onto. Both derive from the
  // same seed, so both default on - but the user recovering only a Penumbra (or
  // only a Zcash) wallet shouldn't be forced through the other network's setup
  // (the zcash birthday, most visibly). At least one must stay selected.
  const [nets, setNets] = useState<Record<ImportNet, boolean>>({ zcash: true, penumbra: true });
  const anySelected = nets.zcash || nets.penumbra;
  const toggleNet = (n: ImportNet) => setNets(s => ({ ...s, [n]: !s[n] }));

  const onContinue = () => {
    const selected = (['zcash', 'penumbra'] as const).filter(n => nets[n]);
    sessionStorage.setItem(PENDING_IMPORT_NETWORKS_KEY, selected.join(','));
    // the zcash birthday step is only relevant when recovering zcash; skip
    // straight to the password otherwise.
    if (nets.zcash) {
      navigate(PagePath.IMPORT_BIRTHDAY);
    } else {
      navigateToPasswordPage(navigate, SEED_PHRASE_ORIGIN.IMPORTED);
    }
  };

  const valid = phrase.length > 0 && phrase.every(w => w.length > 0) && phraseIsValid();

  // Guard direct-URL entry: nothing valid to review means back to entry.
  useEffect(() => {
    if (!valid) {
      navigate(PagePath.IMPORT_SEED_PHRASE);
    }
  }, [valid, navigate]);

  if (!valid) {
    return null;
  }

  return (
    <FadeTransition>
      <div className='flex h-full flex-col gap-6'>
        <header className='flex flex-col gap-1'>
          <button
            type='button'
            onClick={() => navigate(PagePath.IMPORT_SEED_PHRASE)}
            className='mb-2 inline-flex items-center gap-1.5 self-start text-body text-fg-muted transition-colors hover:text-fg-high lowercase'
          >
            <span className='i-ph-arrow-left h-3 w-3' />
            back
          </button>
          <h2 className='text-2xl lowercase tracking-[-0.01em] text-fg-high'>
            review your recovery phrase
          </h2>
          <p className='text-xs text-fg-muted lowercase'>
            confirm these are the right words, in the right order, before import.
          </p>
        </header>

        <ol className='grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3'>
          {phrase.map((word, i) => (
            <li
              key={i}
              className='flex items-baseline gap-2 border border-border-soft/40 bg-canvas/60 px-2.5 py-1.5 [border-radius:8px]'
            >
              <span className='w-5 shrink-0 text-right text-label tabular text-fg-dim'>{i + 1}</span>
              <span className='text-data text-fg-high'>{word}</span>
            </li>
          ))}
        </ol>

        <div className='flex flex-col gap-2'>
          <span className='text-xs text-fg-muted lowercase'>recover on</span>
          <div className='flex gap-2'>
            {(['zcash', 'penumbra'] as const).map(n => (
              <button
                key={n}
                type='button'
                onClick={() => toggleNet(n)}
                aria-pressed={nets[n]}
                className={cn(
                  'flex flex-1 items-center justify-center gap-2 px-3 py-2 text-sm lowercase',
                  '[border-radius:10px] border transition-colors',
                  nets[n]
                    ? 'border-zigner-gold/40 bg-zigner-gold/10 text-fg-high'
                    : 'border-border-soft text-fg-muted hover:text-fg-high',
                )}
              >
                <span
                  className={cn(
                    'inline-block size-2 rounded-full',
                    nets[n] ? 'bg-zigner-gold' : 'border border-fg-dim',
                  )}
                />
                {n}
              </button>
            ))}
          </div>
          <p className='text-label text-fg-dim lowercase leading-snug'>
            same phrase, one wallet - pick which networks to set up now. you can enable the other
            later in settings.
          </p>
        </div>

        <div className='mt-auto flex flex-col gap-3 pt-4'>
          <button
            type='button'
            disabled={!anySelected}
            onClick={onContinue}
            className={cn(
              'group inline-flex items-center justify-center gap-2 px-5 py-3 text-sm lowercase',
              '[border-radius:14px] border transition-[transform,opacity,background-color] duration-200',
              anySelected
                ? 'border-zigner-gold/30 bg-zigner-gold/10 text-zigner-gold hover:-translate-y-[1px] hover:bg-zigner-gold/15'
                : 'cursor-not-allowed border-border-soft/60 bg-elev-2/30 text-fg-muted',
            )}
          >
            looks right, continue
            {anySelected && (
              <span className='i-ph-arrow-right h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5' />
            )}
          </button>
          <button
            type='button'
            onClick={() => navigate(PagePath.IMPORT_SEED_PHRASE)}
            className='self-center text-label text-fg-muted hover:text-fg-high transition-colors lowercase'
          >
            go back and edit
          </button>
        </div>
      </div>
    </FadeTransition>
  );
};
