import { useState } from 'react';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { useStore } from '../../../state';
import { privacySelector, selectTxSigningSecurity } from '../../../state/privacy';
import type { TxSigningSecurity } from '../../../shared/tx-signing-security';
import { SheetOptions } from './sheet-options';

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
        <SheetOptions
          value={level}
          options={SIGNING_SECURITY_OPTIONS}
          onPick={v => {
            void setSetting('txSigningSecurity', v);
            setOpen(false);
          }}
        />
      </Sheet>
    </div>
  );
}
