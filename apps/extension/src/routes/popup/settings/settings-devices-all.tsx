import { useStore } from '../../../state';
import { selectEnabledNetworks } from '../../../state/keyring';
import { HARDWARE_WALLET_ENABLED, LEDGER_TRANSPARENT_ENABLED } from '../../../config/feature-flags';
import { openPageInTab } from '../../../utils/popup-detection';
import { PagePath } from '../../page/paths';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { SettingsScreen } from './settings-screen';
import { Row, RowGroup } from '@repo/ui/components/ui/row';

/**
 * "all device and app controls" - the devices-and-app category's power-user
 * list. Wallets & networks lives here too: SetMap moves the wallet list to
 * an account sheet, but that sheet does not exist yet on this base, so the
 * row re-homes here instead of disappearing (see the task report).
 */
export const SettingsDevicesAll = () => {
  const navigate = usePopupNav();
  const enabledNetworks = useStore(selectEnabledNetworks);
  const zcashOn = enabledNetworks.includes('zcash');

  return (
    <SettingsScreen title='all device and app controls' backPath={PopupPath.SETTINGS_DEVICES}>
      <div className='flex flex-col gap-5'>
        <RowGroup>
          <Row
            type='screen'
            label='wallets & networks'
            description='manage vaults · enable networks'
            onPress={() => navigate(PopupPath.SETTINGS_WALLETS)}
          />
          <Row type='screen' label='zigner' onPress={() => navigate(PopupPath.SETTINGS_ZIGNER)} />
          {zcashOn && (HARDWARE_WALLET_ENABLED || LEDGER_TRANSPARENT_ENABLED) && (
            <Row
              type='screen'
              label='ledger'
              onPress={() => void openPageInTab(PagePath.CONNECT_LEDGER, true)}
            />
          )}
          <Row
            type='screen'
            label='device update'
            onPress={() => navigate(PopupPath.SETTINGS_OTA)}
          />
        </RowGroup>

        <RowGroup>
          <Row
            type='screen'
            label='appearance'
            description='theme · type · where approvals open'
            onPress={() => navigate(PopupPath.SETTINGS_APPEARANCE)}
          />
          <Row
            type='screen'
            label='features'
            onPress={() => navigate(PopupPath.SETTINGS_FEATURES)}
          />
          {/* pro is shelved until there is a critical mass of users - no row,
              no upsell copy anywhere in settings (founder decision) */}
          <Row type='screen' label='about' onPress={() => navigate(PopupPath.SETTINGS_ABOUT)} />
        </RowGroup>
      </div>
    </SettingsScreen>
  );
};
