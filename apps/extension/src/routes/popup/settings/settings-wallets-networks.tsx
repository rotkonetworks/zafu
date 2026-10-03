import { useStore } from '../../../state';
import { selectEnabledNetworks } from '../../../state/keyring';
import { useDisableNetwork, useEnableNetwork } from '../../../hooks/enable-network';
import { NETWORK_BLURB } from '../../../components/network-sheet';
import { getNetwork, getTopLevelNetworks } from '../../../config/networks';
import { Section } from './settings-screen';
import { Row } from '@repo/ui/components/ui/row';
import { SettingsWallets } from './settings-wallets';
import { useExplain } from './settings-explain';

/** the privacy/network explain for a top-level chain is keyed by its network id, not its label */
const explainIdOf = (n: string): string => `network.${n}Enable`;

/** each top-level network on or off; its node and chains live under settings > networks */
export const NetworkSwitches = () => {
  const enabled = useStore(selectEnabledNetworks);
  const disable = useDisableNetwork();
  const enable = useEnableNetwork();
  const { explainProps, sheet } = useExplain();
  return (
    <Section title='networks'>
      {getTopLevelNetworks().map(n => (
        <Row
          key={n}
          type='toggle'
          label={getNetwork(n).name}
          description={NETWORK_BLURB[n]}
          checked={enabled.includes(n)}
          onChange={on => void (on ? enable(n) : disable(n))}
          {...explainProps(explainIdOf(n))}
        />
      ))}
      {sheet}
    </Section>
  );
};

export const SettingsWalletsNetworks = () => (
  <SettingsWallets title='wallets & networks' appendSlot={<NetworkSwitches />} />
);
