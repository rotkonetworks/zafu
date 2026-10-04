/**
 * zcash transparent balance hook
 *
 * queries zidecar for UTXOs at derived transparent addresses.
 * sums valueZat for display in the home page.
 */

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { Utxo } from '../state/keyring/zidecar-client';
import { zcashClient } from '../state/keyring/zcash-backend';
import { useStore } from '../state';
import { selectZcashBackend } from '../state/networks';

const DEFAULT_ZIDECAR_URL = 'https://zcash.rotko.net';

export interface TransparentBalance {
  totalZat: bigint;
  utxos: Utxo[];
  isLoading: boolean;
  error: Error | null;
  /** still the previous addresses' figure (see `holdPrevious`) */
  held: boolean;
}

/**
 * `holdPrevious`: while the addresses change (a pocket switch), keep the last
 * figure as a placeholder, flagged `held`, instead of dropping to zero.
 */
export function useTransparentBalance(
  addresses: string[],
  holdPrevious = false,
): TransparentBalance {
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || DEFAULT_ZIDECAR_URL;
  const backend = useStore(selectZcashBackend);
  const { data, isLoading, error, isPlaceholderData } = useQuery({
    queryKey: ['zcashTransparentUtxos', zidecarUrl, backend, ...addresses],
    queryFn: async () => {
      if (addresses.length === 0) {
        return { totalZat: 0n, utxos: [] as Utxo[] };
      }
      const utxos = await zcashClient(zidecarUrl, backend).getAddressUtxos(addresses);
      const totalZat = utxos.reduce((sum, u) => sum + u.valueZat, 0n);
      return { totalZat, utxos };
    },
    enabled: addresses.length > 0,
    placeholderData: holdPrevious ? keepPreviousData : undefined,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 2,
    // BigInt is not JSON serializable - disable structural sharing
    structuralSharing: false,
  });

  return {
    totalZat: data?.totalZat ?? 0n,
    utxos: data?.utxos ?? [],
    isLoading,
    error: error,
    held: isPlaceholderData,
  };
}
