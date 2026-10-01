import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { registryClient } from './ibc-chains';

/**
 * `registryClient.remote.get` resolves from the bundled registry copy first,
 * never the network (see @repo/context/registry-client). Its icon urls are
 * never fetched: AssetIcon falls back to a generated monogram instead of
 * asking github for them (packages/ui/components/ui/asset-icon).
 */
export const useNumeraires = (chainId?: string) => {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['registry', chainId],
    queryFn: () => registryClient.remote.get(chainId!),
    retry: 1,
    retryDelay: 0,
    staleTime: Infinity,
    enabled: Boolean(chainId),
  });

  const numeraires = useMemo(() => {
    if (isError) {
      console.error(`Could not load numeraires for chainId: ${chainId}`);
    }

    return data?.numeraires.map(n => data.getMetadata(n)) ?? [];
  }, [data, chainId, isError]);

  return { numeraires, isLoading, isError };
};
