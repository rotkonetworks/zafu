/**
 * The selected seed wallet's Hyperliquid account. Nothing here polls: the
 * balances are read when a screen that shows them opens, and when asked.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { localExtStorage } from '@repo/storage-chrome/local';
import {
  HYPERLIQUID_DEFAULT_PATH,
  deriveHyperliquidAddress,
  hyperliquidPath,
} from '@repo/wallet/networks/hyperliquid/derive';
import { queryHyperliquidBalances } from '@repo/wallet/networks/hyperliquid/client';
import { useStore } from '../state';
import { selectEffectiveKeyInfo, selectGetMnemonic } from '../state/keyring';

const PATH_KEY = ['hyperliquidPath'];

/** the person's own derivation path, or the default; rides the settings backup */
export const useHyperliquidPath = () => {
  const queryClient = useQueryClient();
  const { data: path } = useQuery({
    queryKey: PATH_KEY,
    queryFn: async () => hyperliquidPath(await localExtStorage.get('hyperliquidPath')),
    staleTime: Infinity,
  });
  const save = async (next: string) => {
    await (next === HYPERLIQUID_DEFAULT_PATH
      ? localExtStorage.remove('hyperliquidPath')
      : localExtStorage.set('hyperliquidPath', next));
    queryClient.setQueryData(PATH_KEY, next);
  };
  return { path, save };
};

/** only a seed wallet has the key here; a signer or viewing wallet gets no `keyId` */
export const useHyperliquidAccount = () => {
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const getMnemonic = useStore(selectGetMnemonic);
  const { path } = useHyperliquidPath();
  const keyId = keyInfo?.type === 'mnemonic' ? keyInfo.id : undefined;
  const { data: address } = useQuery({
    queryKey: ['hyperliquidAddress', keyId, path],
    queryFn: async () => deriveHyperliquidAddress(await getMnemonic(keyId!), path),
    enabled: !!keyId && !!path,
    staleTime: Infinity,
  });
  const balances = useQuery({
    queryKey: ['hyperliquidBalances', address],
    queryFn: () => queryHyperliquidBalances(address!),
    enabled: !!address,
    // read on opening and on refresh, never on a timer or a focus change
    staleTime: Infinity,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    structuralSharing: false, // bigint amounts
  });
  return { keyId, path, address, balances };
};
