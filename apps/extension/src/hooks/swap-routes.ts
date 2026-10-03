import { useQuery, useQueryClient } from '@tanstack/react-query';
import { localExtStorage } from '@repo/storage-chrome/local';
import type { RouteId } from '../state/swap/routes';
import { lastQuery, saveLast, type SwapLast } from '../state/swap/live';

const KEY = ['swapRoutes'];
type Chosen = Partial<Record<string, RouteId>>;

/** the route the user chose per pair; only a change from the best route is kept */
export const useSwapRoutes = () => {
  const queryClient = useQueryClient();
  const { data: chosen = {} } = useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<Chosen> => (await localExtStorage.get('swapRoutes')) ?? {},
  });
  const choose = async (pair: string, route: RouteId | undefined) => {
    const { [pair]: _, ...rest } = chosen;
    const next = route ? { ...rest, [pair]: route } : rest;
    queryClient.setQueryData(KEY, next);
    await localExtStorage.set('swapRoutes', next as Record<string, RouteId>);
  };
  return { chosen, choose };
};

/** the pair the swap screen reopens on, for this wallet */
export const useSwapLast = (wallet: string | undefined) => {
  const queryClient = useQueryClient();
  const { data } = useQuery(lastQuery);
  const remember = (last: SwapLast) => {
    if (wallet) {
      queryClient.setQueryData(lastQuery.queryKey, { ...data, [wallet]: last });
      void saveLast(wallet, last).catch(() => undefined);
    }
  };
  return { last: wallet ? data?.[wallet] : undefined, read: !!data, remember };
};
