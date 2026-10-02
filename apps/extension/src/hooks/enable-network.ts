import { useEffect } from 'react';
import { useStore } from '../state';
import { refreshEgress } from '../net/egress';
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

/** toggleNetwork flips, so a chain already being turned on is never flipped back */
const turningOn = new Set<NetworkType>();

/**
 * a burner chain is penumbra's plumbing, with no switch of its own: the flow
 * that moves funds through it turns it on, so its nodes may be reached
 */
export const useChainInUse = (id: string | undefined) => {
  const chainId = getSubnetworks('penumbra').find(n => n === id);
  const on = useStore(s => !chainId || s.keyRing.enabledNetworks.includes(chainId));
  // only the chain itself: checking its balances is asked for on the penumbra balance
  const toggleNetwork = useStore(s => s.keyRing.toggleNetwork);
  useEffect(() => {
    if (chainId && !on && !turningOn.has(chainId)) {
      turningOn.add(chainId);
      void toggleNetwork(chainId)
        .then(refreshEgress)
        .finally(() => turningOn.delete(chainId));
    }
  }, [chainId, on]);
};
