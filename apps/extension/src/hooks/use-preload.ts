/**
 * preloading hooks for perceived performance
 * load data before user navigates
 */

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { balancesQueryOptions } from './penumbra-balances';

/**
 * preload balances for the wallet's account
 * called on popup open to have data ready
 */
export const usePreloadBalances = (wallet: string | undefined, account = 0) => {
  const queryClient = useQueryClient();

  useEffect(() => {
    // prefetch in background - don't block render. Seeds the shared RAW
    // balances cache; consumers filter it via their own `select`.
    void queryClient.prefetchQuery({
      ...balancesQueryOptions(wallet, account),
      staleTime: 30_000, // 30 seconds
    });
  }, [queryClient, wallet, account]);
};
