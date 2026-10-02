/**
 * Enter a recovery phrase - Onb7Paste board. One box for the 24 words,
 * pasted or typed, any spacing. A 12-word phrase is accepted quietly for
 * people coming from a penumbra wallet, but never advertised. A typo gets one calm line with the nearest
 * word, and tapping it applies the fix. The board's "paste" button would
 * need clipboard-read permission, so a native paste stands in for it.
 */

import { ClipboardEvent, FormEvent, KeyboardEvent, useState } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { Button } from '@repo/ui/components/ui/button';
import { useStore } from '../../../state';
import {
  isInWordList,
  isWordPrefix,
  parsePhrase,
  SeedPhraseLength,
  suggestWord,
  validateSeedPhrase,
} from '../../../state/seed-phrase/mnemonic';
import { usePageNav } from '../../../utils/navigate';
import { PagePath } from '../paths';
import { PENDING_ZCASH_BIRTHDAY_KEY } from './constants';

const LENGTHS = [12, 24];

export const ImportSeedPhrase = () => {
  const navigate = usePageNav();
  const stored = useStore(s => s.seedPhrase.import.phrase);
  const update = useStore(s => s.seedPhrase.import.update);
  const setLength = useStore(s => s.seedPhrase.import.setLength);
  const [text, setText] = useState(() => stored.join(' ').trim());
  // the shell counts the steps from the stored length: 12 words skip the birthday
  const write = (value: string) => {
    setText(value);
    const n = parsePhrase(value).length;
    if (LENGTHS.includes(n)) {
      setLength(n === 12 ? SeedPhraseLength.TWELVE_WORDS : SeedPhraseLength.TWENTY_FOUR_WORDS);
    }
  };

  const words = parsePhrase(text);
  const typing = !/\s$/.test(text);
  const typo = words.find(
    (w, i) => !isInWordList(w) && !(typing && i === words.length - 1 && isWordPrefix(w)),
  );
  const fix = typo ? suggestWord(typo) : null;
  const valid = !typo && LENGTHS.includes(words.length) && validateSeedPhrase(words);

  const whole = LENGTHS.includes(words.length);
  const tone = typo ? 'warn' : valid ? 'ok' : 'idle';
  const note = typo
    ? `"${typo}" is not a recovery word${fix ? ` · did you mean ${fix}? (tap to fix)` : ''}`
    : whole && !valid
      ? "these words don't form a phrase yet · please check the order"
      : valid
        ? `${words.length} words · valid phrase`
        : words.length
          ? `${words.length} words`
          : '24 words';

  const applyFix = () => fix && write(words.map(w => (w === typo ? fix : w)).join(' '));

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!valid) {
      return;
    }
    update(words.join(' '), 0);
    // twelve words are penumbra-only: no zcash birthday to ask, and none left
    // over from an abandoned attempt
    if (words.length === 12) {
      sessionStorage.removeItem(PENDING_ZCASH_BIRTHDAY_KEY);
      navigate(PagePath.IMPORT_PASSWORD);
      return;
    }
    navigate(PagePath.IMPORT_BIRTHDAY);
  };

  // a whole paste into an empty box lands as clean words, whatever it carried
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (el.selectionStart === 0 && el.selectionEnd === el.value.length) {
      e.preventDefault();
      write(parsePhrase(e.clipboardData.getData('text')).join(' '));
    }
  };

  // enter continues once the phrase is whole; shift+enter keeps a new line
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form onSubmit={submit} className='flex flex-col gap-5'>
      <h1 className='font-display text-[38px] text-fg-high'>enter your phrase</h1>
      <p className='text-body text-fg-muted'>paste it or type it. spaces or new lines are fine.</p>

      <label htmlFor='seed' className='sr-only'>
        recovery phrase
      </label>
      <textarea
        id='seed'
        autoFocus
        spellCheck={false}
        autoComplete='off'
        autoCapitalize='off'
        value={text}
        onChange={e => write(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        placeholder='word word word ...'
        className={cn(
          'h-[150px] w-full resize-none border bg-elev-1 p-4 text-[15px] leading-[1.7] text-fg-high placeholder:text-fg-dim focus:outline-none',
          {
            warn: 'border-warning',
            ok: 'border-green',
            idle: 'border-border-soft focus:border-zigner-gold',
          }[tone],
        )}
      />

      <button
        type='button'
        onClick={applyFix}
        disabled={!fix}
        aria-live='polite'
        className={cn(
          'flex h-5 items-center gap-2.5 bg-transparent text-left text-label',
          { warn: 'text-warning', ok: 'text-green', idle: 'text-fg-muted' }[tone],
        )}
      >
        <span
          className={cn(
            'size-2 shrink-0',
            { warn: 'bg-warning', ok: 'bg-green', idle: 'bg-border-hard' }[tone],
          )}
        />
        {note}
      </button>

      <Button type='submit' disabled={!valid} className='h-14 w-full text-[15px]'>
        continue
      </Button>
      <span className='text-label text-fg-dim'>
        checked on this computer · nothing is sent anywhere
      </span>
    </form>
  );
};
