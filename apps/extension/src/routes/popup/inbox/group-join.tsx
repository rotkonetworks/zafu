/**
 * come in by a code (GroupJoin.dc.html), typed or from a link. The number
 * finds the door's mailbox on the relay; the words stay here and are checked
 * with the person who made the code, the magic wormhole way (people/door).
 * Right words, and the group opens by itself; wrong ones are said at once.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { ScreenHeader } from '../../../components/screen-header';
import { viaLine } from '../../../links/land';
import { peopleAsk, useMyRooms, useWatchRoom } from '../../../people/client';
import { RelaySlot } from '../../../people/relay-slot';
import { CODE_RE, OLD_CODE_RE, isRelayGated, normalizeCode } from '../../../people/protocol';
import { OLDER_CODE } from '../../../people/groups';
import { doorView, type DoorView } from '../../../people/door-run';
import { useDoors } from '../../../people/use-door';
import { PopupPath, groupPath } from '../paths';
import { looksLikeLink, parseLink } from '../../../links/router';
import { NickField } from './nick-field';

/** the code in what was typed or pasted: a bare code, or a zafu: or zafu.pro/j link */
const codeIn = (text: string): string | undefined => {
  if (looksLikeLink(text)) {
    const p = parseLink(text);
    return p.ok && p.intent.kind === 'join' ? p.intent.code : undefined;
  }
  const c = normalizeCode(text);
  return CODE_RE.test(c) || OLD_CODE_RE.test(c) ? c : undefined;
};

const SAY: Record<DoorView | 'older' | 'no-relay' | 'failed', string> = {
  reading: 'reading the code',
  waiting: 'waiting for them · zafu lets you in when they next open zafu, within the hour',
  nothing:
    'nothing answers this code yet. a code works for an hour; one from an older zafu needs them to update.',
  newer: 'their zafu is newer than this one. please update zafu, then try the code again.',
  wrong: "those words don't match this code. nothing was shared · please check them and try again.",
  closed: 'this code has closed. please ask for a new one.',
  in: 'you are in',
  older: 'this code is from an older zafu. the other side needs a newer zafu.',
  'no-relay': 'a code needs the relay · nothing was read',
  failed: 'something broke on our side, not yours. nothing was shared · please try again.',
};

export function GroupJoinPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const code = normalizeCode(params.get('code') ?? '');
  const via = params.get('via');
  const [typed, setTyped] = useState('');
  const [nick, setNick] = useState('');
  const [fail, setFail] = useState<'older' | 'no-relay' | 'failed'>();
  const [roomId, setRoomId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const rooms = useMyRooms();
  const door = rooms.find(r => r.id === roomId);
  const view = doorView(door, Date.now());
  useWatchRoom(roomId && view !== 'in' ? roomId : undefined);
  useDoors();

  useEffect(() => {
    const G = door?.door?.G;
    if (G && rooms.some(r => r.id === `g:${G}`)) {
      navigate(groupPath(G), { replace: true });
    }
  }, [door, rooms, navigate]);

  const join = (c: string) => {
    setBusy(true);
    setFail(undefined);
    void peopleAsk<{ id: string }>('door-open', { code: c, nick: nick.trim() })
      .then(
        ({ id }) => setRoomId(id),
        (e: unknown) =>
          setFail(
            e instanceof Error && e.message.includes(OLDER_CODE)
              ? 'older'
              : isRelayGated(e)
                ? 'no-relay'
                : 'failed',
          ),
      )
      .finally(() => setBusy(false));
  };

  // a typed code was the yes; a link waits for one tap
  useEffect(() => {
    if (code && via === 'typed' && !roomId) {
      join(code);
    }
  }, [code]);

  const shown = fail ?? (roomId ? view : undefined);
  return (
    <div className='flex min-h-full flex-col'>
      <ScreenHeader title='join with a code' backPath={PopupPath.INBOX} />
      <RelaySlot />
      {!code ? (
        <form
          className='flex flex-col gap-3 px-4 py-[18px]'
          onSubmit={e => {
            e.preventDefault();
            const c = codeIn(typed);
            if (c) {
              setParams({ code: c, via: 'typed' });
            }
          }}
        >
          <Input
            aria-label='code'
            placeholder='7-fern-dusk, or a zafu.pro/j link'
            value={typed}
            onChange={e => setTyped(e.target.value)}
            autoFocus
          />
          <NickField value={nick} onChange={setNick} />
          <Button type='submit' disabled={!codeIn(typed)}>
            join
          </Button>
          <span className='flex items-center gap-1.5 text-[11px] text-fg-muted'>
            <span className='i-lucide-shield size-3 shrink-0' aria-hidden='true' />
            the relay sees the number, never the words
          </span>
        </form>
      ) : (
        <div className='flex grow flex-col items-center gap-3 px-4 pb-4 pt-6 text-center'>
          <span className='text-[11px] text-fg-muted'>
            {via === 'typed' ? 'opened from a code' : (viaLine(via) ?? 'opened from a link')}
          </span>
          <span className='flex size-16 items-center justify-center border border-border-hard bg-elev-1 font-display text-3xl text-zigner-gold'>
            蔵
          </span>
          <span className='font-display text-[22px] text-fg-high'>{code}</span>
          <span className='min-h-12 py-2 text-[13px] text-fg-muted'>
            {shown ? SAY[shown] : roomId || busy ? SAY.reading : 'someone shared a code with you'}
          </span>
          <div className='mt-auto flex w-full gap-2'>
            <Button
              variant='secondary'
              className='flex-1'
              data-preload={PopupPath.INBOX}
              onClick={() => navigate(PopupPath.INBOX)}
            >
              {shown === 'waiting' ? 'close' : 'not now'}
            </Button>
            {!roomId && !fail && via !== 'typed' && (
              <Button className='flex-1' disabled={busy} onClick={() => join(code)}>
                join
              </Button>
            )}
            {(shown === 'wrong' || shown === 'closed' || fail) && (
              <Button
                className='flex-1'
                disabled={busy}
                onClick={() => {
                  setRoomId(undefined);
                  setFail(undefined);
                  setParams({});
                }}
              >
                another code
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default GroupJoinPage;
