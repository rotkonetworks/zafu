import { useState } from 'react';
import { useStore } from '../../../state';
import { selectEnabledNetworks } from '../../../state/keyring';
import { cn } from '@repo/ui/lib/utils';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { SettingsScreen } from './settings-screen';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { useAutoLock, AUTO_LOCK_OPTIONS } from './use-auto-lock';
import { SigningSecuritySelector } from './signing-security-selector';

/**
 * "Security & Backup" hub. Auto-lock and transaction-signing security live
 * here inline (they're posture settings, not their own destinations).
 * Recovery phrase, multisig backup, and resync state each have their own
 * canonical screen - this hub LINKS to those rather than duplicating.
 */
export const SecurityBackup = () => {
  const navigate = usePopupNav();
  const enabledNetworks = useStore(selectEnabledNetworks) as string[];
  const zcashOn = enabledNetworks.length === 0 || enabledNetworks.includes('zcash');

  return (
    <SettingsScreen title='security & backup'>
      <div className='flex flex-col gap-5'>
        <SigningSecuritySelector />
        <AutoLock />

        <div>
          <p className='kicker mb-2'>backup & recovery</p>
          <RowGroup>
            <Row
              type='screen'
              icon='i-ph-file-text'
              label='recovery passphrase'
              description="reveal this wallet's seed phrase"
              onPress={() => navigate(PopupPath.SETTINGS_RECOVERY_PASSPHRASE)}
            />
            {zcashOn && (
              <Row
                type='screen'
                icon='i-ph-shield'
                label='multisig backup'
                description='back up FROST multisig shares'
                onPress={() => navigate(PopupPath.SETTINGS_MULTISIG_BACKUP)}
              />
            )}
            <Row
              type='screen'
              icon='i-ph-arrows-clockwise'
              label='resync state'
              description='refetch balance & history from chain - keys kept'
              onPress={() => navigate(PopupPath.SETTINGS_CLEAR_CACHE)}
            />
          </RowGroup>
        </div>
      </div>
    </SettingsScreen>
  );
};

/* ── auto-lock (the one control with no dedicated screen) ─────────────── */

const AutoLock = () => {
  const { minutes, set } = useAutoLock();
  const [open, setOpen] = useState(false);
  const current = AUTO_LOCK_OPTIONS.find(o => o.value === minutes);

  return (
    <div>
      <p className='kicker mb-2'>auto-lock</p>
      <RowGroup>
        <Row
          type='value'
          label='auto-lock'
          description='lock the wallet after this long with no activity'
          value={current?.label ?? `${minutes} min`}
          onPress={() => setOpen(true)}
        />
      </RowGroup>
      <Sheet open={open} onOpenChange={setOpen} title='auto-lock'>
        <div className='flex flex-col gap-2'>
          {AUTO_LOCK_OPTIONS.map(o => {
            const on = o.value === minutes;
            return (
              <button
                key={o.value}
                onClick={() => {
                  set(o.value);
                  setOpen(false);
                }}
                className={cn(
                  'flex items-center gap-3 border px-3.5 py-3 text-left transition-colors',
                  on
                    ? 'border-zigner-gold bg-zigner-gold/10'
                    : 'border-surface-border-soft hover:bg-surface-elev-2',
                )}
              >
                <span
                  className={cn(
                    'flex size-4 shrink-0 items-center justify-center border',
                    on ? 'border-zigner-gold' : 'border-surface-border',
                  )}
                >
                  {on && <span className='size-2 bg-zigner-gold' />}
                </span>
                <span className='text-data text-fg-high lowercase'>{o.label}</span>
              </button>
            );
          })}
        </div>
      </Sheet>
    </div>
  );
};
