/**
 * Import recovery-phrase screen - Onb7Paste board. One textarea: paste or
 * type the phrase (12 or 24 words), spaces or newlines both fine, length is
 * detected from what's entered - no separate word-count toggle anymore.
 *
 * A live per-word check gives a calm message on a typo ("harbour isn't a
 * phrase word · did you mean harbor") rather than only marking the word red;
 * tapping the message applies the fix.
 *
 * Deviation from the board: the board also shows a "paste" button that
 * reads the clipboard directly. That needs a clipboard-read permission the
 * extension doesn't request, so it's dropped here - a native paste (ctrl+v
 * or right-click) into the textarea already fills every word, which is the
 * actual requirement ("paste into the first box fills all words").
 */

import { FormEvent, useMemo, useState } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { Button } from '@repo/ui/components/ui/button';
import { useStore } from '../../../state';
import { importSelector } from '../../../state/seed-phrase/import';
import { SeedPhraseLength, suggestWord } from '../../../state/seed-phrase/mnemonic';
import { usePageNav } from '../../../utils/navigate';
import { PagePath } from '../paths';
import { OnboardingShell } from './onboarding-shell';

const splitWords = (text: string) => text.trim().split(/\s+/).filter(Boolean);

export const ImportSeedPhrase = () => {
  const navigate = usePageNav();
  const { update, setLength, wordIsValid, phraseIsValid } = useStore(importSelector);
  const [text, setText] = useState('');

  const words = useMemo(() => splitWords(text), [text]);
  const firstTypo = useMemo(() => words.find(w => !wordIsValid(w)), [words, wordIsValid]);
  const suggestion = useMemo(() => (firstTypo ? suggestWord(firstTypo) : null), [firstTypo]);
  const valid = words.length > 0 && !words.some(w => !wordIsValid(w)) && phraseIsValid();

  const commit = (nextText: string) => {
    setText(nextText);
    const nextWords = splitWords(nextText);
    setLength(
      nextWords.length <= 12 ? SeedPhraseLength.TWELVE_WORDS : SeedPhraseLength.TWENTY_FOUR_WORDS,
    );
    update(nextWords.join(' '), 0);
  };

  const applyFix = () => {
    if (!firstTypo || !suggestion) {
      return;
    }
    commit(text.replace(firstTypo, suggestion));
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) {
      return;
    }
    navigate(PagePath.IMPORT_REVIEW);
  };

  const note =
    text.length === 0
      ? '12 or 24 words'
      : firstTypo
        ? suggestion
          ? `"${firstTypo}" isn't a phrase word · did you mean ${suggestion}? (tap to fix)`
          : `"${firstTypo}" isn't a phrase word`
        : valid
          ? `${words.length} words · valid phrase`
          : `${words.length} words`;
  const noteColor = firstTypo ? 'text-warning' : valid ? 'text-green' : 'text-fg-muted';

  return (
    <OnboardingShell art='bamboo'>
      <FadeTransition>
        <form onSubmit={handleSubmit} className='flex flex-col gap-5'>
          <h1 className='font-display text-[38px] text-fg-high'>enter your phrase</h1>
          <p className='text-body text-fg-muted lowercase'>
            paste it or type it. spaces or new lines are fine.
          </p>

          <label htmlFor='seed' className='sr-only'>
            recovery phrase
          </label>
          <textarea
            id='seed'
            value={text}
            onChange={e => commit(e.target.value)}
            placeholder='word word word ...'
            className={cn(
              'h-[150px] w-full resize-none border bg-elev-1 p-4 font-mono text-body text-fg-high',
              firstTypo ? 'border-warning' : valid ? 'border-green' : 'border-border-soft',
            )}
          />

          <button
            type='button'
            onClick={applyFix}
            disabled={!firstTypo || !suggestion}
            className={cn(
              'flex h-5 items-center gap-2.5 bg-transparent text-left text-label',
              noteColor,
            )}
          >
            <span
              className={cn(
                'size-2 shrink-0',
                firstTypo ? 'bg-warning' : valid ? 'bg-green' : 'bg-border-hard',
              )}
            />
            {note}
          </button>

          <Button
            type='submit'
            variant='primary'
            disabled={!valid}
            className='h-14 w-full text-body'
          >
            continue
          </Button>
          <span className='text-label text-fg-dim lowercase'>
            checked on this computer · nothing is sent anywhere
          </span>
        </form>
      </FadeTransition>
    </OnboardingShell>
  );
};
