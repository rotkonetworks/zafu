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
import { selectZignerPaired } from './settings-status';

export const ZignerRow = () => {
  const navigate = usePopupNav();
  const paired = useStore(selectZignerPaired);
  return (
    <Row
      type='value'
      label='zigner'
      value={paired ? 'paired' : 'not paired'}
      preload={PopupPath.SETTINGS_ZIGNER}
      onPress={() => navigate(PopupPath.SETTINGS_ZIGNER)}
    />
  );
};

export const AboutRow = () => {
  const navigate = usePopupNav();
  return (
    <Row
      type='value'
      label='about'
      value={chrome.runtime.getManifest().version}
      preload={PopupPath.SETTINGS_ABOUT}
      onPress={() => navigate(PopupPath.SETTINGS_ABOUT)}
    />
  );
};

/** devices and app: one screen, no nested "all controls" (SetDevices.dc.html).
 *  pro is shelved, so it has no row. */
export const SettingsDevicesHome = () => {
  const navigate = usePopupNav();
  const zcashOn = useStore(selectEnabledNetworks).includes('zcash');

  return (
    <SettingsScreen title='devices and app' category='devices' backPath={PopupPath.SETTINGS}>
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
            preload={PopupPath.SETTINGS_OTA}
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
            preload={PopupPath.SETTINGS_FEATURES}
            onPress={() => navigate(PopupPath.SETTINGS_FEATURES)}
          />
          <AboutRow />
        </Section>
        {/* the accounts sheet switches wallets; renaming, importing and removing any of them lives here */}
        <Section title='wallets'>
          <Row
            type='screen'
            label='wallets & networks'
            preload={PopupPath.SETTINGS_WALLETS}
            onPress={() => navigate(PopupPath.SETTINGS_WALLETS)}
          />
        </Section>
      </div>
    </SettingsScreen>
  );
};
