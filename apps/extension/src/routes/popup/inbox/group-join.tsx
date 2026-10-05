/**
 * join a group (GroupJoin.dc.html) from a code or a link. Reading the door
 * needs the relay, so it is asked for here, at the moment of use. "ask to
 * join" shares your name in that group, never your wallet; the founder lets
 * you in, and the group opens by itself when they do.
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
import type { DoorCard } from '../../../people/groups';
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
  return CODE_RE.test(c) ? c : undefined;
};

type Step =
  | { kind: 'reading' }
  | { kind: 'card'; card: DoorCard }
  | { kind: 'nothing' }
  | { kind: 'no-relay' }
  | { kind: 'unclear' }
  | { kind: 'failed' };

export function GroupJoinPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const code = normalizeCode(params.get('code') ?? '');
  const via = params.get('via');
  const [typed, setTyped] = useState('');
  const [nick, setNick] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'reading' });
  const [asking, setAsking] = useState(false);
  const rooms = useMyRooms();

  const card = step.kind === 'card' ? step.card : undefined;
  const door = card && rooms.find(r => r.id === `d:${card.G}`);
  const joined = card && rooms.find(r => r.id === `g:${card.G}` && r.joined);
  const asked = !!door && !door.group?.mine;
  // while you wait to be let in, the door is read every 4 s
  useWatchRoom(asked && !joined ? door.id : undefined);

  useEffect(() => {
    if (joined) {
      navigate(groupPath(joined.group!.G), { replace: true });
    }
  }, [joined, navigate]);

  useEffect(() => {
    if (!CODE_RE.test(code)) {
      return;
    }
    let live = true;
    setStep({ kind: 'reading' });
    void peopleAsk<DoorCard | null>('door-peek', { code }).then(
      c => live && setStep(c ? { kind: 'card', card: c } : { kind: 'nothing' }),
      (e: unknown) =>
        live &&
        setStep({
          kind: isRelayGated(e)
            ? 'no-relay'
            : e instanceof Error && e.message.includes('unclear')
              ? 'unclear'
              : 'failed',
        }),
    );
    return () => {
      live = false;
    };
  }, [code]);

  const ask = () => {
    setAsking(true);
    void peopleAsk('door-ask', { code, nick: nick.trim() })
      .catch(() => setStep({ kind: 'failed' }))
      .finally(() => setAsking(false));
  };

  if (!CODE_RE.test(code)) {
    return (
      <div className='flex min-h-full flex-col'>
        <ScreenHeader title='join a group' backPath={PopupPath.INBOX} />
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
            placeholder='a code or a zafu.pro/j link'
            value={typed}
            onChange={e => {
              setTyped(e.target.value);
              // a whole code or link pasted in opens at once
              const c = codeIn(e.target.value);
              if (c && e.target.value.length - typed.length > 1) {
                setParams({ code: c, via: 'typed' });
              }
            }}
            autoFocus
          />
          <Button type='submit' disabled={!codeIn(typed)}>
            open
          </Button>
          {OLD_CODE_RE.test(code || normalizeCode(typed)) && (
            <span className='text-[11px] text-fg-muted'>
              this code is from an older zafu. please ask for a new one.
            </span>
          )}
        </form>
      </div>
    );
  }

  const others = card ? Math.max(0, card.count - 1) : 0;
  return (
    <div className='flex min-h-full flex-col'>
      <ScreenHeader title='join a group' backPath={PopupPath.INBOX} />
      <RelaySlot waiting={asked && card ? `waiting for ${card.from} to let you in` : undefined} />
      <div className='flex grow flex-col items-center gap-3 px-4 pb-4 pt-6 text-center'>
        <span className='text-[11px] text-fg-muted'>
          {via === 'typed' ? 'opened from a code' : (viaLine(via) ?? 'opened from a link')}
        </span>
        {step.kind === 'card' ? (
          <>
            <span className='flex size-16 items-center justify-center border border-border-hard bg-elev-1 font-display text-3xl text-zigner-gold'>
              蔵
            </span>
            <span className='text-[13px] text-fg-muted'>{step.card.from} invites you to</span>
            <span className='font-display text-[28px] text-fg-high lowercase'>
              {step.card.group}
            </span>
            <span className='text-[11px] text-fg-muted'>
              group chat · you, {step.card.from}
              {others > 0 ? ` and ${others} more` : ''}
            </span>
          </>
        ) : (
          <span className='py-10 text-[13px] text-fg-muted'>
            {step.kind === 'reading'
              ? 'reading the code'
              : step.kind === 'nothing'
                ? 'this code opens nothing right now. a code works for an hour after it is made.'
                : step.kind === 'no-relay'
                  ? 'a group needs the relay · nothing was read'
                  : step.kind === 'unclear'
                    ? 'this code fits two different people, so zafu will not guess. please ask for a new code.'
                    : 'sorry, zafu could not read this code. please try again.'}
          </span>
        )}
      </div>
      <div className='flex flex-col gap-3 px-4 pb-4'>
        {card && !asked && <NickField value={nick} onChange={setNick} />}
        {card && (
          <span className='flex items-center justify-center gap-1.5 text-center text-[11px] text-fg-muted'>
            <span className='i-lucide-shield size-3 shrink-0' aria-hidden='true' />
            joining shares the name you choose here, or a word name made for this group
          </span>
        )}
        <div className='flex gap-2'>
          <Button
            variant='secondary'
            className='flex-1'
            data-preload={PopupPath.INBOX}
            onClick={() => navigate(PopupPath.INBOX)}
          >
            not now
          </Button>
          <Button
            className='flex-1'
            disabled={!card || asked || asking}
            loading={asking}
            onClick={ask}
          >
            {asked ? 'asked' : 'ask to join'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default GroupJoinPage;
