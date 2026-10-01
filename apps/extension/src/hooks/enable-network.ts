import { useStore } from '../state';
import type { NetworkType } from '../state/keyring';
import { isIbcNetwork } from '../state/keyring/network-types';
import { getNetwork, getSubnetworks } from '../config/networks';

/**
 * turning a network on also makes a top-level one the active network; an ibc
 * chain lives inside its parent, so it only needs its transparent balances on
 */
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
    if (!getNetwork(n).parent) {
      await setActive(n);
    }
  };
};

/** turning a network off also turns off its ibc chains, so none keeps reaching its nodes */
export const useDisableNetwork = () => {
  const toggleNetwork = useStore(s => s.keyRing.toggleNetwork);
  const enabled = useStore(s => s.keyRing.enabledNetworks);
  return async (n: NetworkType) => {
    for (const c of [...getSubnetworks(n), n].filter(c => enabled.includes(c))) {
      await toggleNetwork(c);
    }
  };
};
