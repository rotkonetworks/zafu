/**
 * preloading hooks for perceived performance
 * load data before user navigates
 */

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { balancesQueryOptions } from './penumbra-balances';

/**
 * preload balances for account 0
 * called on popup open to have data ready
 */
export const usePreloadBalances = (account = 0) => {
  const queryClient = useQueryClient();

  useEffect(() => {
    // prefetch in background - don't block render. Seeds the shared RAW
    // balances cache; consumers filter it via their own `select`.
    void queryClient.prefetchQuery({
      ...balancesQueryOptions(account),
      staleTime: 30_000, // 30 seconds
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
