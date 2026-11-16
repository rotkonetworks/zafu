/**
 * A pocket's transparent balance: the last check, read from this computer,
 * and `check(tip)`, the only thing here that asks the node. Callers ask on
 * intent (check now, opening the transparent view or the shield step) or,
 * when the user turned it on, on each new block.
 */

import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStore } from '../state';
import { selectZcashBackend, selectZcashEndpoint } from '../state/networks';
import { activeZcashStoreId } from '../state/pockets';
import { zcashClient } from '../state/keyring/zcash-backend';
import {
  afterShield,
  readCheck,
  runCheck,
  saveCheck,
  type TransparentCheck,
} from '../transparent/zcash-check';

/** a pocket's one look back (lookBackTAddresses), handed the way to ask */
type Sweep = (ask: (older: string[]) => Promise<{ address: string }[]>) => Promise<void>;

/** `sweep`: given while the pocket owes its one look back; the next check is that look back */
export const useTransparentBalance = (tAddresses: string[], sweep?: Sweep) => {
  const storeId = useStore(activeZcashStoreId);
  const url = useStore(selectZcashEndpoint);
  const backend = useStore(selectZcashBackend);
  const queryClient = useQueryClient();
  const key = ['zcashTransparentCheck', storeId];

  const last = useQuery({
    queryKey: key,
    queryFn: () => readCheck(storeId!),
    enabled: !!storeId,
    staleTime: Infinity,
    structuralSharing: false, // bigint
  }).data;

  const record = (c: TransparentCheck) => {
    queryClient.setQueryData(key, c);
    void saveCheck(storeId!, c);
  };
  const run = useMutation({
    mutationKey: key,
    mutationFn: ({ tip, addresses }: { tip: number; addresses: string[] }) =>
      runCheck(zcashClient(url, backend), addresses, tip),
    onSuccess: record,
  });
  const checking = useIsMutating({ mutationKey: key }) > 0;
  // a check asked without a tip keeps the one it knew
  const at = (tip: number) => Math.max(tip, last?.height ?? 0);

  const lookBack = async (older: string[]) =>
    (await run.mutateAsync({ tip: at(0), addresses: older })).utxos ?? [];

  return {
    /** the last check, or null before the first */
    last,
    checking,
    failed: run.isError,
    /** one check of every address, each on its own; a second press while one runs does nothing */
    check: (tip = 0) => {
      if (storeId && tAddresses.length > 0 && !queryClient.isMutating({ mutationKey: key })) {
        if (sweep) {
          // a node that did not answer shows as a failed check; the next one tries again
          void sweep(older =>
            run.mutateAsync({ tip: at(tip), addresses: older }).then(c => c.utxos ?? []),
          ).catch(() => undefined);
        } else {
          run.mutate({ tip: at(tip), addresses: tAddresses });
        }
      }
    },
    /**
     * a restored seed's older addresses, asked once (lookBackTAddresses): the
     * result stands as the pocket's check, since the coins it finds are then covered
     */
    lookBack,
    /** a shield went out: its coins stay off the figure until the next check */
    shielded: (spentZat: bigint) => {
      const now = queryClient.getQueryData<TransparentCheck | null>(key);
      if (storeId && now) {
        record(afterShield(now, spentZat));
      }
    },
  };
};
