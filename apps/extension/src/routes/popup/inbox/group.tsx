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
import type { PeopleRoom } from '../../../people/vault';
import { useMemberName } from './use-member-name';
import { SendState } from './send-state';

const dayOf = (s: number) => {
  const w = whenOf(s * 1000);
  return /^\d/.test(w) ? 'today' : w;
};

/** how many people, said as a person would */
export const peopleCount = (n: number) => (n === 1 ? 'just you' : `${n} people`);

/** a shared wallet still filling: "2 of 3 · waiting for 1 more"; a newcomer says no count until the roster is read */
export const waitingLine = (room: PeopleRoom): string | undefined => {
  const want = room.group?.want;
  const members = room.group?.members.length ?? 0;
  if (!want || (!members && !room.group?.mine)) {
    return want && `${want.k} of ${want.n}`;
  }
  const left = want.n - (members || 1);
  return left > 0 ? `${want.k} of ${want.n} · waiting for ${left} more` : undefined;
};

const Line = ({
  item,
  name,
  showName,
  say,
}: {
  item: ThreadItem;
  name: string;
  showName: boolean;
  say: (text: string, retry: string) => void;
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
    <SendState item={item} say={say} />
  </div>
);

export function GroupPage() {
  const navigate = useNavigate();
  const goBack = useBackNav(PopupPath.INBOX);
  const G = useParams()['groupId'] ?? '';
  const roomId = `g:${G}`;
  const rooms = useMyRooms();
  const room = rooms.find(r => r.id === roomId);
  const nameFor = useMemberName(room);
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
  const nameOf = (i: ThreadItem) => (i.mine ? 'you' : nameFor(i.author, i.name));
  const last = items[items.length - 1];
  const memberName = (k: string) => nameFor(k);
  // each wallet's card and each payment sit in the thread where they started
  const { seat, me, keygens } = shared;
  const card = (c?: (typeof keygens)[number]) => (
    <KeyCard
      key={c?.id ?? 'seat'}
      c={c}
      seat={seat}
      me={me}
      roomId={roomId}
      nameOf={memberName}
      onMessage={k => setDraft(`@${memberName(k)} `)}
      onSend={() => setSending(true)}
    />
  );
  const made = seat && keygens.some(c => c.id === seat.multisig?.room?.ceremony);
  const cards = [
    ...keygens.map(c => ({ at: c.at, node: card(c) })),
    // a wallet whose setup records were let go, or an older zafu made: its card from the seat
    ...(seat && !made ? [{ at: -Infinity, node: card() }] : []),
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
            : (waitingLine(room) ?? `group chat · ${peopleCount(room.group?.members.length || 1)}`)
        }
        onInvite={
          room.group?.g && !room.group.gone ? () => navigate(groupInvitePath(G)) : undefined
        }
      />
      <RelaySlot />
      <div
        ref={scroll.ref}
        onScroll={scroll.onScroll}
        className='flex grow flex-col gap-3 overflow-y-auto px-3.5 pb-2 pt-3.5'
      >
        {items.length === 0 && !cards.length && (
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
              {it.kind === 'note' ? (
                <span className='self-center text-center text-[11px] text-fg-dim'>{it.body}</span>
              ) : (
                <Line
                  item={it}
                  name={nameOf(it)}
                  showName={prev?.author !== it.author || prev.mine !== it.mine}
                  say={say}
                />
              )}
            </div>
          );
        })}
        {cardsIn(last?.ts ?? -Infinity, Infinity)}
      </div>
      {shared.older && (
        <span className='shrink-0 border-t border-border-soft px-4 py-2 text-[11px] text-fg-muted'>
          the other side needs a newer zafu to make keys together
        </span>
      )}
      {room.group?.gone ? (
        <span className='shrink-0 border-t border-border-soft px-4 py-3 text-xs text-fg-muted'>
          you&apos;re no longer in this group
        </span>
      ) : (
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
          {room.group?.g?.purpose === 'chat' &&
            !room.group.deal &&
            !seat &&
            !keygens.some(c => !shared.kept[c.id]?.saved) &&
            (room.group.members.length ?? 0) >= 2 && (
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
      )}
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
          members={(room.group?.members ?? []).map(m => ({
            key: m.key,
            name: m.key === shared.me ? 'you' : nameFor(m.key),
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
