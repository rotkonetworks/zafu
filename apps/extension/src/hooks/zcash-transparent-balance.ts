/**
 * A pocket's transparent balance: the last check, read from this computer,
 * and `check(tip)`, the only thing here that asks the node. Callers ask on
 * intent (check now, opening the transparent view or the shield step) or,
 * when the user turned it on, on each new block.
 */

import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStore } from '../state';
import { selectZcashBackend } from '../state/networks';
import { activeZcashStoreId } from '../state/pockets';
import { zcashClient } from '../state/keyring/zcash-backend';
import {
  checkKey,
  fromStored,
  runCheck,
  toStored,
  type TransparentCheck,
} from '../transparent/zcash-check';

export const useTransparentBalance = (tAddresses: string[]) => {
  const storeId = useStore(activeZcashStoreId);
  const url = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';
  const backend = useStore(selectZcashBackend);
  const queryClient = useQueryClient();
  const key = ['zcashTransparentCheck', storeId];

  const last = useQuery({
    queryKey: key,
    queryFn: async () => {
      const k = checkKey(storeId!);
      return fromStored((await chrome.storage.local.get(k))[k]);
    },
    enabled: !!storeId,
    staleTime: Infinity,
    structuralSharing: false, // bigint
  }).data;

  const run = useMutation({
    mutationKey: key,
    mutationFn: (tip: number) => runCheck(zcashClient(url, backend), tAddresses, tip),
    onSuccess: (c: TransparentCheck) => {
      queryClient.setQueryData(key, c);
      void chrome.storage.local.set({ [checkKey(storeId!)]: toStored(c) });
    },
  });
  const checking = useIsMutating({ mutationKey: key }) > 0;

  return {
    /** the last check, or null before the first */
    last,
    checking,
    failed: run.isError,
    /** one check of every address, each on its own; a second press while one runs does nothing */
    check: (tip = 0) => {
      if (storeId && tAddresses.length > 0 && !queryClient.isMutating({ mutationKey: key })) {
        // a check asked without a tip keeps the one it knew
        run.mutate(Math.max(tip, last?.height ?? 0));
      }
    },
  };
};
