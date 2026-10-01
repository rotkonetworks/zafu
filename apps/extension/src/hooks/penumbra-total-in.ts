import { useQuery, useQueryClient } from '@tanstack/react-query';
import { localExtStorage } from '@repo/storage-chrome/local';
import type { TotalIn } from '../routes/popup/home/penumbra-value';

const KEY = ['penumbraTotalIn'];

/** what the penumbra home's total is shown in: usd (default) or um */
export const usePenumbraTotalIn = () => {
  const queryClient = useQueryClient();
  const { data: totalIn = 'usd' } = useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<TotalIn> => (await localExtStorage.get('penumbraTotalIn')) ?? 'usd',
  });
  const setTotalIn = async (next: TotalIn) => {
    queryClient.setQueryData(KEY, next);
    await localExtStorage.set('penumbraTotalIn', next);
  };
  return { totalIn, setTotalIn };
};
