/**
 * a member's door (GroupInvite.dc.html): a code, ways to hand it on, and the
 * people in the group. Anyone in it invites (#110): a code lets one person
 * in, within its hour, answered by the zafu that made it, and both sides see
 * the same two words to compare; "invite another" makes the next. Until a
 * shared wallet's keys are being made, anyone can take someone off: everyone
 * left signs it, and the group moves to a room the removed one cannot read.
 * A shared wallet says how many it still waits for, and opens its thread
 * once full.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { ScreenHeader } from '../../../components/screen-header';
import { toUri, toWebUri } from '../../../links/router';
import { peopleAsk, useMyRooms } from '../../../people/client';
import { RelaySlot } from '../../../people/relay-slot';
import { PopupPath, groupPath } from '../paths';
import { QrCode } from '../../../components/qr-code';
import { doorOpen, doorsOf } from '../../../people/groups';
import { roomIdOf } from '../../../people/lx';
import { useFrostRoom } from '../../../people/use-frost-room';
import { genesisId } from '@zafu/zirc/leaderless';
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

export function GroupInvitePage() {
  const navigate = useNavigate();
  const G = useParams()['groupId'] ?? '';
  const rooms = useMyRooms();
  const room = rooms.find(r => r.id === `g:${G}`);
  const now = Date.now();
  // the newest code that can still let someone in; earlier open ones are listed under it
  const [door, ...earlier] = doorsOf(rooms, G).filter(r => doorOpen(r, now));
  const nameFor = useMemberName(room);
  const { me } = useFrostRoom(room);
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState('');
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
  const remove = (key: string) => {
    setWhy('');
    void peopleAsk('group-remove', { G, key }).catch((e: unknown) =>
      setWhy(e instanceof Error ? e.message : 'this did not leave · please try again'),
    );
  };

  const code = door?.door?.code;
  // before keys: nothing this device signed for the group's own roster in this room
  const signed = room && g?.signed?.room === roomIdOf(room) ? g.signed : undefined;
  const canRemove = !!g?.g && !g.gone && !signed?.r?.[genesisId(g.g)];

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
      {!g?.g || g.gone ? (
        <p className='px-4 py-6 text-sm text-fg-muted'>
          {g?.gone
            ? "you're no longer in this group"
            : 'this group was made with an older zafu · a new group can invite people'}
        </p>
      ) : (
        <div className='flex grow flex-col gap-[18px] overflow-y-auto px-4 pb-4 pt-3.5'>
          <section className='flex flex-col gap-2'>
            <div className='flex items-baseline justify-between'>
              <h2 className='text-xs tracking-[0.04em] text-fg-muted'>invite people</h2>
              <button
                type='button'
                disabled={busy}
                onClick={renew}
                className='text-xs text-zigner-gold hover:underline'
              >
                invite another
              </button>
            </div>
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
                <span className='text-[11px] text-fg-muted'>lets one person in · works for 1h</span>
                <span className='text-[11px] text-fg-dim'>
                  the relay sees the number, never the words
                </span>
              </>
            ) : (
              <span className='text-[13px] text-fg-muted'>each code lets one person in</span>
            )}
            {earlier.map(d => (
              <span key={d.id} className='text-[11px] text-fg-muted'>
                also open · {d.door!.code}
              </span>
            ))}
          </section>
          <section className='flex flex-col gap-1.5'>
            <h2 className='text-xs tracking-[0.04em] text-fg-muted'>people</h2>
            <div className='flex flex-col'>
              {members.map(m => {
                const you = m.key === me;
                const name = you ? 'you' : nameFor(m.key);
                return (
                  <Person
                    key={m.key}
                    initial={name.charAt(0)}
                    name={name}
                    line={m.key === g.founder ? 'created' : 'joined'}
                    action={
                      canRemove &&
                      !you && (
                        <button
                          type='button'
                          onClick={() => remove(m.key)}
                          className='h-8 px-2 text-xs text-fg-muted hover:underline'
                        >
                          remove
                        </button>
                      )
                    }
                  />
                );
              })}
            </div>
            <span className='h-4 text-[11px] text-fg-muted'>{why}</span>
          </section>
          <Button variant='secondary' onClick={() => navigate(groupPath(G))}>
            open the group
          </Button>
        </div>
      )}
    </div>
  );
}

export default GroupInvitePage;
