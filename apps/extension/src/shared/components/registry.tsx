import { useQuery } from '@tanstack/react-query';
import { registryClient } from '../../hooks/ibc-chains';

/**
 * Globals (default endpoints, frontends) from the bundled registry copy -
 * `registryClient.remote.globals` resolves from it first, never the network
 * (see @repo/context/registry-client). The icon urls it carries are never
 * fetched: AssetIcon falls back to a generated monogram instead of asking
 * github for them (packages/ui/components/ui/asset-icon).
 */
export const useRegistry = () => {
  return useQuery({
    queryKey: ['registryGlobals'],
    queryFn: () => registryClient.remote.globals(),
    staleTime: Infinity,
  });
};
