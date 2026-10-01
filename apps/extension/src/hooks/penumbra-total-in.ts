import { useQuery, useQueryClient } from '@tanstack/react-query';
import { localExtStorage } from '@repo/storage-chrome/local';
import type { TotalIn } from '../routes/popup/home/penumbra-value';

const KEY = ['penumbraTotalIn'];

/** never chosen (undefined) reads as um; a stored pick, usd included, is kept */
export const totalInOf = (stored?: TotalIn): TotalIn => stored ?? 'um';

/** what the penumbra home's total is shown in: um (default) or usd */
export const usePenumbraTotalIn = () => {
  const queryClient = useQueryClient();
  const { data: totalIn = totalInOf() } = useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<TotalIn> => totalInOf(await localExtStorage.get('penumbraTotalIn')),
  });
  const setTotalIn = async (next: TotalIn) => {
    queryClient.setQueryData(KEY, next);
    await localExtStorage.set('penumbraTotalIn', next);
  };
  return { totalIn, setTotalIn };
};
