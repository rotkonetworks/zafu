/**
 * the ways to hand a card or an invite on, one copy row each: the zafu: link
 * first (works offline, for someone who has zafu), then the zafu.pro link
 * (for anyone; the page tells them how to get zafu).
 */

import { Clipped } from '@repo/ui/components/ui/clipped';
import { useState } from 'react';
import { useCopy } from '@repo/ui/hooks/use-copy';
import { cn } from '@repo/ui/lib/utils';

export interface ShareWay {
  name: string;
  meta: string;
  /** the text, or how to make it when it is first copied (a card is made then) */
  text: string | (() => Promise<string | undefined>);
}

export const ShareWays = ({ ways, disabled }: { ways: ShareWay[]; disabled?: boolean }) => {
  const { copied, copy } = useCopy();
  const [at, setAt] = useState(-1);
  const pick = async (w: ShareWay, i: number) => {
    const text = typeof w.text === 'string' ? w.text : await w.text();
    if (text) {
      copy(text);
      setAt(i);
    }
  };
  return (
    <div className='flex flex-col border border-border-soft bg-elev-1'>
      {ways.map((w, i) => {
        const done = copied && at === i;
        return (
          <button
            key={w.name}
            type='button'
            disabled={disabled}
            onClick={() => void pick(w, i)}
            className='flex h-14 items-center gap-3 border-t border-border-soft px-3.5 text-left first:border-t-0 hover:bg-elev-2 disabled:pointer-events-none disabled:opacity-50'
          >
            <span className='flex min-w-0 grow flex-col gap-[3px]'>
              <span className='text-[13px] text-fg-high'>{w.name}</span>
              <Clipped className='text-[11px] text-fg-muted'>{w.meta}</Clipped>
            </span>
            <span className={cn('text-xs', done ? 'text-success' : 'text-zigner-gold')}>
              {done ? 'copied' : 'copy'}
            </span>
          </button>
        );
      })}
    </div>
  );
};
