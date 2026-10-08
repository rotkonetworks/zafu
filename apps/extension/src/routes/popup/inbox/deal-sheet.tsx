/**
 * "make a deal" in a 1:1 thread (Cv2DealSet, Cv2Escrow, Cv2EscrowPerson):
 * the terms, then who signs to release it. The two of you (2 of 2) is the
 * default and costs nothing; adding someone who decides makes it 2 of 3:
 * a contact you both can reach, in a small deal group. zafu court is the
 * other choice once its escrow service answers (COURT_OPEN); until then it is
 * not offered, since its keys could never be made.
 *
 * Proposing waits (#110): a deal's terms have no agreed object yet, and a
 * pair room has no joins to make a roster from. Nothing is sent until then.
 */

import { Clipped } from '@repo/ui/components/ui/clipped';
import { useState } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { Segmented } from '@repo/ui/components/ui/segmented';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { cn } from '@repo/ui/lib/utils';
import { parseZecAmount } from '@repo/wallet/networks/zcash/zip321';
import { useStore } from '../../../state';
import { isMutual } from '../../../state/contacts';
import { selectEffectiveKeyInfo } from '../../../state/keyring';
import { COURT_OPEN, type Deal } from '../../../people/frost-room';

type Who = 'two' | 'court' | 'person';

const Choice = ({
  on,
  title,
  line,
  meta,
  onClick,
}: {
  on: boolean;
  title: string;
  line: string;
  meta?: string;
  onClick: () => void;
}) => (
  <button
    type='button'
    role='radio'
    aria-checked={on}
    onClick={onClick}
    className={cn(
      'flex min-h-14 items-center gap-3 border px-3.5 py-2 text-left',
      on ? 'border-gold-line bg-zigner-gold/10' : 'border-border-soft hover:bg-elev-2',
    )}
  >
    <span
      aria-hidden='true'
      className={cn(
        'grid size-[18px] shrink-0 place-items-center',
        on ? 'bg-zigner-gold' : 'border border-border-hard',
      )}
    >
      {on && <span className='i-lucide-check size-3 text-zigner-gold-foreground' />}
    </span>
    <span className='flex grow flex-col gap-0.5'>
      <span className='text-sm text-fg-high'>{title}</span>
      <span className='text-[11px] text-fg-muted'>{line}</span>
    </span>
    {meta && <span className='text-xs text-fg-muted'>{meta}</span>}
  </button>
);

export const DealSheet = ({
  open,
  onClose,
  contactId,
  name,
}: {
  open: boolean;
  onClose: () => void;
  contactId: string;
  name: string;
}) => {
  const walletId = useStore(s => selectEffectiveKeyInfo(s)?.id);
  const contacts = useStore(s => s.contacts.contacts);
  const [amount, setAmount] = useState('');
  const [what, setWhat] = useState('');
  const [payer, setPayer] = useState<Deal['payer']>('proposer');
  const [who, setWho] = useState<Who>('two');
  const [arbiter, setArbiter] = useState<string>();
  const zat = parseZecAmount(amount);
  const others = (Array.isArray(contacts) ? contacts : []).filter(
    c => c.id !== contactId && isMutual(c, walletId),
  );
  const chosen = others.find(c => c.id === arbiter);
  const ready = !!zat && !!what.trim() && (who !== 'person' || !!chosen);

  return (
    <Sheet open={open} onOpenChange={o => !o && onClose()} title={`a deal with ${name}`}>
      <div className='flex flex-col gap-2'>
        <Input
          aria-label='amount'
          placeholder='amount in zec'
          inputMode='decimal'
          value={amount}
          onChange={e => setAmount(e.target.value)}
        />
        <Input
          aria-label='what for'
          placeholder='what for'
          maxLength={48}
          value={what}
          onChange={e => setWhat(e.target.value)}
        />
        <Segmented
          label='who pays in'
          value={payer}
          onChange={setPayer}
          options={[
            { value: 'proposer', label: 'you pay in' },
            { value: 'other', label: `${name} pays in` },
          ]}
        />
      </div>
      <div role='radiogroup' aria-label='who signs to release it' className='flex flex-col gap-1.5'>
        <span className='text-[11px] text-fg-muted'>who signs to release it</span>
        <Choice
          on={who === 'two'}
          title='the two of you'
          line={`2 of 2 · you and ${name}`}
          meta='free'
          onClick={() => setWho('two')}
        />
        {COURT_OPEN && (
          <Choice
            on={who === 'court'}
            title='zafu court decides if you disagree'
            line='2 of 3 · a panel of models and jev · opens later'
            meta='[fee]'
            onClick={() => setWho('court')}
          />
        )}
        <Choice
          on={who === 'person'}
          title='someone you both trust decides'
          line='2 of 3 · a contact holds the third key'
          onClick={() => setWho('person')}
        />
        {who === 'person' && (
          <div className='flex max-h-36 flex-col overflow-y-auto border border-border-soft'>
            {others.length === 0 && (
              <span className='px-3.5 py-3 text-xs text-fg-muted'>
                nobody yet: they need your card, and you theirs
              </span>
            )}
            {others.map(c => (
              <button
                key={c.id}
                type='button'
                onClick={() => setArbiter(c.id)}
                className={cn(
                  'flex h-11 items-center gap-3 border-b border-border-soft px-3.5 text-left text-sm last:border-0',
                  c.id === arbiter ? 'bg-zigner-gold/10 text-fg-high' : 'text-fg hover:bg-elev-2',
                )}
              >
                <Clipped className='grow'>{c.name}</Clipped>
                {c.id === arbiter && <span className='i-lucide-check size-4 text-zigner-gold' />}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className='flex h-10 items-center gap-2.5 border border-warn/40 px-3.5 text-xs text-fg'>
        <span className='size-2 shrink-0 bg-warn' aria-hidden='true' />
        {who === 'two'
          ? 'if one of you stops answering, it stays locked'
          : who === 'court'
            ? 'zafu court answers once its service opens'
            : `${chosen?.name ?? 'they'} and ${name} both agree first`}
      </div>
      <span className='h-4 text-[11px] text-fg-muted'>
        {ready ? 'making a deal waits for a newer zafu · nothing was sent' : ''}
      </span>
      <Button disabled>
        {who === 'person' ? `ask ${chosen?.name ?? 'them'}` : `propose to ${name}`}
      </Button>
    </Sheet>
  );
};
