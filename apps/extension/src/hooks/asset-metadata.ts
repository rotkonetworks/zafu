/**
 * registry asset metadata
 *
 * The penumbra chain registry ships full asset metadata (symbol + `images` +
 * `denomUnits`) for every asset it knows about. The view service already loads
 * this into IndexedDb for penumbra-native assets, but cosmos deposit/withdraw
 * assets are held on the source chain (Noble, Injective, ...) under their base
 * denom (e.g. `uusdc`) and never pass through the view service.
 *
 * A registry asset's `denomUnits` include that cosmos base denom, so we can map
 * a raw cosmos denom to the same metadata the penumbra side uses - giving us a
 * real symbol and icon instead of a parsed guess.
 */

import { useQuery } from '@tanstack/react-query';
import { Metadata } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { registryClient } from './ibc-chains';
import { useChainIdQuery } from './chain-id';

/** denom (base, display, or any denomUnit) -> registry Metadata */
export type AssetMetadataMap = Map<string, Metadata>;

const buildMap = (assets: Metadata[]): AssetMetadataMap => {
  const byDenom: AssetMetadataMap = new Map();
  for (const m of assets) {
    for (const unit of m.denomUnits) {
      if (unit.denom) {
        byDenom.set(unit.denom, m);
      }
    }
    if (m.base) {
      byDenom.set(m.base, m);
    }
    if (m.display) {
      byDenom.set(m.display, m);
    }
  }
  return byDenom;
};

/**
 * Load the registry asset map for the active penumbra chain. Uses the bundled
 * registry as an offline-first backup so the first render still resolves.
 */
export const useRegistryAssetMetadata = () => {
  const { chainId } = useChainIdQuery();

  return useQuery({
    queryKey: ['registryAssetMetadata', chainId],
    enabled: !!chainId,
    staleTime: 30 * 60 * 1000, // 30 minutes
    queryFn: async (): Promise<AssetMetadataMap> => {
      if (!chainId) {
        return new Map();
      }
      const registry = await registryClient.remote.getWithBundledBackup(chainId);
      return buildMap(registry.getAllAssets());
    },
  });
};

/**
 * Resolve a cosmos denom to metadata for icon + symbol rendering. Falls back to
 * a synthetic Metadata carrying just the given symbol, so a monogram icon can be
 * generated when the registry has no entry for the denom.
 */
export const resolveAssetMetadata = (
  map: AssetMetadataMap | undefined,
  denom: string,
  fallbackSymbol: string,
): Metadata => map?.get(denom) ?? new Metadata({ symbol: fallbackSymbol });
