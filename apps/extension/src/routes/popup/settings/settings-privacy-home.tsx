import { useStore } from '../../../state';
import { privacySelector } from '../../../state/privacy';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { SettingsScreen } from './settings-screen';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { TintedRow } from './tinted-row';
import { selectConnectedSiteCount } from './settings-status';
import { useExplain } from './settings-explain';

/** privacy category home (SetPrivacy.dc.html) */
export const SettingsPrivacyHome = () => {
  const navigate = usePopupNav();
  const { settings, setSetting } = useStore(privacySelector);
  const sites = useStore(selectConnectedSiteCount);
  const { explainProps, sheet } = useExplain();

  return (
    <SettingsScreen title='privacy' category='privacy' backPath={PopupPath.SETTINGS}>
      <div className='flex flex-col gap-4'>
        <RowGroup>
          <Row
            type='toggle'
            label='hide balances'
            checked={settings.hideBalances}
            onChange={v => setSetting('hideBalances', v)}
            {...explainProps('hide balances')}
          />
          <Row
            type='toggle'
            label='transaction history'
            checked={settings.enableTransactionHistory}
            onChange={v => setSetting('enableTransactionHistory', v)}
            {...explainProps('transaction history')}
          />
          <Row
            type='value'
            label='connected sites'
            value={String(sites)}
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
      {sheet}
    </SettingsScreen>
  );
};
