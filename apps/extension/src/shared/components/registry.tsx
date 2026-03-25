import { useQuery } from '@tanstack/react-query';
import { ChainRegistryClient } from '@penumbra-labs/registry';

/**
 * prefetch all icon URLs from the registry into browser cache.
 * this prevents a timing leak where the browser would only fetch
 * icons for assets the user holds, revealing their portfolio to
 * the image host (github).
 */
const prefetchRegistryIcons = (registry: ReturnType<ChainRegistryClient['remote']['globals']> extends Promise<infer T> ? T : never) => {
  try {
    const rpcs = registry.rpcs ?? [];
    const frontends = registry.frontends ?? [];
    const urls = new Set<string>();
    for (const item of [...rpcs, ...frontends]) {
      for (const img of item.images ?? []) {
        if (img.png) urls.add(img.png);
        if (img.svg) urls.add(img.svg);
      }
    }
    // fire-and-forget prefetch into browser http cache
    for (const url of urls) {
      void fetch(url, { mode: 'no-cors', cache: 'force-cache' }).catch(() => {});
    }
  } catch {
    // non-critical - icon prefetch failure doesn't break anything
  }
};

export const useRegistry = () => {
  return useQuery({
    queryKey: ['registryGlobals'],
    queryFn: async () => {
      const data = await new ChainRegistryClient().remote.globals();
      prefetchRegistryIcons(data);
      return data;
    },
    staleTime: Infinity,
  });
};
