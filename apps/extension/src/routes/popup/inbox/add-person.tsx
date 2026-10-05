/**
 * add a person (Cv2Show, Cv2Waiting, Cv2Answered): your card for the next
 * person, as a QR and a link, and what is true about it while you wait.
 * Nothing is made until the card leaves this screen: showing, copying or
 * sharing it makes one fresh relationship and keeps its card as a waiting
 * one (`?room=` opens one you made before). The card's room is read while
 * this is on screen.
 *
 * An answer never becomes the person by itself: each one that arrives is
 * shown with its seal, and the person chooses ("2 answers arrived") and
 * compares the seal before they are saved.
 */

import { useState } from 'react';
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
import { pairSeal, readB64Card } from '../../../people/cards';
import type { CardAnswer, PeopleRoom } from '../../../people/vault';
import { requestEgressOptIn } from '../../../net/egress-opt-in';
import { PEOPLE_RELAY } from '../../../config/people-relay';
import { useNow } from '../../../hooks/use-now';
import { hhmm } from '../../../utils/when';
import { SealCompare } from '../contacts/seal-compare';
import { PopupPath, threadPath } from '../paths';

export const cardUrl = (b64: string) => `https://zafu.pro/c#${b64}`;

type Fresh = Awaited<ReturnType<ReturnType<typeof useMyCards>['fresh']>>;

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
        live && 'animate-pulse motion-reduce:animate-none',
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

/** the answer you chose is saved: what you call them, then the chat */
const Answered = ({
  contactId,
  at,
  checked,
}: {
  contactId: string;
  at?: number;
  checked?: number;
}) => {
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
      {!checked && (
        <Cue tone='warn' text='seal not checked · their name and address are their word' />
      )}
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

/** one answer, as its row in "2 answers arrived" */
const AnswerRow = ({ a, onPick }: { a: CardAnswer; onPick: () => void }) => {
  const c = readB64Card(a.b64);
  return (
    <button
      type='button'
      onClick={onPick}
      className='flex h-14 items-center gap-3 border-b border-border-soft px-3.5 text-left last:border-0 hover:bg-elev-2'
    >
      <span className='flex min-w-0 grow flex-col gap-0.5'>
        <span className='truncate text-[13px] text-fg-high'>{c?.name || 'someone'}</span>
        <span className='text-[11px] text-fg-muted'>
          {a.via === 'memo' ? 'by memo' : a.sealed ? 'sealed' : 'not sealed'} · {hhmm(a.at)}
        </span>
      </span>
      <span className='i-lucide-chevron-right size-4 shrink-0 text-fg-dim' aria-hidden='true' />
    </button>
  );
};

/**
 * Answers arrived (Cv2Arrived): choose the one who is the person, then
 * compare the seal with them before they are saved. Anyone with the link
 * can answer, so none is taken by itself.
 */
const Arrived = ({ room }: { room: PeopleRoom }) => {
  const [pick, setPick] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const mine = readB64Card(room.card?.bytes);
  const list = (room.card?.answers ?? []).flatMap(a => {
    const card = readB64Card(a.b64);
    return card ? [{ a, card }] : [];
  });
  const chosen = list.length === 1 ? list[0] : list.find(x => x.card.key === pick);
  const many = list.length > 1 ? `${list.length} answers arrived` : 'an answer arrived';
  const run = (op: 'card-choose' | 'card-dismiss', checked?: boolean) => {
    if (!chosen) {
      return;
    }
    setBusy(true);
    setFailed(false);
    void peopleCall(op, { roomId: room.id, key: chosen.card.key, checked })
      .then(
        () => setPick(undefined),
        () => setFailed(true),
      )
      .finally(() => setBusy(false));
  };

  if (!chosen) {
    return (
      <div className='flex flex-col gap-3'>
        <Cue text={many} />
        <span className='text-xs text-fg-muted'>
          only one is the person you gave your card to. their seal says which.
        </span>
        <div className='flex flex-col border border-border-soft'>
          {list.map(x => (
            <AnswerRow key={x.card.key} a={x.a} onPick={() => setPick(x.card.key)} />
          ))}
        </div>
      </div>
    );
  }
  const name = chosen.card.name || 'them';
  return (
    <div className='flex flex-col gap-3'>
      <Cue text={many} meta={hhmm(chosen.a.at)} />
      {chosen.a.via !== 'memo' && !chosen.a.sealed && (
        <Cue
          tone='warn'
          text='not sealed · an older zafu sent it, others with the link could read it'
        />
      )}
      <span className='text-xs text-fg-muted'>
        {chosen.card.name ? `it says ${chosen.card.name}` : 'it has no name'} · check the seal with{' '}
        {name} before saving
      </span>
      <SealCompare seal={mine ? pairSeal(mine.key, chosen.card.key) : undefined} />
      {failed && <Cue tone='warn' text='sorry, that did not go through. please try again.' />}
      <div className='flex gap-2'>
        <Button
          variant='secondary'
          className='flex-1'
          disabled={busy}
          onClick={() => run('card-dismiss')}
        >
          it does not match
        </Button>
        <Button className='flex-1' disabled={busy} onClick={() => run('card-choose', true)}>
          it matches
        </Button>
      </div>
      <div className='flex justify-between text-[11px]'>
        {list.length > 1 ? (
          <button
            type='button'
            className='text-fg-muted hover:text-fg-high'
            onClick={() => setPick(undefined)}
          >
            back to the answers
          </button>
        ) : (
          <span />
        )}
        <button
          type='button'
          disabled={busy}
          className='text-fg-muted hover:text-fg-high'
          onClick={() => run('card-choose', false)}
        >
          save without checking
        </button>
      </div>
    </div>
  );
};

export function AddPersonPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const cards = useMyCards();
  const [fresh, setFresh] = useState<Fresh>();
  const roomId = params.get('room') ?? undefined;
  const [making, setMaking] = useState(false);
  const [failed, setFailed] = useState<'card' | 'relay'>();
  const [copied, setCopied] = useState(false);
  const now = useNow(30_000);
  const room = useMyRooms().find(r => r.id === roomId);
  const card = room?.card;
  useWatchRoom(card?.state === 'waiting' ? roomId : undefined);
  useCardSync();

  /** keep the card as a waiting one; the relay is asked for here */
  const open = (c: Fresh): Promise<string | undefined> =>
    peopleAsk<{ id: string }>('card-open', {
      card: c.b64,
      contactId: c.contactId,
      gen: c.rel.gen,
      j: c.rel.j,
    }).then(
      r => {
        // the room is in the url: a reload or a second mount never makes another
        setParams({ room: r.id }, { replace: true });
        return r.id;
      },
      () => {
        setFailed('relay');
        return undefined;
      },
    );

  /** the card, made the first time it leaves this screen; one per visit */
  const make = async (): Promise<{ id: string; b64: string } | undefined> => {
    if (roomId) {
      const b64 = card?.bytes ?? fresh?.b64;
      return b64 ? { id: roomId, b64 } : undefined;
    }
    if (making || !cards.ready) {
      return undefined;
    }
    setMaking(true);
    setFailed(undefined);
    try {
      const c = fresh ?? (await cards.fresh());
      setFresh(c);
      const id = await open(c);
      return id ? { id, b64: c.b64 } : undefined;
    } catch {
      setFailed('card');
      return undefined;
    } finally {
      setMaking(false);
    }
  };

  // nothing to share until zafu keeps and watches the card's room
  const bytes = roomId ? (card?.bytes ?? fresh?.b64) : undefined;
  const link = bytes ? cardUrl(bytes) : undefined;
  const mark = (id: string, what: 'copied' | 'shared') =>
    void peopleCall('card-mark', { roomId: id, what }).catch(() => undefined);
  const copy = async () => {
    const c = await make();
    if (!c) {
      return;
    }
    await navigator.clipboard.writeText(cardUrl(c.b64)).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
        mark(c.id, 'copied');
      },
      () => undefined,
    );
  };
  const share = async () => {
    if (typeof navigator.share !== 'function') {
      return copy();
    }
    const c = await make();
    if (c) {
      await navigator.share({ url: cardUrl(c.b64) }).then(
        () => mark(c.id, 'shared'),
        () => undefined,
      );
    }
  };
  const allow = () => void requestEgressOptIn(PEOPLE_RELAY);
  const waitedMin = card
    ? Math.max(0, Math.floor((now - (card.copied ?? card.shared ?? card.shown)) / 60_000))
    : 0;
  const waiting = !card || card.state === 'waiting';
  const arrived = card?.state === 'waiting' && !!card.answers?.length;

  return (
    <div className='flex min-h-full flex-col'>
      <ScreenHeader
        title='add a person'
        backPath={PopupPath.INBOX}
        meta={<span className='text-[11px] text-fg-muted'>your card</span>}
      />
      <main className='flex grow flex-col gap-3 px-4 pb-3 pt-3.5'>
        {cards.cannot ? (
          <Cue tone='warn' text='cards need a wallet whose recovery phrase is on this computer' />
        ) : arrived && room ? (
          <Arrived room={room} />
        ) : (
          waiting && (
            <>
              <div className='flex size-[190px] items-center justify-center self-center border border-border-hard bg-[#f6f2e8] p-2.5'>
                {link ? (
                  <QrCode value={link} size={168} label='your card' ecLevel='L' />
                ) : (
                  <Button
                    variant='secondary'
                    disabled={making || !cards.ready}
                    onClick={() => void make()}
                  >
                    show your card
                  </Button>
                )}
              </div>
              <div className='flex h-10 items-center overflow-hidden whitespace-nowrap border border-border-soft bg-elev-1 px-3 text-xs text-fg-muted'>
                zafu.pro/c#
                <span className='truncate text-fg-high'>{bytes ?? ''}</span>
              </div>
              <div className='flex gap-2'>
                <Button
                  variant='secondary'
                  className='flex-1'
                  disabled={making || !cards.ready}
                  onClick={() => void copy()}
                >
                  <span
                    className={cn(copied ? 'i-lucide-check' : 'i-lucide-copy', 'size-4')}
                    aria-hidden='true'
                  />
                  {copied ? 'copied' : 'copy link'}
                </Button>
                <Button
                  variant='secondary'
                  className='flex-1'
                  disabled={making || !cards.ready}
                  onClick={() => void share()}
                >
                  <span className='i-lucide-share size-4' aria-hidden='true' />
                  share
                </Button>
              </div>
            </>
          )
        )}
        {cards.cannot || arrived ? null : failed === 'card' ? (
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
                onClick={() => void make()}
                className='text-zigner-gold hover:underline'
              >
                allow
              </button>
            }
          />
        ) : card?.state === 'answered' ? (
          <Answered contactId={card.contactId} at={card.at} checked={card.checked} />
        ) : card?.state === 'cancelled' || card?.state === 'cancelling' ? (
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
          <Cue
            text={
              link
                ? 'ready for the next person'
                : making
                  ? 'making your card'
                  : 'made when you show, copy or share it'
            }
          />
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
