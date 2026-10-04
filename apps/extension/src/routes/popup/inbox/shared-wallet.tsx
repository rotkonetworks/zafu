/**
 * A shared wallet in a chat (Cv2GroupMake, Cv2Keygen, Cv2KeygenWait,
 * Cv2GroupDone, Cv2DealKeys): the sheet that starts one, and the card in the
 * thread that shows each member's step, who is missing, and the wallet once
 * every device holds its key. The ceremony itself is people/frost-room.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { CopyButton } from '@repo/ui/components/ui/copy-button';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { cn } from '@repo/ui/lib/utils';
import { formatZecAmount } from '@repo/wallet/networks/zcash/zip321';
import { behind, COURT, majority, mismatched, roundOf, stepOf } from '../../../people/frost-room';
import { startKeys, type FrostView } from '../../../people/use-frost-room';
import { PopupPath } from '../paths';
import { shortAddress } from './threads';

/** a member nobody heard from for this long is shown as not here yet */
const MISSING_S = 120;

const useNow = (ms: number) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
};

const clock = (s: number) =>
  s >= 3600
    ? `${Math.floor(s / 3600)}h`
    : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** the red hanko the boards draw beside a shared-wallet line */
export const Hanko = ({ ch, className }: { ch: string; className?: string }) => (
  <span
    aria-hidden='true'
    className={cn(
      'grid size-[22px] shrink-0 -rotate-6 place-items-center border-2 border-hanko font-display text-xs text-hanko',
      className,
    )}
  >
    {ch}
  </span>
);

const Box = ({ state }: { state: 'done' | 'live' | 'missing' }) => (
  <span
    aria-hidden='true'
    className={cn(
      'size-3.5 shrink-0',
      state === 'done' && 'bg-zigner-gold',
      state === 'live' && 'animate-pulse border-2 border-zigner-gold',
      state === 'missing' && 'border border-border-hard',
    )}
  />
);

/** "3 of 4", or "2 of 3 · zafu court" for a deal with the court */
export const seatsLine = (k: number, members: string[]) =>
  `${k} of ${members.length}${members.includes(COURT) ? ' · zafu court' : ''}`;

interface CardProps {
  view: FrostView;
  roomId: string;
  nameOf: (key: string) => string;
  /** reach a missing member: "message dan" */
  onMessage?: (key: string) => void;
}

/** the card a ceremony draws in its thread, from "making keys" to "ready" */
export const KeyCard = ({ view, roomId, nameOf, onMessage }: CardProps) => {
  const now = useNow(15_000);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const { ceremony: c, seat, me } = view;
  if (!c || !me) {
    return null;
  }
  const mine = c.members.includes(me);
  const round = roundOf(c);
  const late = c.members.length > 0 && now / 1000 - c.last > MISSING_S;
  const missing = late ? behind(c) : [];
  const bad = mismatched(c);
  const label = c.deal ? 'deal' : 'shared wallet';
  const again = (members: string[]) => {
    setBusy(true);
    const n = members.length;
    void startKeys(roomId, members, Math.min(c.k, n) || majority(n), c.label, {
      deal: c.deal,
      replaces: c.id,
    }).finally(() => setBusy(false));
  };
  const rest = c.members.filter(m => !missing.includes(m));
  const who = (m: string) => (m === me ? 'you' : m === COURT ? 'zafu court' : nameOf(m));

  const head = (title: string) => (
    <div className='flex flex-col gap-1.5 px-3.5 py-3'>
      <span className='flex items-center gap-2 text-[11px] text-fg-muted'>
        <Hanko ch={c.deal ? '契' : '蔵'} />
        <span className='grow'>
          {label} · {title}
        </span>
        {!seat && !bad && <span>step {round} of 3</span>}
      </span>
      {c.deal && (
        <span className='font-display text-[26px] text-fg-high'>
          {formatZecAmount(BigInt(c.deal.amount))}{' '}
          <span className='text-sm text-zigner-gold'>zec</span>
        </span>
      )}
      <span className='text-xs text-fg-muted'>
        {c.deal ? `${c.deal.what} · ` : ''}
        {seatsLine(c.k, c.members)}
      </span>
    </div>
  );

  if (seat) {
    return (
      <article className='flex flex-col self-stretch border border-border-hard bg-elev-1'>
        {head(`ready · ${new Date(c.last * 1000).toTimeString().slice(0, 5)}`)}
        <div className='flex flex-col gap-2 border-t border-border-soft px-3.5 py-3'>
          <span className='flex gap-1.5' aria-hidden='true'>
            {Array.from({ length: c.k }, (_, i) => (
              <Hanko key={i} ch='判' />
            ))}
          </span>
          <span className='text-xs text-fg'>
            any {c.k} of you {c.members.length} can send · each holds one key
          </span>
          <span className='font-mono text-[11px] text-fg-muted'>{shortAddress(seat.address)}</span>
        </div>
        <div className='flex gap-2 border-t border-border-soft px-3.5 py-2.5'>
          <CopyButton text={seat.address} label='copy address' />
          <Button
            variant='secondary'
            size='sm'
            className='ml-auto'
            onClick={() =>
              navigate(PopupPath.SEND, {
                state: { prefillRecipient: seat.address, network: 'zcash' },
              })
            }
          >
            add funds
          </Button>
        </div>
      </article>
    );
  }

  return (
    <article className='flex flex-col self-stretch border border-border-hard bg-elev-1'>
      {head(
        bad
          ? 'the keys do not match'
          : missing.length
            ? `waiting for ${missing.map(who).join(', ')}`
            : 'making keys',
      )}
      <div className='border-t border-border-soft'>
        {c.members.map(m => {
          const step = stepOf(c, m);
          const ahead = step >= round || (bad && step === 3);
          const gone = missing.includes(m);
          return (
            <div
              key={m}
              className='flex h-10 items-center gap-2.5 border-t border-border-soft px-3.5 first:border-0'
            >
              <Box state={ahead ? 'done' : gone ? 'missing' : 'live'} />
              <span className='grow truncate text-[13px] text-fg-high'>{who(m)}</span>
              <span className='text-[11px] text-fg-muted'>
                {ahead
                  ? 'done'
                  : gone
                    ? m === COURT
                      ? 'opens later'
                      : 'not here yet'
                    : 'making a share'}
              </span>
            </div>
          );
        })}
      </div>
      {bad ? (
        <div className='flex flex-col gap-2 border-t border-border-soft px-3.5 py-3'>
          <span className='text-xs text-fg'>
            nothing was saved. please make the keys again together.
          </span>
          {mine && (
            <Button size='sm' disabled={busy} onClick={() => again(c.members)}>
              make them again
            </Button>
          )}
        </div>
      ) : missing.length ? (
        <div className='flex flex-col gap-2 border-t border-border-soft px-3.5 py-3'>
          <span className='text-xs text-fg'>
            it waits for {missing.map(who).join(', ')} · nothing is lost ·{' '}
            {clock(now / 1000 - c.last)}
          </span>
          {mine && (
            <div className='flex gap-2'>
              {onMessage && missing.some(m => m !== COURT && m !== me) && (
                <Button
                  variant='secondary'
                  size='sm'
                  className='flex-1'
                  onClick={() => onMessage(missing.find(m => m !== COURT && m !== me)!)}
                >
                  message {who(missing.find(m => m !== COURT && m !== me)!)}
                </Button>
              )}
              {rest.length >= 2 && rest.includes(me) && (
                <Button
                  variant='secondary'
                  size='sm'
                  className='flex-1'
                  disabled={busy}
                  onClick={() => again(rest)}
                >
                  start again without {missing.length > 1 ? 'them' : who(missing[0]!)}
                </Button>
              )}
            </div>
          )}
        </div>
      ) : (
        <span className='border-t border-border-soft px-3.5 py-2 text-[11px] text-fg-dim'>
          each device makes its own share · {clock(Math.max(0, now / 1000 - c.at))}
        </span>
      )}
    </article>
  );
};

/** "seals needed to send": a stepper, from 2 to everyone */
export const Seals = ({ k, n, onK }: { k: number; n: number; onK: (k: number) => void }) => (
  <div className='flex h-14 items-center gap-3 border border-border-soft bg-elev-1 px-3.5'>
    <span className='grow text-xs text-fg-muted'>seals needed to send</span>
    <button
      type='button'
      aria-label='fewer'
      disabled={k <= 2}
      onClick={() => onK(k - 1)}
      className='grid size-10 place-items-center border border-border-soft text-fg-high disabled:text-fg-dim'
    >
      <span className='i-lucide-minus size-4' aria-hidden='true' />
    </button>
    <span className='w-16 text-center font-display text-lg text-fg-high'>
      {k} of {n}
    </span>
    <button
      type='button'
      aria-label='more'
      disabled={k >= n}
      onClick={() => onK(k + 1)}
      className='grid size-10 place-items-center border border-border-soft text-fg-high disabled:text-fg-dim'
    >
      <span className='i-lucide-plus size-4' aria-hidden='true' />
    </button>
  </div>
);

/** "make it a shared wallet": everyone in the room now, and how many must seal */
export const MakeSharedSheet = ({
  open,
  onClose,
  roomId,
  label,
  members,
}: {
  open: boolean;
  onClose: () => void;
  roomId: string;
  label: string;
  members: { key: string; name: string }[];
}) => {
  const n = members.length;
  const [k, setK] = useState(majority(n));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const kk = Math.min(Math.max(2, k), n);
  return (
    <Sheet open={open} onOpenChange={o => !o && onClose()} title='make it a shared wallet'>
      <div className='flex flex-col gap-1.5'>
        <span className='text-[11px] text-fg-muted'>members · everyone in this room · fixed</span>
        <div className='flex flex-wrap gap-1.5'>
          {members.map(m => (
            <span
              key={m.key}
              className='border border-border-soft bg-elev-2 px-2 py-1 text-xs text-fg-high'
            >
              {m.name}
            </span>
          ))}
        </div>
      </div>
      <Seals k={kk} n={n} onK={setK} />
      <span className='text-xs text-fg-muted'>
        any {kk} of you {n} can send · each device holds one key
      </span>
      <span className='h-4 text-[11px] text-hanko-light'>{error}</span>
      <Button
        disabled={busy || n < 2}
        onClick={() => {
          setBusy(true);
          setError('');
          void startKeys(
            roomId,
            members.map(m => m.key),
            kk,
            label,
          ).then(
            () => {
              setBusy(false);
              onClose();
            },
            () => {
              setBusy(false);
              setError('this did not reach the relay. please try again.');
            },
          );
        }}
      >
        make keys together
      </Button>
    </Sheet>
  );
};
