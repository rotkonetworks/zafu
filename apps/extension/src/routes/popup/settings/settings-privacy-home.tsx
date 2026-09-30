import { useStore } from '../../../state';
import { privacySelector } from '../../../state/privacy';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { SettingsScreen } from './settings-screen';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { TintedRow } from './tinted-row';

/**
 * Privacy category home (SetPrivacy.dc.html): the two on-screen toggles a
 * person actually changes, connected sites, then "all privacy controls" for
 * everything else (network, people, zcash.me - settings-privacy.tsx).
 */
export const SettingsPrivacyHome = () => {
  const navigate = usePopupNav();
  const { settings, setSetting } = useStore(privacySelector);

  return (
    <SettingsScreen title='privacy' backPath={PopupPath.SETTINGS}>
      <div className='flex flex-col gap-5'>
        <RowGroup>
          <Row
            type='toggle'
            label='hide balances'
            checked={settings.hideBalances}
            onChange={v => setSetting('hideBalances', v)}
          />
          <Row
            type='toggle'
            label='transaction history'
            checked={settings.enableTransactionHistory}
            onChange={v => setSetting('enableTransactionHistory', v)}
          />
          <Row
            type='screen'
            label='connected sites'
            onPress={() => navigate(PopupPath.SETTINGS_CONNECTED_SITES)}
          />
        </RowGroup>

        <RowGroup>
          <TintedRow
            label='all privacy controls'
            tone='gold'
            onPress={() => navigate(PopupPath.SETTINGS_PRIVACY)}
          />
        </RowGroup>
      </div>
    </SettingsScreen>
  );
};
