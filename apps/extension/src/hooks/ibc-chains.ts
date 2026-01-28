/**
 * hook for fetching IBC-connected chains from penumbra registry
 */

import { useQuery } from '@tanstack/react-query';
import { ChainRegistryClient } from '@penumbra-labs/registry';
import { useChainIdQuery } from './chain-id';

export interface IbcChain {
  displayName: string;
  chainId: string;
  /** channel on penumbra for sending to this chain */
  channelId: string;
  /** channel on this chain pointing back to penumbra */
  counterpartyChannelId: string;
  /** bech32 address prefix (e.g., 'osmo', 'noble') */
  addressPrefix: string;
  images: Array<{ svg?: string; png?: string }>;
}

const registryClient = new ChainRegistryClient();

export const useIbcChains = () => {
  const { chainId } = useChainIdQuery();

  return useQuery({
    queryKey: ['ibcChains', chainId],
    queryFn: async (): Promise<IbcChain[]> => {
      if (!chainId) return [];
      const registry = await registryClient.remote.get(chainId);
      return registry.ibcConnections.map(chain => ({
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
  if (!chain || !address) return false;
  // simple prefix check - full bech32 validation happens on submit
  return address.startsWith(`${chain.addressPrefix}1`);
};
