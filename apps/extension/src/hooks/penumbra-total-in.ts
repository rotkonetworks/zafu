import { useQuery, useQueryClient } from '@tanstack/react-query';
import { localExtStorage, type LocalStorageState } from '@repo/storage-chrome/local';
import type { TotalIn } from '../routes/popup/home/penumbra-value';

/** never chosen (undefined) reads as um; a stored pick, usd included, is kept */
export const totalInOf = (stored?: TotalIn): TotalIn => stored ?? 'um';

/** one stored preference: read once, written through, shared by every reader */
const usePref = <K extends keyof LocalStorageState, T>(
  key: K,
  read: (stored: LocalStorageState[K]) => T,
) => {
  const queryClient = useQueryClient();
  const { data = read(undefined as LocalStorageState[K]) } = useQuery({
    queryKey: [key],
    queryFn: async () => read(await localExtStorage.get(key)),
  });
  const set = async (next: LocalStorageState[K]) => {
    queryClient.setQueryData([key], read(next));
    await localExtStorage.set(key, next);
  };
  return [data, set] as const;
};

/** what the penumbra home's total is shown in: um (default) or usd */
export const usePenumbraTotalIn = () => {
  const [totalIn, setTotalIn] = usePref('penumbraTotalIn', totalInOf);
  return { totalIn, setTotalIn };
};

/** the penumbra rows the user turned to usd, by asset id; the rest show their own amount */
export const usePenumbraRowsInUsd = () => {
  const [inUsd, set] = usePref('penumbraRowsInUsd', ids => ids ?? []);
  const toggle = (id: string) =>
    set(inUsd.includes(id) ? inUsd.filter(x => x !== id) : [...inUsd, id]);
  return { inUsd, toggle };
};
