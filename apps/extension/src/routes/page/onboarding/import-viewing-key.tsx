/**
 * Enter a viewing key - the watch-only way in from Onb6Choose, laid out like
 * Onb7Paste. The key is read on this computer (the same reading settings uses)
 * and held in memory until the password step seals it.
 */

import { FormEvent, useState } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { Button } from '@repo/ui/components/ui/button';
import { useViewingKey } from '../../../hooks/use-viewing-key';
import { usePageNav } from '../../../utils/navigate';
import { PagePath } from '../paths';
import { useOnboarding } from '.';
import { Clipped } from '@repo/ui/components/ui/clipped';

export const ImportViewingKey = () => {
  const navigate = usePageNav();
  const onboarding = useOnboarding();
  const [text, setText] = useState(onboarding.viewingKey);
  const { ok, note } = useViewingKey(text);
  const tone = note?.bad ? 'warn' : ok ? 'ok' : 'idle';

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (ok) {
      onboarding.setViewingKey(ok.key);
      navigate(PagePath.VIEWING_KEY_BIRTHDAY);
    }
  };

  return (
    <form onSubmit={submit} className='flex flex-col gap-5'>
      <h1 className='font-display text-[38px] text-fg-high'>enter your viewing key</h1>
      <p className='text-body text-fg-muted'>it sees this wallet, and can never spend.</p>

      <label htmlFor='vk' className='sr-only'>
        viewing key
      </label>
      <textarea
        id='vk'
        autoFocus
        spellCheck={false}
        autoComplete='off'
        autoCapitalize='off'
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
        placeholder='uview1...'
        className={cn(
          'h-[150px] w-full resize-none break-words border bg-elev-1 p-4 text-[15px] leading-[1.7] text-fg-high placeholder:text-fg-dim focus:outline-none',
          {
            warn: 'border-warning',
            ok: 'border-green',
            idle: 'border-border-soft focus:border-zigner-gold',
          }[tone],
        )}
      />

      <span
        aria-live='polite'
        className={cn(
          'flex h-5 items-center gap-2.5 text-label',
          { warn: 'text-warning', ok: 'text-green', idle: 'text-fg-muted' }[tone],
        )}
      >
        <span
          className={cn(
            'size-2 shrink-0',
            { warn: 'bg-warning', ok: 'bg-green', idle: 'bg-border-hard' }[tone],
          )}
        />
        <Clipped>{note?.text ?? 'a unified full viewing key (uview1...)'}</Clipped>
      </span>

      <Button type='submit' disabled={!ok} className='h-14 w-full text-[15px]'>
        continue
      </Button>
      <span className='text-label text-fg-dim'>
        checked on this computer · nothing is sent anywhere
      </span>
    </form>
  );
};
