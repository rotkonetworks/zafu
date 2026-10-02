/**
 * one group (Group.dc.html), chat only: its lines from the group room on the
 * people relay, oldest first, and a composer. The room is read every 4 s
 * while this screen is open (T2) and not after; nothing here talks to the
 * relay directly, the worker does.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Input } from '@repo/ui/components/ui/input';
import { cn } from '@repo/ui/lib/utils';
import { MessageText } from '../../../components/message-text';
import { useBackNav } from '../../../utils/navigate';
import {
  peopleCall,
  peopleSay,
  useMyRooms,
  useThread,
  useWatchRoom,
} from '../../../people/client';
import { RelaySlot } from '../../../people/relay-slot';
import type { ThreadItem } from '../../../people/vault';
import { PopupPath, groupInvitePath } from '../paths';
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
  const scrollRef = useRef<HTMLDivElement>(null);
  useWatchRoom(room ? roomId : undefined);

  const items = thread?.items ?? [];
  const names = room?.group?.names ?? {};
  const nameOf = (i: ThreadItem) => (i.mine ? 'you' : (names[i.author] ?? i.name));
  const last = items[items.length - 1];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    if (room && last && !last.mine && last.ts > (thread?.read ?? 0)) {
      void peopleCall('read', { roomId }).catch(() => undefined);
    }
  }, [room, roomId, last, thread?.read]);

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
        line={`group chat · ${peopleCount(room.group?.members.length || 1)}`}
        onInvite={room.group?.mine ? () => navigate(groupInvitePath(G)) : undefined}
      />
      <RelaySlot />
      <div ref={scrollRef} className='flex grow flex-col gap-3 overflow-y-auto px-3.5 pb-2 pt-3.5'>
        {items.length === 0 && (
          <span className='self-center text-[11px] text-fg-dim'>no messages yet</span>
        )}
        {items.map((it, i) => {
          const prev = items[i - 1];
          return (
            <div key={it.hash || it.local} className='contents'>
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
        <Input
          aria-label='message'
          placeholder='message the group'
          value={draft}
          maxLength={2000}
          onChange={e => setDraft(e.target.value)}
          className='h-11 min-w-0 grow'
        />
      </form>
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
