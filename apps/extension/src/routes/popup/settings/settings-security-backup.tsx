import { useState } from 'react';
import { useStore } from '../../../state';
import { selectEnabledNetworks } from '../../../state/keyring';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { SettingsScreen } from './settings-screen';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { useAutoLock, AUTO_LOCK_OPTIONS } from './use-auto-lock';
import { SigningSecuritySelector } from './signing-security-selector';
import { SheetOptions } from './sheet-options';

/**
 * "all security controls" - the security category's power-user list. Auto-
 * lock and transaction-signing security live here inline (they're posture
 * settings, not their own destinations). Recovery phrase, multisig backup,
 * and resync state each have their own canonical screen - this hub LINKS to
 * those rather than duplicating.
 */
export const SecurityBackup = () => {
  const navigate = usePopupNav();
  const enabledNetworks = useStore(selectEnabledNetworks) as string[];
  const zcashOn = enabledNetworks.length === 0 || enabledNetworks.includes('zcash');

  return (
    <SettingsScreen title='all security controls' backPath={PopupPath.SETTINGS_SECURITY}>
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

/** the Row + Sheet only, so a caller can place it inside its own RowGroup
 *  (the security home) or under its own kicker + RowGroup (all controls). */
export const AutoLockRow = () => {
  const { minutes, set } = useAutoLock();
  const [open, setOpen] = useState(false);
  const current = AUTO_LOCK_OPTIONS.find(o => o.value === minutes);

  return (
    <>
      <Row
        type='value'
        label='auto-lock'
        description='lock the wallet after this long with no activity'
        value={current?.label ?? `${minutes} min`}
        onPress={() => setOpen(true)}
      />
      <Sheet open={open} onOpenChange={setOpen} title='auto-lock'>
        <SheetOptions
          value={minutes}
          options={AUTO_LOCK_OPTIONS}
          onPick={v => {
            set(v);
            setOpen(false);
          }}
        />
      </Sheet>
    </>
  );
};

const AutoLock = () => (
  <div>
    <p className='kicker mb-2'>auto-lock</p>
    <RowGroup>
      <AutoLockRow />
    </RowGroup>
  </div>
);
