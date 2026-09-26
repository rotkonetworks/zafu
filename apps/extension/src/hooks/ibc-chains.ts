/**
 * hook for fetching IBC-connected chains from penumbra registry
 */

import { useQuery } from '@tanstack/react-query';
import { ChainRegistryClient } from '@penumbrafi/registry';
import { COSMOS_CHAINS, isValidBech32 } from '@repo/wallet/networks/cosmos/chains';
import { getPenumbraRoutes, routeForChain } from '../transparent/penumbra-routes';
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
      const [registry, routes] = await Promise.all([
        registryClient.remote.get(chainId),
        getPenumbraRoutes(),
      ]);
      // The registry lists connections whose penumbra-side client has since
      // expired (cosmoshub channel-0, osmosis channel-4...), and a withdraw
      // over one of those can't be relayed. The channel pair therefore comes
      // from the live routes the penumbra node reports, not the registry; a
      // chain with no live route isn't offered. `launched` still decides which
      // chains zafu supports at all.
      const active = new Set(getActiveIbcChainIds('penumbra'));
      return registry.ibcConnections.flatMap(chain => {
        const ours = Object.values(COSMOS_CHAINS).find(c => c.chainId === chain.chainId);
        if (!active.has(chain.chainId) || !ours) {
          return [];
        }
        const route = routeForChain(ours.id, routes);
        if (!route) {
          return [];
        }
        return [
          {
            displayName: chain.displayName,
            chainId: chain.chainId,
            channelId: route.penumbraSourceChannel,
            counterpartyChannelId: route.penumbraChannel,
            addressPrefix: chain.addressPrefix,
            images: chain.images,
          },
        ];
      });
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
