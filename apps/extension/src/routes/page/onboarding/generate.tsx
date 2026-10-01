/**
 * Seed-phrase generation, reveal and 3-word check - Onb3Phrase/Onb4Check
 * boards. One route (GENERATE_SEED_PHRASE); `phrase`/`check` are local
 * phases, not sub-routes, so the step bar can't distinguish them - reported.
 *
 * - covered until "tap to reveal"; no copy button anywhere on this screen.
 * - "i wrote it down" only enables once revealed.
 * - the 3-word tap check is new but small: three of the words are asked
 *   back one at a time from a fixed 9-word pool (3 answers + 6 distractors).
 * - "back up later" skips the check and keeps the existing backup nudge
 *   (seedPhraseBackedUp is only set once the check actually passes).
 */

import { useEffect, useMemo, useState } from 'react';
import { SeedPhraseLength, generateValidationFields } from '../../../state/seed-phrase/mnemonic';
import { useStore } from '../../../state';
import { generateSelector } from '../../../state/seed-phrase/generate';
import { usePageNav } from '../../../utils/navigate';
import { SEED_PHRASE_ORIGIN } from './password/types';
import { navigateToPasswordPage } from './password/utils';
import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { Button } from '@repo/ui/components/ui/button';
import { localExtStorage } from '@repo/storage-chrome/local';
import { cn } from '@repo/ui/lib/utils';
import { OnboardingBack, OnboardingShell } from './onboarding-shell';

type Phase = 'phrase' | 'check';

export const GenerateSeedPhrase = () => {
  const navigate = usePageNav();
  const { phrase, generateRandomSeedPhrase } = useStore(generateSelector);
  const [phase, setPhase] = useState<Phase>('phrase');
  const [revealed, setRevealed] = useState(false);
  const [checkIndex, setCheckIndex] = useState(0);
  const [wrong, setWrong] = useState(false);

  useEffect(() => {
    if (!phrase.length) {
      generateRandomSeedPhrase(SeedPhraseLength.TWENTY_FOUR_WORDS);
    }
  }, [generateRandomSeedPhrase, phrase.length]);

  const ready = phrase.length === Number(SeedPhraseLength.TWENTY_FOUR_WORDS);

  // three words to ask back, plus a fixed pool of distractors from the same
  // phrase - computed once the phrase is ready, not reshuffled on re-render.
  const asks = useMemo(() => (ready ? generateValidationFields(phrase, 3) : []), [ready, phrase]);
  const pool = useMemo(() => {
    if (!ready) {
      return [];
    }
    const answers = asks.map(a => a.word);
    const rest = phrase.filter(w => !answers.includes(w));
    const distractors = [...rest].sort(() => 0.5 - Math.random()).slice(0, 6);
    return [...answers, ...distractors].sort(() => 0.5 - Math.random());
  }, [ready, asks, phrase]);

  const toPassword = () => navigateToPasswordPage(navigate, SEED_PHRASE_ORIGIN.NEWLY_GENERATED);

  const pickWord = (word: string) => {
    const cur = asks[checkIndex];
    if (!cur) {
      return;
    }
    if (word !== cur.word) {
      setWrong(true);
      return;
    }
    setWrong(false);
    if (checkIndex >= 2) {
      void localExtStorage.set('seedPhraseBackedUp', true);
      toPassword();
      return;
    }
    setCheckIndex(i => i + 1);
  };

  if (phase === 'check') {
    const cur = asks[Math.min(checkIndex, 2)];
    return (
      <OnboardingShell art='enso'>
        <FadeTransition>
          <div className='flex flex-col gap-[22px]'>
            <OnboardingBack onClick={() => setPhase('phrase')} />
            <h1 className='font-display text-[38px] text-fg-high'>quick check</h1>
            <div className='flex items-baseline justify-between'>
              <span className='text-body text-fg-high'>
                tap word #{cur?.index != null ? cur.index + 1 : ''}
              </span>
              <span className='text-label text-fg-muted'>{checkIndex} of 3</span>
            </div>
            <div className='grid grid-cols-3 gap-2.5'>
              {pool.map(word => (
                <button
                  key={word}
                  type='button'
                  onClick={() => pickWord(word)}
                  className='h-14 border border-border-soft bg-elev-1 text-body text-fg-high transition-colors hover:bg-elev-2'
                >
                  {word}
                </button>
              ))}
            </div>
            <span className={cn('h-[18px] text-label', wrong ? 'text-warning' : 'text-fg-muted')}>
              {wrong
                ? "that one doesn't match · please check your paper once more"
                : 'from the words you wrote down'}
            </span>
          </div>
        </FadeTransition>
      </OnboardingShell>
    );
  }

  return (
    <OnboardingShell art='enso'>
      <FadeTransition>
        <div className='flex flex-col gap-5'>
          <h1 className='font-display text-[38px] text-fg-high'>your recovery phrase</h1>
          <p className='text-body text-fg-muted lowercase'>
            write the 24 words on paper, in order. they are the wallet.
          </p>

          {!ready ? (
            <div className='grid animate-pulse grid-cols-4 gap-2 border border-border-soft bg-elev-1 p-3.5'>
              {Array.from({ length: 24 }).map((_, i) => (
                <div key={i} className='h-[18px] bg-elev-2' />
              ))}
            </div>
          ) : (
            <div className='relative border border-border-soft bg-elev-1'>
              <div className='grid grid-cols-4 gap-0 p-3.5'>
                {phrase.map((word, i) => (
                  <span key={i} className='flex h-[34px] items-baseline gap-2 pt-2'>
                    <span className='w-[18px] text-right text-label text-fg-dim'>{i + 1}</span>
                    <span className='text-data text-fg-high'>{word}</span>
                  </span>
                ))}
              </div>
              {!revealed && (
                <button
                  type='button'
                  onClick={() => setRevealed(true)}
                  className='absolute inset-0 flex flex-col items-center justify-center gap-2.5 border-0 bg-elev-1 text-body text-fg-high'
                >
                  <span className='i-ph-eye size-[22px] text-zigner-gold' aria-hidden='true' />
                  tap to reveal
                  <span className='text-label text-fg-muted'>
                    make sure nobody can see your screen
                  </span>
                </button>
              )}
            </div>
          )}

          <Button
            variant={revealed ? 'primary' : 'secondary'}
            disabled={!revealed}
            className='h-14 w-full text-body'
            onClick={() => setPhase('check')}
          >
            i wrote it down
          </Button>
          <button
            type='button'
            onClick={toPassword}
            className='self-center bg-transparent text-label text-fg-muted transition-colors hover:text-fg-high lowercase'
          >
            back up later · zafu will remind you before you receive
          </button>
        </div>
      </FadeTransition>
    </OnboardingShell>
  );
};
