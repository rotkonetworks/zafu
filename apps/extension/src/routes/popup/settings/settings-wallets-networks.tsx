import { useStore } from '../../../state';
import { selectEnabledNetworks } from '../../../state/keyring';
import { useEnableNetwork } from '../../../hooks/enable-network';
import { NETWORK_BLURB } from '../../../components/network-sheet';
import { getNetwork, getTopLevelNetworks } from '../../../config/networks';
import { Section } from './settings-screen';
import { Row } from '@repo/ui/components/ui/row';
import { SettingsWallets } from './settings-wallets';

/** each top-level network on or off; its node and chains live under settings > networks */
export const NetworkSwitches = () => {
  const enabled = useStore(selectEnabledNetworks);
  const toggle = useStore(s => s.keyRing.toggleNetwork);
  const enable = useEnableNetwork();
  return (
    <Section title='networks'>
      {getTopLevelNetworks().map(n => (
        <Row
          key={n}
          type='toggle'
          label={getNetwork(n).name}
          description={NETWORK_BLURB[n]}
          checked={enabled.includes(n)}
          onChange={on => void (on ? enable(n) : toggle(n))}
        />
      ))}
    </Section>
  );
};

export const SettingsWalletsNetworks = () => (
  <SettingsWallets title='wallets & networks' appendSlot={<NetworkSwitches />} />
);
