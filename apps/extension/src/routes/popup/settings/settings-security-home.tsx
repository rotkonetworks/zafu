import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { SettingsScreen } from './settings-screen';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { AutoLockRow, BackupsRow, RemoveWalletRow, useZcashOn } from './settings-security-backup';
import { TintedRow } from './tinted-row';

/** security category home (SetSecurity.dc.html) */
export const SettingsSecurityHome = () => {
  const navigate = usePopupNav();
  const zcashOn = useZcashOn();

  return (
    <SettingsScreen title='security' category='security' backPath={PopupPath.SETTINGS}>
      <div className='flex flex-col gap-4'>
        <RowGroup>
          <Row
            type='screen'
            label='recovery phrase'
            onPress={() => navigate(PopupPath.SETTINGS_RECOVERY_PASSPHRASE)}
          />
          {zcashOn && <BackupsRow label='backups' />}
          <AutoLockRow />
        </RowGroup>

        <RowGroup>
          <TintedRow
            label='all security controls'
            tone='gold'
            onPress={() => navigate(PopupPath.SETTINGS_SECURITY_BACKUP)}
          />
        </RowGroup>

        <RemoveWalletRow />
      </div>
    </SettingsScreen>
  );
};
