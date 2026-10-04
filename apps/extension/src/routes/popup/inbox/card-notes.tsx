/**
 * The lines zafu writes into a thread about the relationship (Cv2DoneYou,
 * Cv2DoneThem, Cv2MemoArrived): saved, confirmed and answered by memo.
 */

import { readNote } from '../../../people/cards';
import type { ThreadItem } from '../../../people/vault';
import { hhmm } from './add-person';

const Line = ({ icon, children }: { icon?: string; children: React.ReactNode }) => (
  <span className='flex items-center gap-1.5 self-center text-[11px] text-fg-muted'>
    {icon && <span className={`${icon} size-3.5 text-zigner-gold`} aria-hidden='true' />}
    {children}
  </span>
);

export const NoteLine = ({ item, name }: { item: ThreadItem; name: string }) => {
  const note = readNote(item);
  const at = item.ts * 1000;
  switch (note?.ev) {
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
    default:
      return null;
  }
};
