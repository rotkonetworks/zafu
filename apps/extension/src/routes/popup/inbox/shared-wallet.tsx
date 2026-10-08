/**
 * A shared wallet in a chat (Cv2GroupMake, Cv2Keygen, Cv2KeygenWait,
 * Cv2GroupDone): the sheet that proposes one, and the card in the thread that
 * shows who agreed, each member's step, who is missing, and the wallet once
 * every device holds its key. The key setup itself is people/frost-room.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { CopyButton } from '@repo/ui/components/ui/copy-button';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { cn } from '@repo/ui/lib/utils';
import {
  majority,
  missingOf,
  mismatched,
  restartOf,
  roundOf,
  stepOf,
  type Keygen,
} from '../../../people/frost-room';
import { agree, proposeWallet } from '../../../people/use-frost-room';
import type { ZcashWalletJson } from '../../../state/wallets';
import { PopupPath } from '../paths';
import { shortAddress } from './threads';

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

interface CardProps {
  /** a wallet being made; none for a seat an older zafu made */
  c?: Keygen;
  seat?: ZcashWalletJson;
  me?: string;
  roomId: string;
  nameOf: (key: string) => string;
  /** reach a missing member: "message dan" */
  onMessage?: (key: string) => void;
  /** propose a payment from the finished wallet */
  onSend?: () => void;
}

const Head = ({ title, k, n, step }: { title: string; k: number; n: number; step?: number }) => (
  <div className='flex flex-col gap-1.5 px-3.5 py-3'>
    <span className='flex items-center gap-2 text-[11px] text-fg-muted'>
      <Hanko ch='蔵' />
      <span className='grow'>shared wallet · {title}</span>
      {step !== undefined && <span>step {step} of 3</span>}
    </span>
    <span className='text-xs text-fg-muted'>
      {k} of {n}
    </span>
  </div>
);

/** the card a wallet draws in its thread, from "agree" to "ready" */
export const KeyCard = ({ c, seat, me, roomId, nameOf, onMessage, onSend }: CardProps) => {
  const now = useNow(15_000);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const ms = seat?.multisig;
  if (seat && ms && (!c || c.id === ms.room?.ceremony)) {
    return (
      <article className='flex flex-col self-stretch border border-border-hard bg-elev-1'>
        <Head title='ready' k={ms.threshold} n={ms.maxSigners} />
        <div className='flex flex-col gap-2 border-t border-border-soft px-3.5 py-3'>
          <span className='flex gap-1.5' aria-hidden='true'>
            {Array.from({ length: ms.threshold }, (_, i) => (
              <Hanko key={i} ch='判' />
            ))}
          </span>
          <span className='text-xs text-fg'>
            any {ms.threshold} of you {ms.maxSigners} can send · each holds one key
          </span>
          <span className='font-mono text-[11px] text-fg-muted'>{shortAddress(seat.address)}</span>
        </div>
        {!ms.backedUpAt && (
          <button
            type='button'
            onClick={() => navigate(PopupPath.SETTINGS_MULTISIG_BACKUP)}
            className='flex min-h-11 items-center gap-2.5 border-t border-border-soft px-3.5 py-2 text-left hover:bg-elev-2'
          >
            <span className='size-3.5 shrink-0 border border-warn' aria-hidden='true' />
            <span className='flex grow flex-col gap-0.5'>
              <span className='text-xs text-fg-high'>back up your key</span>
              <span className='text-[11px] text-warn'>not in your recovery phrase</span>
            </span>
            <span className='i-lucide-chevron-right size-4 text-fg-muted' aria-hidden='true' />
          </button>
        )}
        <div className='flex gap-2 border-t border-border-soft px-3.5 py-2.5'>
          <CopyButton text={seat.address} label='copy address' />
          {onSend && (
            <Button variant='secondary' size='sm' className='ml-auto' onClick={onSend}>
              send from it
            </Button>
          )}
          <Button
            variant='secondary'
            size='sm'
            className={onSend ? '' : 'ml-auto'}
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
  if (!c || !me) {
    return null;
  }
  const mine = c.members.includes(me);
  const round = roundOf(c);
  const missing = missingOf(c, now / 1000);
  const bad = mismatched(c);
  const n = c.members.length;
  const again = (members: string[], k: number) => {
    setBusy(true);
    void proposeWallet(roomId, members, k).finally(() => setBusy(false));
  };
  const rest = restartOf(c, missing);
  const who = (m: string) => (m === me ? 'you' : nameOf(m));
  const toAgree = mine && !c.bound && !c.agreed.has(me) && !c.rival;

  return (
    <article className='flex flex-col self-stretch border border-border-hard bg-elev-1'>
      <Head
        title={
          bad
            ? 'the keys do not match'
            : c.rival
              ? 'two rosters were proposed'
              : missing.length
                ? `waiting for ${missing.map(who).join(', ')}`
                : 'making keys'
        }
        k={c.k}
        n={n}
        step={c.bound && !bad ? round : undefined}
      />
      <div className='border-t border-border-soft'>
        {c.members.map(m => {
          const step = stepOf(c, m);
          const ahead = c.bound ? step >= round || (bad && step === 3) : c.agreed.has(m);
          const gone = missing.includes(m);
          return (
            <div
              key={m}
              className='flex h-10 items-center gap-2.5 border-t border-border-soft px-3.5 first:border-0'
            >
              <Box state={ahead ? 'done' : gone ? 'missing' : 'live'} />
              <span className='grow truncate text-[13px] text-fg-high'>{who(m)}</span>
              <span className='text-[11px] text-fg-muted'>
                {!c.bound
                  ? c.agreed.has(m)
                    ? 'agreed'
                    : 'to agree'
                  : ahead
                    ? 'done'
                    : gone
                      ? 'not here yet'
                      : 'making a share'}
              </span>
            </div>
          );
        })}
      </div>
      {toAgree ? (
        <div className='flex flex-col gap-2 border-t border-border-soft px-3.5 py-3'>
          <span className='text-xs text-fg'>
            {who(c.by)} asks to make a shared wallet together · any {c.k} of {n} can send
          </span>
          <Button
            size='sm'
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void agree(roomId, c.id).finally(() => setBusy(false));
            }}
          >
            agree and make keys
          </Button>
        </div>
      ) : c.rival ? (
        <span className='border-t border-border-soft px-3.5 py-2 text-[11px] text-fg-dim'>
          two rosters were proposed · we&apos;ll settle on one
        </span>
      ) : bad ? (
        <div className='flex flex-col gap-2 border-t border-border-soft px-3.5 py-3'>
          <span className='text-xs text-fg'>
            nothing was saved. please make the keys again together.
          </span>
          {mine && (
            <Button size='sm' disabled={busy} onClick={() => again(c.members, c.k)}>
              make them again
            </Button>
          )}
        </div>
      ) : missing.length ? (
        <div className='flex flex-col gap-2 border-t border-border-soft px-3.5 py-3'>
          <span className='text-xs text-fg'>
            it waits for {missing.map(who).join(', ')} · nothing is lost ·{' '}
            {clock(now / 1000 - Math.max(c.at, c.last))}
          </span>
          {mine && (
            <div className='flex gap-2'>
              {onMessage && missing.some(m => m !== me) && (
                <Button
                  variant='secondary'
                  size='sm'
                  className='flex-1'
                  onClick={() => onMessage(missing.find(m => m !== me)!)}
                >
                  message {who(missing.find(m => m !== me)!)}
                </Button>
              )}
              {rest?.members.includes(me) && (
                <Button
                  variant='secondary'
                  size='sm'
                  className='flex-1'
                  disabled={busy}
                  onClick={() => again(rest.members, rest.k)}
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

/** "seals needed to send": a stepper, from 2 to everyone; with a label, a plain count up to `n` */
export const Seals = ({
  k,
  n,
  onK,
  label,
}: {
  k: number;
  n: number;
  onK: (k: number) => void;
  label?: string;
}) => (
  <div className='flex h-14 items-center gap-3 border border-border-soft bg-elev-1 px-3.5'>
    <span className='grow text-xs text-fg-muted'>{label ?? 'seals needed to send'}</span>
    <button
      type='button'
      aria-label={`fewer ${label ?? 'seals'}`}
      disabled={k <= 2}
      onClick={() => onK(k - 1)}
      className='grid size-10 place-items-center border border-border-soft text-fg-high disabled:text-fg-dim'
    >
      <span className='i-lucide-minus size-4' aria-hidden='true' />
    </button>
    <span className='w-16 text-center font-display text-lg text-fg-high'>
      {label ? k : `${k} of ${n}`}
    </span>
    <button
      type='button'
      aria-label={`more ${label ?? 'seals'}`}
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
  members,
}: {
  open: boolean;
  onClose: () => void;
  roomId: string;
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
          void proposeWallet(
            roomId,
            members.map(m => m.key),
            kk,
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
