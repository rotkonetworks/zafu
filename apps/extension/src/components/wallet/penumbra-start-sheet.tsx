/** penumbra's start, asked as it is turned on (board PenumbraOnUse), never on home */

import { useEffect, useState } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { Sheet } from '@repo/ui/components/ui/sheet';
import type { PenumbraStart } from '../../penumbra/start';

// the one sheet, mounted in the popup layout, and the question it is answering
let show: ((open: boolean) => void) | undefined;
let asking: ((start: PenumbraStart | null) => void) | undefined;

/** the start the person picks, or null when they decide not to turn it on */
export const askPenumbraStart = () =>
  new Promise<PenumbraStart | null>(resolve => {
    asking?.(null);
    asking = resolve;
    show?.(true);
  });

const answer = (start: PenumbraStart | null) => {
  asking?.(start);
  asking = undefined;
  show?.(false);
};

export const PenumbraStartSheet = () => {
  const [open, setOpen] = useState(false);
  const [earlier, setEarlier] = useState(false);
  useEffect(() => {
    show = setOpen;
    return () => {
      show = undefined;
    };
  }, []);
  return (
    <Sheet open={open} onOpenChange={o => !o && answer(null)} title='turn on penumbra'>
      <div className='flex flex-col gap-4'>
        <label className='flex min-h-12 cursor-pointer items-center gap-3 border border-dashed border-border-hard px-3.5 has-[:checked]:border-zigner-gold-dark has-[:checked]:bg-zigner-gold/10'>
          <input
            type='checkbox'
            checked={earlier}
            onChange={e => setEarlier(e.target.checked)}
            className='size-[18px] shrink-0 accent-[var(--zigner-gold)]'
          />
          <span className='text-xs text-fg-muted'>
            used penumbra with this phrase before? sync from earlier
          </span>
        </label>
        <span className='text-[11px] text-fg-dim'>
          {earlier ? 'reads the whole chain · finds everything' : 'syncs from now'} · zcash stays as
          it is
        </span>
        <Button className='w-full' onClick={() => answer(earlier ? { since: 0 } : 'tip')}>
          turn on
        </Button>
        <Button variant='quiet' className='w-full' onClick={() => answer(null)}>
          no, thank you
        </Button>
      </div>
    </Sheet>
  );
};
