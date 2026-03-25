import { useQuery } from '@tanstack/react-query';
import { ChainRegistryClient } from '@penumbra-labs/registry';
import { useMemo } from 'react';

/** prefetch all asset icon URLs to prevent portfolio timing leak */
const prefetchAssetIcons = (registry: { getAllAssets: () => Iterable<{ images?: { png?: string; svg?: string }[] }> }) => {
  try {
    for (const asset of registry.getAllAssets()) {
      for (const img of asset.images ?? []) {
        const url = img.png || img.svg;
        if (url) void fetch(url, { mode: 'no-cors', cache: 'force-cache' }).catch(() => {});
      }
    }
  } catch { /* non-critical */ }
};

export const useNumeraires = (chainId?: string) => {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['registry', chainId],
    queryFn: async () => {
      const registryClient = new ChainRegistryClient();
      const registry = await registryClient.remote.get(chainId!);
      prefetchAssetIcons(registry);
      return registry;
    },
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
