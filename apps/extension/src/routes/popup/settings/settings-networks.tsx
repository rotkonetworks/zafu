import { Navigate, useSearchParams } from 'react-router-dom';
import { useStore } from '../../../state';
import { selectEnabledNetworks } from '../../../state/keyring';
import type { NetworkId } from '../../../state/networks';
import { useEnableNetwork } from '../../../hooks/enable-network';
import { hostOf } from '../../../net/destination';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { Section, SettingsScreen } from './settings-screen';
import { Row } from '@repo/ui/components/ui/row';
import { useExplain, type ExplainId } from './settings-explain';

/** each chain's own screen, and its label here */
const CHAINS = [
  { id: 'zcash', label: 'zcash', screen: PopupPath.SETTINGS_ZCASH_NETWORK, explainId: 'network.zcashEnable' },
  {
    id: 'penumbra',
    label: 'penumbra',
    screen: PopupPath.SETTINGS_PENUMBRA_NETWORK,
    explainId: 'network.penumbraEnable',
  },
] as const satisfies readonly {
  id: NetworkId;
  label: string;
  screen: PopupPath;
  explainId: ExplainId;
}[];

/** a chain shows the node it reads from when on, and turns on when off */
const ChainRow = ({
  chain,
  onExplain,
}: {
  chain: (typeof CHAINS)[number];
  onExplain?: (label: string) => void;
}) => {
  const navigate = usePopupNav();
  const on = useStore(s => selectEnabledNetworks(s).includes(chain.id));
  const endpoint = useStore(s => s.networks.networks[chain.id].endpoint);
  const enable = useEnableNetwork();
  return (
    <Row
      type='value'
      label={chain.label}
      value={on ? (endpoint && hostOf(endpoint)) || 'auto' : 'turn on'}
      preload={on ? chain.screen : undefined}
      onPress={() => (on ? navigate(chain.screen) : void enable(chain.id))}
      onExplain={onExplain}
    />
  );
};

/** settings > networks: one screen for every network control (SetNetworksAll.dc.html) */
export const SettingsNetworks = () => {
  const navigate = usePopupNav();
  const zcashOn = useStore(s => selectEnabledNetworks(s).includes('zcash'));
  const [params] = useSearchParams();
  // the home "switch node" links arrive as ?network=<id>
  const linked = CHAINS.find(c => c.id === params.get('network'));
  const { explainProps, sheet: explainSheet } = useExplain();
  if (linked) {
    return <Navigate replace to={`${linked.screen}?sheet=node`} />;
  }
  return (
    <SettingsScreen title='networks' category='networks' backPath={PopupPath.SETTINGS}>
      <div className='flex flex-col gap-4'>
        <Section title='chains'>
          {CHAINS.map(c => (
            <ChainRow key={c.id} chain={c} {...explainProps(c.explainId)} />
          ))}
        </Section>
        {zcashOn && (
          <Section title='services'>
            <Row
              type='screen'
              label='voting endpoints'
              preload={PopupPath.SETTINGS_VOTING}
              onPress={() => navigate(PopupPath.SETTINGS_VOTING)}
            />
          </Section>
        )}
      </div>
      {explainSheet}
    </SettingsScreen>
  );
};
