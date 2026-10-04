/**
 * waiting for an answer (Cv2WaitList, Cv2WaitCancel): the cards you showed
 * that no one answered yet. Their rooms are read while people is open.
 * Cancelling posts a signed close into the card's room, so whoever opens it
 * later sees it was cancelled, and its keys are never used again.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { peopleCall, useMyRooms } from '../../../people/client';
import type { PeopleRoom } from '../../../people/vault';
import { PopupPath } from '../paths';
import { hhmm } from './add-person';

/** what happened to a waiting card last, and when */
export const cardLine = (c: NonNullable<PeopleRoom['card']>): [string, number] =>
  c.shared && c.shared >= (c.copied ?? 0)
    ? ['link shared', c.shared]
    : c.copied
      ? ['link copied', c.copied]
      : ['card shown on screen', c.shown];

const dayAt = (ms: number) => {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  const yesterday = new Date(Date.now() - 86_400_000).toDateString() === d.toDateString();
  return `${today ? 'today' : yesterday ? 'yesterday' : d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }).toLowerCase()} ${hhmm(ms)}`;
};

export const WaitingCards = () => {
  const navigate = useNavigate();
  const waiting = useMyRooms().filter(
    r => r.kind === 'card' && r.card?.mine && r.card.state === 'waiting',
  );
  const [cancel, setCancel] = useState<PeopleRoom>();
  const [busy, setBusy] = useState(false);
  if (!waiting.length) {
    return null;
  }
  return (
    <section className='flex flex-col gap-1.5'>
      <h2 className='text-xs tracking-[0.04em] text-fg-muted'>waiting for an answer</h2>
      <div className='flex flex-col border border-border-soft'>
        {waiting.map(r => {
          const [what, at] = cardLine(r.card!);
          return (
            <div
              key={r.id}
              className='flex h-14 items-center gap-3 border-b border-border-soft px-3 last:border-0'
            >
              <span className='size-2 shrink-0 animate-pulse bg-zigner-gold' aria-hidden='true' />
              <button
                type='button'
                onClick={() => navigate(`${PopupPath.INBOX_ADD}?room=${encodeURIComponent(r.id)}`)}
                className='flex min-w-0 grow flex-col gap-0.5 text-left'
              >
                <span className='truncate text-[13px] text-fg-high'>{what}</span>
                <span className='text-[11px] text-fg-muted'>{dayAt(at)} · watching</span>
              </button>
              <button
                type='button'
                onClick={() => setCancel(r)}
                className='shrink-0 px-1 text-xs text-fg-muted hover:text-fg-high'
              >
                cancel
              </button>
            </div>
          );
        })}
      </div>
      <Sheet
        open={!!cancel}
        onOpenChange={o => !o && setCancel(undefined)}
        title='cancel this card?'
      >
        {cancel?.card && (
          <div className='flex flex-col gap-3'>
            <div className='flex flex-col border border-border-soft bg-elev-1 text-xs'>
              <span className='border-b border-border-soft px-3.5 py-2.5 text-fg-high'>
                {cardLine(cancel.card)[0]} {dayAt(cardLine(cancel.card)[1])}
              </span>
              <span className='px-3.5 py-2.5 text-fg-muted'>answers · none yet</span>
            </div>
            <span className='text-xs text-fg-muted'>
              anyone who opens it later sees it was cancelled. its keys are never used again.
            </span>
            <div className='flex gap-2'>
              <Button variant='secondary' className='flex-1' onClick={() => setCancel(undefined)}>
                keep waiting
              </Button>
              <Button
                className='flex-1'
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void peopleCall('card-cancel', { roomId: cancel.id })
                    .catch(() => undefined)
                    .finally(() => {
                      setBusy(false);
                      setCancel(undefined);
                    });
                }}
              >
                cancel card
              </Button>
            </div>
          </div>
        )}
      </Sheet>
    </section>
  );
};
