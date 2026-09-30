import { SettingsScreen } from './settings-screen';
import { DeviceScanner } from '../../../components/device-scanner/device-scanner';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';

/**
 * Popup screen for pairing a zigner or keystone - the scan/result flow
 * lives in components/device-scanner; this just supplies the screen chrome
 * and sends the user back to the wallet list once a wallet is added.
 */
export const SettingsConnectDevice = () => {
  const navigate = usePopupNav();
  return (
    <SettingsScreen title='connect device' backPath={PopupPath.SETTINGS_WALLETS}>
      <DeviceScanner
        onDone={() => navigate(PopupPath.SETTINGS_WALLETS)}
        onCancel={() => navigate(PopupPath.SETTINGS_WALLETS)}
      />
    </SettingsScreen>
  );
};
