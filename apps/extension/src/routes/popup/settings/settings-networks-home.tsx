import { useNavigate } from 'react-router-dom';
import { useStore } from '../../../state';
import { selectEnabledNetworks, type NetworkType } from '../../../state/keyring';
import { isIbcNetwork } from '../../../state/keyring/network-types';
import { NETWORKS, getTopLevelNetworks } from '../../../config/networks';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { Section, SettingsScreen } from './settings-screen';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { TintedRow } from './tinted-row';
import { ZcashMeRow } from './settings-privacy';

/** where each network's own screen lives; penumbra's is the endpoint + ibc panel */
const NETWORK_SCREEN: Partial<Record<NetworkType, string>> = {
  zcash: PopupPath.SETTINGS_ZCASH_NETWORK,
  penumbra: `${PopupPath.SETTINGS_NETWORKS}?network=penumbra`,
};

/** turning a network on also makes it the active one, as the full toggle list does */
export const useEnableNetwork = () => {
  const toggleNetwork = useStore(s => s.keyRing.toggleNetwork);
  const setActive = useStore(s => s.keyRing.setActiveNetwork);
  const setSetting = useStore(s => s.privacy.setSetting);
  const transparentOn = useStore(s => s.privacy.settings.enableTransparentBalances);
  return async (n: NetworkType) => {
    await toggleNetwork(n);
    if (isIbcNetwork(n) && !transparentOn) {
      await setSetting('enableTransparentBalances', true);
    }
    await setActive(n);
  };
};

/** one row per top-level network: open it when on, turn it on when off.
 *  fresh wallets are zcash-only, so this is where the others are switched on. */
const ChainRows = ({ ibcLabel }: { ibcLabel?: boolean }) => {
  const navigate = useNavigate();
  const enabled = useStore(selectEnabledNetworks);
  const enable = useEnableNetwork();
  return (
    <>
      {getTopLevelNetworks().map(n => {
        const on = enabled.includes(n);
        const screen = NETWORK_SCREEN[n];
        const name = NETWORKS[n].name.toLowerCase();
        return (
          <Row
            key={n}
            type='value'
            label={ibcLabel && n === 'penumbra' ? `${name} + ibc` : name}
            value={on ? undefined : 'turn on'}
            onPress={() => (on ? navigate(screen ?? PopupPath.SETTINGS_NETWORKS) : void enable(n))}
          />
        );
      })}
    </>
  );
};

/** networks category home (SetNetworks.dc.html) */
export const SettingsNetworksHome = () => {
  const navigate = usePopupNav();
  return (
    <SettingsScreen title='networks' category='networks' backPath={PopupPath.SETTINGS}>
      <div className='flex flex-col gap-4'>
        <RowGroup>
          <ChainRows />
        </RowGroup>
        <RowGroup>
          <TintedRow
            label='all network controls'
            tone='gold'
            onPress={() => navigate(PopupPath.SETTINGS_NETWORKS_ALL)}
          />
        </RowGroup>
      </div>
    </SettingsScreen>
  );
};

/** "all network controls" (SetNetworksAll.dc.html). proxy is shelved, so it has no row. */
export const SettingsNetworksAll = () => {
  const navigate = usePopupNav();
  const zcashOn = useStore(selectEnabledNetworks).includes('zcash');
  return (
    <SettingsScreen
      title='all network controls'
      category='networks'
      backPath={PopupPath.SETTINGS_NETWORKS_HOME}
    >
      <div className='flex flex-col gap-4'>
        <Section title='chains'>
          <ChainRows ibcLabel />
        </Section>
        <Section title='privacy over the wire'>
          <Row
            type='screen'
            label='everything zafu talks to'
            onPress={() => navigate(PopupPath.SETTINGS_CONNECTIONS)}
          />
        </Section>
        {zcashOn && (
          <Section title='people and services'>
            <ZcashMeRow />
            <Row
              type='screen'
              label='voting endpoints'
              onPress={() => navigate(PopupPath.SETTINGS_VOTING)}
            />
          </Section>
        )}
      </div>
    </SettingsScreen>
  );
};
