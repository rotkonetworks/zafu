/**
 * Seed-phrase generation + backup step.
 *
 * This screen previously auto-redirected the moment the phrase was
 * derived — the user finished onboarding without ever seeing their 24
 * words. For a self-custody wallet that's a loss-of-funds footgun:
 * device dies before the user finds settings → recovery passphrase,
 * and the wallet is unrecoverable.
 *
 * Now the step does what the stepper label ("secret phrase") promises:
 *   1. derive (skeleton for the <100ms WASM window)
 *   2. display the numbered 24-word grid
 *   3. require an explicit "I wrote it down" confirmation
 *   4. only then continue to network selection
 */

import { SeedPhraseLength } from '../../../state/seed-phrase/mnemonic';
import { useEffect, useState } from 'react';
import { useStore } from '../../../state';
import { generateSelector } from '../../../state/seed-phrase/generate';
import { usePageNav } from '../../../utils/navigate';
import { SEED_PHRASE_ORIGIN } from './password/types';
import { navigateToNetworkSelection } from './password/utils';
import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { localExtStorage } from '@repo/storage-chrome/local';
import { cn } from '@repo/ui/lib/utils';

export const GenerateSeedPhrase = () => {
  const navigate = usePageNav();
  const { phrase, generateRandomSeedPhrase } = useStore(generateSelector);
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);

  // On render, asynchronously generate a new seed phrase
  // Use 24 words for better entropy and zcash compatibility
  useEffect(() => {
    if (!phrase.length) {
      generateRandomSeedPhrase(SeedPhraseLength.TWENTY_FOUR_WORDS);
    }
  }, [generateRandomSeedPhrase, phrase.length]);

  const ready = phrase.length === Number(SeedPhraseLength.TWENTY_FOUR_WORDS);

  const copyPhrase = () => {
    void navigator.clipboard.writeText(phrase.join(' '));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <FadeTransition>
      <div className='flex h-full flex-col gap-5'>
        <header className='flex flex-col gap-1'>
          <h2 className='text-2xl lowercase tracking-[-0.01em] text-fg-high'>
            your recovery phrase
          </h2>
          <p className='text-xs text-fg-muted lowercase'>
            24 words, derived locally — no server ever sees this. write them down in order and store
            them offline.
          </p>
        </header>

        {!ready ? (
          /* skeleton while WASM derives — CSS pulse only */
          <div className='grid animate-pulse grid-cols-3 gap-2'>
            {Array.from({ length: 24 }).map((_, i) => (
              <div key={i} className='h-8 rounded-sm bg-elev-2/40' />
            ))}
          </div>
        ) : (
          <>
            <ol className='grid select-all grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3'>
              {phrase.map((word, i) => (
                <li
                  key={i}
                  className='flex items-baseline gap-2 border border-border-soft/40 bg-canvas/60 px-2.5 py-1.5 [border-radius:8px]'
                >
                  <span className='w-5 shrink-0 text-right text-label tabular text-fg-dim'>
                    {i + 1}
                  </span>
                  <span className='text-data text-fg-high'>{word}</span>
                </li>
              ))}
            </ol>

            <div className='flex items-center gap-4'>
              <button
                type='button'
                onClick={copyPhrase}
                className='inline-flex items-center gap-1.5 text-label text-fg-muted lowercase transition-colors hover:text-fg-high'
              >
                <span className={cn(copied ? 'i-ph-check' : 'i-ph-copy', 'h-3.5 w-3.5')} />
                {copied ? 'copied' : 'copy to clipboard'}
              </button>
              <span className='flex items-center gap-1.5 text-label text-rust lowercase'>
                <span className='i-ph-warning h-3.5 w-3.5' />
                never share these words with anyone
              </span>
            </div>

            <div className='mt-auto flex flex-col gap-3 pt-4'>
              <label className='flex cursor-pointer items-center gap-2.5 text-sm text-fg lowercase'>
                <input
                  type='checkbox'
                  checked={confirmed}
                  onChange={e => setConfirmed(e.target.checked)}
                  className='h-4 w-4 accent-[var(--zigner-gold)]'
                />
                I wrote down all 24 words in order
              </label>
              <button
                type='button'
                disabled={!confirmed}
                onClick={() => {
                  void localExtStorage.set('seedPhraseBackedUp', true);
                  navigateToNetworkSelection(navigate, SEED_PHRASE_ORIGIN.NEWLY_GENERATED);
                }}
                className={cn(
                  'inline-flex items-center justify-center gap-2 px-6 py-3 text-sm lowercase',
                  '[border-radius:14px] border transition-[transform,background-color,opacity] duration-200',
                  confirmed
                    ? 'border-zigner-gold/30 bg-zigner-gold/10 text-zigner-gold hover:-translate-y-[1px] hover:bg-zigner-gold/15'
                    : 'cursor-not-allowed border-border-soft/60 bg-elev-2/40 text-fg-dim opacity-60',
                )}
              >
                continue
                <span className='i-ph-arrow-right h-4 w-4' />
              </button>
            </div>
          </>
        )}
      </div>
    </FadeTransition>
  );
};
