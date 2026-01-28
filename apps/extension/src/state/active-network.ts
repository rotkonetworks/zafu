import type { LocalStorageState } from '@repo/storage-chrome/local';
import type { ExtensionStorage } from '@repo/storage-chrome/base';
import { AllSlices, SliceCreator } from '.';

/** @deprecated use keyRing.activeNetwork instead */
export type NetworkType = 'penumbra' | 'zcash' | 'polkadot' | 'kusama' | 'osmosis' | 'noble' | 'nomic' | 'celestia' | 'ethereum' | 'bitcoin';

export interface ActiveNetworkSlice {
  /** Currently active network */
  activeNetwork: NetworkType;
  /** Set the active network */
  setActiveNetwork: (network: NetworkType) => Promise<void>;
}

export const createActiveNetworkSlice =
  (local: ExtensionStorage<LocalStorageState>): SliceCreator<ActiveNetworkSlice> =>
  (set) => {
    return {
      activeNetwork: 'penumbra', // default to penumbra for backwards compat
      setActiveNetwork: async (network: NetworkType) => {
        set((state) => {
          state.activeNetwork.activeNetwork = network;
        });

        await local.set('activeNetwork', network);
      },
    };
  };

export const activeNetworkSelector = (state: AllSlices) => state.activeNetwork;
