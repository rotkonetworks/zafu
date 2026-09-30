import { useState } from 'react';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { SettingsScreen } from './settings-screen';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { TintedRow } from './tinted-row';
import { SheetOptions } from './sheet-options';
import { useZafuTheme, type ZafuTheme } from './settings-appearance';

const THEME_OPTIONS: readonly { value: ZafuTheme; label: string }[] = [
  { value: 'sumi', label: 'sumi' },
  { value: 'washi', label: 'washi' },
];

/**
 * Devices and app category home (SetDevices.dc.html): zigner, theme, about,
 * then "all device and app controls" for ledger, device update, features,
 * pro and the wallets & networks list (moved out of the main index; there
 * is no account sheet yet on this base, so it re-homes here instead of
 * being dropped - see the task report).
 */
export const SettingsDevicesHome = () => {
  const navigate = usePopupNav();
  const { theme, set: setTheme } = useZafuTheme();
  const [themeOpen, setThemeOpen] = useState(false);

  return (
    <SettingsScreen title='devices and app' backPath={PopupPath.SETTINGS}>
      <div className='flex flex-col gap-5'>
        <RowGroup>
          <Row type='screen' label='zigner' onPress={() => navigate(PopupPath.SETTINGS_ZIGNER)} />
          <Row type='value' label='theme' value={theme} onPress={() => setThemeOpen(true)} />
          <Row
            type='value'
            label='about'
            value={chrome.runtime.getManifest().version}
            onPress={() => navigate(PopupPath.SETTINGS_ABOUT)}
          />
        </RowGroup>

        <RowGroup>
          <TintedRow
            label='all device and app controls'
            tone='gold'
            onPress={() => navigate(PopupPath.SETTINGS_DEVICES_ALL)}
          />
        </RowGroup>
      </div>

      <Sheet open={themeOpen} onOpenChange={setThemeOpen} title='theme'>
        <SheetOptions
          value={theme}
          options={THEME_OPTIONS}
          onPick={t => {
            setTheme(t);
            setThemeOpen(false);
          }}
        />
      </Sheet>
    </SettingsScreen>
  );
};
