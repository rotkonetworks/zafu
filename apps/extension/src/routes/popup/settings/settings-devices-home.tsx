import { useStore } from '../../../state';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { SettingsScreen } from './settings-screen';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { TintedRow } from './tinted-row';
import { ThemeRow } from './settings-appearance';
import { selectZignerPaired } from './settings-status';

export const ZignerRow = () => {
  const navigate = usePopupNav();
  const paired = useStore(selectZignerPaired);
  return (
    <Row
      type='value'
      label='zigner'
      value={paired ? 'paired' : 'not paired'}
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
      onPress={() => navigate(PopupPath.SETTINGS_ABOUT)}
    />
  );
};

/** devices and app category home (SetDevices.dc.html) */
export const SettingsDevicesHome = () => {
  const navigate = usePopupNav();
  return (
    <SettingsScreen title='devices and app' category='devices' backPath={PopupPath.SETTINGS}>
      <div className='flex flex-col gap-4'>
        <RowGroup>
          <ZignerRow />
          <ThemeRow />
          <AboutRow />
        </RowGroup>
        <RowGroup>
          <TintedRow
            label='all device and app controls'
            tone='gold'
            onPress={() => navigate(PopupPath.SETTINGS_DEVICES_ALL)}
          />
        </RowGroup>
      </div>
    </SettingsScreen>
  );
};
