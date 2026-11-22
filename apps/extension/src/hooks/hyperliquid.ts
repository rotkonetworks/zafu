/**
 * The selected seed wallet's Hyperliquid accounts and the one in use.
 * Nothing here polls: balances are read when a screen that shows them opens,
 * and when asked.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { localExtStorage } from '@repo/storage-chrome/local';
import { deriveHyperliquidAddress } from '@repo/wallet/networks/hyperliquid/derive';
import {
  hyperliquidAccountExists,
  queryHyperliquidBalances,
} from '@repo/wallet/networks/hyperliquid/client';
import { useStore } from '../state';
import { selectEffectiveKeyInfo, selectGetMnemonic } from '../state/keyring';
import { pocketOwner } from '../state/pockets';
import {
  accountPath,
  accountsOf,
  activeOf,
  changeAccounts,
  customPathOf,
  nameOf,
  pathOf,
  readBook,
  rowsOf,
  scanAccounts,
  withName,
  withNew,
  withTop,
  type AccountId,
  type AccountsBook,
} from '../hyperliquid/accounts';

const BOOK_KEY = ['hyperliquidAccounts'];
const PATH_KEY = ['hyperliquidPath'];

/** the accounts of the selected seed wallet; a signer or viewing wallet has none here */
export const useHyperliquidAccounts = () => {
  const queryClient = useQueryClient();
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const getMnemonic = useStore(selectGetMnemonic);
  const keyId = keyInfo?.type === 'mnemonic' ? keyInfo.id : undefined;
  const owner = keyInfo && keyId ? pocketOwner(keyInfo) : undefined;
  const book = useQuery({ queryKey: BOOK_KEY, queryFn: readBook, staleTime: Infinity });
  const custom = useQuery({
    queryKey: PATH_KEY,
    queryFn: async () => customPathOf(await localExtStorage.get('hyperliquidPath')) ?? null,
    staleTime: Infinity,
  });
  const accounts = accountsOf(book.data ?? {}, owner);
  const customPath = custom.data ?? undefined;
  const active = activeOf(accounts, customPath);

  const change = async (fn: Parameters<typeof changeAccounts>[1]) => {
    if (owner) {
      queryClient.setQueryData<AccountsBook>(BOOK_KEY, await changeAccounts(owner, fn));
    }
  };

  return {
    keyId,
    /** false until both the accounts and the path are read: nothing derives before */
    ready: book.isSuccess && custom.isSuccess,
    active,
    name: nameOf(accounts, active),
    path: pathOf(active, customPath),
    customPath,
    rows: rowsOf(accounts, customPath),
    pick: (id: AccountId) => change(w => ({ ...w, active: id })),
    /** the next index, one tap */
    add: () => change(withNew),
    rename: (id: AccountId, name: string) => change(w => withName(w, id, name)),
    /** the imported path: set it (and move to it), or take it away (and move to account 0) */
    setCustomPath: async (path: string | undefined) => {
      await (path
        ? localExtStorage.set('hyperliquidPath', path)
        : localExtStorage.remove('hyperliquidPath'));
      queryClient.setQueryData(PATH_KEY, path ?? null);
      await change(w => ({ ...w, active: path ? 'path' : 0 }));
    },
    /**
     * Look for accounts from the seed alone (hyperliquid/accounts scanAccounts)
     * and raise the highest index to the last one found. Resolves that index.
     */
    lookForAccounts: async (): Promise<number> => {
      if (!keyId) {
        return -1;
      }
      const mnemonic = await getMnemonic(keyId);
      const found = await scanAccounts(n =>
        hyperliquidAccountExists(deriveHyperliquidAddress(mnemonic, accountPath(n))),
      );
      await change(w => withTop(w, found));
      return found;
    },
  };
};

/** the account in use: its key path, address and what it can move */
export const useHyperliquidAccount = () => {
  const getMnemonic = useStore(selectGetMnemonic);
  const { keyId, ready, path, name, active } = useHyperliquidAccounts();
  const { data: address } = useQuery({
    queryKey: ['hyperliquidAddress', keyId, path],
    queryFn: async () => deriveHyperliquidAddress(await getMnemonic(keyId!), path),
    enabled: !!keyId && ready,
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
  return { keyId, path: ready ? path : undefined, name, active, address, balances };
};
