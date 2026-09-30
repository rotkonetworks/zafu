import { useState } from 'react';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { SettingsScreen } from './settings-screen';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { cn } from '@repo/ui/lib/utils';
import { TintedRow } from './tinted-row';
import { useZafuTheme, type ZafuTheme } from './settings-appearance';

const THEME_LABEL: Record<ZafuTheme, string> = { sumi: 'sumi', washi: 'washi' };

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
          <Row
            type='value'
            label='theme'
            value={THEME_LABEL[theme]}
            onPress={() => setThemeOpen(true)}
          />
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
        <div className='flex flex-col gap-2'>
          {(['sumi', 'washi'] as const).map(t => {
            const on = t === theme;
            return (
              <button
                key={t}
                onClick={() => {
                  setTheme(t);
                  setThemeOpen(false);
                }}
                className={cn(
                  'flex items-center gap-3 border px-3.5 py-3 text-left transition-colors',
                  on
                    ? 'border-zigner-gold bg-zigner-gold/10'
                    : 'border-surface-border-soft hover:bg-surface-elev-2',
                )}
              >
                <span
                  className={cn(
                    'flex size-4 shrink-0 items-center justify-center border',
                    on ? 'border-zigner-gold' : 'border-surface-border',
                  )}
                >
                  {on && <span className='size-2 bg-zigner-gold' />}
                </span>
                <span className='text-data text-fg-high lowercase'>{THEME_LABEL[t]}</span>
              </button>
            );
          })}
        </div>
      </Sheet>
    </SettingsScreen>
  );
};
