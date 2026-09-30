import { useStore } from '../../../state';
import { selectEnabledNetworks } from '../../../state/keyring';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { SettingsScreen } from './settings-screen';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { TintedRow } from './tinted-row';

/**
 * Networks category home (SetNetworks.dc.html): one row per enabled
 * top-level network, then "all network controls" for the merged wallets +
 * networks screen (the endpoint pickers, the ibc directory, custom nodes).
 */
export const SettingsNetworksHome = () => {
  const navigate = usePopupNav();
  const enabledNetworks = useStore(selectEnabledNetworks) as string[];

  return (
    <SettingsScreen title='networks' backPath={PopupPath.SETTINGS}>
      <div className='flex flex-col gap-5'>
        <RowGroup>
          {enabledNetworks.includes('zcash') && (
            <Row
              type='screen'
              label='zcash'
              onPress={() => navigate(PopupPath.SETTINGS_ZCASH_NETWORK)}
            />
          )}
          {enabledNetworks.includes('penumbra') && (
            <Row
              type='screen'
              label='penumbra'
              onPress={() => navigate(`${PopupPath.SETTINGS_NETWORKS}?network=penumbra`)}
            />
          )}
        </RowGroup>

        <RowGroup>
          <TintedRow
            label='all network controls'
            tone='gold'
            onPress={() => navigate(PopupPath.SETTINGS_NETWORKS)}
          />
        </RowGroup>
      </div>
    </SettingsScreen>
  );
};
