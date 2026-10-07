/**
 * waiting for an answer (Cv2WaitList, Cv2WaitCancel): the cards you showed
 * that no one answered yet, and those with answers to choose from. Their
 * rooms are read while people is open. Cancelling posts a signed close into
 * the card's room, so whoever opens it later sees it was cancelled, and its
 * keys are never used again; until the close leaves, the row says so and
 * zafu tries again the next time people opens.
 */

import { Clipped } from '@repo/ui/components/ui/clipped';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { cn } from '@repo/ui/lib/utils';
import { peopleCall, useMyRooms } from '../../../people/client';
import type { PeopleRoom } from '../../../people/vault';
import { PopupPath } from '../paths';
import { dayAt } from '../../../utils/when';

/** what happened to a waiting card last, and when */
export const cardLine = (c: NonNullable<PeopleRoom['card']>): [string, number] =>
  c.state === 'cancelling'
    ? ['cancelling', c.at ?? c.shown]
    : c.answers?.length
      ? [
          c.answers.length > 1 ? `${c.answers.length} answers arrived` : 'an answer arrived',
          Math.max(...c.answers.map(a => a.at)),
        ]
      : c.shared && c.shared >= (c.copied ?? 0)
        ? ['link shared', c.shared]
        : c.copied
          ? ['link copied', c.copied]
          : ['card shown on screen', c.shown];

/** the cards a list shows: still waiting, or a close that has not left yet */
export const listed = (r: PeopleRoom): boolean =>
  r.kind === 'card' &&
  !!r.card?.mine &&
  (r.card.state === 'waiting' || r.card.state === 'cancelling');

export const WaitingCards = () => {
  const navigate = useNavigate();
  const waiting = useMyRooms().filter(listed);
  const [cancel, setCancel] = useState<PeopleRoom>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const close = () => {
    setCancel(undefined);
    setFailed(false);
  };
  if (!waiting.length) {
    return null;
  }
  return (
    <section className='flex flex-col gap-1.5'>
      <h2 className='text-xs tracking-[0.04em] text-fg-muted'>waiting for an answer</h2>
      <div className='flex flex-col border border-border-soft'>
        {waiting.map(r => {
          const [what, at] = cardLine(r.card!);
          const cancelling = r.card!.state === 'cancelling';
          return (
            <div
              key={r.id}
              className='flex h-14 items-center gap-3 border-b border-border-soft px-3 last:border-0'
            >
              <span
                className={cn(
                  'size-2 shrink-0',
                  cancelling
                    ? 'bg-warn'
                    : 'animate-pulse bg-zigner-gold motion-reduce:animate-none',
                )}
                aria-hidden='true'
              />
              <button
                type='button'
                disabled={cancelling}
                onClick={() => navigate(`${PopupPath.INBOX_ADD}?room=${encodeURIComponent(r.id)}`)}
                className='flex min-w-0 grow flex-col gap-0.5 text-left'
              >
                <Clipped className='text-[13px] text-fg-high'>{what}</Clipped>
                <span className='text-[11px] text-fg-muted'>
                  {dayAt(at)} · {cancelling ? 'zafu tries again when people opens' : 'watching'}
                </span>
              </button>
              {!cancelling && (
                <button
                  type='button'
                  onClick={() => setCancel(r)}
                  aria-label={`cancel the card, ${what} ${dayAt(at)}`}
                  className='shrink-0 px-1 text-xs text-fg-muted hover:text-fg-high'
                >
                  cancel
                </button>
              )}
            </div>
          );
        })}
      </div>
      <Sheet open={!!cancel} onOpenChange={o => !o && close()} title='cancel this card?'>
        {cancel?.card && (
          <div className='flex flex-col gap-3'>
            <div className='flex flex-col border border-border-soft bg-elev-1 text-xs'>
              <span className='border-b border-border-soft px-3.5 py-2.5 text-fg-high'>
                {cardLine(cancel.card)[0]} {dayAt(cardLine(cancel.card)[1])}
              </span>
              <span className='px-3.5 py-2.5 text-fg-muted'>
                answers · {cancel.card.answers?.length || 'none yet'}
              </span>
            </div>
            {failed ? (
              <span className='text-xs text-warn' role='status'>
                sorry, the relay did not take it yet. zafu stopped watching this card and will send
                the cancel again when people opens.
              </span>
            ) : (
              <span className='text-xs text-fg-muted'>
                anyone who opens it later sees it was cancelled. its keys are never used again.
              </span>
            )}
            <div className='flex gap-2'>
              <Button variant='secondary' className='flex-1' onClick={close}>
                {failed ? 'close' : 'keep waiting'}
              </Button>
              <Button
                className='flex-1'
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setFailed(false);
                  void peopleCall('card-cancel', { roomId: cancel.id })
                    .then(close, () => setFailed(true))
                    .finally(() => setBusy(false));
                }}
              >
                {failed ? 'try again' : 'cancel card'}
              </Button>
            </div>
          </div>
        )}
      </Sheet>
    </section>
  );
};
