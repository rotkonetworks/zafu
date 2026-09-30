import { useStore } from '../../../state';
import { passwordSelector } from '../../../state/password';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { SettingsScreen } from './settings-screen';
import { Row, RowGroup } from '@repo/ui/components/ui/row';

/**
 * Settings index - four categories (security · privacy · networks · devices
 * and app), each a calm home with a few rows and an "all ... controls" row
 * for the full list. See SetMap.dc.html for the per-setting re-home.
 */
const CATEGORIES = [
  {
    title: 'security',
    icon: 'i-ph-shield-check',
    href: PopupPath.SETTINGS_SECURITY,
  },
  {
    title: 'privacy',
    icon: 'i-ph-eye-slash',
    href: PopupPath.SETTINGS_PRIVACY_HOME,
  },
  {
    title: 'networks',
    icon: 'i-ph-compass',
    href: PopupPath.SETTINGS_NETWORKS_HOME,
  },
  {
    title: 'devices and app',
    icon: 'i-ph-sliders-horizontal',
    href: PopupPath.SETTINGS_DEVICES,
  },
] as const;

export const Settings = () => {
  const navigate = usePopupNav();
  const { clearSessionPassword } = useStore(passwordSelector);

  return (
    <SettingsScreen title='settings' backPath={PopupPath.INDEX}>
      <div className='flex grow flex-col justify-between'>
        <RowGroup>
          {CATEGORIES.map(c => (
            <Row
              key={c.href}
              type='screen'
              icon={c.icon}
              label={c.title}
              onPress={() => navigate(c.href)}
            />
          ))}
        </RowGroup>

        <div className='mt-4 border-t border-border-soft pt-4'>
          <RowGroup>
            <Row
              type='screen'
              icon='i-ph-sign-out'
              label='lock wallet'
              onPress={() => {
                clearSessionPassword();
                chrome.runtime.reload();
              }}
            />
          </RowGroup>
        </div>
      </div>
    </SettingsScreen>
  );
};
