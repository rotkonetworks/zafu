/**
 * one group (Group.dc.html), chat only: its lines from the group room on the
 * people relay, oldest first, and a composer. The room is read every 4 s
 * while this screen is open (T2) and not after; nothing here talks to the
 * relay directly, the worker does.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Input } from '@repo/ui/components/ui/input';
import { cn } from '@repo/ui/lib/utils';
import { MessageText } from '../../../components/message-text';
import { useBackNav } from '../../../utils/navigate';
import { peopleCall, peopleSay, useMyRooms, useThread, useWatchRoom } from '../../../people/client';
import { RelaySlot } from '../../../people/relay-slot';
import type { ThreadItem } from '../../../people/vault';
import { useFrostRoom } from '../../../people/use-frost-room';
import { useSharedBalance } from '../../../hooks/use-shared-balance';
import { useStickToBottom } from '../../../hooks/use-stick-to-bottom';
import { fmtZec } from '../home/format';
import { PopupPath, groupInvitePath } from '../paths';
import { KeyCard, MakeSharedSheet } from './shared-wallet';
import { PaymentCard, ProposeSheet } from './payments';
import { usePasswordGate } from '../../../hooks/password-gate';
import { whenOf } from './threads';

const dayOf = (s: number) => {
  const w = whenOf(s * 1000);
  return /^\d/.test(w) ? 'today' : w;
};

/** how many people, said as a person would */
export const peopleCount = (n: number) => (n === 1 ? 'just you' : `${n} people`);

const Line = ({
  item,
  name,
  showName,
  onRetry,
}: {
  item: ThreadItem;
  name: string;
  showName: boolean;
  onRetry: () => void;
}) => (
  <div className={cn('flex max-w-[78%] flex-col gap-1', item.mine ? 'self-end' : 'self-start')}>
    {showName && !item.mine && <span className='text-[11px] text-fg-muted'>{name}</span>}
    <span
      className={cn(
        'whitespace-pre-wrap break-words border px-3 py-[9px] text-[13px] leading-normal text-fg-high',
        item.mine ? 'border-gold-line bg-zigner-gold/10' : 'border-border-soft bg-elev-1',
        item.kind === 'action' && 'italic',
      )}
    >
      {item.kind === 'action' && `${name} `}
      <MessageText text={item.body} />
    </span>
    {item.status === 'sending' && (
      <span className='self-end text-[11px] text-fg-muted'>sending</span>
    )}
    {item.status === 'failed' && (
      <span className='flex gap-2 self-end text-[11px] text-hanko-light'>
        this did not reach the relay
        <button type='button' className='text-zigner-gold hover:underline' onClick={onRetry}>
          try again
        </button>
      </span>
    )}
  </div>
);

export function GroupPage() {
  const navigate = useNavigate();
  const goBack = useBackNav(PopupPath.INBOX);
  const G = useParams()['groupId'] ?? '';
  const roomId = `g:${G}`;
  const room = useMyRooms().find(r => r.id === roomId);
  const thread = useThread(room);
  const [draft, setDraft] = useState('');
  const [making, setMaking] = useState(false);
  const [sending, setSending] = useState(false);
  const { requestAuth, PasswordModal } = usePasswordGate();
  useWatchRoom(room ? roomId : undefined);
  const shared = useFrostRoom(room);
  const held = useSharedBalance(shared.seat);
  const ms = shared.seat?.multisig;

  const items = thread?.items ?? [];
  const names = room?.group?.names ?? {};
  const nameOf = (i: ThreadItem) => (i.mine ? 'you' : (names[i.author] ?? i.name));
  const last = items[items.length - 1];
  const memberName = (k: string) => names[k] ?? k.slice(0, 8);
  // the key card and each payment sit in the thread where they started
  const c = shared.ceremony;
  const { seat, me } = shared;
  const cards = [
    ...(c
      ? [
          {
            at: c.at,
            node: (
              <KeyCard
                key={c.id}
                view={shared}
                roomId={roomId}
                nameOf={memberName}
                onMessage={k => setDraft(`@${memberName(k)} `)}
                onSend={() => setSending(true)}
              />
            ),
          },
        ]
      : []),
    ...(room && seat && me
      ? shared.payments.map(p => ({
          at: p.at,
          node: (
            <PaymentCard
              key={p.id}
              p={p}
              room={room}
              seat={seat}
              me={me}
              kept={shared.kept[p.id]}
              nameOf={memberName}
              requestAuth={requestAuth}
            />
          ),
        }))
      : []),
  ];
  const cardsIn = (from: number, to: number) =>
    cards.filter(x => x.at > from && x.at <= to).map(x => x.node);

  // the view moves for a new line or card, never for a room record changing one
  const scroll = useStickToBottom(items.length + cards.length, !!last?.mine);
  const here = !!room;
  useEffect(() => {
    if (here && last && !last.mine && last.ts > (thread?.read ?? 0)) {
      void peopleCall('read', { roomId }).catch(() => undefined);
    }
  }, [here, roomId, last, thread?.read]);

  const say = (text: string, retry?: string) =>
    void peopleSay(roomId, text, retry).catch(() => undefined);

  if (!room) {
    return (
      <div className='flex h-full flex-col'>
        <Header onBack={goBack} name='a group' line='not on this wallet' />
        <p className='px-4 py-6 text-sm text-fg-muted'>this group is not in this wallet</p>
      </div>
    );
  }

  return (
    <div className='flex h-full flex-col'>
      <Header
        onBack={goBack}
        name={room.name}
        line={
          ms
            ? `${ms.threshold} of ${ms.maxSigners} · ${held === undefined ? '…' : held ? fmtZec(Number(held) / 1e8, 4) : '0.00'} zec shared`
            : `group chat · ${peopleCount(room.group?.members.length || 1)}`
        }
        onInvite={room.group?.mine ? () => navigate(groupInvitePath(G)) : undefined}
      />
      <RelaySlot />
      <div
        ref={scroll.ref}
        onScroll={scroll.onScroll}
        className='flex grow flex-col gap-3 overflow-y-auto px-3.5 pb-2 pt-3.5'
      >
        {items.length === 0 && !c && (
          <span className='self-center text-[11px] text-fg-dim'>no messages yet</span>
        )}
        {items.map((it, i) => {
          const prev = items[i - 1];
          return (
            <div key={it.hash || it.local} className='contents'>
              {cardsIn(prev?.ts ?? -Infinity, it.ts)}
              {dayOf(it.ts) !== (prev ? dayOf(prev.ts) : '') && (
                <span className='self-center text-[11px] text-fg-dim'>{dayOf(it.ts)}</span>
              )}
              <Line
                item={it}
                name={nameOf(it)}
                showName={prev?.author !== it.author || prev.mine !== it.mine}
                onRetry={() => say(it.kind === 'action' ? `/me ${it.body}` : it.body, it.local)}
              />
            </div>
          );
        })}
        {cardsIn(last?.ts ?? -Infinity, Infinity)}
      </div>
      <form
        className='flex shrink-0 gap-2 border-t border-border-soft px-3 pb-3 pt-2.5'
        onSubmit={e => {
          e.preventDefault();
          const text = draft.trim();
          if (text) {
            setDraft('');
            say(text);
          }
        }}
      >
        {!shared.ceremony && !shared.seat && (room.group?.members.length ?? 0) >= 2 && (
          <button
            type='button'
            aria-label='make it a shared wallet'
            onClick={() => setMaking(true)}
            className='grid size-11 shrink-0 place-items-center border border-border-soft bg-elev-2 text-zigner-gold hover:bg-border-soft'
          >
            <span className='i-lucide-plus size-[18px]' aria-hidden='true' />
          </button>
        )}
        <Input
          aria-label='message'
          placeholder='message the group'
          value={draft}
          maxLength={2000}
          onChange={e => setDraft(e.target.value)}
          className='h-11 min-w-0 grow'
        />
      </form>
      {PasswordModal}
      {seat && (
        <ProposeSheet
          open={sending}
          onClose={() => setSending(false)}
          room={room}
          seat={seat}
          requestAuth={requestAuth}
        />
      )}
      {shared.me && (
        <MakeSharedSheet
          open={making}
          onClose={() => setMaking(false)}
          roomId={roomId}
          label={room.name}
          deal={room.group?.deal}
          members={(room.group?.members ?? []).map(m => ({
            key: m.key,
            name: m.key === shared.me ? 'you' : m.name,
          }))}
        />
      )}
    </div>
  );
}

const Header = ({
  onBack,
  name,
  line,
  onInvite,
}: {
  onBack: () => void;
  name: string;
  line: string;
  onInvite?: () => void;
}) => (
  <header className='flex h-16 shrink-0 items-center gap-1.5 border-b border-border-soft px-2'>
    <button
      type='button'
      aria-label='back'
      onClick={onBack}
      className='grid h-10 w-9 shrink-0 place-items-center text-fg-muted hover:text-fg-high'
    >
      <span className='i-lucide-chevron-left size-[18px]' />
    </button>
    <span className='flex size-9 shrink-0 items-center justify-center border border-border-hard bg-elev-1 font-display text-[17px] text-zigner-gold'>
      蔵
    </span>
    <span className='flex min-w-0 grow flex-col gap-[3px] pl-1'>
      <span className='truncate font-display text-[17px] text-fg-high lowercase'>{name}</span>
      <span className='truncate text-[11px] text-fg-muted'>{line}</span>
    </span>
    {onInvite && (
      <button
        type='button'
        aria-label='invite people'
        onClick={onInvite}
        className='grid size-10 shrink-0 place-items-center text-fg-muted transition-colors hover:bg-elev-2 hover:text-fg-high'
      >
        <span className='i-lucide-user-plus size-[18px]' aria-hidden='true' />
      </button>
    )}
  </header>
);

export default GroupPage;
