/**
 * hook for fetching IBC-connected chains from penumbra registry
 */

import { useQuery } from '@tanstack/react-query';
import { ChainRegistryClient } from '@penumbra-labs/registry';
import { useChainIdQuery } from './chain-id';
import { getActiveIbcChainIds } from '../config/networks';

export interface IbcChain {
  displayName: string;
  chainId: string;
  /** channel on penumbra for sending to this chain */
  channelId: string;
  /** channel on this chain pointing back to penumbra */
  counterpartyChannelId: string;
  /** bech32 address prefix (e.g., 'osmo', 'noble') */
  addressPrefix: string;
  images: { svg?: string; png?: string }[];
}

const registryClient = new ChainRegistryClient();

export const useIbcChains = () => {
  const { chainId } = useChainIdQuery();

  return useQuery({
    queryKey: ['ibcChains', chainId],
    queryFn: async (): Promise<IbcChain[]> => {
      if (!chainId) {
        return [];
      }
      const registry = await registryClient.remote.get(chainId);
      // Gate to chains with a live channel/client. The registry lists every
      // configured connection regardless of whether its channel is currently
      // open; only offer the ones we have verified active (Noble right now).
      const active = new Set(getActiveIbcChainIds('penumbra'));
      return registry.ibcConnections
        .filter(chain => active.has(chain.chainId))
        .map(chain => ({
          displayName: chain.displayName,
          chainId: chain.chainId,
          channelId: chain.channelId,
          counterpartyChannelId: chain.counterpartyChannelId,
          addressPrefix: chain.addressPrefix,
          images: chain.images,
        }));
    },
    enabled: !!chainId,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
};

/** validate destination address for a chain */
export const isValidIbcAddress = (chain: IbcChain | undefined, address: string): boolean => {
  if (!chain || !address) {
    return false;
  }
  // simple prefix check - full bech32 validation happens on submit
  return address.startsWith(`${chain.addressPrefix}1`);
};
