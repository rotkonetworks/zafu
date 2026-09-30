import { useState } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { useStore } from '../../../state';
import { privacySelector, selectTxSigningSecurity } from '../../../state/privacy';
import type { TxSigningSecurity } from '../../../shared/tx-signing-security';

/**
 * Transaction-signing security selector. Lives under Security & Backup
 * because it controls when a password confirmation is required — that's
 * a security posture, not a privacy toggle. Does NOT change encryption
 * (the seed is always encrypted at rest); only affects when the
 * per-transaction confirmation prompt fires.
 */

const SIGNING_SECURITY_OPTIONS: readonly {
  value: TxSigningSecurity;
  label: string;
  desc: string;
  warn?: string;
}[] = [
  {
    value: 'foilhat',
    label: 'foil hat',
    desc: 'password + a 3s delay on every transaction',
  },
  {
    value: 'grace',
    label: 'grace (15 min)',
    desc: 'password once, then skipped for 15 minutes - no delay',
  },
  {
    value: 'unlock-only',
    label: 'unlock only',
    desc: 'no per-transaction password - no delay',
    warn: 'any transaction signs while the app is unlocked; relies on auto-lock',
  },
];

export function SigningSecuritySelector() {
  const { setSetting } = useStore(privacySelector);
  const level = useStore(selectTxSigningSecurity);
  const [open, setOpen] = useState(false);
  const current = SIGNING_SECURITY_OPTIONS.find(o => o.value === level);

  return (
    <div>
      <p className='kicker mb-2'>transaction signing</p>
      <RowGroup>
        <Row
          type='value'
          label='transaction signing'
          description='when the wallet asks for your password to approve a transaction'
          value={current?.label ?? 'grace (15 min)'}
          onPress={() => setOpen(true)}
        />
      </RowGroup>
      <Sheet open={open} onOpenChange={setOpen} title='transaction signing'>
        <div className='flex flex-col gap-2'>
          {SIGNING_SECURITY_OPTIONS.map(opt => {
            const active = level === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => {
                  void setSetting('txSigningSecurity', opt.value);
                  setOpen(false);
                }}
                className={cn(
                  'flex items-start gap-3 border px-3.5 py-3 text-left transition-colors',
                  active
                    ? 'border-zigner-gold bg-zigner-gold/10'
                    : 'border-surface-border-soft hover:bg-surface-elev-2',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex size-4 shrink-0 items-center justify-center border',
                    active ? 'border-zigner-gold' : 'border-surface-border',
                  )}
                >
                  {active && <span className='size-2 bg-zigner-gold' />}
                </span>
                <span className='flex-1'>
                  <span className='block text-sm font-medium text-fg-high'>{opt.label}</span>
                  <span className='block text-xs text-fg-muted'>{opt.desc}</span>
                  {opt.warn && active && (
                    <span className='mt-1 flex items-center gap-1 text-xs text-yellow-400'>
                      <span className='i-ph-warning h-3 w-3 shrink-0' />
                      {opt.warn}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </Sheet>
    </div>
  );
}
