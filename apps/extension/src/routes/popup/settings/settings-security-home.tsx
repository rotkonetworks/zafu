import { useStore } from '../../../state';
import { selectEnabledNetworks, selectKeyInfos } from '../../../state/keyring';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { SettingsScreen } from './settings-screen';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { AutoLockRow } from './settings-security-backup';
import { TintedRow } from './tinted-row';

/**
 * Security category home (SetSecurity.dc.html): a few calm rows, then "all
 * security controls" for the power-user list, then a danger section that
 * links into the wallet list to remove one - removal itself lives on its
 * own screen (settings-remove-wallet.tsx) because it needs the vault id.
 */
export const SettingsSecurityHome = () => {
  const navigate = usePopupNav();
  const hasWallet = useStore(selectKeyInfos).length > 0;
  const enabledNetworks = useStore(selectEnabledNetworks) as string[];
  const zcashOn = enabledNetworks.length === 0 || enabledNetworks.includes('zcash');

  return (
    <SettingsScreen title='security' backPath={PopupPath.SETTINGS}>
      <div className='flex flex-col gap-5'>
        <RowGroup>
          <Row
            type='screen'
            label='recovery phrase'
            onPress={() => navigate(PopupPath.SETTINGS_RECOVERY_PASSPHRASE)}
          />
          {zcashOn && (
            <Row
              type='screen'
              label='backups'
              onPress={() => navigate(PopupPath.SETTINGS_MULTISIG_BACKUP)}
            />
          )}
          <AutoLockRow />
        </RowGroup>

        <RowGroup>
          <TintedRow
            label='all security controls'
            tone='gold'
            onPress={() => navigate(PopupPath.SETTINGS_SECURITY_BACKUP)}
          />
        </RowGroup>

        {hasWallet && (
          <RowGroup>
            <TintedRow
              label='remove a wallet'
              tone='danger'
              onPress={() => navigate(PopupPath.SETTINGS_WALLETS)}
            />
          </RowGroup>
        )}
      </div>
    </SettingsScreen>
  );
};
