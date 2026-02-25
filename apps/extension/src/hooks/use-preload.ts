/**
 * preloading hooks for perceived performance
 * load data before user navigates
 */

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { viewClient } from '../clients';

/**
 * preload balances for account 0
 * called on popup open to have data ready
 */
export const usePreloadBalances = (account = 0) => {
  const queryClient = useQueryClient();

  useEffect(() => {
    // prefetch in background - don't block render
    void queryClient.prefetchQuery({
      queryKey: ['balances', account],
      staleTime: 30_000, // 30 seconds
      queryFn: async () => {
        try {
          return await Array.fromAsync(viewClient.balances({ accountFilter: { account } }));
        } catch {
          return [];
        }
      },
    });
  }, [queryClient, account]);
};

/**
 * preload route components
 * call this on likely navigation targets
 */
export const preloadRoute = (importFn: () => Promise<unknown>) => {
  // trigger dynamic import in background
  void importFn();
};
