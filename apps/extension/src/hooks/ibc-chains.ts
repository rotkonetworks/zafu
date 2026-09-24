/**
 * hook for fetching IBC-connected chains from penumbra registry
 */

import { useQuery } from '@tanstack/react-query';
import { ChainRegistryClient } from '@penumbrafi/registry';
import { isValidBech32 } from '@repo/wallet/networks/cosmos/chains';
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

/** shared penumbra chain-registry client - reused for asset metadata lookups */
export const registryClient = new ChainRegistryClient();

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
      // open; only offer the ones we have verified active (Noble and Injective
      // right now).
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

/**
 * Validate a destination address for a chain - a FULL bech32 decode (checksum +
 * structure), not just a prefix match. An unshield out of penumbra is
 * irreversible, so a typo'd `inj1...` / `noble1...` recipient must be caught
 * here; a prefix-only check would pass a corrupted address and strand funds.
 */
export const isValidIbcAddress = (chain: IbcChain | undefined, address: string): boolean => {
  if (!chain || !address) {
    return false;
  }
  return isValidBech32(address, chain.addressPrefix);
};
