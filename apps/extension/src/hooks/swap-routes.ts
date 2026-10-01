import { useQuery, useQueryClient } from '@tanstack/react-query';
import { localExtStorage } from '@repo/storage-chrome/local';
import type { RouteId } from '../state/swap/routes';

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
