import { useNavigate } from 'react-router-dom';
import { useStore } from '../../../state';
import { selectEffectiveKeyInfo, selectEnabledNetworks } from '../../../state/keyring';
import { selectTxSigningSecurity } from '../../../state/privacy';
import type { TxSigningSecurity } from '../../../shared/tx-signing-security';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Section, SettingsScreen } from './settings-screen';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { useAutoLock, AUTO_LOCK_OPTIONS } from './use-auto-lock';
import { OptionsRow } from './sheet-options';
import { TintedRow } from './tinted-row';
import { selectUnbackedSeatCount } from './settings-status';

const SIGNING_OPTIONS: readonly { value: TxSigningSecurity; label: string; desc: string }[] = [
  { value: 'unlock-only', label: 'unlock only', desc: 'unlocked means you can sign' },
  { value: 'grace', label: 'grace 15 min', desc: 'ask for the password again after 15 min' },
  { value: 'foilhat', label: 'foil hat', desc: 'password for every signature' },
];

export const useZcashOn = () => {
  const enabled = useStore(selectEnabledNetworks) as string[];
  return enabled.length === 0 || enabled.includes('zcash');
};

export const AutoLockRow = () => {
  const { minutes, set } = useAutoLock();
  return <OptionsRow label='auto-lock' value={minutes} options={AUTO_LOCK_OPTIONS} onPick={set} />;
};

const SigningRow = () => {
  const setSetting = useStore(s => s.privacy.setSetting);
  return (
    <OptionsRow
      label='transaction signing'
      value={useStore(selectTxSigningSecurity)}
      options={SIGNING_OPTIONS}
      onPick={v => void setSetting('txSigningSecurity', v)}
    />
  );
};

export const BackupsRow = ({ label }: { label: string }) => {
  const navigate = usePopupNav();
  const unbacked = useStore(selectUnbackedSeatCount);
  return (
    <Row
      type='value'
      label={label}
      value={unbacked ? `${unbacked} not backed up` : undefined}
      tone='warn'
      onPress={() => navigate(PopupPath.SETTINGS_MULTISIG_BACKUP)}
    />
  );
};

/** removes the wallet the person is looking at; the list of all wallets lives in the accounts sheet */
export const RemoveWalletRow = () => {
  const navigate = useNavigate();
  const vault = useStore(selectEffectiveKeyInfo);
  return vault ? (
    <RowGroup>
      <TintedRow
        label={`remove ${vault.name}`}
        tone='danger'
        onPress={() => navigate(`${PopupPath.SETTINGS_REMOVE_WALLET}?id=${vault.id}`)}
      />
    </RowGroup>
  ) : null;
};

/** "all security controls" (SetSecurityAll.dc.html) */
export const SecurityBackup = () => {
  const navigate = usePopupNav();
  const zcashOn = useZcashOn();

  return (
    <SettingsScreen
      title='all security controls'
      category='security'
      backPath={PopupPath.SETTINGS_SECURITY}
    >
      <div className='flex flex-col gap-4'>
        <Section title='keys'>
          <Row
            type='screen'
            label='recovery phrase'
            onPress={() => navigate(PopupPath.SETTINGS_RECOVERY_PASSPHRASE)}
          />
          {zcashOn && <BackupsRow label='multisig backup (frost shares)' />}
        </Section>
        <Section title='locking'>
          <AutoLockRow />
          <SigningRow />
        </Section>
        <Section title='recovery'>
          <Row
            type='value'
            label='resync balance and history'
            value='keys kept'
            onPress={() => navigate(PopupPath.SETTINGS_CLEAR_CACHE)}
          />
        </Section>
        <RemoveWalletRow />
      </div>
    </SettingsScreen>
  );
};
