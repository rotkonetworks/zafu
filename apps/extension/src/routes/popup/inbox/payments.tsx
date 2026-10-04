/**
 * Payments from a shared wallet, in its thread (Group.dc.html): the sheet a
 * member proposes one with, and the card every member reviews and seals in
 * the chat. The rounds are people/room-sign; the review is the same function
 * multisig/sign.tsx uses (send/frost-multisig/review).
 */

import { useState } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { cn } from '@repo/ui/lib/utils';
import { formatZecAmount, parseZecAmount } from '@repo/wallet/networks/zcash/zip321';
import type { PeopleRoom } from '../../../people/vault';
import type { FrostMine } from '../../../people/frost-room';
import type { Proposal } from '../../../people/room-sign';
import { declinePayment, proposePayment, sealPayment } from '../../../people/use-frost-room';
import type { ZcashWalletJson } from '../../../state/wallets';
import type { Verdict } from '../send/frost-multisig/multisig-verifier';
import { reviewSignRequest } from '../send/frost-multisig/review';
import { Hanko } from './shared-wallet';
import { shortAddress } from './threads';

const say = (e: unknown) =>
  e instanceof Error ? e.message : 'this did not leave. please try again.';

/** "send from it": an address and an amount; built here, sealed by you first */
export const ProposeSheet = ({
  open,
  onClose,
  room,
  seat,
  to: payee,
  requestAuth,
}: {
  open: boolean;
  onClose: () => void;
  room: PeopleRoom;
  seat: ZcashWalletJson;
  /** a deal: the other person, as the thread knows them */
  to?: string;
  requestAuth: () => Promise<boolean>;
}) => {
  const [to, setTo] = useState(payee ?? '');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const zat = parseZecAmount(amount);
  return (
    <Sheet open={open} onOpenChange={o => !o && onClose()} title='send from the shared wallet'>
      <Input
        aria-label='to'
        placeholder='u1…'
        value={to}
        onChange={e => setTo(e.target.value.trim())}
        className='font-mono text-xs'
      />
      <Input
        aria-label='amount'
        placeholder='amount in zec'
        inputMode='decimal'
        value={amount}
        onChange={e => setAmount(e.target.value)}
      />
      <span className='text-xs text-fg-muted'>
        any {seat.multisig!.threshold} of you {seat.multisig!.maxSigners} seal it · you seal first
      </span>
      <span className='h-4 text-[11px] text-hanko-light'>{error}</span>
      <Button
        disabled={!to || !zat || busy}
        loading={busy}
        onClick={() => {
          setError('');
          void requestAuth().then(ok => {
            if (!ok) {
              return;
            }
            setBusy(true);
            void proposePayment(room, seat, to, String(zat)).then(
              () => {
                setBusy(false);
                onClose();
              },
              (e: unknown) => {
                setBusy(false);
                setError(say(e));
              },
            );
          });
        }}
      >
        propose and seal
      </Button>
    </Sheet>
  );
};

/** one proposal in the chat: what it pays, who sealed, and your part */
export const PaymentCard = ({
  p,
  room,
  seat,
  me,
  kept,
  nameOf,
  requestAuth,
}: {
  p: Proposal;
  room: PeopleRoom;
  seat: ZcashWalletJson;
  me: string;
  kept?: FrostMine;
  nameOf: (key: string) => string;
  requestAuth: () => Promise<boolean>;
}) => {
  const [verdict, setVerdict] = useState<Verdict>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const k = seat.multisig!.threshold;
  const who = (m: string) => (m === me ? 'you' : nameOf(m));
  const yours = !kept?.cm && !kept?.no && !p.no.has(me) && !p.sent;
  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    void fn().then(
      () => setBusy(false),
      (e: unknown) => {
        setBusy(false);
        setError(say(e));
      },
    );
  };
  const review = () =>
    run(async () => {
      const r = await reviewSignRequest(
        { sighash: p.sighash, recipient: p.to, amountZat: p.amt, feeZat: p.fee, pcztHex: p.pczt },
        seat.orchardFvk,
        seat.mainnet,
      );
      setVerdict(r.verdict);
      if (r.verdict.kind === 'match' && (await requestAuth())) {
        await sealPayment(room, seat, p);
      }
    });
  return (
    <article className='flex flex-col self-stretch border border-border-hard bg-elev-1'>
      <div className='flex flex-col gap-1.5 px-3.5 py-3'>
        <span className='flex items-center gap-2 text-[11px] text-fg-muted'>
          <Hanko ch='判' />
          <span className='grow'>proposal · by {who(p.by)}</span>
          <span>{p.sent ? 'sent' : p.set ? 'signing' : 'open'}</span>
        </span>
        <span className='font-display text-[26px] text-fg-high'>
          {formatZecAmount(BigInt(p.amt))} <span className='text-sm text-zigner-gold'>zec</span>
        </span>
        <span className='text-xs text-fg-muted'>
          to {shortAddress(p.to)} · fee up to {formatZecAmount(BigInt(p.fee))} · shielded
        </span>
      </div>
      <div className='flex flex-col gap-1 border-t border-border-soft px-3.5 py-2.5'>
        <span className='text-xs text-fg'>
          {Math.min(p.commits.size, k)} of {k} seals · any {k} of {seat.multisig!.maxSigners} can
          send it
        </span>
        {[...p.commits.keys()].map(m => (
          <span key={m} className='text-[11px] text-fg-muted'>
            {who(m)} sealed{p.shares.has(m) ? ' · signed' : ''}
          </span>
        ))}
        {[...p.no].map(m => (
          <span key={m} className='text-[11px] text-fg-muted'>
            {who(m)} declined
          </span>
        ))}
        {p.sent && (
          <span className='break-all font-mono text-[11px] text-success'>sent · {p.sent}</span>
        )}
      </div>
      {verdict && verdict.kind !== 'match' && verdict.kind !== 'pending' && (
        <ul className='flex flex-col gap-1 border-t border-border-soft px-3.5 py-2.5 text-[11px] text-hanko-light'>
          {verdict.reasons.map(r => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {error && <span className='px-3.5 pb-2 text-[11px] text-hanko-light'>{error}</span>}
      {yours && (
        <div className={cn('flex gap-2 border-t border-border-soft px-3.5 py-2.5')}>
          <Button size='sm' className='flex-1' disabled={busy} onClick={review}>
            review and seal
          </Button>
          <Button
            variant='secondary'
            size='sm'
            disabled={busy}
            onClick={() => run(() => declinePayment(room, p))}
          >
            decline
          </Button>
        </div>
      )}
    </article>
  );
};
