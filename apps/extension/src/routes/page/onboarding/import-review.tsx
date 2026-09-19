/**
 * Import review step - one read-only look at the recovery phrase before the
 * wallet is sealed.
 *
 * The entry screen lets you type or paste into an editable grid, which is
 * exactly where an off-by-one paste or a mistyped word hides. This screen
 * reflects the phrase back as static numbered words so the user confirms what
 * will actually be imported, then continues to the birthday step. Cheap
 * insurance against importing the wrong wallet.
 *
 * It also carries the POOL NOTICE. zafu is orchard + ironwood only, but a
 * recovery phrase is pool-agnostic: the same ZIP-32 seed backs sapling and
 * transparent accounts too, and the librustzcash wallets people are importing
 * FROM (WebZjs / the MetaMask snap, Zashi, YWallet) derive a full
 * UnifiedSpendingKey and routinely hold sapling. Without this, such a user
 * imports, syncs, sees zero, and reasonably concludes the wallet they just
 * installed lost their money. One paragraph before the import removes that.
 *
 * Phrased as "zafu cannot see or spend them" rather than "move them with
 * another wallet first": post-NU6.3 orchard outputs are consensus-disabled and
 * the corresponding rule for sapling is not settled here, so any promise of an
 * escape route could become false at activation. That the funds sit untouched
 * on-chain is true either way.
 */

import { useEffect } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { useStore } from '../../../state';
import { importSelector } from '../../../state/seed-phrase/import';
import { usePageNav } from '../../../utils/navigate';
import { PagePath } from '../paths';

export const ImportReview = () => {
  const navigate = usePageNav();
  const { phrase, phraseIsValid } = useStore(importSelector);

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

        <div className='flex flex-col gap-2 rounded-lg border border-border-soft p-3.5'>
          <span className='inline-flex items-center gap-2 text-sm text-fg-high lowercase'>
            <span className='i-ph-info h-4 w-4 text-rust shrink-0' />
            zafu holds orchard and ironwood
          </span>
          <p className='text-xs text-fg-muted lowercase leading-snug'>
            if this phrase also has sapling funds from another wallet, they will not show up here
            and cannot be spent from zafu. they stay on-chain and untouched — zafu simply cannot
            see them.
          </p>
        </div>

        <div className='mt-auto flex flex-col gap-3 pt-4'>
          <button
            type='button'
            onClick={() => navigate(PagePath.IMPORT_BIRTHDAY)}
            className={cn(
              'group inline-flex items-center justify-center gap-2 px-5 py-3 text-sm lowercase',
              '[border-radius:14px] border transition-[transform,background-color] duration-200',
              'border-zigner-gold/30 bg-zigner-gold/10 text-zigner-gold hover:-translate-y-[1px] hover:bg-zigner-gold/15',
            )}
          >
            looks right, continue
            <span className='i-ph-arrow-right h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5' />
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
