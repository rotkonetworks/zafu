/**
 * zcash transparent balance hook
 *
 * queries zidecar for UTXOs at derived transparent addresses.
 * sums valueZat for display in the home page.
 */

import { useQuery } from '@tanstack/react-query';
import { ZidecarClient, type Utxo } from '../state/keyring/zidecar-client';
import { useStore } from '../state';

const DEFAULT_ZIDECAR_URL = 'https://zcash.rotko.net';

export interface TransparentBalance {
  totalZat: bigint;
  utxos: Utxo[];
  isLoading: boolean;
  error: Error | null;
}

export function useTransparentBalance(addresses: string[]): TransparentBalance {
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || DEFAULT_ZIDECAR_URL;
  const {
    data,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['zcashTransparentUtxos', zidecarUrl, ...addresses],
    queryFn: async () => {
      if (addresses.length === 0) return { totalZat: 0n, utxos: [] as Utxo[] };
      const client = new ZidecarClient(zidecarUrl);
      const utxos = await client.getAddressUtxos(addresses);
      const totalZat = utxos.reduce((sum, u) => sum + u.valueZat, 0n);
      return { totalZat, utxos };
    },
    enabled: addresses.length > 0,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 2,
    // BigInt is not JSON serializable — disable structural sharing
    structuralSharing: false,
  });

  return {
    totalZat: data?.totalZat ?? 0n,
    utxos: data?.utxos ?? [],
    isLoading,
    error: error as Error | null,
  };
}
