import type { LocalStorageState } from '@repo/storage-chrome/local';
import type { ExtensionStorage } from '@repo/storage-chrome/base';
import { AllSlices, SliceCreator } from '.';

export interface NetworkSlice {
  grpcEndpoint: string | undefined;
  /** what the worker's penumbra sync last published, for whichever wallet it runs */
  penumbraSync?: LocalStorageState['penumbraSync'];
  chainId?: string;
  setGRPCEndpoint: (endpoint: string) => Promise<void>;
  /** every wallet's sync start, for a chain that is no longer the same */
  clearPenumbraStarts: () => Promise<void>;
  setChainId: (chainId: string) => void;
}

export const createNetworkSlice =
  (local: ExtensionStorage<LocalStorageState>): SliceCreator<NetworkSlice> =>
  set => {
    return {
      grpcEndpoint: undefined,
      penumbraSync: undefined,
      chainId: undefined,
      setGRPCEndpoint: async (endpoint: string) => {
        set(state => {
          state.network.grpcEndpoint = endpoint;
        });

        await local.set('grpcEndpoint', endpoint);
      },
      clearPenumbraStarts: async () => {
        await local.remove('penumbraStarts');
      },
      setChainId: (chainId: string) => {
        set(state => {
          state.network.chainId = chainId;
        });
      },
    };
  };

export const networkSelector = (state: AllSlices) => state.network;
