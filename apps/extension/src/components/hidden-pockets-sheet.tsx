/**
 * hidden pockets - the quiet "hidden · N" row at the end of the pocket list
 * opens here. A hidden pocket is never deleted (it keeps syncing and its
 * balance), so the only action here is bringing it back into view.
 */

import { useEffect } from 'react';
import { useStore } from '../state';
import { Sheet } from '@repo/ui/components/ui/sheet';
import type { Pocket } from '../state/pockets';

export const HiddenPocketsSheet = ({
  open,
  onOpenChange,
  owner,
  pockets,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  owner: string | undefined;
  pockets: Pocket[];
}) => {
  const unhide = useStore(s => s.pockets.unhide);

  // the last one unhidden leaves nothing to show here; close quietly rather
  // than sit open on an empty list
  useEffect(() => {
    if (open && pockets.length === 0) {
      onOpenChange(false);
    }
  }, [open, pockets.length, onOpenChange]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title='hidden pockets'>
      <div className='-mx-4 flex flex-col px-3'>
        {pockets.map(p => (
          <div key={p.account} className='flex h-[54px] items-center gap-3 px-2'>
            <span className='flex min-w-0 flex-1 flex-col gap-[3px]'>
              <span className='truncate text-sm text-fg-muted lowercase'>{p.name}</span>
              <span className='truncate text-[11px] text-fg-muted lowercase'>
                account {p.account}
              </span>
            </span>
            <button
              type='button'
              onClick={() => owner && void unhide(owner, p.account)}
              aria-label={`unhide ${p.name}`}
              className='flex size-11 shrink-0 items-center justify-center text-fg-muted transition-colors hover:text-fg-high'
            >
              <span className='i-ph-eye size-4' aria-hidden='true' />
            </button>
          </div>
        ))}
      </div>
    </Sheet>
  );
};
