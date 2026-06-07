/**
 * Seed-phrase generation is a redirect step — the WASM derivation
 * usually completes in <100ms and the user gets routed to set-password.
 * Without a loading state the screen flashes blank, which feels like
 * the wallet stalled. Adds a small inline skeleton inside the shell
 * vocabulary so the user always has something coherent on screen, even
 * on slower devices.
 */

import { SeedPhraseLength } from '../../../state/seed-phrase/mnemonic';
import { useEffect } from 'react';
import { useStore } from '../../../state';
import { generateSelector } from '../../../state/seed-phrase/generate';
import { usePageNav } from '../../../utils/navigate';
import { SEED_PHRASE_ORIGIN } from './password/types';
import { navigateToNetworkSelection } from './password/utils';
import { FadeTransition } from '@repo/ui/components/ui/fade-transition';

export const GenerateSeedPhrase = () => {
  const navigate = usePageNav();
  const { phrase, generateRandomSeedPhrase } = useStore(generateSelector);

  // On render, asynchronously generate a new seed phrase
  // Use 24 words for better entropy and zcash compatibility
  useEffect(() => {
    if (!phrase.length) {
      generateRandomSeedPhrase(SeedPhraseLength.TWENTY_FOUR_WORDS);
    }
  }, [generateRandomSeedPhrase, phrase.length]);

  useEffect(() => {
    if (phrase.length === Number(SeedPhraseLength.TWENTY_FOUR_WORDS)) {
      navigateToNetworkSelection(navigate, SEED_PHRASE_ORIGIN.NEWLY_GENERATED);
    }
  }, [phrase.length, navigate]);

  return (
    <FadeTransition>
      <div className='flex h-full flex-col gap-6'>
        <header className='flex flex-col gap-1'>
          <h2 className='text-2xl lowercase tracking-[-0.01em] text-fg-high'>
            generating your recovery phrase
          </h2>
          <p className='text-xs text-fg-muted lowercase tracking-[0.02em]'>
            24 random words. derived locally — no server ever sees this.
          </p>
        </header>

        {/* skeleton placeholder while WASM derives the phrase. CSS pulse
            only, no JS animation cost. Disappears the moment the redirect
            useEffect fires (typically under 100 ms). */}
        <div className='grid animate-pulse grid-cols-3 gap-2'>
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className='h-8 rounded-sm bg-elev-2/40' />
          ))}
        </div>

        <p className='mt-auto text-[10px] text-fg-muted lowercase tracking-[0.02em]'>
          this usually completes in under a second.
        </p>
      </div>
    </FadeTransition>
  );
};
