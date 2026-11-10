/**
 * Every penumbra account holding funds. The view service finds notes for any
 * account the viewing key owns (the account is recovered from each note's
 * address), so a deposit to an account beyond the pockets shows up here.
 * Only read while the accounts sheet is open: it is a full balances stream.
 */

import { queryOptions } from '@tanstack/react-query';
import { getAddressIndex } from '@penumbra-zone/getters/address-view';
import type { BalancesResponse } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { viewClient } from '../clients';

export const fundedAccounts = (balances: BalancesResponse[]): number[] => [
  ...new Set(balances.map(b => getAddressIndex.optional(b.accountAddress)?.account ?? 0)),
];

/** keyed by wallet, so one wallet's accounts are never listed under another */
export const penumbraAccountsQuery = (walletId: string | undefined) =>
  queryOptions({
    queryKey: ['penumbra-accounts', walletId],
    queryFn: async () => fundedAccounts(await Array.fromAsync(viewClient.balances({}))),
    retry: 1,
  });
