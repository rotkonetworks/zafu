/**
 * the founder's door (GroupInvite.dc.html): the code, three ways to hand it
 * on, and the people in the group with whoever is asking to join. A code
 * works for an hour; each person is let in by hand.
 */

import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useCopy } from '@repo/ui/hooks/use-copy';
import { Button } from '@repo/ui/components/ui/button';
import { cn } from '@repo/ui/lib/utils';
import { ScreenHeader } from '../../../components/screen-header';
import { toUri } from '../../../links/router';
import { peopleAsk, useMyRooms, useWatchRoom } from '../../../people/client';
import { RelaySlot } from '../../../people/relay-slot';
import { PopupPath, groupPath } from '../paths';
import { useStore } from '../../../state';
import { encodeMemoInvite } from '../../../people/memo-door';
import type { PeopleRoom } from '../../../people/vault';
import { DEFAULT_PEOPLE_RELAY } from '../../../config/people-relay';
import { peopleCount } from './group';
import { JoinAsks } from './join-asks';
import { useMemberName } from './use-member-name';

const Share = ({ code }: { code: string }) => {
  const { copy } = useCopy();
  const [copied, setCopied] = useState(-1);
  const ways = [
    { name: 'copy code', meta: 'they paste it into zafu · no link at all', text: code },
    {
      name: 'copy zafu: link',
      meta: 'private · opens zafu directly',
      text: toUri({ kind: 'join', code }),
    },
    {
      name: 'copy web link',
      meta: 'for people without zafu · zafu.pro sees a visit, never the code',
      text: `https://zafu.pro/j#${code}`,
    },
  ];
  return (
    <div className='flex flex-col border border-border-soft bg-elev-1'>
      {ways.map((w, i) => (
        <button
          key={w.name}
          type='button'
          onClick={() => {
            copy(w.text);
            setCopied(i);
          }}
          className='flex h-14 items-center gap-3 border-t border-border-soft px-3.5 text-left first:border-t-0 hover:bg-elev-2'
        >
          <span className='flex min-w-0 grow flex-col gap-[3px]'>
            <span className='text-[13px] text-fg-high'>{w.name}</span>
            <span className='truncate text-[11px] text-fg-muted'>{w.meta}</span>
          </span>
          <span className={cn('text-xs', copied === i ? 'text-success' : 'text-zigner-gold')}>
            {copied === i ? 'copied' : 'copy'}
          </span>
        </button>
      ))}
    </div>
  );
};

const Person = ({
  initial,
  name,
  line,
  action,
}: {
  initial: string;
  name: string;
  line?: string;
  action?: React.ReactNode;
}) => (
  <div className='flex h-14 items-center gap-3 px-1'>
    <span className='flex size-8 shrink-0 items-center justify-center bg-elev-2 text-sm text-fg-high lowercase'>
      {initial}
    </span>
    <span className='flex min-w-0 grow flex-col gap-[3px]'>
      <span className='truncate text-sm text-fg-high'>{name}</span>
      {line && <span className='truncate text-[11px] text-fg-muted'>{line}</span>}
    </span>
    {action}
  </div>
);

/**
 * someone you already have an address for: the invite goes in a memo, which
 * is end-to-end encrypted to them, so it carries the room itself (the memo
 * door). No code, no relay round trip, and no allow step: sending it is yours.
 */
const ByMemo = ({ room }: { room: PeopleRoom }) => {
  const navigate = useNavigate();
  const contacts = useStore(s => s.contacts.contacts);
  const [fail, setFail] = useState(false);
  const reachable = (Array.isArray(contacts) ? contacts : []).flatMap(c => {
    const a = c.addresses.find(x => x.network === 'zcash');
    return a ? [{ c, address: a.address }] : [];
  });
  if (!reachable.length || !room.group) {
    return null;
  }
  const g = room.group;
  const send = (address: string) => {
    try {
      const memo = encodeMemoInvite({
        kind: 'group',
        secret: room.secret,
        G: g.G,
        founder: g.founder,
        group: room.name,
        from: g.names?.[g.founder] ?? '',
        // '' is the built-in relay; anything else travels with the invite
        relay: room.relay === DEFAULT_PEOPLE_RELAY ? '' : room.relay,
      });
      navigate(PopupPath.SEND, {
        state: { prefillRecipient: address, prefillMemo: memo, network: 'zcash' },
      });
    } catch {
      setFail(true);
    }
  };
  return (
    <section className='flex flex-col gap-1.5'>
      <h2 className='text-xs tracking-[0.04em] text-fg-muted'>invite by memo</h2>
      <div className='flex flex-col'>
        {reachable.map(({ c, address }) => (
          <Person
            key={c.id}
            initial={c.name.charAt(0)}
            name={c.name}
            action={
              <button
                type='button'
                onClick={() => send(address)}
                className='h-8 px-2 text-xs text-zigner-gold hover:underline'
              >
                send
              </button>
            }
          />
        ))}
      </div>
      {fail && (
        <span className='text-[11px] text-hanko-light'>
          sorry, this invite does not fit in a memo. please share the code instead.
        </span>
      )}
    </section>
  );
};

export function GroupInvitePage() {
  const navigate = useNavigate();
  const G = useParams()['groupId'] ?? '';
  const rooms = useMyRooms();
  const room = rooms.find(r => r.id === `g:${G}`);
  const door = rooms.find(r => r.id === `d:${G}`);
  const nameFor = useMemberName(room);
  const [busy, setBusy] = useState(false);
  const open = !!door && (door.until ?? 0) > Date.now();
  useWatchRoom(open ? door.id : undefined);

  const renew = () => {
    setBusy(true);
    void peopleAsk('group-renew', { G })
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  const members = room?.group?.members ?? [];

  return (
    <div className='flex h-full flex-col'>
      <ScreenHeader
        title={room?.name ?? 'a group'}
        backPath={PopupPath.INBOX}
        meta={room ? `group chat · ${peopleCount(members.length || 1)}` : undefined}
      />
      <RelaySlot />
      {!room?.group?.mine ? (
        <p className='px-4 py-6 text-sm text-fg-muted'>
          only the person who made the group invites
        </p>
      ) : (
        <>
          <JoinAsks room={room} door={open ? door : undefined} />
          <div className='flex grow flex-col gap-[18px] overflow-y-auto px-4 pb-4 pt-3.5'>
            <section className='flex flex-col gap-2'>
              <h2 className='text-xs tracking-[0.04em] text-fg-muted'>invite people</h2>
              {open && door.group?.code ? (
                <>
                  <span className='font-display text-[26px] text-fg-high'>{door.group.code}</span>
                  <Share code={door.group.code} />
                  <span className='text-[11px] text-fg-muted'>
                    works for 1h · you allow each person
                  </span>
                  <span className='text-[11px] text-fg-dim'>
                    anyone with the code sees the group's name and who asks · the invite stays
                    sealed
                  </span>
                </>
              ) : (
                <div className='flex items-center justify-between gap-3'>
                  <span className='text-[13px] text-fg-muted'>the last code has closed</span>
                  <button
                    type='button'
                    disabled={busy}
                    onClick={renew}
                    className='text-xs text-zigner-gold hover:underline'
                  >
                    make a new code
                  </button>
                </div>
              )}
            </section>
            <section className='flex flex-col gap-1.5'>
              <h2 className='text-xs tracking-[0.04em] text-fg-muted'>people</h2>
              <div className='flex flex-col'>
                {members.map(m => {
                  const you = m.key === room.group?.founder;
                  const name = you ? 'you' : nameFor(m.key);
                  return (
                    <Person
                      key={m.key}
                      initial={name.charAt(0)}
                      name={name}
                      line={you ? 'created' : 'joined'}
                    />
                  );
                })}
              </div>
            </section>
            <ByMemo room={room} />
            <Button variant='secondary' onClick={() => navigate(groupPath(G))}>
              open the group
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

export default GroupInvitePage;
