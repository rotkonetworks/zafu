/**
 * The new phrase and its 3-word check - Onb3Phrase and Onb4Check boards.
 * Covered until revealed, never copyable. The wallet is sealed once the
 * check passes, or straight away on "back up later" (the home nudge then
 * stays until the phrase is shown again).
 */

import { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { cn } from '@repo/ui/lib/utils';
import { Button } from '@repo/ui/components/ui/button';
import { localExtStorage } from '@repo/storage-chrome/local';
import { SeedPhraseLength } from '../../../state/seed-phrase/mnemonic';
import { useStore } from '../../../state';
import { usePageNav } from '../../../utils/navigate';
import { PagePath } from '../paths';
import { useOnboarding } from '.';
import { useFinalizeOnboarding } from './password/hooks';
import { SEED_PHRASE_ORIGIN } from './password/types';

const useSeal = () => {
  const { password } = useOnboarding();
  const { finalize, error, loading } = useFinalizeOnboarding();
  return {
    password,
    error,
    loading,
    seal: () => finalize(SEED_PHRASE_ORIGIN.NEWLY_GENERATED, password),
  };
};

export const GenerateSeedPhrase = () => {
  const navigate = usePageNav();
  const phrase = useStore(s => s.seedPhrase.generate.phrase);
  const generate = useStore(s => s.seedPhrase.generate.generateRandomSeedPhrase);
  const [revealed, setRevealed] = useState(false);
  const wroteIt = useRef<HTMLButtonElement>(null);
  const { password, error, loading, seal } = useSeal();

  useEffect(() => {
    if (!phrase.length) {
      generate(SeedPhraseLength.TWENTY_FOUR_WORDS);
    }
  }, [generate, phrase.length]);

  if (!password) {
    return <Navigate to={PagePath.CREATE_PASSWORD} replace />;
  }

  return (
    <div className='flex flex-col gap-5'>
      <h1 className='font-display text-[38px] text-fg-high'>your recovery phrase</h1>
      <p className='text-body text-fg-muted'>
        write the 24 words on paper, in order. they are the wallet.
      </p>

      <div className='relative border border-border-soft bg-elev-1'>
        <ol className='grid grid-cols-4 p-3.5'>
          {Array.from({ length: 24 }, (_, i) => (
            <li key={i} className='flex h-[34px] items-baseline gap-2 px-1.5 pt-2'>
              <span className='w-[18px] text-right text-[11px] text-fg-dim'>{i + 1}</span>
              <span className='text-body text-fg-high'>{revealed ? phrase[i] : ''}</span>
            </li>
          ))}
        </ol>
        {!revealed && (
          <button
            type='button'
            autoFocus
            onClick={() => {
              setRevealed(true);
              // the cover unmounts; keep the keyboard on the next step
              requestAnimationFrame(() => wroteIt.current?.focus());
            }}
            className='absolute inset-0 flex flex-col items-center justify-center gap-2.5 border-0 bg-elev-1 text-body text-fg-high focus-visible:outline-none'
          >
            <span className='i-ph-eye size-[22px] text-zigner-gold' aria-hidden='true' />
            tap to reveal
            <span className='text-[11px] text-fg-muted'>make sure nobody can see your screen</span>
          </button>
        )}
      </div>

      <Button
        ref={wroteIt}
        disabled={!revealed}
        className='h-14 w-full text-[15px]'
        onClick={() => navigate(PagePath.CHECK_SEED_PHRASE)}
      >
        i wrote it down
      </Button>
      <button
        type='button'
        disabled={loading}
        onClick={() => void seal()}
        className={cn(
          'self-center bg-transparent text-label transition-colors hover:text-fg-high',
          error ? 'text-warning' : 'text-fg-muted',
        )}
      >
        {error ?? 'back up later · zafu will remind you before you receive'}
      </button>
    </div>
  );
};

/** three asked words plus six others from the same phrase, shuffled once. */
const makePool = (phrase: string[], answers: string[]) => {
  const rest = [...new Set(phrase)].filter(w => !answers.includes(w));
  const shuffle = <T,>(xs: T[]) => xs.sort(() => Math.random() - 0.5);
  return shuffle([...new Set(answers), ...shuffle(rest).slice(0, 6)]);
};

export const CheckSeedPhrase = () => {
  const phrase = useStore(s => s.seedPhrase.generate.phrase);
  const asks = useStore(s => s.seedPhrase.generate.validationFields);
  const [pool] = useState(() =>
    makePool(
      phrase,
      asks.map(a => a.word),
    ),
  );
  const [done, setDone] = useState(0);
  const [wrong, setWrong] = useState(false);
  const { password, error, loading, seal } = useSeal();

  if (!password || asks.length < 3) {
    return <Navigate to={PagePath.CREATE_PASSWORD} replace />;
  }

  const cur = asks[Math.min(done, 2)]!;
  const pick = (word: string) => {
    if (word !== cur.word) {
      setWrong(true);
      return;
    }
    setWrong(false);
    // the last word seals; after a failed seal, tapping it again retries
    if (done >= 2) {
      setDone(3);
      void localExtStorage.set('seedPhraseBackedUp', true).then(seal);
      return;
    }
    setDone(done + 1);
  };

  const note = error ?? (wrong ? "that one doesn't match · please check your paper once more" : '');
  return (
    <div className='flex flex-col gap-[22px]'>
      <h1 className='font-display text-[38px] text-fg-high'>quick check</h1>
      <div className='flex items-baseline justify-between'>
        <span className='text-base text-fg-high'>tap word #{cur.index + 1}</span>
        <span className='text-label text-fg-muted'>{Math.min(done, 3)} of 3</span>
      </div>
      <div className='grid grid-cols-3 gap-2.5'>
        {pool.map((word, i) => (
          <button
            key={word}
            type='button'
            autoFocus={i === 0}
            disabled={loading}
            onClick={() => pick(word)}
            className='h-14 border border-border-soft bg-elev-1 text-[15px] text-fg-high transition-colors hover:border-border-hard hover:bg-elev-2 focus-visible:border-zigner-gold focus-visible:outline-none'
          >
            {word}
          </button>
        ))}
      </div>
      <span className={cn('h-[18px] text-label', note ? 'text-warning' : 'text-fg-muted')}>
        {note || 'from the words you wrote down'}
      </span>
    </div>
  );
};
