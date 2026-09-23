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

  return (
    <div>
      <p className='kicker mb-2'>transaction signing</p>
      <div className='flex flex-col gap-2 rounded-lg border border-border-soft bg-elev-1 p-3'>
        <p className='text-label text-fg-muted'>
          when the wallet asks for your password to approve a transaction. does not change
          encryption — only when the confirmation is required.
        </p>
        <div className='mt-1 flex flex-col gap-2'>
          {SIGNING_SECURITY_OPTIONS.map(opt => {
            const active = level === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => void setSetting('txSigningSecurity', opt.value)}
                className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  active
                    ? 'border-zigner-gold bg-zigner-gold/5'
                    : 'border-border-soft hover:bg-elev-2'
                }`}
              >
                <span
                  className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                    active ? 'i-ph-radio-button text-zigner-gold' : 'i-ph-circle text-fg-muted'
                  }`}
                />
                <span className='flex-1'>
                  <span className='block text-sm font-medium'>{opt.label}</span>
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
      </div>
    </div>
  );
}
