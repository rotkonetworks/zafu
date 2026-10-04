/**
 * add a person (Cv2Show, Cv2Waiting): your card for the next person, as a QR
 * and a link, and what is true about it while you wait. Opening this screen
 * makes one fresh relationship and keeps its card as a waiting card; `?room=`
 * opens one you made before. The card's room is read while this is on screen.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { cn } from '@repo/ui/lib/utils';
import { useStore } from '../../../state';
import { QrCode } from '../../../components/qr-code';
import { ScreenHeader } from '../../../components/screen-header';
import {
  peopleAsk,
  peopleCall,
  useMyRooms,
  usePeopleSlot,
  useWatchRoom,
} from '../../../people/client';
import { useCardSync, useMyCards } from '../../../people/my-card';
import { requestEgressOptIn } from '../../../net/egress-opt-in';
import { PEOPLE_RELAY } from '../../../config/people-relay';
import { PopupPath, threadPath } from '../paths';

export const cardUrl = (b64: string) => `https://zafu.pro/c#${b64}`;

export const hhmm = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

type Fresh = Awaited<ReturnType<ReturnType<typeof useMyCards>['fresh']>>;

/** one card per visit: a re-render or a second mount never mints another */
const made = new Map<string, Promise<Fresh>>();

const Cue = ({
  live,
  text,
  meta,
  tone,
}: {
  live?: boolean;
  text: string;
  meta?: React.ReactNode;
  tone?: 'warn';
}) => (
  <div className='flex h-9 shrink-0 items-center gap-2.5 border border-border-soft px-3.5'>
    <span
      className={cn(
        'size-2 shrink-0',
        tone === 'warn' ? 'bg-warn' : 'bg-zigner-gold',
        live && 'animate-pulse',
      )}
      aria-hidden='true'
    />
    <span className='grow truncate text-xs text-fg'>{text}</span>
    {meta && <span className='shrink-0 text-[11px] text-fg-muted'>{meta}</span>}
  </div>
);

/** what the relay is doing for this card, honestly */
const RelayCue = ({ onAllow }: { onAllow: () => void }) => {
  const slot = usePeopleSlot();
  return slot === 'needs-opt-in' ? (
    <Cue
      tone='warn'
      text='no one can answer until the relay is allowed'
      meta={
        <button type='button' onClick={onAllow} className='text-zigner-gold hover:underline'>
          allow
        </button>
      }
    />
  ) : slot === 'unreachable' || slot === 'offline' || slot === 'blocked' ? (
    <Cue
      tone='warn'
      text={slot === 'blocked' ? 'the relay is blocked' : 'the relay is not answering'}
    />
  ) : slot === 'checked' ? (
    <Cue text='relay connected' />
  ) : (
    <Cue live text='reaching the relay' />
  );
};

const Answered = ({ contactId, at }: { contactId: string; at?: number }) => {
  const navigate = useNavigate();
  const contact = useStore(s =>
    (Array.isArray(s.contacts.contacts) ? s.contacts.contacts : []).find(c => c.id === contactId),
  );
  const updateContact = useStore(s => s.contacts.updateContact);
  const [name, setName] = useState('');
  const address = contact?.addresses.find(a => a.network === 'zcash')?.address;
  return (
    <form
      className='flex flex-col gap-3'
      onSubmit={e => {
        e.preventDefault();
        if (contact && address) {
          void updateContact(contact.id, { name: name.trim() || contact.name }).then(() =>
            navigate(threadPath(address.toLowerCase()), { replace: true }),
          );
        }
      }}
    >
      <Cue text='your card was saved' meta={at ? hhmm(at) : undefined} />
      <Input
        aria-label='you call them'
        placeholder={contact?.name && contact.name !== 'someone' ? contact.name : 'you call them'}
        value={name}
        onChange={e => setName(e.target.value)}
        autoFocus
      />
      <Button type='submit' disabled={!address || (!name.trim() && contact?.name === 'someone')}>
        open the chat
      </Button>
    </form>
  );
};

export function AddPersonPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const cards = useMyCards();
  const [fresh, setFresh] = useState<Fresh>();
  const [roomId, setRoomId] = useState(params.get('room') ?? undefined);
  const [failed, setFailed] = useState<'card' | 'relay'>();
  const [copied, setCopied] = useState(false);
  const [minute, setMinute] = useState(0);
  const room = useMyRooms().find(r => r.id === roomId);
  const card = room?.card;
  useWatchRoom(card?.state === 'waiting' ? roomId : undefined);
  useCardSync();

  /** keep the card as a waiting one; the relay is asked for here, once */
  const open = (c: Fresh) =>
    peopleAsk<{ id: string }>('card-open', {
      card: c.b64,
      contactId: c.contactId,
      gen: c.rel.gen,
      j: c.rel.j,
    }).then(
      r => setRoomId(r.id),
      () => setFailed('relay'),
    );

  useEffect(() => {
    if (roomId || !cards.ready) {
      return;
    }
    const key = String((history.state as { key?: string } | null)?.key ?? 'one');
    let run = made.get(key);
    if (!run) {
      run = cards.fresh();
      made.set(key, run);
    }
    void run.then(
      c => {
        setFresh(c);
        void open(c);
      },
      () => setFailed('card'),
    );
  }, [roomId, cards.ready]);

  // the minutes waited, honestly: a clock tick, nothing else
  useEffect(() => {
    const t = setInterval(() => setMinute(m => m + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const bytes = card?.bytes ?? fresh?.b64;
  const link = bytes ? cardUrl(bytes) : undefined;
  const mark = (what: 'copied' | 'shared') =>
    roomId && void peopleCall('card-mark', { roomId, what }).catch(() => undefined);
  const copy = () => {
    if (link) {
      void navigator.clipboard.writeText(link).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
        mark('copied');
      });
    }
  };
  const share = () => {
    if (!link) {
      return;
    }
    if (typeof navigator.share === 'function') {
      void navigator.share({ url: link }).then(
        () => mark('shared'),
        () => undefined,
      );
    } else {
      copy();
    }
  };
  const allow = () => void requestEgressOptIn(PEOPLE_RELAY);
  const waitedMin = card
    ? Math.max(0, Math.floor((Date.now() - (card.copied ?? card.shared ?? card.shown)) / 60_000))
    : 0;
  void minute;

  return (
    <div className='flex min-h-full flex-col'>
      <ScreenHeader
        title='add a person'
        backPath={PopupPath.INBOX}
        meta={<span className='text-[11px] text-fg-muted'>your card</span>}
      />
      <main className='flex grow flex-col gap-3 px-4 pb-3 pt-3.5'>
        {card?.state !== 'answered' && (
          <>
            <div className='self-center border border-border-hard bg-[#f6f2e8] p-2.5'>
              {link ? (
                <QrCode value={link} size={168} label='your card' ecLevel='L' />
              ) : (
                <span className='block size-[168px]' aria-hidden='true' />
              )}
            </div>
            <div className='flex h-10 items-center overflow-hidden whitespace-nowrap border border-border-soft bg-elev-1 px-3 text-xs text-fg-muted'>
              zafu.pro/c#
              <span className='truncate text-fg-high'>{bytes ?? ''}</span>
            </div>
            <div className='flex gap-2'>
              <Button variant='secondary' className='flex-1' disabled={!link} onClick={copy}>
                <span
                  className={cn(copied ? 'i-lucide-check' : 'i-lucide-copy', 'size-4')}
                  aria-hidden='true'
                />
                {copied ? 'copied' : 'copy link'}
              </Button>
              <Button variant='secondary' className='flex-1' disabled={!link} onClick={share}>
                <span className='i-lucide-share size-4' aria-hidden='true' />
                share
              </Button>
            </div>
          </>
        )}
        {failed === 'card' ? (
          <Cue
            tone='warn'
            text='sorry, zafu could not make your card. please unlock and try again.'
          />
        ) : failed === 'relay' ? (
          <Cue
            tone='warn'
            text='no one can answer until the relay is allowed'
            meta={
              <button
                type='button'
                onClick={() => {
                  setFailed(undefined);
                  if (fresh) {
                    void open(fresh);
                  }
                }}
                className='text-zigner-gold hover:underline'
              >
                allow
              </button>
            }
          />
        ) : card?.state === 'answered' ? (
          <Answered contactId={card.contactId} at={card.at} />
        ) : card?.state === 'cancelled' ? (
          <Cue tone='warn' text='this card was cancelled' />
        ) : card && (card.copied || card.shared) ? (
          <div className='flex flex-col gap-1'>
            <Cue live text='waiting for an answer' meta={`${waitedMin} min`} />
            <Cue
              text={card.shared && card.shared > (card.copied ?? 0) ? 'link shared' : 'link copied'}
              meta={hhmm(Math.max(card.copied ?? 0, card.shared ?? 0))}
            />
            <RelayCue onAllow={allow} />
          </div>
        ) : (
          <Cue text={link ? 'ready for the next person' : 'making your card'} />
        )}
      </main>
      <footer className='flex shrink-0 gap-2 border-t border-border-soft px-4 pb-4 pt-3'>
        <Button
          variant='secondary'
          className='flex-1'
          onClick={() => navigate(PopupPath.INBOX_SCAN)}
        >
          scan theirs
        </Button>
        <Button
          variant='secondary'
          className='flex-1'
          onClick={() => navigate(PopupPath.INBOX, { replace: true })}
        >
          done
        </Button>
      </footer>
    </div>
  );
}

export default AddPersonPage;
