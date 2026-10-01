import { useStore } from '../../../state';
import { selectEnabledNetworks } from '../../../state/keyring';
import { HARDWARE_WALLET_ENABLED, LEDGER_TRANSPARENT_ENABLED } from '../../../config/feature-flags';
import { openPageInTab } from '../../../utils/popup-detection';
import { PagePath } from '../../page/paths';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { Section, SettingsScreen } from './settings-screen';
import { Row } from '@repo/ui/components/ui/row';
import { ApprovalsRow, FontRow, ThemeRow } from './settings-appearance';
import { AboutRow, ZignerRow } from './settings-devices-home';

/** "all device and app controls" (SetDevicesAll.dc.html). pro is shelved, so it has no row. */
export const SettingsDevicesAll = () => {
  const navigate = usePopupNav();
  const zcashOn = useStore(selectEnabledNetworks).includes('zcash');

  return (
    <SettingsScreen
      title='all device and app controls'
      category='devices'
      backPath={PopupPath.SETTINGS_DEVICES}
    >
      <div className='flex flex-col gap-4'>
        <Section title='devices'>
          <ZignerRow />
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
        </Section>
        <Section title='app'>
          <ThemeRow />
          <FontRow />
          <ApprovalsRow />
          <Row
            type='screen'
            label='features'
            onPress={() => navigate(PopupPath.SETTINGS_FEATURES)}
          />
          <AboutRow />
        </Section>
        {/* the accounts sheet switches wallets; renaming, importing and removing any of them lives here */}
        <Section title='wallets'>
          <Row
            type='screen'
            label='wallets & networks'
            onPress={() => navigate(PopupPath.SETTINGS_WALLETS)}
          />
        </Section>
      </div>
    </SettingsScreen>
  );
};
