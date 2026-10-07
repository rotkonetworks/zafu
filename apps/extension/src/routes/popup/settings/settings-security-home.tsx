import { useNavigate } from 'react-router-dom';
import { useStore } from '../../../state';
import { selectEffectiveKeyInfo, selectEnabledNetworks } from '../../../state/keyring';
import { selectTxSigningSecurity } from '../../../state/privacy';
import type { TxSigningSecurity } from '../../../shared/tx-signing-security';
import { Row } from '@repo/ui/components/ui/row';
import { Section, SettingsScreen } from './settings-screen';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { useAutoLock, AUTO_LOCK_OPTIONS } from './use-auto-lock';
import { OptionsRow } from './sheet-options';
import { selectSeatCount, selectUnbackedSeatCount } from './settings-status';
import { useExplain } from './settings-explain';

const SIGNING_OPTIONS: readonly {
  value: TxSigningSecurity;
  label: string;
  desc: string;
  /** who can sign, under the row */
  sees: string;
}[] = [
  {
    value: 'unlock-only',
    label: 'never',
    desc: 'unlocked means you can sign',
    sees: 'someone at this computer can sign while it is unlocked',
  },
  {
    value: 'grace',
    label: 'after 15 min',
    desc: 'ask for the password again after 15 min',
    sees: 'someone at this computer can sign until then',
  },
  {
    value: 'foilhat',
    label: 'every time',
    desc: 'password for every signature',
    sees: 'nobody signs without your password',
  },
];

const AutoLockRow = ({ onExplain }: { onExplain?: (label: string) => void }) => {
  const { minutes, set } = useAutoLock();
  const label = AUTO_LOCK_OPTIONS.find(o => o.value === minutes)?.label;
  return (
    <OptionsRow
      label='auto-lock'
      description={minutes ? `locks after ${label} without use` : 'stays open until you lock it'}
      value={minutes}
      options={AUTO_LOCK_OPTIONS}
      onPick={set}
      onExplain={onExplain}
    />
  );
};

const SigningRow = ({ onExplain }: { onExplain?: (label: string) => void }) => {
  const setSetting = useStore(s => s.privacy.setSetting);
  const value = useStore(selectTxSigningSecurity);
  return (
    <OptionsRow
      label='ask for password to sign'
      description={SIGNING_OPTIONS.find(o => o.value === value)?.sees}
      value={value}
      options={SIGNING_OPTIONS}
      onPick={v => void setSetting('txSigningSecurity', v)}
      onExplain={onExplain}
    />
  );
};

const BackupsRow = () => {
  const navigate = usePopupNav();
  const unbacked = useStore(selectUnbackedSeatCount);
  return (
    <Row
      type='value'
      label='group seat backups'
      description='seats are not in your recovery phrase'
      value={unbacked ? `${unbacked} not backed up` : undefined}
      tone='warn'
      preload={PopupPath.SETTINGS_MULTISIG_BACKUP}
      onPress={() => navigate(PopupPath.SETTINGS_MULTISIG_BACKUP)}
    />
  );
};

/** removes the wallet in view; any other one is removed from its sheet under wallets */
const RemoveWalletRow = () => {
  const navigate = useNavigate();
  const vault = useStore(selectEffectiveKeyInfo);
  return vault ? (
    <Row
      type='screen'
      danger
      label={`remove ${vault.name}`}
      description='this computer forgets it · the chain does not'
      onPress={() => navigate(`${PopupPath.SETTINGS_REMOVE_WALLET}?id=${vault.id}`)}
    />
  ) : null;
};

/** security: only you can open or sign (SetSecurity.dc.html) */
export const SettingsSecurityHome = () => {
  const navigate = usePopupNav();
  const zcashOn = useStore(s => selectEnabledNetworks(s).includes('zcash'));
  // seat backups are separate from the recovery phrase, and only mean
  // something once there is a group seat to back up
  const hasSeats = useStore(selectSeatCount) > 0;
  const { explainProps, sheet } = useExplain();

  return (
    <SettingsScreen title='security' category='security' home backPath={PopupPath.SETTINGS}>
      <div className='flex flex-col gap-4'>
        <Section title='unlock and sign'>
          <AutoLockRow {...explainProps('security.autoLock')} />
          <SigningRow {...explainProps('security.txSigning')} />
          <Row
            type='screen'
            label='change password'
            description='only this computer knows it'
            preload={PopupPath.SETTINGS_CHANGE_PASSWORD}
            onPress={() => navigate(PopupPath.SETTINGS_CHANGE_PASSWORD)}
          />
        </Section>

        <Section title='keys'>
          <Row
            type='screen'
            label='recovery phrase'
            description='shown, never copyable · or as a qr to zigner'
            preload={PopupPath.SETTINGS_RECOVERY_PASSPHRASE}
            onPress={() => navigate(PopupPath.SETTINGS_RECOVERY_PASSPHRASE)}
          />
          {zcashOn && hasSeats && <BackupsRow />}
        </Section>

        {/* each network's own resync lives on its screen; this one also clears personal data */}
        <Section title='start over'>
          <Row
            type='screen'
            label='start over'
            description='sync a network again · or clear personal data'
            preload={PopupPath.SETTINGS_CLEAR_CACHE}
            onPress={() => navigate(PopupPath.SETTINGS_CLEAR_CACHE)}
          />
          <RemoveWalletRow />
        </Section>
      </div>
      {sheet}
    </SettingsScreen>
  );
};
