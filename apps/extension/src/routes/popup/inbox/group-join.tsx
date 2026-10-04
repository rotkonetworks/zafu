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
import { CODE_RE, OLD_CODE_RE, normalizeCode } from '../../../people/protocol';
import type { DoorCard } from '../../../people/groups';
import { PopupPath, groupPath } from '../paths';

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
          kind:
            e instanceof Error && /not allowed yet|blocked/.test(e.message)
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
    void peopleAsk('door-ask', { code })
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
            setParams({ code: normalizeCode(typed), via: 'typed' });
          }}
        >
          <Input
            aria-label='code'
            placeholder='673-chaos-mail-kite'
            value={typed}
            onChange={e => setTyped(e.target.value)}
            autoFocus
          />
          <Button type='submit' disabled={!CODE_RE.test(normalizeCode(typed))}>
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
        {card && (
          <span className='flex items-center justify-center gap-1.5 text-[11px] text-fg-muted'>
            <span className='i-lucide-shield size-3' aria-hidden='true' />
            joining shares your name, not your wallet
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
