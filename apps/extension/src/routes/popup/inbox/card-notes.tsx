/**
 * The lines zafu writes into a thread about the relationship (Cv2DoneYou,
 * Cv2DoneThem, Cv2MemoArrived, Cv2Update, Cv2UpdateSheet): saved, confirmed,
 * answered by memo, and a signed card that changed something.
 */

import { useState } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { Sheet } from '@repo/ui/components/ui/sheet';
import type { CardV2 } from '@repo/wallet/networks/zcash/card-v2';
import { changed, readNote, type Note } from '../../../people/cards';
import { addressesOf } from '../../../people/my-card';
import type { ThreadItem } from '../../../people/vault';
import { hhmm } from './add-person';
import { shortAddress } from './threads';

const WHAT: Record<ReturnType<typeof changed>[number], string> = {
  zcash: 'address',
  penumbra: 'penumbra address',
  relay: 'relay',
  caps: 'way to reach them',
};

const shown = (c: CardV2, k: ReturnType<typeof changed>[number]) =>
  k === 'zcash' || k === 'penumbra'
    ? shortAddress(addressesOf(c).find(a => a.network === k)?.address ?? 'none')
    : k === 'relay'
      ? new URL(c.relay).host
      : String(c.caps);

const Line = ({ icon, children }: { icon?: string; children: React.ReactNode }) => (
  <span className='flex items-center gap-1.5 self-center text-[11px] text-fg-muted'>
    {icon && <span className={`${icon} size-3.5 text-zigner-gold`} aria-hidden='true' />}
    {children}
  </span>
);

const UpdateSheet = ({
  note,
  name,
  at,
  onClose,
}: {
  note: Extract<Note, { ev: 'update' }>;
  name: string;
  at: number;
  onClose: () => void;
}) => {
  const keys = changed(note.from, note.to);
  return (
    <Sheet open onOpenChange={o => !o && onClose()} title={`${name}'s card changed`}>
      <div className='flex flex-col border border-border-soft bg-elev-1 text-xs'>
        {keys.map(k => (
          <div key={k} className='flex flex-col gap-1 border-b border-border-soft px-3.5 py-2.5'>
            <span className='text-fg-muted'>{WHAT[k]}</span>
            <span className='font-mono text-fg-dim line-through'>{shown(note.from, k)}</span>
            <span className='font-mono text-fg-high'>{shown(note.to, k)}</span>
          </div>
        ))}
        <div className='flex items-center justify-between border-b border-border-soft px-3.5 py-2.5'>
          <span className='text-fg-muted'>signed by</span>
          <span className='flex items-center gap-1.5 text-fg-high'>
            <span className='i-lucide-check size-3.5 text-zigner-gold' aria-hidden='true' />
            the same key as before
          </span>
        </div>
        <div className='flex items-center justify-between border-b border-border-soft px-3.5 py-2.5'>
          <span className='text-fg-muted'>revision</span>
          <span className='text-fg-high'>
            {note.from.revision} → {note.to.revision}
          </span>
        </div>
        <div className='flex items-center justify-between px-3.5 py-2.5'>
          <span className='text-fg-muted'>when</span>
          <span className='text-fg-high'>{hhmm(at)}</span>
        </div>
      </div>
      {keys.includes('zcash') && (
        <span className='text-[11px] text-fg-muted'>
          paying {name} uses the new address from now
        </span>
      )}
      <Button onClick={onClose}>done</Button>
    </Sheet>
  );
};

export const NoteLine = ({ item, name }: { item: ThreadItem; name: string }) => {
  const [open, setOpen] = useState(false);
  const note = readNote(item);
  const at = item.ts * 1000;
  if (!note) {
    return null;
  }
  switch (note.ev) {
    case 'saved-you':
      return (
        <>
          {note.via === 'memo' ? (
            <>
              <Line icon='i-lucide-mail'>
                {name} answered by memo
                {note.height ? ` · block ${note.height.toLocaleString('en')}` : ''} · {hhmm(at)}
              </Line>
              <Line icon='i-lucide-check'>signature unchanged · {name} saved your card</Line>
            </>
          ) : (
            <Line icon='i-lucide-check'>
              {name} saved your card · {hhmm(at)}
            </Line>
          )}
          <span className='self-center text-[11px] text-fg-dim'>
            you can chat and pay each other
          </span>
        </>
      );
    case 'saved-them':
      return (
        <Line icon='i-lucide-check'>
          you saved {name} · {hhmm(at)}
        </Line>
      );
    case 'confirmed':
      return (
        <Line icon='i-lucide-check-check'>
          {name} has your card · {hhmm(at)}
        </Line>
      );
    case 'closed':
      return <Line>{name} closed this relationship</Line>;
    case 'update': {
      const keys = changed(note.from, note.to);
      return (
        <>
          <button
            type='button'
            onClick={() => setOpen(true)}
            className='flex items-center gap-1.5 self-center text-[11px] text-fg-muted hover:text-fg-high'
          >
            <span className='i-lucide-pen-line size-3.5 text-zigner-gold' aria-hidden='true' />
            {name}&apos;s {WHAT[keys[0] ?? 'zcash']} changed · signed by {name}
            <span className='i-lucide-chevron-right size-3.5' aria-hidden='true' />
          </button>
          {open && <UpdateSheet note={note} name={name} at={at} onClose={() => setOpen(false)} />}
        </>
      );
    }
  }
};
