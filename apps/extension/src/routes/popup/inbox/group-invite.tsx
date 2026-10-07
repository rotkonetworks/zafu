/**
 * the founder's door (GroupInvite.dc.html): the code, ways to hand it on,
 * and the people in the group. A code works for an hour; whoever types its
 * words comes in, and both sides see the same two words to compare. A shared
 * wallet says how many it still waits for, and opens its thread once full.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { ScreenHeader } from '../../../components/screen-header';
import { toUri, toWebUri } from '../../../links/router';
import { peopleAsk, useMyRooms, useWatchRoom } from '../../../people/client';
import { RelaySlot } from '../../../people/relay-slot';
import { PopupPath, groupPath } from '../paths';
import { useStore } from '../../../state';
import { encodeMemoInvite } from '../../../people/memo-door';
import type { PeopleRoom } from '../../../people/vault';
import { DEFAULT_PEOPLE_RELAY } from '../../../config/people-relay';
import { QrCode } from '../../../components/qr-code';
import { useDoors } from '../../../people/use-door';
import { doorId } from '../../../people/groups';
import { ANSWERS_PER_CODE } from '../../../people/door';
import { peopleCount, waitingLine } from './group';
import { useMemberName } from './use-member-name';
import { ShareWays, type ShareWay } from './share-ways';

const shareWays = (code: string): ShareWay[] => [
  { name: 'just the code', meta: 'they type it into zafu · no link at all', text: code },
  {
    name: 'for zafu',
    meta: 'works offline · they paste it into zafu',
    text: toUri({ kind: 'join', code }),
  },
  {
    name: 'for anyone',
    meta: 'opens zafu.pro, which sees a visit, never the code',
    text: toWebUri({ kind: 'join', code }),
  },
];

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
  const door = rooms.find(r => r.id === doorId(G));
  const nameFor = useMemberName(room);
  const [busy, setBusy] = useState(false);
  const open = !!door?.door && (door.until ?? 0) > Date.now();
  useWatchRoom(open ? door.id : undefined);
  useWatchRoom(room?.id);
  useDoors();
  const g = room?.group;
  const members = g?.members ?? [];
  const full = !!g?.want && members.length >= g.want.n;
  // a shared wallet with everyone in: its keys are made in its thread
  useEffect(() => {
    if (full) {
      navigate(groupPath(G), { replace: true });
    }
  }, [full, G, navigate]);

  const renew = () => {
    setBusy(true);
    void peopleAsk('group-renew', { G })
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  // a code answers a dozen runs: anyone with its number can spend them, so then it is closed too
  const spent = (door?.door?.answered?.length ?? 0) >= ANSWERS_PER_CODE;
  const code = open && !spent ? door.door!.code : undefined;
  const words = door?.door?.answered ?? [];

  return (
    <div className='flex h-full flex-col'>
      <ScreenHeader
        title={room?.name ?? 'a group'}
        backPath={PopupPath.INBOX}
        meta={
          room
            ? (waitingLine(room) ?? `group chat · ${peopleCount(members.length || 1)}`)
            : undefined
        }
      />
      <RelaySlot />
      {!g?.mine ? (
        <p className='px-4 py-6 text-sm text-fg-muted'>
          only the person who made the group invites
        </p>
      ) : (
        <div className='flex grow flex-col gap-[18px] overflow-y-auto px-4 pb-4 pt-3.5'>
          <section className='flex flex-col gap-2'>
            <h2 className='text-xs tracking-[0.04em] text-fg-muted'>invite people</h2>
            {code ? (
              <>
                <span className='font-display text-[26px] text-fg-high'>{code}</span>
                <QrCode
                  value={toWebUri({ kind: 'join', code })}
                  size={168}
                  label='the code'
                  ecLevel='L'
                />
                <ShareWays ways={shareWays(code)} />
                <span className='text-[11px] text-fg-muted'>
                  works for 1h · whoever types its words comes in
                </span>
                <span className='text-[11px] text-fg-dim'>
                  the relay sees the number, never the words
                </span>
              </>
            ) : (
              <div className='flex items-center justify-between gap-3'>
                <span className='text-[13px] text-fg-muted'>
                  {spent ? 'the last code answered all it can' : 'the last code has closed'}
                </span>
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
                const you = m.key === g.founder;
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
            {words.length > 0 && (
              <span className='text-[11px] text-fg-dim'>
                words to compare, if you like: {words.map(w => w.words).join(' · ')}
              </span>
            )}
          </section>
          {room && <ByMemo room={room} />}
          <Button variant='secondary' onClick={() => navigate(groupPath(G))}>
            open the group
          </Button>
        </div>
      )}
    </div>
  );
}

export default GroupInvitePage;
