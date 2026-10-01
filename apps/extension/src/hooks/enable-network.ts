import { useStore } from '../state';
import type { NetworkType } from '../state/keyring';
import { isIbcNetwork } from '../state/keyring/network-types';

/** turning a network on also makes it the active one; an ibc chain needs its transparent balances on */
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
